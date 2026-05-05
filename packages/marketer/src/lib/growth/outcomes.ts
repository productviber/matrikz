import type { AgentActionRow, Env } from '../../types';
import { AGENT_ACTION_EVENT, AGENT_ACTION_STATUS, AGENT_ACTION_TYPE, GROWTH_POLICY } from '../../constants';
import { execute, now, query, queryOne } from '../db';
import { recordAgentActionEvent, recordAgentActionOutcome } from './actions';
import { sendOutcomeFeedback } from './feedbackClient';

export interface StaleSubjectReview {
  tenantId: string;
  subjectId: string;
  originalActionType: string;
  actionId: string;
}

export interface StaleActionReviewResult {
  scanned: number;
  marked: number;
  actionIds: string[];
  /**
   * Subjects whose actions were marked no_outcome_observed. The cron job
   * may use this list to trigger a fresh signal evaluation cycle for each
   * subject, enabling the agent to reconsider after a failed intervention.
   *
   * Callers must respect frequency caps — re-evaluation does not bypass
   * the policy engine's action window or daily budget guards.
   */
  subjectsForReview: StaleSubjectReview[];
}

export interface OutcomeAttributionResult {
  scanned: number;
  attributed: number;
  conversionAttributed: number;
  engagementAttributed: number;
  actionIds: string[];
}

function attributionStrength(actionCreatedAt: number, observedAt: number): string {
  const delta = Math.max(0, observedAt - actionCreatedAt);
  if (delta <= 6 * 60 * 60) return 'strong_time_proximity';
  if (delta <= 24 * 60 * 60) return 'moderate_time_proximity';
  return 'weak_time_proximity';
}

async function readConversionObservedAt(
  env: Env,
  subjectId: string,
  createdAt: number,
  dueAt: number | null,
): Promise<number | null> {
  const row = await queryOne<{ converted_at: number | null }>(
    env.DB,
    `SELECT converted_at
       FROM marketing_contacts
      WHERE lower(email) = lower(?)
        AND converted_at IS NOT NULL
        AND converted_at >= ?
        AND (? IS NULL OR converted_at <= ?)
      ORDER BY converted_at ASC
      LIMIT 1`,
    [subjectId, createdAt, dueAt, dueAt],
  );
  return row?.converted_at ?? null;
}

async function readEmailEngagementObservedAt(
  env: Env,
  subjectId: string,
  createdAt: number,
  dueAt: number | null,
): Promise<number | null> {
  const row = await queryOne<{ observed_at: number | null }>(
    env.DB,
    `SELECT MIN(COALESCE(clicked_at, opened_at, replied_at)) AS observed_at
       FROM email_sends
      WHERE lower(contact_email) = lower(?)
        AND created_at >= ?
        AND (? IS NULL OR created_at <= ?)
        AND (clicked_at IS NOT NULL OR opened_at IS NOT NULL OR replied_at IS NOT NULL)`,
    [subjectId, createdAt, dueAt, dueAt],
  );
  return row?.observed_at ?? null;
}

async function readSkripEngagementObservedAt(
  env: Env,
  actionId: string,
  createdAt: number,
  dueAt: number | null,
): Promise<{ observedAt: number | null; status: string | null; channel: string | null }> {
  const row = await queryOne<{ observed_at: number | null; status: string | null; channel: string | null }>(
    env.DB,
    `SELECT MAX(l.last_outcome_at) AS observed_at,
            MAX(l.latest_status) AS status,
            MAX(l.channel) AS channel
       FROM channel_execution_outbox o
  LEFT JOIN channel_message_lineage l
         ON l.tenant_id = o.tenant_id
        AND l.campaign_id = o.campaign_id
        AND l.step_id = o.step_id
        AND l.contact_id = o.contact_id
        AND l.channel = o.channel
      WHERE json_extract(o.payload_json, '$.context.agentActionId') = ?
        AND o.created_at >= ?
        AND (? IS NULL OR o.created_at <= ?)
        AND l.last_outcome_at IS NOT NULL
        AND l.latest_status IN (
          'message.delivered', 'message.opened', 'message.clicked', 'message.replied',
          'delivered', 'opened', 'clicked', 'replied'
        )`,
    [actionId, createdAt, dueAt, dueAt],
  );
  return {
    observedAt: row?.observed_at ?? null,
    status: row?.status ?? null,
    channel: row?.channel ?? null,
  };
}

export async function markStaleAgentActions(
  env: Env,
  limit: number = GROWTH_POLICY.DEFAULT_LIST_LIMIT,
): Promise<StaleActionReviewResult> {
  const epoch = now();
  const rows = await query<Pick<AgentActionRow, 'action_id' | 'tenant_id' | 'subject_id' | 'proposed_action' | 'outcome_due_at' | 'correlation_id' | 'ai_metadata_json'>>(
    env.DB,
    `SELECT action_id, tenant_id, subject_id, proposed_action, outcome_due_at, correlation_id, ai_metadata_json
       FROM agent_actions
      WHERE status = ?
        AND outcome_due_at IS NOT NULL
        AND outcome_due_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM agent_action_outcomes o WHERE o.action_id = agent_actions.action_id
        )
      ORDER BY outcome_due_at ASC
      LIMIT ?`,
    [AGENT_ACTION_STATUS.EXECUTED, epoch, Math.max(1, Math.min(limit, GROWTH_POLICY.MAX_LIST_LIMIT))],
  );

  const actionIds: string[] = [];
  const subjectsForReview: StaleSubjectReview[] = [];

  for (const row of rows) {
    await execute(
      env.DB,
      `INSERT OR IGNORE INTO agent_action_outcomes
        (action_id, outcome_type, observed_at, window_seconds, attribution_strength, revenue_or_value, evidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        row.action_id,
        AGENT_ACTION_STATUS.NO_OUTCOME_OBSERVED,
        epoch,
        GROWTH_POLICY.DEFAULT_OUTCOME_WINDOW_SECONDS,
        'none',
        JSON.stringify({ reason: 'outcome_window_elapsed', outcomeDueAt: row.outcome_due_at }),
        epoch,
      ],
    );
    await execute(
      env.DB,
      `UPDATE agent_actions SET status = ?, outcome_json = ?, updated_at = ? WHERE action_id = ?`,
      [
        AGENT_ACTION_STATUS.NO_OUTCOME_OBSERVED,
        JSON.stringify({ outcomeType: AGENT_ACTION_STATUS.NO_OUTCOME_OBSERVED, observedAt: epoch }),
        epoch,
        row.action_id,
      ],
    );
    await recordAgentActionEvent(env, row.action_id, AGENT_ACTION_EVENT.NO_OUTCOME_OBSERVED, {
      outcomeDueAt: row.outcome_due_at,
      observedAt: epoch,
    }, 'cron');
    const aiMeta = row.ai_metadata_json ? JSON.parse(row.ai_metadata_json) as Record<string, unknown> : null;
    const agentCorrelationId = typeof aiMeta?.correlationId === 'string' ? aiMeta.correlationId : null;
    if (agentCorrelationId && row.tenant_id) {
      void sendOutcomeFeedback(env, {
        correlationId: agentCorrelationId,
        tenantId: row.tenant_id,
        subjectId: row.subject_id,
        actionTaken: row.proposed_action,
        outcomeMetric: 'no_response',
        observedAt: new Date(epoch * 1000).toISOString(),
      }).catch(() => { /* non-fatal */ });
    }
    actionIds.push(row.action_id);
    subjectsForReview.push({
      tenantId: row.tenant_id ?? '',
      subjectId: row.subject_id,
      originalActionType: row.proposed_action,
      actionId: row.action_id,
    });
  }

  return { scanned: rows.length, marked: actionIds.length, actionIds, subjectsForReview };
}

/**
 * B3: Attribute outcome evidence back to executed agent actions.
 *
 * Attribution paths:
 * - enroll_sequence -> marketing_contacts.converted_at (conversion) and
 *   email_sends engagement fields (opened/clicked/replied)
 * - send_via_skrip -> channel_execution_outbox + channel_message_lineage
 *   for delivery/engagement status, plus marketing_contacts conversion checks
 */
export async function attributeAgentActionOutcomes(
  env: Env,
  limit: number = GROWTH_POLICY.DEFAULT_LIST_LIMIT,
): Promise<OutcomeAttributionResult> {
  const max = Math.max(1, Math.min(limit, GROWTH_POLICY.MAX_LIST_LIMIT));
  const rows = await query<Pick<AgentActionRow, 'action_id' | 'tenant_id' | 'subject_id' | 'proposed_action' | 'created_at' | 'outcome_due_at' | 'correlation_id' | 'ai_metadata_json'>>(
    env.DB,
    `SELECT action_id, tenant_id, subject_id, proposed_action, created_at, outcome_due_at, correlation_id, ai_metadata_json
       FROM agent_actions a
      WHERE a.proposed_action IN (?, ?)
        AND a.status IN (?, ?)
        AND NOT EXISTS (
          SELECT 1
            FROM agent_action_outcomes o
           WHERE o.action_id = a.action_id
             AND o.outcome_type IN ('conversion', 'engagement')
        )
      ORDER BY a.created_at DESC
      LIMIT ?`,
    [
      AGENT_ACTION_TYPE.ENROLL_SEQUENCE,
      AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
      AGENT_ACTION_STATUS.EXECUTED,
      AGENT_ACTION_STATUS.OUTCOME_OBSERVED,
      max,
    ],
  );

  let attributed = 0;
  let conversionAttributed = 0;
  let engagementAttributed = 0;
  const actionIds: string[] = [];

  for (const row of rows) {
    const aiMeta = row.ai_metadata_json ? JSON.parse(row.ai_metadata_json) as Record<string, unknown> : null;
    const agentCorrelationId = typeof aiMeta?.correlationId === 'string' ? aiMeta.correlationId : null;

    const conversionObservedAt = await readConversionObservedAt(env, row.subject_id, row.created_at, row.outcome_due_at);
    if (conversionObservedAt) {
      await recordAgentActionOutcome(env, {
        actionId: row.action_id,
        outcomeType: 'conversion',
        observedAt: conversionObservedAt,
        attributionStrength: attributionStrength(row.created_at, conversionObservedAt),
        evidence: {
          source: 'outcome_attribution',
          pathway: row.proposed_action === AGENT_ACTION_TYPE.ENROLL_SEQUENCE ? 'email_sequence' : 'skrip_orchestrated',
          tenantId: row.tenant_id,
          subjectId: row.subject_id,
        },
      });
      if (agentCorrelationId && row.tenant_id) {
        void sendOutcomeFeedback(env, {
          correlationId: agentCorrelationId,
          tenantId: row.tenant_id,
          subjectId: row.subject_id,
          actionTaken: row.proposed_action,
          outcomeMetric: 'converted',
          observedAt: new Date(conversionObservedAt * 1000).toISOString(),
        }).catch(() => { /* non-fatal */ });
      }
      attributed++;
      conversionAttributed++;
      actionIds.push(row.action_id);
      continue;
    }

    if (row.proposed_action === AGENT_ACTION_TYPE.ENROLL_SEQUENCE) {
      const engagementObservedAt = await readEmailEngagementObservedAt(env, row.subject_id, row.created_at, row.outcome_due_at);
      if (engagementObservedAt) {
        await recordAgentActionOutcome(env, {
          actionId: row.action_id,
          outcomeType: 'engagement',
          observedAt: engagementObservedAt,
          attributionStrength: attributionStrength(row.created_at, engagementObservedAt),
          evidence: {
            source: 'outcome_attribution',
            pathway: 'email_sequence',
            engagementType: 'email_open_or_click_or_reply',
            tenantId: row.tenant_id,
            subjectId: row.subject_id,
          },
        });
        if (agentCorrelationId && row.tenant_id) {
          void sendOutcomeFeedback(env, {
            correlationId: agentCorrelationId,
            tenantId: row.tenant_id,
            subjectId: row.subject_id,
            actionTaken: row.proposed_action,
            outcomeMetric: 'opened',
            observedAt: new Date(engagementObservedAt * 1000).toISOString(),
          }).catch(() => { /* non-fatal */ });
        }
        attributed++;
        engagementAttributed++;
        actionIds.push(row.action_id);
      }
      continue;
    }

    const skrip = await readSkripEngagementObservedAt(env, row.action_id, row.created_at, row.outcome_due_at);
    if (skrip.observedAt) {
      await recordAgentActionOutcome(env, {
        actionId: row.action_id,
        outcomeType: 'engagement',
        observedAt: skrip.observedAt,
        attributionStrength: attributionStrength(row.created_at, skrip.observedAt),
        evidence: {
          source: 'outcome_attribution',
          pathway: 'skrip_lineage',
          lineageStatus: skrip.status,
          channel: skrip.channel,
          tenantId: row.tenant_id,
          subjectId: row.subject_id,
        },
      });
      if (agentCorrelationId && row.tenant_id) {
        const skripMetric =
          skrip.status === 'message.clicked' || skrip.status === 'clicked' ? 'clicked' :
          skrip.status === 'message.opened' || skrip.status === 'opened' ? 'opened' :
          'delivered';
        void sendOutcomeFeedback(env, {
          correlationId: agentCorrelationId,
          tenantId: row.tenant_id,
          subjectId: row.subject_id,
          actionTaken: row.proposed_action,
          outcomeMetric: skripMetric,
          observedAt: new Date(skrip.observedAt * 1000).toISOString(),
        }).catch(() => { /* non-fatal */ });
      }
      attributed++;
      engagementAttributed++;
      actionIds.push(row.action_id);
    }
  }

  return {
    scanned: rows.length,
    attributed,
    conversionAttributed,
    engagementAttributed,
    actionIds,
  };
}