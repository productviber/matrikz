import type { Env } from '../../types';
import { AGENT_ACTION_EVENT, AGENT_ACTION_STATUS, GROWTH_POLICY } from '../../constants';
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

  const [
    totals,
    aiFallback,
    approvals,
    policyBlocks,
    confidenceByAction,
    conversionsByAction,
  ] = await Promise.all([
    queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) AS count FROM agent_actions WHERE created_at >= ?`,
      [sinceEpoch],
    ),
    queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) AS count
         FROM agent_actions
        WHERE created_at >= ?
          AND ai_metadata_json IS NOT NULL
          AND (ai_metadata_json LIKE '%"fallback":true%' OR ai_metadata_json LIKE '%"fallback": true%')`,
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
    query<{ proposed_action: string; avg_confidence: number; proposals: number }>(
      env.DB,
      `SELECT proposed_action,
              ROUND(AVG(confidence), 2) AS avg_confidence,
              COUNT(*) AS proposals
         FROM agent_actions
        WHERE created_at >= ?
        GROUP BY proposed_action
        ORDER BY proposals DESC`,
      [sinceEpoch],
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
  ]);

  const totalProposals = totals?.count ?? 0;
  const fallbackCount = aiFallback?.count ?? 0;
  const acceptedCount = approvals?.count ?? 0;
  const blockedCount = policyBlocks?.count ?? 0;
  const fallbackRate = totalProposals > 0 ? fallbackCount / totalProposals : 0;
  const acceptanceRate = totalProposals > 0 ? acceptedCount / totalProposals : 0;
  const policyBlockRate = totalProposals > 0 ? blockedCount / totalProposals : 0;

  return ok({
    windowDays,
    totalProposals,
    fallbackCount,
    fallbackRate,
    acceptedCount,
    acceptanceRate,
    blockedCount,
    policyBlockRate,
    confidenceByAction,
    conversionsByAction,
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