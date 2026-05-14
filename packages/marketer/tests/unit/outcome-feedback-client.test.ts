import { describe, expect, it, vi } from 'vitest';
import { KV_PREFIX } from '../../src/constants';
import { OUTCOME_DELTA_MAP, sendOutcomeFeedback } from '../../src/lib/growth/feedbackClient';
import { createMockEnv } from '../helpers';

describe('outcome feedback client', () => {
  it('uses the canonical Matrikz outcome vocabulary through the local adapter', () => {
    expect(Object.keys(OUTCOME_DELTA_MAP).sort()).toEqual([
      'accepted',
      'bounced',
      'clicked',
      'converted',
      'delivered',
      'dismissed',
      'dlq_dropped',
      'no_action_recorded',
      'no_response',
      'opened',
      'overridden',
      'recommended',
      'replied',
      'sent',
      'unsubscribed',
    ]);
  });

  it('sends required headers including UUIDv4 idempotency key', async () => {
    let capturedHeaders: Headers = new Headers();
    const fetcher = {
      fetch: vi.fn(async (_url: string, init: RequestInit) => {
        capturedHeaders = new Headers(init.headers as HeadersInit);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    };

    const env = createMockEnv({
      AI_ENGINE: fetcher as any,
      INTERNAL_SECRET: 'internal-secret',
      OUTCOME_FEEDBACK_URL: 'https://matrikz/internal/outcome-feedback',
    });

    await sendOutcomeFeedback(env as any, {
      correlationId: 'corr-client-1',
      tenantId: 'acme',
      subjectId: 'lead@acme.com',
      actionTaken: 'send_via_skrip',
      outcomeMetric: 'clicked',
      observedAt: new Date().toISOString(),
    });

    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(capturedHeaders.get('x-internal-secret')).toBe('internal-secret');
    expect(capturedHeaders.get('x-tenant-id')).toBe('acme');
    expect(capturedHeaders.get('x-correlation-id')).toBe('corr-client-1');
    expect(capturedHeaders.get('x-idempotency-key')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('retries transient failures and succeeds', async () => {
    const fetcher = {
      fetch: vi
        .fn()
        .mockResolvedValueOnce(new Response('retry', { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    };

    const env = createMockEnv({
      AI_ENGINE: fetcher as any,
      INTERNAL_SECRET: 'internal-secret',
      OUTCOME_FEEDBACK_URL: 'https://matrikz/internal/outcome-feedback',
    });

    await sendOutcomeFeedback(env as any, {
      correlationId: 'corr-client-2',
      tenantId: 'acme',
      subjectId: 'lead@acme.com',
      actionTaken: 'send_via_skrip',
      outcomeMetric: 'opened',
      observedAt: new Date().toISOString(),
    });

    expect(fetcher.fetch).toHaveBeenCalledTimes(2);
  });

  it('records failure on permanent upstream error', async () => {
    const fetcher = {
      fetch: vi.fn(async () => new Response('bad request', { status: 400 })),
    };

    const env = createMockEnv({
      AI_ENGINE: fetcher as any,
      INTERNAL_SECRET: 'internal-secret',
      OUTCOME_FEEDBACK_URL: 'https://matrikz/internal/outcome-feedback',
    });

    await sendOutcomeFeedback(env as any, {
      correlationId: 'corr-client-3',
      tenantId: 'acme',
      subjectId: 'lead@acme.com',
      actionTaken: 'send_via_skrip',
      outcomeMetric: 'unsubscribed',
      observedAt: new Date().toISOString(),
    });

    const failureCount = await env.KV_MARKETING.get(`${KV_PREFIX.OUTCOME_FEEDBACK_FAILED}acme`);
    expect(failureCount).toBe('1');
  });

  it('skips duplicate event deliveries idempotently', async () => {
    const fetcher = {
      fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    };

    const env = createMockEnv({
      AI_ENGINE: fetcher as any,
      INTERNAL_SECRET: 'internal-secret',
      OUTCOME_FEEDBACK_URL: 'https://matrikz/internal/outcome-feedback',
    });

    const params = {
      correlationId: 'corr-client-4',
      tenantId: 'acme',
      subjectId: 'lead@acme.com',
      actionTaken: 'send_via_skrip',
      outcomeMetric: 'delivered' as const,
      observedAt: '2026-05-10T07:20:00.000Z',
    };

    await sendOutcomeFeedback(env as any, params);
    await sendOutcomeFeedback(env as any, params);

    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
  });
});
