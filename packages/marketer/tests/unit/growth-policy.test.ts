import { describe, expect, it } from 'vitest';
import { AGENT_ACTION_TYPE } from '../../src/constants';
import { evaluateGrowthPolicy } from '../../src/lib/growth/policy';
import { createMockEnv } from '../helpers';

describe('growth policy', () => {
  it('allows a ledgered wait action when no guardrail blocks it', async () => {
    const env = createMockEnv();
    const policy = await evaluateGrowthPolicy(env as any, {
      subjectId: 'lead@acme.com',
      action: { type: AGENT_ACTION_TYPE.WAIT, params: { reviewAfterSeconds: 3600 } },
      riskLevel: 'low',
      confidence: 70,
    });

    expect(policy.allowed).toBe(true);
    expect(policy.effectiveChannels).toContain('ledger');
  });

  it('blocks outbound enrollment for a permanently suppressed contact', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/FROM suppression_list/i, () => [{ id: 1 }]);

    const policy = await evaluateGrowthPolicy(env as any, {
      subjectId: 'lead@acme.com',
      action: { type: AGENT_ACTION_TYPE.ENROLL_SEQUENCE, params: { triggerEvent: 'outbound.prospect_discovered' } },
      riskLevel: 'low',
      confidence: 75,
    });

    expect(policy.allowed).toBe(false);
    expect(policy.blockedReasons).toContain('suppressed_contact');
  });

  it('blocks Skrip sends when no eligible channel identity exists', async () => {
    const env = createMockEnv();
    const policy = await evaluateGrowthPolicy(env as any, {
      subjectId: 'lead@acme.com',
      action: { type: AGENT_ACTION_TYPE.SEND_VIA_SKRIP, params: { campaignId: 'cmp_1' } },
      riskLevel: 'medium',
      confidence: 75,
    });

    expect(policy.allowed).toBe(false);
    expect(policy.blockedReasons).toContain('no_eligible_skrip_channel');
  });

  it('allows enroll_sequence without email authority flag (legacy path)', async () => {
    const env = createMockEnv();
    const policy = await evaluateGrowthPolicy(env as any, {
      subjectId: 'lead@acme.com',
      action: { type: AGENT_ACTION_TYPE.ENROLL_SEQUENCE, params: {} },
      riskLevel: 'low',
      confidence: 70,
    });

    expect(policy.allowed).toBe(true);
    expect(policy.effectiveChannels).toContain('email');
    expect(policy.evidence).not.toHaveProperty('emailChannelAuthority');
  });

  it('emits dry_run warning when SKRIP_EMAIL_AUTHORITY_ENABLED and channel is in dry_run', async () => {
    const env = createMockEnv();
    (env as any).SKRIP_EMAIL_AUTHORITY_ENABLED = 'true';
    env.DB.onQuery(/channel_authorities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        campaign_id: null,
        channel: 'email',
        authority: 'skrip',
        rollout_state: 'dry_run',
        feature_flag_key: null,
      },
    ]);

    const policy = await evaluateGrowthPolicy(env as any, {
      subjectId: 'lead@acme.com',
      action: { type: AGENT_ACTION_TYPE.ENROLL_SEQUENCE, params: {} },
      riskLevel: 'low',
      confidence: 70,
    });

    expect(policy.allowed).toBe(true);
    expect(policy.warnings).toContain('email_skrip_authority_dry_run');
    expect(policy.evidence).toHaveProperty('emailChannelAuthority');
  });

  it('emits fallback warning when SKRIP_EMAIL_AUTHORITY_ENABLED and email authority is disabled', async () => {
    const env = createMockEnv();
    (env as any).SKRIP_EMAIL_AUTHORITY_ENABLED = 'true';
    env.DB.onQuery(/channel_authorities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        campaign_id: null,
        channel: 'email',
        authority: 'visibility_marketing',
        rollout_state: 'disabled',
        feature_flag_key: null,
      },
    ]);

    const policy = await evaluateGrowthPolicy(env as any, {
      subjectId: 'lead@acme.com',
      action: { type: AGENT_ACTION_TYPE.ENROLL_SEQUENCE, params: {} },
      riskLevel: 'low',
      confidence: 70,
    });

    expect(policy.allowed).toBe(true);
    expect(policy.warnings).toContain('email_skrip_authority_not_enabled_fallback_to_legacy');
  });

  it('blocks enroll_sequence when SKRIP_EMAIL_AUTHORITY_ENABLED and email channel kill switch active', async () => {
    const env = createMockEnv();
    (env as any).SKRIP_EMAIL_AUTHORITY_ENABLED = 'true';
    await env.KV_MARKETING.put('agent:growth:kill:channel:default:email', 'true');

    const policy = await evaluateGrowthPolicy(env as any, {
      subjectId: 'lead@acme.com',
      action: { type: AGENT_ACTION_TYPE.ENROLL_SEQUENCE, params: {} },
      riskLevel: 'low',
      confidence: 70,
    });

    expect(policy.allowed).toBe(false);
    expect(policy.blockedReasons).toContain('email_channel_authority_kill_switch');
  });
});