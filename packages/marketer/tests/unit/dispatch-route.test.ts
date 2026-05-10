import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { KV_PREFIX } from '../../src/constants';
import { createMockCtx, createMockEnv, makeRequest, type MockEnv } from '../helpers';

describe('dispatch ingress route', () => {
  let env: MockEnv;
  let ctx: ReturnType<typeof createMockCtx>;

  beforeEach(() => {
    env = createMockEnv({
      SYSTEM_TOKEN: 'system-token',
      INTERNAL_SECRET: 'internal-secret',
    });
    ctx = createMockCtx();
  });

  it('returns 401 when x-internal-secret is missing', async () => {
    const response = await worker.fetch(
      makeRequest('POST', '/dispatch', {
        tenantId: 'acme',
        subjectId: 'lead@acme.com',
        correlationId: 'corr-missing-secret',
        actionType: 'send_via_skrip',
        campaignId: 'cmp_1',
        stepId: 'step_1',
        channel: 'push',
        contactId: 'lead@acme.com',
      }, {
        'x-system-token': 'system-token',
      }),
      env as any,
      ctx,
    );

    expect(response.status).toBe(401);
  });

  it('returns 400 when payload is invalid', async () => {
    const response = await worker.fetch(
      makeRequest('POST', '/dispatch', {
        tenantId: 'acme',
        subjectId: 'lead@acme.com',
        correlationId: 'corr-invalid',
        actionType: 'send_via_skrip',
        campaignId: 'cmp_1',
        stepId: 'step_1',
        channel: 'email',
        contactId: 'lead@acme.com',
      }, {
        'x-system-token': 'system-token',
        'x-internal-secret': 'internal-secret',
      }),
      env as any,
      ctx,
    );

    expect(response.status).toBe(400);
  });

  it('returns 202 and persists correlation mapping on accepted payload', async () => {
    const response = await worker.fetch(
      makeRequest('POST', '/dispatch', {
        tenantId: 'acme',
        subjectId: 'lead@acme.com',
        correlationId: 'corr-accepted-1',
        actionType: 'send_via_skrip',
        campaignId: 'cmp_1',
        stepId: 'step_1',
        channel: 'push',
        contactId: 'lead@acme.com',
      }, {
        'x-system-token': 'system-token',
        'x-internal-secret': 'internal-secret',
      }),
      env as any,
      ctx,
    );

    expect(response.status).toBe(202);
    const body = await response.json() as { data: { accepted: boolean } };
    expect(body.data.accepted).toBe(true);

    const outboxInsert = env.DB._queries.find((q) => q.sql.includes('INSERT OR IGNORE INTO channel_execution_outbox'));
    expect(outboxInsert).toBeDefined();

    const mapping = await env.KV_MARKETING.get(`${KV_PREFIX.OUTCOME_DISPATCH_MAP}corr-accepted-1`, 'json') as { actionType: string } | null;
    expect(mapping?.actionType).toBe('send_via_skrip');
  });
});
