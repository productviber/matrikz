import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { createMockCtx, createMockEnv, makeRequest, type MockEnv } from '../helpers';

describe('admin skrip route integration', () => {
  let env: MockEnv;
  let ctx: ReturnType<typeof createMockCtx>;

  beforeEach(() => {
    env = createMockEnv();
    ctx = createMockCtx();
  });

  it('enforces admin auth for skrip flag set', async () => {
    const response = await worker.fetch(
      makeRequest('POST', '/api/admin/skrip/flags', { key: 'tenant:default', value: true }),
      env as any,
      ctx,
    );

    expect(response.status).toBe(401);
  });

  it('enforces admin auth for kill-switch drill', async () => {
    const response = await worker.fetch(
      makeRequest('POST', '/api/admin/skrip/killswitch/drill', { scope: 'global' }),
      env as any,
      ctx,
    );

    expect(response.status).toBe(401);
  });

  it('maintains flag set and policy-state read consistency', async () => {
    env.DB.onQuery(/FROM channel_authorities/i, () => [{
      authority: 'skrip',
      rollout_state: 'enabled',
      feature_flag_key: null,
    }]);

    const setResponse = await worker.fetch(
      makeRequest(
        'POST',
        '/api/admin/skrip/flags',
        { key: 'tenant:default:channel:push', value: true },
        { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
      ),
      env as any,
      ctx,
    );

    expect(setResponse.status).toBe(200);

    const stateResponse = await worker.fetch(
      makeRequest(
        'GET',
        '/api/admin/skrip/policy-state?tenantId=default&channel=push',
        undefined,
        { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
      ),
      env as any,
      ctx,
    );

    expect(stateResponse.status).toBe(200);
    const body = await stateResponse.json() as {
      data: {
        flags: { channelEnabled: boolean };
        summary: { canDispatch: boolean };
      }
    };
    expect(body.data.flags.channelEnabled).toBe(true);
    expect(body.data.summary.canDispatch).toBe(true);
  });

  it('returns kill-switch drill report for active tenant channel switch', async () => {
    await env.KV_MARKETING.put('agent:growth:kill:channel:default:push', 'true');

    const response = await worker.fetch(
      makeRequest(
        'POST',
        '/api/admin/skrip/killswitch/drill',
        { scope: 'channel', tenantId: 'default', channel: 'push' },
        { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
      ),
      env as any,
      ctx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: {
        anyActive: boolean;
        switches: { channel: { active: boolean } | null };
      }
    };
    expect(body.data.anyActive).toBe(true);
    expect(body.data.switches.channel?.active).toBe(true);
  });

  it('supports dlq replay with empty dead-letter queue', async () => {
    const response = await worker.fetch(
      makeRequest(
        'POST',
        '/api/admin/skrip/dlq/replay',
        { tenantId: 'default', limit: 10 },
        { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
      ),
      env as any,
      ctx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { replayed: number; skipped: number; scanned: number } };
    expect(body.data.scanned).toBe(0);
    expect(body.data.replayed).toBe(0);
    expect(body.data.skipped).toBe(0);
  });

  it('replays populated retryable dead-letter rows', async () => {
    env.DB.onQuery(/FROM channel_outcome_dead_letter/i, () => [
      {
        id: 7,
        tenant_id: 'default',
        event_id: 'evt_1',
        event_type: 'dispatch.failed',
        payload_json: JSON.stringify({
          campaignId: 'cmp_1',
          stepId: 'step_1',
          contact: { externalContactId: 'lead@acme.com' },
          channel: 'push',
          schedule: { scheduleSlot: '2026-05-04T10:00Z' },
        }),
      },
    ]);

    const response = await worker.fetch(
      makeRequest(
        'POST',
        '/api/admin/skrip/dlq/replay',
        { tenantId: 'default', limit: 10 },
        { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
      ),
      env as any,
      ctx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { scanned: number; replayed: number; skipped: number } };
    expect(body.data.scanned).toBe(1);
    expect(body.data.replayed).toBe(1);
    expect(body.data.skipped).toBe(0);
  });
});
