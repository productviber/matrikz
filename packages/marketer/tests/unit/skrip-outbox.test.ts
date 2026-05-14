import { describe, expect, it } from 'vitest';
import { enqueueEligibleSkripChannels } from '../../src/lib/skrip/outbox';
import { createMockEnv } from '../helpers';

describe('enqueueEligibleSkripChannels', () => {
  it('creates a dry-run outbox row for an eligible contact channel identity', async () => {
    const env = createMockEnv({
      SKRIP_DEFAULT_ENABLEMENT: 'true',
    });

    env.DB.onQuery(/FROM contact_channel_identities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        external_contact_id: 'lead@example.com',
        canonical_id: 'skrip_can_1',
        channel: 'push',
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
    env.DB.onQuery(/FROM channel_authorities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        campaign_id: 'cmp_1',
        channel: 'push',
        authority: 'skrip',
        rollout_state: 'dry_run',
        feature_flag_key: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);

    const result = await enqueueEligibleSkripChannels(env as any, {
      campaignId: 'cmp_1',
      stepId: 'step_push_1',
      contactId: 'lead@example.com',
      domain: 'acme.com',
      context: { domain: 'acme.com' },
      scheduleAt: 1_714_652_800,
    });

    expect(result).toHaveLength(1);
    expect(result[0].channel).toBe('push');
    expect(result[0].status).toBe('dry_run');

    const insert = env.DB._queries.find((query) =>
      query.sql.includes('INSERT OR IGNORE INTO channel_execution_outbox'),
    );
    expect(insert).toBeDefined();
    expect(insert?.params).toContain('push');
    expect(insert?.params).toContain('dry_run');
  });

  it('filters candidate identities with allowedChannels', async () => {
    const env = createMockEnv({
      SKRIP_DEFAULT_ENABLEMENT: 'true',
    });

    env.DB.onQuery(/FROM contact_channel_identities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        external_contact_id: 'lead@example.com',
        canonical_id: 'skrip_can_1',
        channel: 'push',
        consent_state: 'opted_in',
        suppression_state: 'clear',
        availability_state: 'available',
        identity_confidence: 1,
        registration_state: 'registered',
        last_reconciled_at: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 2,
        tenant_id: 'default',
        external_contact_id: 'lead@example.com',
        canonical_id: 'skrip_can_2',
        channel: 'whatsapp',
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
    env.DB.onQuery(/FROM channel_authorities/i, (params) => [
      {
        id: 1,
        tenant_id: 'default',
        campaign_id: 'cmp_1',
        channel: String(params?.[1] ?? 'push'),
        authority: 'skrip',
        rollout_state: 'dry_run',
        feature_flag_key: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);

    const result = await enqueueEligibleSkripChannels(env as any, {
      campaignId: 'cmp_1',
      stepId: 'step_secondary',
      contactId: 'lead@example.com',
      domain: 'acme.com',
      context: { domain: 'acme.com' },
      scheduleAt: 1_714_652_800,
      allowedChannels: ['whatsapp'],
    });

    expect(result).toHaveLength(1);
    expect(result[0].channel).toBe('whatsapp');
  });

  it('applies fallbackChain priority order when staging channels', async () => {
    const env = createMockEnv({
      SKRIP_DEFAULT_ENABLEMENT: 'true',
    });

    env.DB.onQuery(/FROM contact_channel_identities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        external_contact_id: 'lead@example.com',
        canonical_id: 'skrip_can_push',
        channel: 'push',
        consent_state: 'opted_in',
        suppression_state: 'clear',
        availability_state: 'available',
        identity_confidence: 1,
        registration_state: 'registered',
        last_reconciled_at: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 2,
        tenant_id: 'default',
        external_contact_id: 'lead@example.com',
        canonical_id: 'skrip_can_whatsapp',
        channel: 'whatsapp',
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
    env.DB.onQuery(/FROM channel_authorities/i, (params) => [
      {
        id: 1,
        tenant_id: 'default',
        campaign_id: 'cmp_1',
        channel: String(params?.[1] ?? 'push'),
        authority: 'skrip',
        rollout_state: 'dry_run',
        feature_flag_key: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);

    const result = await enqueueEligibleSkripChannels(env as any, {
      campaignId: 'cmp_1',
      stepId: 'step_secondary',
      contactId: 'lead@example.com',
      domain: 'acme.com',
      context: { domain: 'acme.com' },
      scheduleAt: 1_714_652_800,
      allowedChannels: ['push', 'whatsapp'],
      fallbackChain: ['whatsapp', 'push'],
    });

    expect(result).toHaveLength(2);
    expect(result[0].channel).toBe('whatsapp');
    expect(result[1].channel).toBe('push');
  });
});