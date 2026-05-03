import type { AgentActionEventRow, AgentActionOutcomeRow, Env, GrowthExecutionIntent, GrowthMessageBrief, GrowthSkripStrategicRequest } from '../../types';
import { query } from '../db';
import { parseJsonObject } from './common';
import { getAgentAction, listAgentActionEvents, type AgentActionView } from './actions';

interface OutboxTraceRow {
  id: number;
  campaign_id: string;
  step_id: string;
  contact_id: string;
  channel: string;
  status: string;
  idempotency_key: string;
  payload_json: string;
  message_id: string | null;
  skrip_outbound_id: string | null;
  provider_ref: string | null;
  latest_status: string | null;
  last_outcome_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface AgentActionExecutionTrace {
  action: AgentActionView;
  events: Array<AgentActionEventRow & { payload: Record<string, unknown> }>;
  intent: GrowthExecutionIntent | null;
  messageBrief: GrowthMessageBrief | null;
  skripHandoff: GrowthSkripStrategicRequest | null;
  outbox: Array<OutboxTraceRow & { payload: Record<string, unknown> }>;
  outcomes: Array<AgentActionOutcomeRow & { evidence: Record<string, unknown> }>;
}

function parsedPayload<T>(value: string | null): T | null {
  if (!value) return null;
  return parseJsonObject(value) as unknown as T;
}

export async function loadAgentActionExecutionTrace(env: Env, actionId: string): Promise<AgentActionExecutionTrace | null> {
  const action = await getAgentAction(env, actionId);
  if (!action) return null;

  const [events, outbox, outcomes] = await Promise.all([
    listAgentActionEvents(env, actionId),
    query<OutboxTraceRow>(
      env.DB,
      `SELECT o.id,
              o.campaign_id,
              o.step_id,
              o.contact_id,
              o.channel,
              o.status,
              o.idempotency_key,
              o.payload_json,
              l.message_id,
              l.skrip_outbound_id,
              l.provider_ref,
              l.latest_status,
              l.last_outcome_at,
              o.created_at,
              o.updated_at
         FROM channel_execution_outbox o
    LEFT JOIN channel_message_lineage l
           ON l.tenant_id = o.tenant_id
          AND l.campaign_id = o.campaign_id
          AND l.step_id = o.step_id
          AND l.contact_id = o.contact_id
          AND l.channel = o.channel
        WHERE json_extract(o.payload_json, '$.context.agentActionId') = ?
        ORDER BY o.created_at DESC`,
      [actionId],
    ),
    query<AgentActionOutcomeRow>(
      env.DB,
      `SELECT * FROM agent_action_outcomes WHERE action_id = ? ORDER BY observed_at DESC, id DESC`,
      [actionId],
    ),
  ]);

  const parsedEvents = events.map((event) => ({
    ...event,
    payload: parseJsonObject(event.payload_json),
  }));

  const intent = (parsedEvents.find((event) => event.event_type === 'execution_intent_built')?.payload.intent ?? null) as GrowthExecutionIntent | null;
  const messageBrief = (parsedEvents.find((event) => event.event_type === 'message_brief_ready')?.payload.brief ?? null) as GrowthMessageBrief | null;
  const skripHandoff = (parsedEvents.find((event) => event.event_type === 'skrip_handoff_prepared')?.payload.handoff ?? null) as GrowthSkripStrategicRequest | null;

  return {
    action,
    events: parsedEvents,
    intent,
    messageBrief,
    skripHandoff,
    outbox: outbox.map((row) => ({ ...row, payload: parseJsonObject(row.payload_json) })),
    outcomes: outcomes.map((row) => ({ ...row, evidence: parsedPayload<Record<string, unknown>>(row.evidence_json) ?? {} })),
  };
}