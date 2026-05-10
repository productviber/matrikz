import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { KV_PREFIX } from '../../src/constants';
import { createMockCtx, createMockEnv, makeRequest, type MockEnv } from '../helpers';

describe('closed-loop metrics endpoints', () => {
  let env: MockEnv;
  let ctx: ReturnType<typeof createMockCtx>;

  beforeEach(async () => {
    env = createMockEnv({
      SYSTEM_TOKEN: 'system-token',
    });
    ctx = createMockCtx();

    await env.KV_MARKETING.put(`${KV_PREFIX.OUTCOME_DISPATCH_ACCEPTED}acme`, '8');
    await env.KV_MARKETING.put(`${KV_PREFIX.OUTCOME_DISPATCH_REJECTED}acme`, '2');
    await env.KV_MARKETING.put(`${KV_PREFIX.OUTCOME_FEEDBACK_LATENCY_SUM}acme`, '900');
    await env.KV_MARKETING.put(`${KV_PREFIX.OUTCOME_FEEDBACK_LATENCY_COUNT}acme`, '3');
    await env.KV_MARKETING.put(`${KV_PREFIX.OUTCOME_FEEDBACK_FAILED}acme`, '1');
  });

  it('returns stable dispatch success-rate schema', async () => {
    const response = await worker.fetch(
      makeRequest('GET', '/metrics/dispatch-success-rate?tenantId=acme', undefined, {
        'x-system-token': 'system-token',
      }),
      env as any,
      ctx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { tenantId: string; accepted: number; rejected: number; total: number; successRate: number } };
    expect(body.data.tenantId).toBe('acme');
    expect(body.data.accepted).toBe(8);
    expect(body.data.rejected).toBe(2);
    expect(body.data.total).toBe(10);
    expect(body.data.successRate).toBe(0.8);
  });

  it('returns stable outcome-feedback-latency schema', async () => {
    const response = await worker.fetch(
      makeRequest('GET', '/metrics/outcome-feedback-latency?tenantId=acme', undefined, {
        'x-system-token': 'system-token',
      }),
      env as any,
      ctx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { tenantId: string; count: number; avgLatencyMs: number } };
    expect(body.data.tenantId).toBe('acme');
    expect(body.data.count).toBe(3);
    expect(body.data.avgLatencyMs).toBe(300);
  });

  it('returns stable outcome-feedback-failures schema', async () => {
    const response = await worker.fetch(
      makeRequest('GET', '/metrics/outcome-feedback-failures?tenantId=acme', undefined, {
        'x-system-token': 'system-token',
      }),
      env as any,
      ctx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { tenantId: string; failures: number } };
    expect(body.data.tenantId).toBe('acme');
    expect(body.data.failures).toBe(1);
  });
});
