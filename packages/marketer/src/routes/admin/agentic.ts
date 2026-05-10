import type { Env } from '../../types';
import { AGENT_ACTION_EVENT, AGENT_ACTION_STATUS, AGENT_ACTION_TYPE, GROWTH_POLICY } from '../../constants';
import { createAiEngineClient } from '../../lib/ai-engine/client';
import { execute, now, query, queryOne } from '../../lib/db';
import { listGrowthSignals } from '../../lib/growth/signals';
import { attributeAgentActionOutcomes, markStaleAgentActions } from '../../lib/growth/outcomes';
import { recordAgentActionEvent } from '../../lib/growth/actions';
import { evaluateGrowthPolicy } from '../../lib/growth/policy';
import { isRecord } from '../../lib/growth/common';
import { badRequest, notFound, ok, serverError } from '../../lib/response';

function parseWindowDays(request: Request, fallback = 30): number {
  const url = new URL(request.url);
  const raw = Number.parseInt(url.searchParams.get('windowDays') ?? String(fallback), 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 365) : fallback;
}

function parseLimit(request: Request, fallback: number = GROWTH_POLICY.DEFAULT_LIST_LIMIT): number {
  const url = new URL(request.url);
  const raw = Number.parseInt(url.searchParams.get('limit') ?? String(fallback), 10);
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 1), GROWTH_POLICY.MAX_LIST_LIMIT) : fallback;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export async function handleAdminAgenticSignals(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const signals = await listGrowthSignals(env, {
    tenantId: url.searchParams.get('tenantId'),
    status: url.searchParams.get('status') ?? undefined,
    subjectId: url.searchParams.get('subjectId') ?? undefined,
    subjectType: url.searchParams.get('subjectType') ?? undefined,
    signalType: url.searchParams.get('signalType') ?? undefined,
    severity: url.searchParams.get('severity') ?? undefined,
    includeExpired: url.searchParams.get('includeExpired') === 'true',
    limit: parseLimit(request),
  });

  const lifecycle = await query<{ status: string; count: number }>(
    env.DB,
    `SELECT status, COUNT(*) AS count
       FROM growth_signals
      WHERE tenant_id = ?
      GROUP BY status
      ORDER BY count DESC`,
    [url.searchParams.get('tenantId') ?? 'default'],
  );

  return ok({ signals, count: signals.length, lifecycle });
}

export async function handleAdminAgenticPerformance(request: Request, env: Env): Promise<Response> {
  const windowDays = parseWindowDays(request);
  const sinceEpoch = now() - windowDays * 86_400;

  try {
    const [statusCounts, actionTypeCounts, riskCounts, outcomeCounts, channelCorrelations, emailCorrelations, recentBlocks] = await Promise.all([
      query<{ status: string; count: number }>(
        env.DB,
        `SELECT status, COUNT(*) AS count
           FROM agent_actions
          WHERE created_at >= ?
          GROUP BY status
          ORDER BY count DESC`,
        [sinceEpoch],
      ),
      query<{ proposed_action: string; count: number }>(
        env.DB,
        `SELECT proposed_action, COUNT(*) AS count
           FROM agent_actions
          WHERE created_at >= ?
          GROUP BY proposed_action
          ORDER BY count DESC`,
        [sinceEpoch],
      ),
      query<{ risk_level: string; count: number }>(
        env.DB,
        `SELECT risk_level, COUNT(*) AS count
           FROM agent_actions
          WHERE created_at >= ?
          GROUP BY risk_level
          ORDER BY count DESC`,
        [sinceEpoch],
      ),
      query<{ outcome_type: string; count: number; value_cents: number | null }>(
        env.DB,
        `SELECT outcome_type, COUNT(*) AS count, SUM(revenue_or_value) AS value_cents
           FROM agent_action_outcomes
          WHERE observed_at >= ?
          GROUP BY outcome_type
          ORDER BY count DESC`,
        [sinceEpoch],
      ),
      query<{ action_id: string; proposed_action: string; outbox_rows: number; dispatched_rows: number; failed_rows: number }>(
        env.DB,
        `SELECT aa.action_id, aa.proposed_action,
                COUNT(ceo.id) AS outbox_rows,
                SUM(CASE WHEN ceo.status = 'dispatched' THEN 1 ELSE 0 END) AS dispatched_rows,
                SUM(CASE WHEN ceo.status = 'failed' THEN 1 ELSE 0 END) AS failed_rows
           FROM agent_actions aa
      LEFT JOIN channel_execution_outbox ceo
             ON json_extract(ceo.payload_json, '$.context.agentActionId') = aa.action_id
          WHERE aa.created_at >= ?
          GROUP BY aa.action_id, aa.proposed_action
         HAVING outbox_rows > 0
          ORDER BY aa.created_at DESC
          LIMIT 50`,
        [sinceEpoch],
      ),
      query<{ action_id: string; subject_id: string; email_sends: number; opened: number; clicked: number; replied: number }>(
        env.DB,
        `SELECT aa.action_id, aa.subject_id,
                COUNT(es.id) AS email_sends,
                SUM(CASE WHEN es.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
                SUM(CASE WHEN es.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
                SUM(CASE WHEN es.replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied
           FROM agent_actions aa
      LEFT JOIN email_sends es
             ON lower(es.contact_email) = lower(aa.subject_id)
            AND es.created_at >= aa.created_at
            AND (aa.outcome_due_at IS NULL OR es.created_at <= aa.outcome_due_at)
          WHERE aa.created_at >= ?
          GROUP BY aa.action_id, aa.subject_id
         HAVING email_sends > 0
          ORDER BY aa.created_at DESC
          LIMIT 50`,
        [sinceEpoch],
      ),
      query<{ action_id: string; subject_id: string; proposed_action: string; risk_level: string; confidence: number; policy_result_json: string; created_at: number }>(
        env.DB,
        `SELECT action_id, subject_id, proposed_action, risk_level, confidence, policy_result_json, created_at
           FROM agent_actions
          WHERE created_at >= ? AND status = ?
          ORDER BY created_at DESC
          LIMIT 25`,
        [sinceEpoch, AGENT_ACTION_STATUS.REJECTED],
      ),
    ]);

    return ok({
      windowDays,
      statusCounts,
      actionTypeCounts,
      riskCounts,
      outcomeCounts,
      channelCorrelations,
      emailCorrelations,
      recentBlocks,
    });
  } catch (err) {
    console.error('[Admin] handleAdminAgenticPerformance error:', err);
    return serverError('Failed to load agentic performance');
  }
}

export async function handleApproveAgentAction(request: Request, env: Env, actionId: string): Promise<Response> {
  let body: Record<string, unknown> = {};
  try { body = await request.json() as Record<string, unknown>; } catch { body = {}; }
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'admin';

  const action = await queryOne<{ action_id: string; status: string; policy_result_json: string }>(
    env.DB,
    `SELECT action_id, status, policy_result_json FROM agent_actions WHERE action_id = ? LIMIT 1`,
    [actionId],
  );
  if (!action) return notFound('Agent action not found');
  if (action.status === AGENT_ACTION_STATUS.EXECUTED) return badRequest('Executed actions cannot be re-approved');

  await execute(
    env.DB,
    `UPDATE agent_actions SET status = ?, approved_at = COALESCE(approved_at, ?), updated_at = ? WHERE action_id = ?`,
    [AGENT_ACTION_STATUS.APPROVED, now(), now(), actionId],
  );
  await recordAgentActionEvent(env, actionId, AGENT_ACTION_EVENT.APPROVED, { manualApproval: true }, actor);
  return ok({ actionId, status: AGENT_ACTION_STATUS.APPROVED, actor });
}

export async function handleAgenticOutcomeExport(request: Request, env: Env): Promise<Response> {
  const limit = parseLimit(request, 50);
  const windowDays = parseWindowDays(request);
  const sinceEpoch = now() - windowDays * 86_400;
  const outcomes = await query(
    env.DB,
    `SELECT o.action_id, o.outcome_type, o.observed_at, o.window_seconds, o.attribution_strength, o.revenue_or_value, o.evidence_json,
            aa.proposed_action, aa.risk_level, aa.confidence, aa.ai_metadata_json
       FROM agent_action_outcomes o
  LEFT JOIN agent_actions aa ON aa.action_id = o.action_id
      WHERE o.observed_at >= ?
      ORDER BY o.observed_at DESC
      LIMIT ?`,
    [sinceEpoch, limit],
  );
  const aiResult = await createAiEngineClient(env).outcomeDiagnose({
    capability: 'growth-outcome-export',
    windowDays,
    outcomes,
  });
  return ok({ windowDays, exported: outcomes.length, aiEngineConfigured: Boolean(env.AI_ENGINE), aiResult });
}

export async function handleMarkStaleAgentActions(request: Request, env: Env): Promise<Response> {
  const result = await markStaleAgentActions(env, parseLimit(request, 100));
  return ok(result);
}

export async function handleAttributeAgentActionOutcomes(request: Request, env: Env): Promise<Response> {
  const result = await attributeAgentActionOutcomes(env, parseLimit(request, 100));
  return ok(result);
}

export async function handleAgentDecisionTrace(request: Request, env: Env, subjectId: string): Promise<Response> {
  const url = new URL(request.url);
  const tenantId = url.searchParams.get('tenantId') ?? 'default';
  const limit = parseLimit(request, 25);

  const traceRows = await query<{
    action_id: string;
    signal_id: string | null;
    proposed_action: string;
    status: string;
    risk_level: string;
    confidence: number;
    evidence_json: string;
    ai_metadata_json: string | null;
    policy_result_json: string;
    outcome_json: string | null;
    created_at: number;
    updated_at: number;
    event_count: number;
    last_outcome_type: string | null;
    last_outcome_at: number | null;
  }>(
    env.DB,
    `SELECT a.action_id,
            a.signal_id,
            a.proposed_action,
            a.status,
            a.risk_level,
            a.confidence,
            a.evidence_json,
            a.ai_metadata_json,
            a.policy_result_json,
            a.outcome_json,
            a.created_at,
            a.updated_at,
            (SELECT COUNT(*) FROM agent_action_events e WHERE e.action_id = a.action_id) AS event_count,
            (SELECT outcome_type FROM agent_action_outcomes o WHERE o.action_id = a.action_id ORDER BY observed_at DESC LIMIT 1) AS last_outcome_type,
            (SELECT observed_at FROM agent_action_outcomes o WHERE o.action_id = a.action_id ORDER BY observed_at DESC LIMIT 1) AS last_outcome_at
       FROM agent_actions a
      WHERE a.tenant_id = ?
        AND a.subject_id = ?
      ORDER BY a.created_at DESC
      LIMIT ?`,
    [tenantId, decodeURIComponent(subjectId), limit],
  );

  return ok({ tenantId, subjectId: decodeURIComponent(subjectId), trace: traceRows, count: traceRows.length });
}

export async function handleAdminAgenticQuality(request: Request, env: Env): Promise<Response> {
  const windowDays = parseWindowDays(request);
  const sinceEpoch = now() - windowDays * 86_400;
  const highConfidenceThreshold = GROWTH_POLICY.QUALITY_HIGH_CONFIDENCE_THRESHOLD;
  const reviewActionTypes = [
    AGENT_ACTION_TYPE.WAIT,
    AGENT_ACTION_TYPE.MANUAL_REVIEW,
    AGENT_ACTION_TYPE.ESCALATE_TO_HUMAN,
  ];

  const [
    totals,
    metadataRollup,
    approvals,
    policyBlocks,
    executedCostRollup,
    traceCompletenessRollup,
    aiMetadataByDimension,
    diversityQualityRollup,
    aggregateQuality,
    qualityByAction,
    conversionsByAction,
    recentQualityRisks,
  ] = await Promise.all([
    queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) AS count FROM agent_actions WHERE created_at >= ?`,
      [sinceEpoch],
    ),
    queryOne<{
      metadata_rows: number;
      fallback_count: number | null;
      token_estimate_total: number | null;
      cost_estimate_total: number | null;
      avg_latency_ms: number | null;
      missing_token_estimate_count: number | null;
      missing_cost_estimate_count: number | null;
    }>(
      env.DB,
      `SELECT COUNT(*) AS metadata_rows,
              SUM(CASE WHEN json_extract(ai_metadata_json, '$.fallback') = 1 THEN 1 ELSE 0 END) AS fallback_count,
              SUM(COALESCE(CAST(json_extract(ai_metadata_json, '$.tokenEstimate') AS REAL), 0)) AS token_estimate_total,
              SUM(COALESCE(CAST(json_extract(ai_metadata_json, '$.costEstimate') AS REAL), 0)) AS cost_estimate_total,
              ROUND(AVG(CAST(json_extract(ai_metadata_json, '$.latencyMs') AS REAL)), 2) AS avg_latency_ms,
              SUM(CASE WHEN json_extract(ai_metadata_json, '$.tokenEstimate') IS NULL THEN 1 ELSE 0 END) AS missing_token_estimate_count,
              SUM(CASE WHEN json_extract(ai_metadata_json, '$.costEstimate') IS NULL THEN 1 ELSE 0 END) AS missing_cost_estimate_count
         FROM agent_actions
        WHERE created_at >= ?
          AND ai_metadata_json IS NOT NULL`,
      [sinceEpoch],
    ),
    queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) AS count
         FROM agent_actions
        WHERE created_at >= ?
          AND status IN (?, ?)` ,
      [sinceEpoch, AGENT_ACTION_STATUS.APPROVED, AGENT_ACTION_STATUS.EXECUTED],
    ),
    queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) AS count
         FROM agent_actions
        WHERE created_at >= ?
          AND status = ?`,
      [sinceEpoch, AGENT_ACTION_STATUS.REJECTED],
    ),
    queryOne<{
      executed_action_count: number;
      executed_cost_estimate_total: number | null;
      executed_missing_cost_estimate_count: number | null;
    }>(
      env.DB,
      `SELECT COUNT(*) AS executed_action_count,
              SUM(COALESCE(CAST(json_extract(ai_metadata_json, '$.costEstimate') AS REAL), 0)) AS executed_cost_estimate_total,
              SUM(CASE WHEN ai_metadata_json IS NULL OR json_extract(ai_metadata_json, '$.costEstimate') IS NULL THEN 1 ELSE 0 END) AS executed_missing_cost_estimate_count
         FROM agent_actions
        WHERE created_at >= ?
          AND status IN (?, ?, ?)`,
      [
        sinceEpoch,
        AGENT_ACTION_STATUS.EXECUTED,
        AGENT_ACTION_STATUS.OUTCOME_OBSERVED,
        AGENT_ACTION_STATUS.NO_OUTCOME_OBSERVED,
      ],
    ),
    queryOne<{
      trace_rows: number;
      complete_trace_rows: number | null;
      metadata_present_count: number | null;
      prompt_version_present_count: number | null;
      schema_version_present_count: number | null;
      provider_model_or_fallback_present_count: number | null;
      route_reason_present_count: number | null;
      fallback_reason_present_count: number | null;
      policy_result_present_count: number | null;
      signal_summary_present_count: number | null;
      subject_context_present_count: number | null;
      outcome_summary_present_count: number | null;
    }>(
      env.DB,
      `SELECT COUNT(*) AS trace_rows,
              SUM(CASE WHEN ai_metadata_json IS NOT NULL THEN 1 ELSE 0 END) AS metadata_present_count,
              SUM(CASE WHEN json_extract(ai_metadata_json, '$.promptVersion') IS NOT NULL THEN 1 ELSE 0 END) AS prompt_version_present_count,
              SUM(CASE WHEN json_extract(ai_metadata_json, '$.responseSchemaVersion') IS NOT NULL THEN 1 ELSE 0 END) AS schema_version_present_count,
              SUM(CASE WHEN json_extract(ai_metadata_json, '$.fallback') = 1
                         OR (json_extract(ai_metadata_json, '$.provider') IS NOT NULL
                         AND json_extract(ai_metadata_json, '$.model') IS NOT NULL)
                       THEN 1 ELSE 0 END) AS provider_model_or_fallback_present_count,
              SUM(CASE WHEN json_extract(ai_metadata_json, '$.explanation') IS NOT NULL
                         OR json_extract(proposed_action_json, '$.reason') IS NOT NULL
                       THEN 1 ELSE 0 END) AS route_reason_present_count,
              SUM(CASE WHEN json_extract(ai_metadata_json, '$.fallback') != 1
                         OR json_extract(ai_metadata_json, '$.error') IS NOT NULL
                         OR json_extract(ai_metadata_json, '$.rawSummary.error') IS NOT NULL
                         OR json_extract(ai_metadata_json, '$.explanation') IS NOT NULL
                       THEN 1 ELSE 0 END) AS fallback_reason_present_count,
              SUM(CASE WHEN policy_result_json IS NOT NULL
                         AND json_extract(policy_result_json, '$.allowed') IS NOT NULL
                       THEN 1 ELSE 0 END) AS policy_result_present_count,
              SUM(CASE WHEN json_extract(evidence_json, '$.signalCount') IS NOT NULL
                         AND json_extract(evidence_json, '$.signalTypes') IS NOT NULL
                       THEN 1 ELSE 0 END) AS signal_summary_present_count,
              SUM(CASE WHEN json_extract(evidence_json, '$.subjectContext') IS NOT NULL THEN 1 ELSE 0 END) AS subject_context_present_count,
              SUM(CASE WHEN json_extract(evidence_json, '$.subjectContext.recentOutcomeTypes') IS NOT NULL THEN 1 ELSE 0 END) AS outcome_summary_present_count,
              SUM(CASE WHEN ai_metadata_json IS NOT NULL
                         AND json_extract(ai_metadata_json, '$.promptVersion') IS NOT NULL
                         AND json_extract(ai_metadata_json, '$.responseSchemaVersion') IS NOT NULL
                         AND (json_extract(ai_metadata_json, '$.fallback') = 1
                              OR (json_extract(ai_metadata_json, '$.provider') IS NOT NULL
                              AND json_extract(ai_metadata_json, '$.model') IS NOT NULL))
                         AND (json_extract(ai_metadata_json, '$.explanation') IS NOT NULL
                              OR json_extract(proposed_action_json, '$.reason') IS NOT NULL)
                         AND (json_extract(ai_metadata_json, '$.fallback') != 1
                              OR json_extract(ai_metadata_json, '$.error') IS NOT NULL
                              OR json_extract(ai_metadata_json, '$.rawSummary.error') IS NOT NULL
                              OR json_extract(ai_metadata_json, '$.explanation') IS NOT NULL)
                         AND policy_result_json IS NOT NULL
                         AND json_extract(policy_result_json, '$.allowed') IS NOT NULL
                         AND json_extract(evidence_json, '$.signalCount') IS NOT NULL
                         AND json_extract(evidence_json, '$.signalTypes') IS NOT NULL
                         AND json_extract(evidence_json, '$.subjectContext') IS NOT NULL
                         AND json_extract(evidence_json, '$.subjectContext.recentOutcomeTypes') IS NOT NULL
                       THEN 1 ELSE 0 END) AS complete_trace_rows
         FROM agent_actions
        WHERE created_at >= ?`,
      [sinceEpoch],
    ),
      query<{
        provider: string | null;
        model: string | null;
        prompt_version: string | null;
        response_schema_version: string | null;
        capability: string | null;
        fallback: number | null;
        proposals: number;
        token_estimate_total: number | null;
        cost_estimate_total: number | null;
        avg_latency_ms: number | null;
        missing_token_estimate_count: number | null;
        missing_cost_estimate_count: number | null;
      }>(
        env.DB,
        `SELECT json_extract(ai_metadata_json, '$.provider') AS provider,
                json_extract(ai_metadata_json, '$.model') AS model,
                json_extract(ai_metadata_json, '$.promptVersion') AS prompt_version,
                json_extract(ai_metadata_json, '$.responseSchemaVersion') AS response_schema_version,
                json_extract(ai_metadata_json, '$.capability') AS capability,
                CASE WHEN json_extract(ai_metadata_json, '$.fallback') = 1 THEN 1 ELSE 0 END AS fallback,
                COUNT(*) AS proposals,
                SUM(COALESCE(CAST(json_extract(ai_metadata_json, '$.tokenEstimate') AS REAL), 0)) AS token_estimate_total,
                SUM(COALESCE(CAST(json_extract(ai_metadata_json, '$.costEstimate') AS REAL), 0)) AS cost_estimate_total,
                ROUND(AVG(CAST(json_extract(ai_metadata_json, '$.latencyMs') AS REAL)), 2) AS avg_latency_ms,
                SUM(CASE WHEN json_extract(ai_metadata_json, '$.tokenEstimate') IS NULL THEN 1 ELSE 0 END) AS missing_token_estimate_count,
                SUM(CASE WHEN json_extract(ai_metadata_json, '$.costEstimate') IS NULL THEN 1 ELSE 0 END) AS missing_cost_estimate_count
           FROM agent_actions
          WHERE created_at >= ?
            AND ai_metadata_json IS NOT NULL
          GROUP BY provider, model, prompt_version, response_schema_version, capability, fallback
          ORDER BY proposals DESC`,
        [sinceEpoch],
      ),
      queryOne<{
        repeated_same_category_count: number | null;
        repeated_no_outcome_category_count: number | null;
        repeated_same_category_no_outcome_count: number | null;
      }>(
        env.DB,
        `SELECT SUM(CASE WHEN json_array_length(json_extract(evidence_json, '$.subjectContext.repeatedActionWarnings')) > 0 THEN 1 ELSE 0 END) AS repeated_same_category_count,
                SUM(CASE WHEN json_extract(evidence_json, '$.subjectContext.diversityRisk') = 'repeated_no_outcome' THEN 1 ELSE 0 END) AS repeated_no_outcome_category_count,
                SUM(CASE WHEN json_array_length(json_extract(evidence_json, '$.subjectContext.repeatedActionWarnings')) > 0
                           AND EXISTS (
                             SELECT 1 FROM agent_action_outcomes o
                              WHERE o.action_id = agent_actions.action_id
                                AND o.outcome_type = ?
                           )
                         THEN 1 ELSE 0 END) AS repeated_same_category_no_outcome_count
           FROM agent_actions
          WHERE created_at >= ?`,
        [AGENT_ACTION_STATUS.NO_OUTCOME_OBSERVED, sinceEpoch],
      ),
    queryOne<{
      proposals: number;
      high_confidence_proposals: number | null;
      positive_action_count: number | null;
      conversion_action_count: number | null;
      no_outcome_action_count: number | null;
      high_confidence_no_outcome: number | null;
      suppressed_or_reviewed_count: number | null;
      suppressed_positive_outcome_count: number | null;
    }>(
      env.DB,
      `SELECT COUNT(*) AS proposals,
              SUM(CASE WHEN confidence >= ? THEN 1 ELSE 0 END) AS high_confidence_proposals,
              SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM agent_action_outcomes o
                     WHERE o.action_id = agent_actions.action_id
                       AND o.outcome_type IN ('conversion', 'engagement')
                  ) THEN 1 ELSE 0 END) AS positive_action_count,
              SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM agent_action_outcomes o
                     WHERE o.action_id = agent_actions.action_id
                       AND o.outcome_type = 'conversion'
                  ) THEN 1 ELSE 0 END) AS conversion_action_count,
              SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM agent_action_outcomes o
                     WHERE o.action_id = agent_actions.action_id
                       AND o.outcome_type = ?
                  ) THEN 1 ELSE 0 END) AS no_outcome_action_count,
              SUM(CASE WHEN confidence >= ? AND EXISTS (
                    SELECT 1 FROM agent_action_outcomes o
                     WHERE o.action_id = agent_actions.action_id
                       AND o.outcome_type = ?
                  ) THEN 1 ELSE 0 END) AS high_confidence_no_outcome,
              SUM(CASE WHEN proposed_action IN (?, ?, ?) THEN 1 ELSE 0 END) AS suppressed_or_reviewed_count,
              SUM(CASE WHEN proposed_action IN (?, ?, ?) AND EXISTS (
                    SELECT 1 FROM agent_action_outcomes o
                     WHERE o.action_id = agent_actions.action_id
                       AND o.outcome_type IN ('conversion', 'engagement')
                  ) THEN 1 ELSE 0 END) AS suppressed_positive_outcome_count
         FROM agent_actions
        WHERE created_at >= ?`,
      [
        highConfidenceThreshold,
        AGENT_ACTION_STATUS.NO_OUTCOME_OBSERVED,
        highConfidenceThreshold,
        AGENT_ACTION_STATUS.NO_OUTCOME_OBSERVED,
        ...reviewActionTypes,
        ...reviewActionTypes,
        sinceEpoch,
      ],
    ),
    query<{
      proposed_action: string;
      avg_confidence: number;
      proposals: number;
      positive_outcomes: number;
      conversions: number;
      no_outcome_observed: number;
      high_confidence_proposals: number;
      high_confidence_no_outcome: number;
      repeated_same_category: number;
      repeated_no_outcome_category: number;
    }>(
      env.DB,
      `SELECT proposed_action,
              ROUND(AVG(confidence), 2) AS avg_confidence,
              COUNT(*) AS proposals,
              SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM agent_action_outcomes o
                     WHERE o.action_id = a.action_id
                       AND o.outcome_type IN ('conversion', 'engagement')
                  ) THEN 1 ELSE 0 END) AS positive_outcomes,
              SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM agent_action_outcomes o
                     WHERE o.action_id = a.action_id
                       AND o.outcome_type = 'conversion'
                  ) THEN 1 ELSE 0 END) AS conversions,
              SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM agent_action_outcomes o
                     WHERE o.action_id = a.action_id
                       AND o.outcome_type = ?
                  ) THEN 1 ELSE 0 END) AS no_outcome_observed,
              SUM(CASE WHEN confidence >= ? THEN 1 ELSE 0 END) AS high_confidence_proposals,
              SUM(CASE WHEN confidence >= ? AND EXISTS (
                    SELECT 1 FROM agent_action_outcomes o
                     WHERE o.action_id = a.action_id
                       AND o.outcome_type = ?
                  ) THEN 1 ELSE 0 END) AS high_confidence_no_outcome,
              SUM(CASE WHEN json_array_length(json_extract(evidence_json, '$.subjectContext.repeatedActionWarnings')) > 0 THEN 1 ELSE 0 END) AS repeated_same_category,
              SUM(CASE WHEN json_extract(evidence_json, '$.subjectContext.diversityRisk') = 'repeated_no_outcome' THEN 1 ELSE 0 END) AS repeated_no_outcome_category
         FROM agent_actions
           AS a
        WHERE created_at >= ?
        GROUP BY proposed_action
        ORDER BY proposals DESC`,
      [
        AGENT_ACTION_STATUS.NO_OUTCOME_OBSERVED,
        highConfidenceThreshold,
        highConfidenceThreshold,
        AGENT_ACTION_STATUS.NO_OUTCOME_OBSERVED,
        sinceEpoch,
      ],
    ),
    query<{ proposed_action: string; conversions: number }>(
      env.DB,
      `SELECT a.proposed_action, COUNT(*) AS conversions
         FROM agent_action_outcomes o
   INNER JOIN agent_actions a ON a.action_id = o.action_id
        WHERE o.outcome_type = 'conversion'
          AND o.observed_at >= ?
        GROUP BY a.proposed_action
        ORDER BY conversions DESC`,
      [sinceEpoch],
    ),
    query<{
      action_id: string;
      subject_id: string;
      proposed_action: string;
      status: string;
      confidence: number;
      created_at: number;
      ai_metadata_json: string | null;
      last_outcome_type: string | null;
    }>(
      env.DB,
      `SELECT action_id,
              subject_id,
              proposed_action,
              status,
              confidence,
              created_at,
              ai_metadata_json,
              (SELECT outcome_type
                 FROM agent_action_outcomes o
                WHERE o.action_id = agent_actions.action_id
                ORDER BY observed_at DESC
                LIMIT 1) AS last_outcome_type
         FROM agent_actions
        WHERE created_at >= ?
          AND (
            (confidence >= ? AND EXISTS (
              SELECT 1 FROM agent_action_outcomes o
               WHERE o.action_id = agent_actions.action_id
                 AND o.outcome_type = ?
            ))
            OR
            (proposed_action IN (?, ?, ?) AND EXISTS (
              SELECT 1 FROM agent_action_outcomes o
               WHERE o.action_id = agent_actions.action_id
                 AND o.outcome_type IN ('conversion', 'engagement')
            ))
            OR json_extract(ai_metadata_json, '$.fallback') = 1
          )
        ORDER BY created_at DESC
        LIMIT ?`,
      [
        sinceEpoch,
        highConfidenceThreshold,
        AGENT_ACTION_STATUS.NO_OUTCOME_OBSERVED,
        ...reviewActionTypes,
        GROWTH_POLICY.QUALITY_RISK_SAMPLE_LIMIT,
      ],
    ),
  ]);

  const totalProposals = totals?.count ?? 0;
  const metadataRows = metadataRollup?.metadata_rows ?? 0;
  const fallbackCount = metadataRollup?.fallback_count ?? 0;
  const acceptedCount = approvals?.count ?? 0;
  const blockedCount = policyBlocks?.count ?? 0;
  const positiveActionCount = aggregateQuality?.positive_action_count ?? 0;
  const noOutcomeActionCount = aggregateQuality?.no_outcome_action_count ?? 0;
  const highConfidenceProposals = aggregateQuality?.high_confidence_proposals ?? 0;
  const highConfidenceNoOutcome = aggregateQuality?.high_confidence_no_outcome ?? 0;
  const suppressedOrReviewedCount = aggregateQuality?.suppressed_or_reviewed_count ?? 0;
  const suppressedPositiveOutcomeCount = aggregateQuality?.suppressed_positive_outcome_count ?? 0;
  const tokenEstimateTotal = metadataRollup?.token_estimate_total ?? 0;
  const costEstimateTotal = metadataRollup?.cost_estimate_total ?? 0;
  const executedActionCount = executedCostRollup?.executed_action_count ?? 0;
  const executedCostEstimateTotal = executedCostRollup?.executed_cost_estimate_total ?? 0;
  const traceRows = traceCompletenessRollup?.trace_rows ?? 0;
  const completeTraceRows = traceCompletenessRollup?.complete_trace_rows ?? 0;
  const repeatedSameCategoryCount = diversityQualityRollup?.repeated_same_category_count ?? 0;
  const repeatedNoOutcomeCategoryCount = diversityQualityRollup?.repeated_no_outcome_category_count ?? 0;
  const repeatedSameCategoryNoOutcomeCount = diversityQualityRollup?.repeated_same_category_no_outcome_count ?? 0;

  const fallbackRate = rate(fallbackCount, totalProposals);
  const acceptanceRate = rate(acceptedCount, totalProposals);
  const policyBlockRate = rate(blockedCount, totalProposals);
  const metadataCompletenessRate = rate(metadataRows, totalProposals);
  const noOutcomeRate = rate(noOutcomeActionCount, totalProposals);
  const highConfidenceNoOutcomeRate = rate(highConfidenceNoOutcome, highConfidenceProposals);
  const suppressedPositiveOutcomeRate = rate(suppressedPositiveOutcomeCount, suppressedOrReviewedCount);

  const qualityByActionWithRates = qualityByAction.map((row) => ({
    ...row,
    positiveOutcomeRate: rate(row.positive_outcomes ?? 0, row.proposals),
    conversionRate: rate(row.conversions ?? 0, row.proposals),
    noOutcomeRate: rate(row.no_outcome_observed ?? 0, row.proposals),
    highConfidenceNoOutcomeRate: rate(row.high_confidence_no_outcome ?? 0, row.high_confidence_proposals ?? 0),
    repeatedSameCategoryRate: rate(row.repeated_same_category ?? 0, row.proposals),
    repeatedNoOutcomeCategoryRate: rate(row.repeated_no_outcome_category ?? 0, row.proposals),
  }));

  const aiMetadataByDimensionWithRates = aiMetadataByDimension.map((row) => ({
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    responseSchemaVersion: row.response_schema_version,
    capability: row.capability,
    fallback: row.fallback === 1,
    proposals: row.proposals,
    tokenEstimateTotal: row.token_estimate_total ?? 0,
    costEstimateTotal: row.cost_estimate_total ?? 0,
    avgLatencyMs: row.avg_latency_ms ?? null,
    avgTokensPerProposal: rate(row.token_estimate_total ?? 0, row.proposals),
    avgCostPerProposal: rate(row.cost_estimate_total ?? 0, row.proposals),
    missingTokenEstimateCount: row.missing_token_estimate_count ?? 0,
    missingCostEstimateCount: row.missing_cost_estimate_count ?? 0,
  }));

  return ok({
    windowDays,
    highConfidenceThreshold,
    totalProposals,
    metadataRows,
    metadataCompletenessRate,
    fallbackCount,
    fallbackRate,
    acceptedCount,
    acceptanceRate,
    blockedCount,
    policyBlockRate,
    tokenEstimateTotal,
    costEstimateTotal,
    avgLatencyMs: metadataRollup?.avg_latency_ms ?? null,
    avgTokensPerProposal: rate(tokenEstimateTotal, totalProposals),
    avgCostPerProposal: rate(costEstimateTotal, totalProposals),
    executedActionCount,
    executedCostEstimateTotal,
    costPerExecutedAction: rate(executedCostEstimateTotal, executedActionCount),
    executedMissingCostEstimateCount: executedCostRollup?.executed_missing_cost_estimate_count ?? 0,
    costPerPositiveOutcome: rate(costEstimateTotal, positiveActionCount),
    missingTokenEstimateCount: metadataRollup?.missing_token_estimate_count ?? 0,
    missingCostEstimateCount: metadataRollup?.missing_cost_estimate_count ?? 0,
    positiveActionCount,
    conversionActionCount: aggregateQuality?.conversion_action_count ?? 0,
    noOutcomeActionCount,
    noOutcomeRate,
    highConfidenceProposals,
    highConfidenceNoOutcome,
    highConfidenceNoOutcomeRate,
    falsePositiveProxy: {
      description: 'High-confidence proposals that later recorded no_outcome_observed.',
      count: highConfidenceNoOutcome,
      denominator: highConfidenceProposals,
      rate: highConfidenceNoOutcomeRate,
    },
    falseNegativeProxy: {
      description: 'Wait/manual_review/escalate_to_human proposals that later recorded conversion or engagement.',
      count: suppressedPositiveOutcomeCount,
      denominator: suppressedOrReviewedCount,
      rate: suppressedPositiveOutcomeRate,
    },
    aiMetadataByDimension: aiMetadataByDimensionWithRates,
    repeatedSameCategoryInterventions: {
      description: 'Proposals created when recent history already showed repeated action-category exposure for the subject.',
      count: repeatedSameCategoryCount,
      rate: rate(repeatedSameCategoryCount, totalProposals),
      repeatedNoOutcomeCategoryCount,
      repeatedNoOutcomeCategoryRate: rate(repeatedNoOutcomeCategoryCount, totalProposals),
      noOutcomeCount: repeatedSameCategoryNoOutcomeCount,
      noOutcomeRate: rate(repeatedSameCategoryNoOutcomeCount, repeatedSameCategoryCount),
    },
    traceCompleteness: {
      description: 'Proposal rows with enough structured metadata, policy, signal, subject, and outcome context for operator trace review.',
      rows: traceRows,
      completeRows: completeTraceRows,
      completeRate: rate(completeTraceRows, traceRows),
      present: {
        metadata: traceCompletenessRollup?.metadata_present_count ?? 0,
        promptVersion: traceCompletenessRollup?.prompt_version_present_count ?? 0,
        responseSchemaVersion: traceCompletenessRollup?.schema_version_present_count ?? 0,
        providerModelOrFallback: traceCompletenessRollup?.provider_model_or_fallback_present_count ?? 0,
        routeReason: traceCompletenessRollup?.route_reason_present_count ?? 0,
        fallbackReason: traceCompletenessRollup?.fallback_reason_present_count ?? 0,
        policyResult: traceCompletenessRollup?.policy_result_present_count ?? 0,
        signalSummary: traceCompletenessRollup?.signal_summary_present_count ?? 0,
        subjectContext: traceCompletenessRollup?.subject_context_present_count ?? 0,
        outcomeSummary: traceCompletenessRollup?.outcome_summary_present_count ?? 0,
      },
      missing: {
        metadata: traceRows - (traceCompletenessRollup?.metadata_present_count ?? 0),
        promptVersion: traceRows - (traceCompletenessRollup?.prompt_version_present_count ?? 0),
        responseSchemaVersion: traceRows - (traceCompletenessRollup?.schema_version_present_count ?? 0),
        providerModelOrFallback: traceRows - (traceCompletenessRollup?.provider_model_or_fallback_present_count ?? 0),
        routeReason: traceRows - (traceCompletenessRollup?.route_reason_present_count ?? 0),
        fallbackReason: traceRows - (traceCompletenessRollup?.fallback_reason_present_count ?? 0),
        policyResult: traceRows - (traceCompletenessRollup?.policy_result_present_count ?? 0),
        signalSummary: traceRows - (traceCompletenessRollup?.signal_summary_present_count ?? 0),
        subjectContext: traceRows - (traceCompletenessRollup?.subject_context_present_count ?? 0),
        outcomeSummary: traceRows - (traceCompletenessRollup?.outcome_summary_present_count ?? 0),
      },
    },
    confidenceByAction: qualityByActionWithRates.map((row) => ({
      proposed_action: row.proposed_action,
      avg_confidence: row.avg_confidence,
      proposals: row.proposals,
    })),
    qualityByAction: qualityByActionWithRates,
    conversionsByAction,
    recentQualityRisks,
  });
}

export async function handleOverrideAgentAction(request: Request, env: Env, actionId: string): Promise<Response> {
  let body: Record<string, unknown> = {};
  try { body = await request.json() as Record<string, unknown>; } catch { body = {}; }

  const action = await queryOne<{
    action_id: string;
    tenant_id: string;
    subject_id: string;
    status: string;
    risk_level: string;
    confidence: number;
  }>(
    env.DB,
    `SELECT action_id, tenant_id, subject_id, status, risk_level, confidence
       FROM agent_actions
      WHERE action_id = ?
      LIMIT 1`,
    [actionId],
  );
  if (!action) return notFound('Agent action not found');
  if (action.status === AGENT_ACTION_STATUS.EXECUTED) {
    return badRequest('Executed actions cannot be overridden');
  }

  const override = body.action;
  if (!isRecord(override) || typeof override.type !== 'string') {
    return badRequest('action override payload is required');
  }
  const replacement = {
    type: override.type,
    params: isRecord(override.params) ? override.params : {},
    reason: typeof override.reason === 'string' ? override.reason : undefined,
  };
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'operator';
  const reason = typeof body.reason === 'string' ? body.reason : 'manual override';

  const policyResult = await evaluateGrowthPolicy(env, {
    tenantId: action.tenant_id,
    subjectId: action.subject_id,
    action: replacement,
    riskLevel: action.risk_level,
    confidence: action.confidence,
    actionId,
  });
  const nextStatus = !policyResult.allowed
    ? AGENT_ACTION_STATUS.REJECTED
    : (policyResult.requiredApproval ? AGENT_ACTION_STATUS.POLICY_CHECKED : AGENT_ACTION_STATUS.APPROVED);

  await execute(
    env.DB,
    `UPDATE agent_actions
        SET proposed_action = ?,
            proposed_action_json = ?,
            policy_result_json = ?,
            status = ?,
            updated_at = ?,
            approved_at = CASE WHEN ? = 'approved' THEN COALESCE(approved_at, ?) ELSE approved_at END
      WHERE action_id = ?`,
    [
      replacement.type,
      JSON.stringify(replacement),
      JSON.stringify(policyResult),
      nextStatus,
      now(),
      nextStatus,
      now(),
      actionId,
    ],
  );

  await recordAgentActionEvent(env, actionId, AGENT_ACTION_EVENT.POLICY_CHECKED, {
    override: true,
    actor,
    reason,
    replacement,
    policyResult,
  }, actor);
  if (nextStatus === AGENT_ACTION_STATUS.APPROVED) {
    await recordAgentActionEvent(env, actionId, AGENT_ACTION_EVENT.APPROVED, {
      override: true,
      actor,
      reason,
    }, actor);
  }
  if (nextStatus === AGENT_ACTION_STATUS.REJECTED) {
    await recordAgentActionEvent(env, actionId, AGENT_ACTION_EVENT.REJECTED, {
      override: true,
      actor,
      reason,
      blockedReasons: policyResult.blockedReasons,
    }, actor);
  }

  return ok({ actionId, status: nextStatus, actor, reason, policyResult });
}