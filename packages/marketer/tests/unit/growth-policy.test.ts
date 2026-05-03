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
      action: {
        type: AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
        params: { campaignId: 'cmp_1', interventionMode: 'rescue', context: { signalType: 'cold_clicked_no_reply' } },
      },
      riskLevel: 'medium',
      confidence: 75,
    });

    expect(policy.allowed).toBe(false);
    expect(policy.blockedReasons).toContain('no_eligible_skrip_channel');
  });

  it('blocks Skrip sends that are not marked as rescue mode', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/contact_channel_identities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        contact_id: 'lead@acme.com',
        channel: 'push',
        canonical_id: 'skrip_contact_1',
        provider_ref: null,
        confidence: 100,
        registration_status: 'registered',
        last_synced_at: null,
        metadata_json: '{}',
        created_at: 1,
        updated_at: 1,
      },
    ]);
    env.DB.onQuery(/channel_authorities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        campaign_id: null,
        channel: 'push',
        authority: 'skrip',
        rollout_state: 'enabled',
        feature_flag_key: null,
      },
    ]);

    const policy = await evaluateGrowthPolicy(env as any, {
      subjectId: 'lead@acme.com',
      action: {
        type: AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
        params: { campaignId: 'cmp_1', interventionMode: 'primary', context: { signalType: 'cold_clicked_no_reply' } },
      },
      riskLevel: 'medium',
      confidence: 75,
    });

    expect(policy.allowed).toBe(false);
    expect(policy.blockedReasons).toContain('skrip_send_requires_rescue_mode');
  });

  it('blocks Skrip sends when rescue mode lacks high intent or urgency signal', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/contact_channel_identities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        contact_id: 'lead@acme.com',
        channel: 'push',
        canonical_id: 'skrip_contact_1',
        provider_ref: null,
        confidence: 100,
        registration_status: 'registered',
        last_synced_at: null,
        metadata_json: '{}',
        created_at: 1,
        updated_at: 1,
      },
    ]);
    env.DB.onQuery(/channel_authorities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        campaign_id: null,
        channel: 'push',
        authority: 'skrip',
        rollout_state: 'enabled',
        feature_flag_key: null,
      },
    ]);

    const policy = await evaluateGrowthPolicy(env as any, {
      subjectId: 'lead@acme.com',
      action: {
        type: AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
        params: { campaignId: 'cmp_1', interventionMode: 'rescue', context: { signalType: 'signup_no_site_connected' } },
      },
      riskLevel: 'medium',
      confidence: 75,
    });

    expect(policy.allowed).toBe(false);
    expect(policy.blockedReasons).toContain('skrip_send_requires_high_intent_or_urgency_signal');
  });

  it('allows email rescue mode when push is the primary channel', async () => {
    const env = createMockEnv();
    const policy = await evaluateGrowthPolicy(env as any, {
      subjectId: 'lead@acme.com',
      action: {
        type: AGENT_ACTION_TYPE.ENROLL_SEQUENCE,
        params: { triggerEvent: 'agentic.push_failed', interventionMode: 'rescue', primaryChannel: 'push' },
      },
      riskLevel: 'low',
      confidence: 75,
    });

    expect(policy.allowed).toBe(true);
    expect(policy.effectiveChannels).toContain('email');
    expect(policy.warnings).not.toContain('email_rescue_mode_without_push_primary');
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

  it('activates push_assist policy for enroll_sequence when push identity is eligible', async () => {
    const env = createMockEnv({ SKRIP_DEFAULT_ENABLEMENT: 'true' });
    env.DB.onQuery(/contact_channel_identities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        external_contact_id: 'lead@acme.com',
        canonical_id: 'skrip_can_1',
        channel: 'push',
        address: 'token_1',
        consent_state: 'opted_in',
        suppression_state: 'clear',
        availability_state: 'available',
        identity_confidence: 1,
        registration_state: 'registered',
        last_reconciled_at: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    env.DB.onQuery(/channel_authorities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        campaign_id: null,
        channel: 'push',
        authority: 'skrip',
        rollout_state: 'enabled',
        feature_flag_key: null,
      },
    ]);

    const policy = await evaluateGrowthPolicy(env as any, {
      subjectId: 'lead@acme.com',
      action: {
        type: AGENT_ACTION_TYPE.ENROLL_SEQUENCE,
        params: { skripPolicy: 'push_assist' },
      },
      riskLevel: 'low',
      confidence: 70,
    });

    expect(policy.allowed).toBe(true);
    expect(policy.effectiveChannels).toContain('email');
    expect(policy.effectiveChannels).toContain('push');
  });

  it('enforces autonomy threshold gate when conversion history is below threshold', async () => {
    const env = createMockEnv({ SKRIP_DEFAULT_ENABLEMENT: 'true' });
    await env.KV_MARKETING.put('growth:autonomy_threshold:send_via_skrip:default', '80');
    env.DB.onQuery(/SELECT COUNT\(\*\) AS count[\s\S]+status IN \('executed', 'outcome_observed', 'no_outcome_observed'\)/i, () => [{ count: 10 }]);
    env.DB.onQuery(/SELECT COUNT\(\*\) AS count[\s\S]+o\.outcome_type = 'conversion'/i, () => [{ count: 1 }]);

    // Make one eligible push identity so the action itself is otherwise allowed.
    env.DB.onQuery(/contact_channel_identities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        external_contact_id: 'lead@acme.com',
        canonical_id: 'skrip_can_1',
        channel: 'push',
        address: 'token_1',
        consent_state: 'opted_in',
        suppression_state: 'clear',
        availability_state: 'available',
        identity_confidence: 1,
        registration_state: 'registered',
        last_reconciled_at: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    env.DB.onQuery(/channel_authorities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        campaign_id: null,
        channel: 'push',
        authority: 'skrip',
        rollout_state: 'enabled',
        feature_flag_key: null,
      },
    ]);

    const policy = await evaluateGrowthPolicy(env as any, {
      subjectId: 'lead@acme.com',
      action: {
        type: AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
        params: {
          campaignId: 'cmp_1',
          interventionMode: 'rescue',
          context: { signalType: 'cold_clicked_no_reply' },
        },
      },
      riskLevel: 'low',
      confidence: 75,
    });

    expect(policy.allowed).toBe(true);
    expect(policy.requiredApproval).toBe(true);
    expect(policy.warnings).toContain('autonomy_threshold_not_met');
    expect(policy.evidence).toHaveProperty('autonomyThreshold');
  });
});