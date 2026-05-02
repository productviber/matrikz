import type {
  AgentActionEventRow,
  AgentActionRow,
  Env,
  GrowthPolicyResult,
  ProposedAgentAction,
} from '../../types';
import {
  AGENT_ACTION_EVENT,
  AGENT_ACTION_STATUS,
  AGENT_ACTION_TYPE,
  AGENT_RISK_LEVEL,
  EVENT_TYPES,
  GROWTH_POLICY,
  NOTIFICATION_CHANNEL,
} from '../../constants';
import { cancelPendingEmails, enrollInSequences } from '../email';
import { execute, now, query, queryOne } from '../db';
import { getCorrelationId } from '../correlation';
import { enqueueEligibleSkripChannels } from '../skrip/outbox';
import { evaluateGrowthPolicy } from './policy';
import { hashObject, isRecord, normalizeSubjectId, normalizeTenantId, parseJsonObject, stableStringify } from './common';

export interface CreateAgentActionInput {
  agentId?: string | null;
  tenantId?: string | null;
  subjectId: string;
  signalId?: string | null;
  action: ProposedAgentAction;
  riskLevel?: string;
  confidence?: number;
  evidence?: Record<string, unknown>;
  requestSnapshot?: Record<string, unknown>;
  aiMetadata?: unknown;
  policyResult: GrowthPolicyResult;
}

export interface AgentActionView extends Omit<AgentActionRow, 'proposed_action_json' | 'evidence_json' | 'policy_result_json' | 'ai_metadata_json' | 'outcome_json'> {
  proposedAction: ProposedAgentAction;
  evidence: Record<string, unknown>;
  policyResult: GrowthPolicyResult;
  aiMetadata: Record<string, unknown> | null;
  outcome: Record<string, unknown> | null;
}

export interface ExecutionResult {
  executed: boolean;
  action: AgentActionView;
  result: Record<string, unknown>;
}

function actionParamRecord(action: ProposedAgentAction): Record<string, unknown> {
  return isRecord(action.params) ? action.params : {};
}

function actionParamString(action: ProposedAgentAction, key: string): string | null {
  const value = actionParamRecord(action)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function actionParamNumber(action: ProposedAgentAction, key: string): number | null {
  const value = actionParamRecord(action)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseAction(row: AgentActionRow): AgentActionView {
  return {
    ...row,
    proposedAction: parseJsonObject(row.proposed_action_json) as unknown as ProposedAgentAction,
    evidence: parseJsonObject(row.evidence_json),
    policyResult: parseJsonObject(row.policy_result_json) as unknown as GrowthPolicyResult,
    aiMetadata: row.ai_metadata_json ? parseJsonObject(row.ai_metadata_json) : null,
    outcome: row.outcome_json ? parseJsonObject(row.outcome_json) : null,
  };
}

async function buildActionIdentity(input: {
  tenantId: string;
  subjectId: string;
  signalId: string | null;
  action: ProposedAgentAction;
}): Promise<{ actionId: string; idempotencyKey: string }> {
  const actionWindow = Math.floor(now() / GROWTH_POLICY.ACTION_WINDOW_SECONDS);
  const hash = await hashObject({
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    signalId: input.signalId,
    action: input.action,
    actionWindow,
  });
  return {
    actionId: `act_${hash}`,
    idempotencyKey: `${input.tenantId}:${input.subjectId}:${input.signalId ?? 'none'}:${input.action.type}:${actionWindow}:${hash}`,
  };
}

function statusFromPolicy(policyResult: GrowthPolicyResult): string {
  if (!policyResult.allowed) return AGENT_ACTION_STATUS.REJECTED;
  if (policyResult.requiredApproval) return AGENT_ACTION_STATUS.POLICY_CHECKED;
  return AGENT_ACTION_STATUS.APPROVED;
}

export async function recordAgentActionEvent(
  env: Env,
  actionId: string,
  eventType: string,
  payload: Record<string, unknown>,
  actor = 'agentic-api',
): Promise<void> {
  await execute(
    env.DB,
    `INSERT INTO agent_action_events (action_id, event_type, actor, correlation_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [actionId, eventType, actor, getCorrelationId(), JSON.stringify(payload), now()],
  );
}

export async function createAgentActionProposal(env: Env, input: CreateAgentActionInput): Promise<AgentActionView> {
  const tenantId = normalizeTenantId(input.tenantId);
  const subjectId = normalizeSubjectId(input.subjectId);
  const signalId = input.signalId ?? null;
  const { actionId, idempotencyKey } = await buildActionIdentity({ tenantId, subjectId, signalId, action: input.action });
  const epoch = now();
  const status = statusFromPolicy(input.policyResult);
  const inputHash = await hashObject(input.requestSnapshot ?? { tenantId, subjectId, signalId });
  const outputHash = await hashObject({ action: input.action, policyResult: input.policyResult, aiMetadata: input.aiMetadata ?? null });
  const approvedAt = status === AGENT_ACTION_STATUS.APPROVED ? epoch : null;
  const riskLevel = input.riskLevel ?? AGENT_RISK_LEVEL.MEDIUM;
  const confidence = Math.max(0, Math.min(100, Math.floor(input.confidence ?? GROWTH_POLICY.DEFAULT_CONFIDENCE)));

  await execute(
    env.DB,
    `INSERT INTO agent_actions
      (action_id, idempotency_key, correlation_id, agent_id, tenant_id, subject_id, signal_id, proposed_action,
       proposed_action_json, status, risk_level, confidence, evidence_json, input_hash, output_hash,
       policy_result_json, ai_metadata_json, created_at, updated_at, approved_at, executed_at, outcome_due_at, outcome_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
     ON CONFLICT(idempotency_key) DO UPDATE SET
       correlation_id = excluded.correlation_id,
       status = CASE
         WHEN agent_actions.status = 'executed' THEN agent_actions.status
         ELSE excluded.status
       END,
       risk_level = excluded.risk_level,
       confidence = excluded.confidence,
       evidence_json = excluded.evidence_json,
       output_hash = excluded.output_hash,
       policy_result_json = excluded.policy_result_json,
       ai_metadata_json = excluded.ai_metadata_json,
       approved_at = COALESCE(agent_actions.approved_at, excluded.approved_at),
       outcome_due_at = COALESCE(agent_actions.outcome_due_at, excluded.outcome_due_at),
       updated_at = excluded.updated_at`,
    [
      actionId,
      idempotencyKey,
      getCorrelationId(),
      input.agentId?.trim() || GROWTH_POLICY.DEFAULT_AGENT_ID,
      tenantId,
      subjectId,
      signalId,
      input.action.type,
      JSON.stringify(input.action),
      status,
      riskLevel,
      confidence,
      JSON.stringify(input.evidence ?? {}),
      inputHash,
      outputHash,
      JSON.stringify(input.policyResult),
      input.aiMetadata ? JSON.stringify(input.aiMetadata) : null,
      epoch,
      epoch,
      approvedAt,
      epoch + GROWTH_POLICY.DEFAULT_OUTCOME_WINDOW_SECONDS,
    ],
  );

  await recordAgentActionEvent(env, actionId, AGENT_ACTION_EVENT.PROPOSED, { action: input.action, confidence, riskLevel });
  await recordAgentActionEvent(env, actionId, AGENT_ACTION_EVENT.POLICY_CHECKED, { policyResult: input.policyResult });
  if (status === AGENT_ACTION_STATUS.APPROVED) {
    await recordAgentActionEvent(env, actionId, AGENT_ACTION_EVENT.APPROVED, { automatic: true });
  }
  if (status === AGENT_ACTION_STATUS.REJECTED) {
    await recordAgentActionEvent(env, actionId, AGENT_ACTION_EVENT.REJECTED, { blockedReasons: input.policyResult.blockedReasons });
  }

  const row = await queryOne<AgentActionRow>(env.DB, `SELECT * FROM agent_actions WHERE idempotency_key = ? LIMIT 1`, [idempotencyKey]);
  if (!row) throw new Error('Failed to load agent action proposal');
  return parseAction(row);
}

export async function getAgentAction(env: Env, actionId: string): Promise<AgentActionView | null> {
  const row = await queryOne<AgentActionRow>(env.DB, `SELECT * FROM agent_actions WHERE action_id = ? LIMIT 1`, [actionId]);
  return row ? parseAction(row) : null;
}

export async function listAgentActionEvents(env: Env, actionId: string): Promise<AgentActionEventRow[]> {
  return query<AgentActionEventRow>(
    env.DB,
    `SELECT * FROM agent_action_events WHERE action_id = ? ORDER BY created_at ASC, id ASC`,
    [actionId],
  );
}

export async function dryRunAgentAction(env: Env, input: {
  actionId?: string;
  tenantId?: string | null;
  subjectId?: string;
  action?: ProposedAgentAction;
  riskLevel?: string;
  confidence?: number;
}): Promise<{ policyResult: GrowthPolicyResult; action?: AgentActionView }> {
  if (input.actionId) {
    const action = await getAgentAction(env, input.actionId);
    if (!action) throw new Error('Agent action not found');
    const policyResult = await evaluateGrowthPolicy(env, {
      tenantId: action.tenant_id,
      subjectId: action.subject_id,
      action: action.proposedAction,
      riskLevel: action.risk_level,
      confidence: action.confidence,
      actionId: action.action_id,
    });
    const status = policyResult.allowed ? AGENT_ACTION_STATUS.POLICY_CHECKED : AGENT_ACTION_STATUS.REJECTED;
    await execute(
      env.DB,
      `UPDATE agent_actions SET status = ?, policy_result_json = ?, updated_at = ? WHERE action_id = ?`,
      [status, JSON.stringify(policyResult), now(), action.action_id],
    );
    await recordAgentActionEvent(env, action.action_id, AGENT_ACTION_EVENT.POLICY_CHECKED, { policyResult, dryRun: true });
    return { policyResult, action: await getAgentAction(env, action.action_id) ?? action };
  }

  if (!input.subjectId || !input.action) {
    throw new Error('subjectId and action are required when actionId is not provided');
  }
  const policyResult = await evaluateGrowthPolicy(env, {
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    action: input.action,
    riskLevel: input.riskLevel,
    confidence: input.confidence,
  });
  return { policyResult };
}

async function markActionStatus(
  env: Env,
  actionId: string,
  status: string,
  payload: Record<string, unknown>,
  eventType: string,
): Promise<void> {
  const epoch = now();
  await execute(
    env.DB,
    `UPDATE agent_actions
        SET status = ?, updated_at = ?, executed_at = CASE WHEN ? = 'executed' THEN ? ELSE executed_at END,
            outcome_json = CASE WHEN ? = 'executed' THEN ? ELSE outcome_json END
      WHERE action_id = ?`,
    [status, epoch, status, epoch, status, JSON.stringify(payload), actionId],
  );
  await recordAgentActionEvent(env, actionId, eventType, payload);
}

async function executeWait(action: AgentActionView): Promise<Record<string, unknown>> {
  const reviewAfterSeconds = actionParamNumber(action.proposedAction, 'reviewAfterSeconds') ?? 24 * 60 * 60;
  return {
    type: AGENT_ACTION_TYPE.WAIT,
    nextReviewAt: now() + Math.max(60 * 60, Math.min(reviewAfterSeconds, 30 * 24 * 60 * 60)),
  };
}

async function executeOperatorTask(env: Env, action: AgentActionView): Promise<Record<string, unknown>> {
  const summary = `${action.proposed_action} for ${action.subject_id}: ${action.proposedAction.reason ?? 'Agent requested operator review'}`;
  await execute(
    env.DB,
    `INSERT INTO notification_log (channel, event_type, payload_summary, status, created_at)
     VALUES (?, ?, ?, 'sent', ?)`,
    [NOTIFICATION_CHANNEL.SLACK, 'agent.operator_task', summary.slice(0, 500), now()],
  );
  return { type: action.proposed_action, operatorTaskCreated: true, summary: summary.slice(0, 500) };
}

async function executeSequenceEnrollment(env: Env, action: AgentActionView): Promise<Record<string, unknown>> {
  const triggerEvent = actionParamString(action.proposedAction, 'triggerEvent') ?? EVENT_TYPES.OUTBOUND_PROSPECT_DISCOVERED;
  const capabilityHookId = actionParamString(action.proposedAction, 'capabilityHookId');
  const contextValue = actionParamRecord(action.proposedAction).context;
  const context = isRecord(contextValue) ? contextValue : { agentActionId: action.action_id };
  const enrolled = await enrollInSequences(env, action.subject_id, triggerEvent, { ...context, agentActionId: action.action_id }, capabilityHookId);
  return { type: AGENT_ACTION_TYPE.ENROLL_SEQUENCE, triggerEvent, enrolled };
}

async function executeSkripSend(env: Env, action: AgentActionView): Promise<Record<string, unknown>> {
  const campaignId = actionParamString(action.proposedAction, 'campaignId') ?? 'agent-growth';
  const stepId = actionParamString(action.proposedAction, 'stepId') ?? `agent-${action.action_id}`;
  const domain = actionParamString(action.proposedAction, 'domain');
  const contextValue = actionParamRecord(action.proposedAction).context;
  const context = isRecord(contextValue) ? contextValue : { agentActionId: action.action_id };
  const enqueued = await enqueueEligibleSkripChannels(env, {
    tenantId: action.tenant_id,
    campaignId,
    stepId,
    contactId: action.subject_id,
    domain,
    context: { ...context, agentActionId: action.action_id },
  });
  return { type: AGENT_ACTION_TYPE.SEND_VIA_SKRIP, campaignId, stepId, enqueued };
}

async function executeCampaignStatus(env: Env, action: AgentActionView, status: 'active' | 'paused'): Promise<Record<string, unknown>> {
  const campaignRef = actionParamString(action.proposedAction, 'campaignId')
    ?? actionParamString(action.proposedAction, 'campaignSlug')
    ?? action.subject_id;
  const timestampColumn = status === 'active' ? 'started_at' : 'paused_at';
  await execute(
    env.DB,
    `UPDATE outbound_campaigns
        SET status = ?, ${timestampColumn} = ?, updated_at = ?
      WHERE slug = ? OR CAST(id AS TEXT) = ?`,
    [status, now(), now(), campaignRef, campaignRef],
  );
  return { type: status === 'active' ? AGENT_ACTION_TYPE.START_CAMPAIGN : AGENT_ACTION_TYPE.PAUSE_CAMPAIGN, campaignRef, status };
}

async function executePauseContact(env: Env, action: AgentActionView): Promise<Record<string, unknown>> {
  const triggerEvent = actionParamString(action.proposedAction, 'triggerEvent') ?? undefined;
  const cancelled = await cancelPendingEmails(env, action.subject_id, triggerEvent);
  return { type: AGENT_ACTION_TYPE.PAUSE_CONTACT, cancelled, triggerEvent: triggerEvent ?? null };
}

async function executeActionPrimitive(env: Env, action: AgentActionView): Promise<Record<string, unknown>> {
  switch (action.proposed_action) {
    case AGENT_ACTION_TYPE.WAIT:
      return executeWait(action);
    case AGENT_ACTION_TYPE.MANUAL_REVIEW:
    case AGENT_ACTION_TYPE.ESCALATE_TO_HUMAN:
      return executeOperatorTask(env, action);
    case AGENT_ACTION_TYPE.ENROLL_SEQUENCE:
      return executeSequenceEnrollment(env, action);
    case AGENT_ACTION_TYPE.SEND_VIA_SKRIP:
      return executeSkripSend(env, action);
    case AGENT_ACTION_TYPE.START_CAMPAIGN:
      return executeCampaignStatus(env, action, 'active');
    case AGENT_ACTION_TYPE.PAUSE_CAMPAIGN:
      return executeCampaignStatus(env, action, 'paused');
    case AGENT_ACTION_TYPE.PAUSE_CONTACT:
      return executePauseContact(env, action);
    default:
      throw new Error(`Unsupported action type: ${action.proposed_action}`);
  }
}

export async function executeAgentAction(env: Env, actionId: string): Promise<ExecutionResult> {
  const action = await getAgentAction(env, actionId);
  if (!action) throw new Error('Agent action not found');

  if (action.status === AGENT_ACTION_STATUS.EXECUTED) {
    return { executed: true, action, result: action.outcome ?? { alreadyExecuted: true } };
  }

  const policyResult = await evaluateGrowthPolicy(env, {
    tenantId: action.tenant_id,
    subjectId: action.subject_id,
    action: action.proposedAction,
    riskLevel: action.risk_level,
    confidence: action.confidence,
    actionId: action.action_id,
  });

  await execute(
    env.DB,
    `UPDATE agent_actions SET policy_result_json = ?, updated_at = ? WHERE action_id = ?`,
    [JSON.stringify(policyResult), now(), action.action_id],
  );
  await recordAgentActionEvent(env, action.action_id, AGENT_ACTION_EVENT.POLICY_CHECKED, { policyResult, executeAttempt: true });

  if (!policyResult.allowed) {
    const result = { blocked: true, blockedReasons: policyResult.blockedReasons };
    await markActionStatus(env, action.action_id, AGENT_ACTION_STATUS.REJECTED, result, AGENT_ACTION_EVENT.REJECTED);
    return { executed: false, action: await getAgentAction(env, action.action_id) ?? action, result };
  }

  if (policyResult.requiredApproval && action.status !== AGENT_ACTION_STATUS.APPROVED) {
    const result = { blocked: true, approvalRequired: true };
    await markActionStatus(env, action.action_id, AGENT_ACTION_STATUS.POLICY_CHECKED, result, AGENT_ACTION_EVENT.POLICY_CHECKED);
    return { executed: false, action: await getAgentAction(env, action.action_id) ?? action, result };
  }

  try {
    const result = await executeActionPrimitive(env, action);
    await markActionStatus(env, action.action_id, AGENT_ACTION_STATUS.EXECUTED, result, AGENT_ACTION_EVENT.EXECUTED);
    return { executed: true, action: await getAgentAction(env, action.action_id) ?? action, result };
  } catch (error) {
    const result = { error: error instanceof Error ? error.message : String(error) };
    await markActionStatus(env, action.action_id, AGENT_ACTION_STATUS.FAILED, result, AGENT_ACTION_EVENT.FAILED);
    return { executed: false, action: await getAgentAction(env, action.action_id) ?? action, result };
  }
}

export async function recordAgentActionOutcome(env: Env, input: {
  actionId: string;
  outcomeType: string;
  observedAt?: number;
  windowSeconds?: number;
  attributionStrength?: string;
  revenueOrValue?: number | null;
  evidence?: Record<string, unknown>;
}): Promise<void> {
  const observedAt = input.observedAt ?? now();
  await execute(
    env.DB,
    `INSERT OR IGNORE INTO agent_action_outcomes
      (action_id, outcome_type, observed_at, window_seconds, attribution_strength, revenue_or_value, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.actionId,
      input.outcomeType,
      observedAt,
      input.windowSeconds ?? GROWTH_POLICY.DEFAULT_OUTCOME_WINDOW_SECONDS,
      input.attributionStrength ?? 'observed',
      input.revenueOrValue ?? null,
      JSON.stringify(input.evidence ?? {}),
      now(),
    ],
  );
  await execute(
    env.DB,
    `UPDATE agent_actions SET status = ?, outcome_json = ?, updated_at = ? WHERE action_id = ?`,
    [AGENT_ACTION_STATUS.OUTCOME_OBSERVED, stableStringify(input.evidence ?? {}), now(), input.actionId],
  );
  await recordAgentActionEvent(env, input.actionId, AGENT_ACTION_EVENT.OUTCOME_OBSERVED, {
    outcomeType: input.outcomeType,
    observedAt,
  });
}