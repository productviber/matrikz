/**
 * Analytics Service Client — calls visibility-analytics via service binding.
 *
 * Uses `env.ANALYTICS.fetch()` for zero-latency internal RPC.
 */

import type { Env } from '../types';

const INTERNAL_BASE = 'https://internal';

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

async function internalFetch(env: Env, path: string, opts: FetchOptions = {}): Promise<Response> {
  const { method = 'GET', headers = {}, body } = opts;
  const url = `${INTERNAL_BASE}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  return env.ANALYTICS.fetch(url, init as any) as unknown as Response;
}

function authHeader(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${env.ADMIN_TOKEN}` };
}

// ─── Public Endpoints ───────────────────────────────────────────────────────

export async function healthCheck(env: Env): Promise<{ status: string }> {
  const res = await internalFetch(env, '/health');
  return res.json();
}

export async function getBillingTiers(env: Env) {
  const res = await internalFetch(env, '/api/v1/billing/tiers');
  return res.json();
}

// ─── Authenticated Endpoints ────────────────────────────────────────────────

export async function getCockpitData(env: Env, sessionToken: string) {
  const res = await internalFetch(env, '/api/v1/cockpit', {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  return res.json();
}

export async function getBillingStatus(env: Env, sessionToken: string) {
  const res = await internalFetch(env, '/api/v1/billing/status', {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  return res.json();
}

// ─── Admin Endpoints ────────────────────────────────────────────────────────

export async function createAffiliate(
  env: Env,
  data: { code: string; name: string; email: string; commissionRate?: number }
) {
  const res = await internalFetch(env, '/admin/affiliates', {
    method: 'POST',
    headers: authHeader(env),
    body: data,
  });
  return res.json();
}

export async function listAffiliates(env: Env) {
  const res = await internalFetch(env, '/admin/affiliates', {
    headers: authHeader(env),
  });
  return res.json();
}

export async function getAffiliateByCode(env: Env, code: string) {
  const res = await internalFetch(env, `/admin/affiliates?code=${encodeURIComponent(code)}`, {
    headers: authHeader(env),
  });
  return res.json();
}

export async function getMigrationStatus(env: Env) {
  const res = await internalFetch(env, '/admin/migrations', {
    headers: authHeader(env),
  });
  return res.json();
}

export async function runMigrations(env: Env) {
  const res = await internalFetch(env, '/admin/migrations/run', {
    method: 'POST',
    headers: authHeader(env),
  });
  return res.json();
}
