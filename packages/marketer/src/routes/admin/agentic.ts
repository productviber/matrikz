import type { Env } from '../../types';
import { AGENT_ACTION_EVENT, AGENT_ACTION_STATUS, GROWTH_POLICY } from '../../constants';
import { createAiEngineClient } from '../../lib/ai-engine/client';
import { execute, now, query, queryOne } from '../../lib/db';
import { listGrowthSignals } from '../../lib/growth/signals';
import { markStaleAgentActions } from '../../lib/growth/outcomes';
import { recordAgentActionEvent } from '../../lib/growth/actions';
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