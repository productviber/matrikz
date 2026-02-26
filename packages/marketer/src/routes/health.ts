/**
 * Health Check Routes
 */

import type { Env } from '../types';
import { ok, unauthorized } from '../lib/response';
import { isAdmin } from '../lib/response';
import { WORKER_NAME, WORKER_VERSION, KV_PREFIX, INTERNAL_BASE_URL } from '../constants';

export function handleHealthCheck(): Response {
  return ok({
    status: 'ok',
    worker: WORKER_NAME,
    version: WORKER_VERSION,
    timestamp: new Date().toISOString(),
  });
}

export async function handleDetailedHealth(request: Request, env: Env): Promise<Response> {
  // Detailed health exposes internal topology — require admin token
  if (!isAdmin(request, env)) {
    return unauthorized('Admin token required for detailed health check');
  }

  const checks: Record<string, string> = {};

  // D1 check
  try {
    await env.DB.prepare('SELECT 1').first();
    checks.d1 = 'ok';
  } catch {
    checks.d1 = 'error';
  }

  // KV check
  try {
    await env.KV_MARKETING.get(KV_PREFIX.HEALTH_CHECK);
    checks.kv = 'ok';
  } catch {
    checks.kv = 'error';
  }

  // Analytics service binding check
  try {
    const res = await env.ANALYTICS.fetch(`${INTERNAL_BASE_URL}/health`) as unknown as Response;
    checks.analytics = res.ok ? 'ok' : `error:${res.status}`;
  } catch {
    checks.analytics = 'unavailable';
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');

  return ok({
    status: allOk ? 'healthy' : 'degraded',
    worker: WORKER_NAME,
    checks,
    timestamp: new Date().toISOString(),
  });
}
