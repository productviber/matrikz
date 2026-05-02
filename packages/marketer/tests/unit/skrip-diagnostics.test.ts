import { describe, expect, it } from 'vitest';
import { handleSkripDiagnostics } from '../../src/routes/admin/skrip';
import { createMockEnv, makeRequest } from '../helpers';

describe('handleSkripDiagnostics', () => {
  it('returns configuration, counts, and flag snapshot', async () => {
    const env = createMockEnv({
      SKRIP_BASE_URL: 'https://skrip.example',
      SKRIP_SERVICE_TOKEN: 'skrip-token',
      SKRIP_SIGNING_SECRET: 'skrip-signing',
      SKRIP_WEBHOOK_SIGNING_SECRET: 'skrip-webhook',
      SKRIP_DEFAULT_ENABLEMENT: 'true',
    });

    env.DB.onQuery(/FROM channel_authorities\s+WHERE tenant_id/i, () => [
      {
        tenant_id: 'tenant_acme',
        campaign_id: 'cmp_1',
        channel: 'push',
        authority: 'skrip',
        rollout_state: 'dry_run',
      },
    ]);
    env.DB.onQuery(/SELECT COUNT\(\*\) AS count FROM channel_authorities$/i, () => [{ count: 1 }]);
    env.DB.onQuery(/FROM channel_execution_outbox/i, () => [{ count: 3 }]);
    env.DB.onQuery(/FROM channel_outcome_dead_letter/i, () => [{ count: 2 }]);

    const request = makeRequest('GET', '/api/admin/outbound/skrip/diagnostics?tenantId=tenant_acme&campaignId=cmp_1&channel=push', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const response = await handleSkripDiagnostics(request, env as any);
    const body = await response.json() as { data: any };

    expect(response.status).toBe(200);
    expect(body.data.configured.clientConfigured).toBe(true);
    expect(body.data.counts).toMatchObject({ authorityRows: 1, pendingOutbox: 3, pendingDlq: 2 });
    expect(body.data.flags.effectiveEnabled).toBe(true);
    expect(body.data.authorities).toHaveLength(1);
  });
});