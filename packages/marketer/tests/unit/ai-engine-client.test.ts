import { describe, expect, it } from 'vitest';
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
});