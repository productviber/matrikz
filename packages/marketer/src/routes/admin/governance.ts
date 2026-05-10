import type { Env } from '../../types';
import { query } from '../../lib/db';
import { ok, badRequest, serverError } from '../../lib/response';
import { parsePositiveIntParam } from './admin-lib';
import { resolveGovernanceMode, buildGovernancePolicyInfo } from '../../lib/governance-ingress';
import { resolveGovernanceExecutionMode } from '../../lib/governance-execution-client';
import { KV_PREFIX, GOVERNANCE_INGRESS_MODE } from '../../constants';

interface GovernanceSummaryRow {
  total: number;
  allowed_count: number;
  blocked_count: number;
  observed_count: number;
  bypassed_count: number;
  duplicate_suppressed_count: number;
  violation_count: number;
}

interface SourceBreakdownRow {
  source: string;
  count: number;
}

/**
 * GET /api/admin/governance/ingress-slo
 *
 * Query params:
 *   hours      lookback window, default 24, max 720 (30 days)
 *   tenantId   optional tenant scope filter
 *   source     optional authority_source filter
 *   reason     optional reason filter
 *   mode       optional governance_mode filter
 *   actionType optional action_type filter
 */
export async function handleGovernanceIngressSlo(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const hours = parsePositiveIntParam(url.searchParams.get('hours'), 24, 720);
    const tenantId = url.searchParams.get('tenantId')?.trim() || null;
    const source = url.searchParams.get('source')?.trim() || null;
    const reason = url.searchParams.get('reason')?.trim() || null;
    const mode = url.searchParams.get('mode')?.trim() || null;
    const actionType = url.searchParams.get('actionType')?.trim() || null;
    const since = Math.floor(Date.now() / 1000) - (hours * 3600);

    const where: string[] = ['recorded_at >= ?'];
    const params: unknown[] = [since];
    if (tenantId) {
      where.push('tenant_scope = ?');
      params.push(tenantId);
    }
    if (source) {
      where.push('authority_source = ?');
      params.push(source);
    }
    if (reason) {
      where.push('reason = ?');
      params.push(reason);
    }
    if (mode) {
      where.push('governance_mode = ?');
      params.push(mode);
    }
    if (actionType) {
      where.push('action_type = ?');
      params.push(actionType);
    }

    const summaryRows = await query<GovernanceSummaryRow>(
      env.DB,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN allowed = 1 THEN 1 ELSE 0 END) AS allowed_count,
              SUM(CASE WHEN enforcement_outcome = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
              SUM(CASE WHEN enforcement_outcome = 'observed' THEN 1 ELSE 0 END) AS observed_count,
              SUM(CASE WHEN enforcement_outcome = 'bypassed' THEN 1 ELSE 0 END) AS bypassed_count,
              SUM(CASE WHEN enforcement_outcome = 'duplicate_suppressed' THEN 1 ELSE 0 END) AS duplicate_suppressed_count,
              SUM(CASE WHEN violation = 1 THEN 1 ELSE 0 END) AS violation_count
         FROM governance_ingress_decisions
        WHERE ${where.join(' AND ')}`,
      params,
    );

    const sourceRows = await query<SourceBreakdownRow>(
      env.DB,
      `SELECT COALESCE(authority_source, 'absent_or_legacy') AS source,
              COUNT(*) AS count
         FROM governance_ingress_decisions
        WHERE ${where.join(' AND ')}
        GROUP BY COALESCE(authority_source, 'absent_or_legacy')
        ORDER BY count DESC`,
      params,
    );

    const reasonRows = await query<SourceBreakdownRow>(
      env.DB,
      `SELECT reason AS source,
              COUNT(*) AS count
         FROM governance_ingress_decisions
        WHERE ${where.join(' AND ')}
        GROUP BY reason
        ORDER BY count DESC`,
      params,
    );

    const outcomeRows = await query<SourceBreakdownRow>(
      env.DB,
      `SELECT enforcement_outcome AS source,
              COUNT(*) AS count
         FROM governance_ingress_decisions
        WHERE ${where.join(' AND ')}
        GROUP BY enforcement_outcome
        ORDER BY count DESC`,
      params,
    );

    const summary = summaryRows[0] ?? {
      total: 0,
      allowed_count: 0,
      blocked_count: 0,
      observed_count: 0,
      bypassed_count: 0,
      duplicate_suppressed_count: 0,
      violation_count: 0,
    };

    const denominator = Math.max(1, summary.total);
    const passRate = summary.allowed_count / denominator;

    return ok({
      window: {
        hours,
        since,
        sinceIso: new Date(since * 1000).toISOString(),
      },
      scope: {
        tenantId,
        source,
        reason,
        mode,
        actionType,
      },
      totals: {
        events: summary.total,
        allowed: summary.allowed_count,
        blocked: summary.blocked_count,
        observed: summary.observed_count,
        bypassed: summary.bypassed_count,
        duplicateSuppressed: summary.duplicate_suppressed_count,
        violations: summary.violation_count,
      },
      rates: {
        passRate,
        violationRate: summary.violation_count / denominator,
        blockedRate: summary.blocked_count / denominator,
      },
      sourceDistribution: sourceRows.reduce<Record<string, number>>((acc, row) => {
        acc[row.source] = row.count;
        return acc;
      }, {}),
      reasonDistribution: reasonRows.reduce<Record<string, number>>((acc, row) => {
        acc[row.source] = row.count;
        return acc;
      }, {}),
      enforcementOutcomeDistribution: outcomeRows.reduce<Record<string, number>>((acc, row) => {
        acc[row.source] = row.count;
        return acc;
      }, {}),
    });
  } catch (err) {
    console.error('[Admin] handleGovernanceIngressSlo error:', err);
    return serverError('Failed to load governance ingress SLO');
  }
}

/**
 * GET /api/admin/governance/enforcement-status
 *
 * Returns the current active governance mode (including any KV override),
 * the parsed policy configuration, and the raw env var values for audit.
 */
export async function handleGovernanceEnforcementStatus(
  _request: Request,
  env: Env,
): Promise<Response> {
  try {
    const kvOverrideRaw = await env.KV_MARKETING.get(KV_PREFIX.GOVERNANCE_MODE_OVERRIDE).catch(() => null);
    const activeMode = await resolveGovernanceMode(env);
    const policyInfo = buildGovernancePolicyInfo(env);

    return ok({
      activeMode,
      kvOverride: kvOverrideRaw ?? null,
      envMode: env.GOVERNANCE_INGRESS_MODE ?? null,
      policy: policyInfo,
      overrideActive: kvOverrideRaw !== null && kvOverrideRaw !== undefined,
    });
  } catch (err) {
    console.error('[Admin] handleGovernanceEnforcementStatus error:', err);
    return serverError('Failed to load governance enforcement status');
  }
}

/**
 * POST /api/admin/governance/mode-override
 * Body: { "mode": "off" | "observe" | "enforce" }
 *
 * Writes a KV-based emergency mode override that takes precedence over the
 * GOVERNANCE_INGRESS_MODE env var. Survives without redeployment.
 * TTL: 7 days (604800 seconds). Re-posting resets the TTL.
 *
 * DELETE /api/admin/governance/mode-override
 *
 * Clears the KV override, reverting to the env var.
 */
export async function handleGovernanceModeOverride(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method === 'DELETE') {
    try {
      await env.KV_MARKETING.delete(KV_PREFIX.GOVERNANCE_MODE_OVERRIDE);
      return ok({ cleared: true, activeMode: env.GOVERNANCE_INGRESS_MODE ?? 'off' });
    } catch (err) {
      console.error('[Admin] handleGovernanceModeOverride DELETE error:', err);
      return serverError('Failed to clear governance mode override');
    }
  }

  // POST
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  if (typeof body !== 'object' || body === null || !('mode' in body)) {
    return badRequest('Request body must include a "mode" field');
  }

  const mode = (body as Record<string, unknown>).mode;
  const VALID_MODES = [GOVERNANCE_INGRESS_MODE.OFF, GOVERNANCE_INGRESS_MODE.OBSERVE, GOVERNANCE_INGRESS_MODE.ENFORCE];
  if (typeof mode !== 'string' || !VALID_MODES.includes(mode as never)) {
    return badRequest(`"mode" must be one of: ${VALID_MODES.join(', ')}`);
  }

  try {
    // TTL: 7 days — forces re-confirmation if forgotten, preventing stale overrides
    await env.KV_MARKETING.put(KV_PREFIX.GOVERNANCE_MODE_OVERRIDE, mode, { expirationTtl: 604800 });
    return ok({ overrideSet: true, mode, expiresInSeconds: 604800 });
  } catch (err) {
    console.error('[Admin] handleGovernanceModeOverride POST error:', err);
    return serverError('Failed to set governance mode override');
  }
}

/**
 * GET /api/admin/governance/execution-slo
 *
 * SLO summary for execution-path governance decisions.
 * Query params:
 *   hours      lookback window, default 24, max 720
 *   tenantId   optional tenant scope filter
 *   actionType optional action_type filter
 *   mode       optional governance_mode filter
 */
export async function handleGovernanceExecutionSlo(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const hours = parsePositiveIntParam(url.searchParams.get('hours'), 24, 720);
    const tenantId = url.searchParams.get('tenantId')?.trim() || null;
    const actionType = url.searchParams.get('actionType')?.trim() || null;
    const mode = url.searchParams.get('mode')?.trim() || null;
    const since = Math.floor(Date.now() / 1000) - hours * 3600;

    const where: string[] = ['recorded_at >= ?'];
    const params: unknown[] = [since];
    if (tenantId) { where.push('tenant_scope = ?'); params.push(tenantId); }
    if (actionType) { where.push('action_type = ?'); params.push(actionType); }
    if (mode) { where.push('governance_mode = ?'); params.push(mode); }

    interface ExecSummaryRow {
      total: number;
      allowed_count: number;
      blocked_count: number;
      observed_count: number;
      bypassed_count: number;
      violation_count: number;
    }
    interface BreakdownRow { source: string; count: number; }

    const summaryRows = await query<ExecSummaryRow>(
      env.DB,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN allowed = 1 THEN 1 ELSE 0 END) AS allowed_count,
              SUM(CASE WHEN enforcement_outcome = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
              SUM(CASE WHEN enforcement_outcome = 'observed' THEN 1 ELSE 0 END) AS observed_count,
              SUM(CASE WHEN enforcement_outcome = 'bypassed' THEN 1 ELSE 0 END) AS bypassed_count,
              SUM(CASE WHEN violation = 1 THEN 1 ELSE 0 END) AS violation_count
         FROM governance_execution_decisions
        WHERE ${where.join(' AND ')}`,
      params,
    );

    const actionTypeRows = await query<BreakdownRow>(
      env.DB,
      `SELECT action_type AS source, COUNT(*) AS count
         FROM governance_execution_decisions
        WHERE ${where.join(' AND ')}
        GROUP BY action_type
        ORDER BY count DESC`,
      params,
    );

    const outcomeRows = await query<BreakdownRow>(
      env.DB,
      `SELECT enforcement_outcome AS source, COUNT(*) AS count
         FROM governance_execution_decisions
        WHERE ${where.join(' AND ')}
        GROUP BY enforcement_outcome
        ORDER BY count DESC`,
      params,
    );

    const reasonRows = await query<BreakdownRow>(
      env.DB,
      `SELECT reason AS source, COUNT(*) AS count
         FROM governance_execution_decisions
        WHERE ${where.join(' AND ')}
        GROUP BY reason
        ORDER BY count DESC`,
      params,
    );

    const summary = summaryRows[0] ?? {
      total: 0, allowed_count: 0, blocked_count: 0,
      observed_count: 0, bypassed_count: 0, violation_count: 0,
    };

    const activeExecutionMode = await resolveGovernanceExecutionMode(env);
    const kvExecOverride = await env.KV_MARKETING.get(KV_PREFIX.GOVERNANCE_EXECUTION_MODE_OVERRIDE).catch(() => null);
    const denominator = Math.max(1, summary.total);

    return ok({
      window: { hours, since, sinceIso: new Date(since * 1000).toISOString() },
      scope: { tenantId, actionType, mode },
      activeExecutionMode,
      executionModeEnvVar: env.GOVERNANCE_EXECUTION_MODE ?? null,
      executionModeKvOverride: kvExecOverride ?? null,
      governanceServiceConfigured: !!(env.GOVERNANCE || env.GOVERNANCE_URL),
      totals: {
        events: summary.total,
        allowed: summary.allowed_count,
        blocked: summary.blocked_count,
        observed: summary.observed_count,
        bypassed: summary.bypassed_count,
        violations: summary.violation_count,
      },
      rates: {
        passRate: summary.allowed_count / denominator,
        violationRate: summary.violation_count / denominator,
        blockedRate: summary.blocked_count / denominator,
      },
      actionTypeDistribution: actionTypeRows.reduce<Record<string, number>>((acc, r) => {
        acc[r.source] = r.count; return acc;
      }, {}),
      enforcementOutcomeDistribution: outcomeRows.reduce<Record<string, number>>((acc, r) => {
        acc[r.source] = r.count; return acc;
      }, {}),
      reasonDistribution: reasonRows.reduce<Record<string, number>>((acc, r) => {
        acc[r.source] = r.count; return acc;
      }, {}),
    });
  } catch (err) {
    console.error('[Admin] handleGovernanceExecutionSlo error:', err);
    return serverError('Failed to load governance execution SLO');
  }
}