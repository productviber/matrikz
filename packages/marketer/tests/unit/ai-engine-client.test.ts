import { describe, expect, it, vi } from 'vitest';
import { AGENT_ACTION_TYPE } from '../../src/constants';
import { createAiEngineClient } from '../../src/lib/ai-engine/client';
import { createMockEnv, createMockFetcher } from '../helpers';

describe('ai-engine growth client', () => {
  it('falls back to manual_review when ai-engine is unavailable for high-intent signals', async () => {
    const env = createMockEnv();
    const client = createAiEngineClient(env as any);

    const result = await client.growthNextAction({
      subjectId: 'lead@acme.com',
      signals: [{ severity: 'high' }],
      context: {},
    });

    expect(result.action.type).toBe(AGENT_ACTION_TYPE.MANUAL_REVIEW);
    expect(result.metadata.fallback).toBe(true);
  });

  it('normalizes a structured ai-engine recommendation', async () => {
    const env = createMockEnv({
      AI_ENGINE: createMockFetcher({
        '/internal/growth-next-action': {
          body: {
            action: { type: 'wait', params: { reviewAfterSeconds: 7200 }, reason: 'Let the signal mature' },
            riskLevel: 'low',
            confidence: 71,
            explanation: 'Wait is safest.',
            metadata: { provider: 'test', model: 'unit', promptVersion: 'v1' },
          },
        },
      }) as any,
    });

    const result = await createAiEngineClient(env as any).growthNextAction({
      tenantId: 'default',
      subjectId: 'lead@acme.com',
      signals: [],
      context: {},
    });

    expect(result.action.type).toBe('wait');
    expect(result.confidence).toBe(71);
    expect(result.metadata.fallback).toBe(false);
    expect(result.metadata.provider).toBe('test');
  });

  it('sends x-internal-secret header', async () => {
    let capturedHeaders: Headers | null = null;
    const mockFetcher = {
      fetch: vi.fn(async (url: string, init: RequestInit) => {
        capturedHeaders = new Headers(init.headers as Record<string, string>);
        return new Response(JSON.stringify({
          action: { type: 'wait', params: {}, reason: '' },
          riskLevel: 'low', confidence: 70, explanation: '', rawSummary: '',
          metadata: {},
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    };
    const env = createMockEnv({ AI_ENGINE: mockFetcher as any, INTERNAL_SECRET: 'test-secret' });
    await createAiEngineClient(env as any).growthNextAction({ subjectId: 's', signals: [], context: {} });
    expect(capturedHeaders!.get('x-internal-secret')).toBe('test-secret');
  });

  it('sends x-tenant-id header', async () => {
    let capturedHeaders: Headers | null = null;
    const mockFetcher = {
      fetch: vi.fn(async (url: string, init: RequestInit) => {
        capturedHeaders = new Headers(init.headers as Record<string, string>);
        return new Response(JSON.stringify({
          action: { type: 'wait', params: {}, reason: '' },
          riskLevel: 'low', confidence: 70, explanation: '', rawSummary: '',
          metadata: {},
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    };
    const env = createMockEnv({ AI_ENGINE: mockFetcher as any });
    await createAiEngineClient(env as any).growthNextAction({ tenantId: 'acme', subjectId: 's', signals: [], context: {} });
    expect(capturedHeaders!.get('x-tenant-id')).toBeDefined();
  });

  it('sends x-idempotency-key header', async () => {
    let capturedHeaders: Headers | null = null;
    const mockFetcher = {
      fetch: vi.fn(async (url: string, init: RequestInit) => {
        capturedHeaders = new Headers(init.headers as Record<string, string>);
        return new Response(JSON.stringify({
          action: { type: 'wait', params: {}, reason: '' },
          riskLevel: 'low', confidence: 70, explanation: '', rawSummary: '',
          metadata: {},
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    };
    const env = createMockEnv({ AI_ENGINE: mockFetcher as any });
    await createAiEngineClient(env as any).growthNextAction({ subjectId: 's', signals: [], context: {} });
    expect(capturedHeaders!.get('x-idempotency-key')).toBeTruthy();
  });

  it('increments circuit failure counter on non-2xx response', async () => {
    const mockFetcher = {
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 'UPSTREAM_FAILURE' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    };
    const env = createMockEnv({ AI_ENGINE: mockFetcher as any });
    await createAiEngineClient(env as any).growthNextAction({ subjectId: 's', signals: [], context: {} });
    const failureKey = Array.from((env.KV_MARKETING as any)._store.keys() as Iterable<string>).find((k: string) => k.includes('failure'));
    expect(failureKey).toBeDefined();
  });

  it('does NOT increment circuit failure counter on 503 CAPABILITY_DISABLED', async () => {
    const mockFetcher = {
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: { code: 'CAPABILITY_DISABLED', message: 'disabled' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    };
    const env = createMockEnv({ AI_ENGINE: mockFetcher as any });
    await createAiEngineClient(env as any).growthNextAction({ subjectId: 's', signals: [], context: {} });
    const failureKey = Array.from((env.KV_MARKETING as any)._store.keys() as Iterable<string>).find((k: string) => k.includes('failure'));
    expect(failureKey).toBeUndefined();
  });
});