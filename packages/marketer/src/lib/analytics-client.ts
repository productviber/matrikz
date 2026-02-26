/**
 * Analytics Service Client — calls visibility-analytics via service binding.
 *
 * Uses `env.ANALYTICS.fetch()` for zero-latency internal RPC.
 * Only exports functions that are actively used by the marketer worker.
 * Previously dead-code exports (getCockpitData, getBillingStatus,
 * getBillingTiers, getMigrationStatus, runMigrations) have been removed.
 */

import type { Env } from '../types';
import { INTERNAL_BASE_URL, CONTENT_TYPE_JSON } from '../constants';

// ─── Typed Response ─────────────────────────────────────────────────────────

export interface AnalyticsResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

async function internalFetch<T = unknown>(
  env: Env,
  path: string,
  opts: FetchOptions = {}
): Promise<AnalyticsResponse<T>> {
  const { method = 'GET', headers = {}, body } = opts;
  const url = `${INTERNAL_BASE_URL}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': CONTENT_TYPE_JSON,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = (await env.ANALYTICS.fetch(url, init as any)) as unknown as Response;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${text}` };
  }

  try {
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Failed to parse analytics response' };
  }
}

function authHeader(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${env.ADMIN_TOKEN}` };
}

// ─── Public Endpoints ───────────────────────────────────────────────────────

export async function healthCheck(env: Env): Promise<{ status: string }> {
  const res = await internalFetch<{ status: string }>(env, '/health');
  return res.data ?? { status: 'unknown' };
}

// ─── Admin Endpoints ────────────────────────────────────────────────────────

export async function createAffiliate(
  env: Env,
  data: { code: string; name: string; email: string; commissionRate?: number }
): Promise<AnalyticsResponse> {
  return internalFetch(env, '/admin/affiliates', {
    method: 'POST',
    headers: authHeader(env),
    body: data,
  });
}

export async function listAffiliates(env: Env): Promise<AnalyticsResponse> {
  return internalFetch(env, '/admin/affiliates', {
    headers: authHeader(env),
  });
}

export async function getAffiliateByCode(env: Env, code: string): Promise<AnalyticsResponse> {
  return internalFetch(env, `/admin/affiliates?code=${encodeURIComponent(code)}`, {
    headers: authHeader(env),
  });
}

// ─── Click Event Forwarding ─────────────────────────────────────────────────

interface ClickEventPayload {
  slug: string;
  affiliateCode?: string;
  referrer?: string;
  userAgent?: string;
}

/**
 * Forward a referral click event to the analytics worker.
 * Called fire-and-forget from the referral redirect handler.
 * Failures are swallowed — clicks must never block the redirect.
 */
export async function forwardClickEvent(
  env: Env,
  payload: ClickEventPayload
): Promise<void> {
  try {
    await internalFetch(env, '/api/v1/events/click', {
      method: 'POST',
      headers: authHeader(env),
      body: {
        event: 'affiliate.click',
        source: 'visibility-marketing',
        timestamp: new Date().toISOString(),
        data: payload,
      },
    });
  } catch (err) {
    console.warn('[Analytics] Failed to forward click event:', err);
  }
}
