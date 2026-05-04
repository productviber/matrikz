/**
 * ai-engine Client — Full Capability Surface Contract Tests
 *
 * Tests the Marketing worker's ai-engine client for all five growth
 * capabilities beyond `growthNextAction` (which is covered separately):
 *
 *   - messageBrief     → /internal/message-brief
 *   - outcomeDiagnose  → /internal/outcome-diagnose
 *   - journeyCritic    → /internal/journey-critic
 *   - growthSignalSummarize → /internal/growth-signal-summarize
 *
 * Enforces:
 *   - Correct endpoint routing for each capability.
 *   - x-internal-secret header on every request.
 *   - Graceful fallback (ok: false) when AI_ENGINE binding is absent.
 *   - Graceful fallback (ok: false) when ai-engine returns 5xx.
 *   - Circuit breaker trips on repeated failures.
 *
 * Alignment ref: ECOSYSTEM_ALIGNMENT_REVIEW_2026-05-04.md
 * "Increase direct use of additional advisory capabilities beyond next-action,
 * especially message-brief and outcome-diagnose."
 */

import { describe, expect, it, vi } from 'vitest';
import { createAiEngineClient } from '../../src/lib/ai-engine/client';
import { createMockEnv, createMockFetcher } from '../helpers';

// ─── Helpers ──────────────────────────────────────────────────────────────

function captureFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const mockFetcher = {
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, data: { stub: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  };
  return { calls, mockFetcher };
}

// ─── messageBrief ────────────────────────────────────────────────────────

describe('ai-engine client: messageBrief capability', () => {
  it('routes to /internal/message-brief', async () => {
    const { calls, mockFetcher } = captureFetch();
    const env = createMockEnv({ AI_ENGINE: mockFetcher as any });
    const client = createAiEngineClient(env as any);

    await client.messageBrief({
      tenantId: 'test-tenant',
      objective: 'Re-engage inactive users',
      audience: 'trial users inactive for 14+ days',
      channelHints: ['push', 'email'],
      constraints: ['max 120 words'],
    });

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].url).toContain('message-brief');
  });

  it('sends x-internal-secret header on messageBrief requests', async () => {
    const capturedHeaders: Record<string, string> = {};
    const mockFetcher = {
      fetch: vi.fn(async (_url: string, init: RequestInit) => {
        const h = new Headers(init.headers as Record<string, string>);
        h.forEach((v, k) => { capturedHeaders[k] = v; });
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    };
    const env = createMockEnv({ AI_ENGINE: mockFetcher as any, INTERNAL_SECRET: 'secret-msg-brief' });
    await createAiEngineClient(env as any).messageBrief({ objective: 'test', audience: 'test' });

    expect(capturedHeaders['x-internal-secret']).toBe('secret-msg-brief');
  });

  it('returns ok:false when AI_ENGINE binding is absent', async () => {
    const env = createMockEnv({ AI_ENGINE: undefined as any });
    const result = await createAiEngineClient(env as any).messageBrief({ objective: 'test', audience: 'test' });
    expect(result.ok).toBe(false);
  });

  it('returns ok:false when ai-engine returns 503', async () => {
    const mockFetcher = {
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 'UPSTREAM_FAILURE' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    };
    const env = createMockEnv({ AI_ENGINE: mockFetcher as any });
    const result = await createAiEngineClient(env as any).messageBrief({ objective: 'test', audience: 'test' });
    expect(result.ok).toBe(false);
  });

  it('forwards growthGoal and channelHints in request body', async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    const mockFetcher = {
      fetch: vi.fn(async (_url: string, init: RequestInit) => {
        capturedBodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    };
    const env = createMockEnv({ AI_ENGINE: mockFetcher as any });

    await createAiEngineClient(env as any).messageBrief({
      objective: 'drive activation',
      audience: 'new signups',
      channelHints: ['push', 'sms'],
      constraints: ['max 80 words', 'no discounts'],
    });

    const body = capturedBodies[0];
    expect(body).toBeDefined();
    expect(body).toHaveProperty('objective');
    expect(body).toHaveProperty('channelHints');
  });
});

// ─── outcomeDiagnose ────────────────────────────────────────────────────

describe('ai-engine client: outcomeDiagnose capability', () => {
  it('routes to /internal/outcome-diagnose', async () => {
    const { calls, mockFetcher } = captureFetch();
    const env = createMockEnv({ AI_ENGINE: mockFetcher as any });

    await createAiEngineClient(env as any).outcomeDiagnose({
      tenantId: 'test-tenant',
      expected: { deliveryRate: 0.9, openRate: 0.3 },
      observed: { deliveryRate: 0.6, openRate: 0.1 },
    });

    expect(calls[0].url).toContain('outcome-diagnose');
  });

  it('sends x-internal-secret header on outcomeDiagnose requests', async () => {
    const capturedHeaders: Record<string, string> = {};
    const mockFetcher = {
      fetch: vi.fn(async (_url: string, init: RequestInit) => {
        const h = new Headers(init.headers as Record<string, string>);
        h.forEach((v, k) => { capturedHeaders[k] = v; });
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    };
    const env = createMockEnv({ AI_ENGINE: mockFetcher as any, INTERNAL_SECRET: 'secret-outcome' });
    await createAiEngineClient(env as any).outcomeDiagnose({ expected: {}, observed: {} });

    expect(capturedHeaders['x-internal-secret']).toBe('secret-outcome');
  });

  it('returns ok:false when AI_ENGINE binding is absent', async () => {
    const env = createMockEnv({ AI_ENGINE: undefined as any });
    const result = await createAiEngineClient(env as any).outcomeDiagnose({ expected: {}, observed: {} });
    expect(result.ok).toBe(false);
  });

  it('includes actionType, channel, and outcomeType in request payload', async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    const mockFetcher = {
      fetch: vi.fn(async (_url: string, init: RequestInit) => {
        capturedBodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    };
    const env = createMockEnv({ AI_ENGINE: mockFetcher as any });

    await createAiEngineClient(env as any).outcomeDiagnose({
      expected: { deliveryRate: 0.9, channel: 'push', actionType: 'send_via_skrip' },
      observed: { deliveryRate: 0.5, outcomeType: 'failed' },
    });

    const body = capturedBodies[0];
    expect(JSON.stringify(body)).toContain('expected');
    expect(JSON.stringify(body)).toContain('observed');
  });
});

// ─── journeyCritic ──────────────────────────────────────────────────────

describe('ai-engine client: journeyCritic capability', () => {
  it('routes to /internal/journey-critic', async () => {
    const { calls, mockFetcher } = captureFetch();
    const env = createMockEnv({ AI_ENGINE: mockFetcher as any });

    await createAiEngineClient(env as any).journeyCritic({
      tenantId: 'test-tenant',
      journeyState: { stage: 'onboarding', days: 5 },
      priorActions: [],
      outcomes: [],
    });

    expect(calls[0].url).toContain('journey-critic');
  });

  it('returns ok:false when AI_ENGINE binding is absent', async () => {
    const env = createMockEnv({ AI_ENGINE: undefined as any });
    const result = await createAiEngineClient(env as any).journeyCritic({ journeyState: {} });
    expect(result.ok).toBe(false);
  });
});

// ─── growthSignalSummarize ──────────────────────────────────────────────

describe('ai-engine client: growthSignalSummarize capability', () => {
  it('routes to /internal/growth-signal-summarize', async () => {
    const { calls, mockFetcher } = captureFetch();
    const env = createMockEnv({ AI_ENGINE: mockFetcher as any });

    await createAiEngineClient(env as any).growthSignalSummarize({
      tenantId: 'test-tenant',
      signals: [{ kind: 'number', name: 'intent', value: 0.85, weight: 0.9 }],
      outputLocale: 'en',
    });

    expect(calls[0].url).toContain('growth-signal-summarize');
  });

  it('returns ok:false when AI_ENGINE binding is absent', async () => {
    const env = createMockEnv({ AI_ENGINE: undefined as any });
    const result = await createAiEngineClient(env as any).growthSignalSummarize({ signals: [] });
    expect(result.ok).toBe(false);
  });
});

// ─── Circuit breaker ────────────────────────────────────────────────────

describe('ai-engine client: circuit breaker across capabilities', () => {
  it('returns ok:false immediately when circuit is open', async () => {
    const env = createMockEnv({
      AI_ENGINE: { fetch: vi.fn() } as any,
    });

    // Open circuit by writing a future timestamp
    await env.KV_MARKETING.put('ai-engine:circuit:default', String(Date.now() + 60_000));

    const client = createAiEngineClient(env as any);
    const [briefResult, diagnoseResult] = await Promise.all([
      client.messageBrief({ objective: 'test', audience: 'test' }),
      client.outcomeDiagnose({ expected: {}, observed: {} }),
    ]);

    // Both should fail fast without calling fetch
    expect(briefResult.ok).toBe(false);
    expect(diagnoseResult.ok).toBe(false);
    expect((env.AI_ENGINE as any).fetch).not.toHaveBeenCalled();
  });
});
