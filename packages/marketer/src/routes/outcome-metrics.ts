import type { Env } from '../types';
import { ok } from '../lib/response';
import {
  readDispatchSuccessRate,
  readOutcomeFeedbackFailures,
  readOutcomeFeedbackLatency,
} from '../lib/growth/closedLoop';

function tenantFromQuery(request: Request): string | undefined {
  const tenantId = new URL(request.url).searchParams.get('tenantId');
  return tenantId && tenantId.trim().length > 0 ? tenantId : undefined;
}

export async function handleDispatchSuccessRate(request: Request, env: Env): Promise<Response> {
  const tenantId = tenantFromQuery(request);
  const metrics = await readDispatchSuccessRate(env, tenantId);
  return ok({
    tenantId: metrics.tenantId,
    accepted: metrics.accepted,
    rejected: metrics.rejected,
    total: metrics.total,
    successRate: metrics.successRate,
  });
}

export async function handleOutcomeFeedbackLatency(request: Request, env: Env): Promise<Response> {
  const tenantId = tenantFromQuery(request);
  const metrics = await readOutcomeFeedbackLatency(env, tenantId);
  return ok({
    tenantId: metrics.tenantId,
    count: metrics.count,
    avgLatencyMs: metrics.avgLatencyMs,
  });
}

export async function handleOutcomeFeedbackFailures(request: Request, env: Env): Promise<Response> {
  const tenantId = tenantFromQuery(request);
  const metrics = await readOutcomeFeedbackFailures(env, tenantId);
  return ok({
    tenantId: metrics.tenantId,
    failures: metrics.failures,
  });
}
