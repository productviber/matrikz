/**
 * Analytics Client — Cross-Worker Contract Tests
 *
 * Validates that the analytics client in the marketer worker sends requests
 * with the correct shape to the analytics worker. Tests verify:
 *   1. Request path, method, headers for each exported function
 *   2. Response parsing — both ok and error cases
 *   3. correlationId header forwarded on every call
 *   4. Auth header included on admin endpoints
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockEnv } from '../helpers';
import { setCorrelationId } from '../../src/lib/correlation';
import {
  healthCheck,
  createAffiliate,
  listAffiliates,
  getAffiliateByCode,
} from '../../src/lib/analytics-client';

// ── Mock fetch interceptor ─────────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeMockAnalytics(
  responses: Array<{ status?: number; body: unknown }>,
): { ANALYTICS: any; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  let callIdx = 0;

  const ANALYTICS = {
    async fetch(url: string | URL, init?: RequestInit) {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const hMap = init.headers as Record<string, string>;
        Object.assign(headers, hMap);
      }
      let parsedBody: unknown = undefined;
      if (init?.body && typeof init.body === 'string') {
        try { parsedBody = JSON.parse(init.body); } catch { parsedBody = init.body; }
      }
      captured.push({ url: urlStr, method: init?.method ?? 'GET', headers, body: parsedBody });

      const response = responses[callIdx] ?? { status: 200, body: { ok: true } };
      callIdx++;
      return new Response(JSON.stringify(response.body), {
        status: response.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };

  return { ANALYTICS, captured };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('analytics-client: healthCheck', () => {
  it('calls GET /health', async () => {
    const { ANALYTICS, captured } = makeMockAnalytics([{ body: { status: 'ok' } }]);
    const env = createMockEnv({ ANALYTICS: ANALYTICS as any });
    const result = await healthCheck(env as any);
    expect(result.status).toBe('ok');
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('GET');
    expect(new URL(captured[0].url).pathname).toBe('/health');
  });

  it('returns { status: "unknown" } on network error', async () => {
    const { ANALYTICS, captured } = makeMockAnalytics([{ status: 500, body: { error: 'oops' } }]);
    const env = createMockEnv({ ANALYTICS: ANALYTICS as any });
    const result = await healthCheck(env as any);
    expect(result.status).toBe('unknown');
    expect(captured).toHaveLength(1);
  });
});

describe('analytics-client: createAffiliate', () => {
  it('posts to /admin/affiliates with auth header', async () => {
    const { ANALYTICS, captured } = makeMockAnalytics([{ body: { ok: true } }]);
    const env = createMockEnv({ ANALYTICS: ANALYTICS as any, ADMIN_TOKEN: 'adm-tok' });
    await createAffiliate(env as any, { code: 'aff1', name: 'Test', email: 'test@example.com' });
    expect(captured[0].method).toBe('POST');
    expect(new URL(captured[0].url).pathname).toBe('/admin/affiliates');
    expect(captured[0].headers['Authorization']).toBe('Bearer adm-tok');
    expect((captured[0].body as any).code).toBe('aff1');
  });
});

describe('analytics-client: listAffiliates', () => {
  it('sends GET /admin/affiliates with auth header', async () => {
    const { ANALYTICS, captured } = makeMockAnalytics([{ body: { ok: true, data: [] } }]);
    const env = createMockEnv({ ANALYTICS: ANALYTICS as any, ADMIN_TOKEN: 'adm-tok' });
    const result = await listAffiliates(env as any);
    expect(result.ok).toBe(true);
    expect(captured[0].method).toBe('GET');
    expect(captured[0].headers['Authorization']).toBe('Bearer adm-tok');
  });
});

describe('analytics-client: getAffiliateByCode', () => {
  it('encodes the affiliate code in the query string', async () => {
    const { ANALYTICS, captured } = makeMockAnalytics([{ body: { ok: true } }]);
    const env = createMockEnv({ ANALYTICS: ANALYTICS as any });
    await getAffiliateByCode(env as any, 'my affiliate');
    const parsedUrl = new URL(captured[0].url);
    expect(parsedUrl.searchParams.get('code')).toBe('my affiliate');
  });
});

describe('analytics-client: correlationId forwarding', () => {
  it('includes x-correlation-id header on every call', async () => {
    const corrId = setCorrelationId('test-corr-123');
    const { ANALYTICS, captured } = makeMockAnalytics([{ body: { ok: true } }]);
    const env = createMockEnv({ ANALYTICS: ANALYTICS as any });
    await listAffiliates(env as any);
    expect(captured[0].headers['x-correlation-id']).toBe(corrId);
  });
});

describe('analytics-client: error envelope parsing', () => {
  it('returns { ok: false, error } on non-200 response', async () => {
    const { ANALYTICS } = makeMockAnalytics([{ status: 500, body: 'server error' }]);
    const env = createMockEnv({ ANALYTICS: ANALYTICS as any });
    const result = await listAffiliates(env as any);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error).toContain('HTTP 500');
  });

  it('returns { ok: false, error } on malformed JSON response', async () => {
    // Override fetch to return non-JSON
    const ANALYTICS = {
      async fetch() {
        return new Response('not-json', { status: 200, headers: { 'Content-Type': 'text/plain' } });
      },
    };
    const env = createMockEnv({ ANALYTICS: ANALYTICS as any });
    const result = await listAffiliates(env as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Failed to parse');
  });
});
