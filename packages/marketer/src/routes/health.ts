/**
 * Health Check Routes
 */

import type { Env } from '../types';
import { ok } from '../lib/response';

export function handleHealthCheck(): Response {
  return ok({
    status: 'ok',
    worker: 'visibility-marketing',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
}

export async function handleDetailedHealth(env: Env): Promise<Response> {
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
    await env.KV_MARKETING.get('__health_check__');
    checks.kv = 'ok';
  } catch {
    checks.kv = 'error';
  }

  // Analytics service binding check
  try {
    const res = await env.ANALYTICS.fetch('https://internal/health') as unknown as Response;
    checks.analytics = res.ok ? 'ok' : `error:${res.status}`;
  } catch {
    checks.analytics = 'unavailable';
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');

  return ok({
    status: allOk ? 'healthy' : 'degraded',
    worker: 'visibility-marketing',
    checks,
    timestamp: new Date().toISOString(),
  });
}
