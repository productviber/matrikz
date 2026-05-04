import { describe, expect, it } from 'vitest';
import { GROWTH_POLICY, KV_PREFIX } from '../../src/constants';
import {
  handleKillSwitchDrill,
  handleSkripFlagSet,
  handleSkripPolicyState,
} from '../../src/routes/admin/skrip';
import { createMockEnv, makeRequest } from '../helpers';

describe('skrip policy and flags', () => {
  it('sets a skrip flag with valid key and ttl', async () => {
    const env = createMockEnv();

    const response = await handleSkripFlagSet(
      makeRequest('POST', '/api/admin/skrip/flags', {
        key: 'tenant:default:channel:push',
        value: true,
        ttlSecs: 120,
      }),
      env as any,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { key: string; value: boolean; ttlSecs: number } };
    expect(body.data.key).toBe(`${KV_PREFIX.SKRIP_FLAG}tenant:default:channel:push`);
    expect(body.data.value).toBe(true);
    expect(body.data.ttlSecs).toBe(120);
    const stored = await env.KV_MARKETING.get(`${KV_PREFIX.SKRIP_FLAG}tenant:default:channel:push`);
    expect(stored).toBe('true');
  });

  it('rejects invalid flag key format', async () => {
    const env = createMockEnv();

    const response = await handleSkripFlagSet(
      makeRequest('POST', '/api/admin/skrip/flags', {
        key: 'invalid:key:shape:extra',
        value: true,
      }),
      env as any,
    );

    expect(response.status).toBe(400);
  });

  it('rejects non-boolean flag values', async () => {
    const env = createMockEnv();

    const response = await handleSkripFlagSet(
      makeRequest('POST', '/api/admin/skrip/flags', {
        key: 'tenant:default',
        value: 'true',
      }),
      env as any,
    );

    expect(response.status).toBe(400);
  });

  it('requires channel query for policy state', async () => {
    const env = createMockEnv();

    const response = await handleSkripPolicyState(
      makeRequest('GET', '/api/admin/skrip/policy-state?tenantId=default'),
      env as any,
    );

    expect(response.status).toBe(400);
  });

  it('validates allowed policy-state channels', async () => {
    const env = createMockEnv();

    const response = await handleSkripPolicyState(
      makeRequest('GET', '/api/admin/skrip/policy-state?tenantId=default&channel=fax'),
      env as any,
    );

    expect(response.status).toBe(400);
  });

  it('returns combined authority, flags, decision, and summary', async () => {
    const env = createMockEnv({ SKRIP_DEFAULT_ENABLEMENT: 'true' });
    await env.KV_MARKETING.put(`${KV_PREFIX.SKRIP_FLAG}tenant:default:channel:push`, 'true');
    env.DB.onQuery(/FROM channel_authorities/i, () => [{
      authority: 'skrip',
      rollout_state: 'enabled',
      feature_flag_key: null,
    }]);

    const response = await handleSkripPolicyState(
      makeRequest('GET', '/api/admin/skrip/policy-state?tenantId=default&channel=push'),
      env as any,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: {
        flags: { channelEnabled: boolean; effectiveEnabled: boolean };
        decision: { useSkrip: boolean; dryRun: boolean };
        summary: { canDispatch: boolean; blockedBy: string[] };
      }
    };
    expect(body.data.flags.channelEnabled).toBe(true);
    expect(body.data.flags.effectiveEnabled).toBe(true);
    expect(body.data.decision.useSkrip).toBe(true);
    expect(body.data.decision.dryRun).toBe(false);
    expect(body.data.summary.canDispatch).toBe(true);
    expect(body.data.summary.blockedBy).toHaveLength(0);
  });

  it('reads all kill-switch scopes in drill endpoint', async () => {
    const env = createMockEnv();
    await env.KV_MARKETING.put(GROWTH_POLICY.KILL_SWITCH_GLOBAL_KEY, 'true');
    await env.KV_MARKETING.put(`${GROWTH_POLICY.KILL_SWITCH_TENANT_PREFIX}default`, 'false');
    await env.KV_MARKETING.put(`${GROWTH_POLICY.KILL_SWITCH_CAMPAIGN_PREFIX}default:cmp_1`, 'true');
    await env.KV_MARKETING.put(`${GROWTH_POLICY.KILL_SWITCH_CHANNEL_PREFIX}default:push`, 'false');

    const response = await handleKillSwitchDrill(
      makeRequest('POST', '/api/admin/skrip/killswitch/drill', {
        scope: 'channel',
        tenantId: 'default',
        campaignId: 'cmp_1',
        channel: 'push',
      }),
      env as any,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: {
        kvReadPath: string;
        anyActive: boolean;
        switches: { global: { active: boolean }; campaign: { active: boolean } | null };
      }
    };
    expect(body.data.kvReadPath).toBe('ok');
    expect(body.data.switches.global.active).toBe(true);
    expect(body.data.switches.campaign?.active).toBe(true);
    expect(body.data.anyActive).toBe(true);
  });

  it('rejects invalid kill-switch scope', async () => {
    const env = createMockEnv();

    const response = await handleKillSwitchDrill(
      makeRequest('POST', '/api/admin/skrip/killswitch/drill', { scope: 'region' }),
      env as any,
    );

    expect(response.status).toBe(400);
  });
});
