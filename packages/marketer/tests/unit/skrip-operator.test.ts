import { describe, expect, it } from 'vitest';
import { handleSkripAuthorityUpsert, handleSkripOptInFunnel } from '../../src/routes/admin/skrip';
import { createMockEnv, makeRequest } from '../helpers';

describe('Skrip operator controls', () => {
  it('returns opt-in funnel counters, registration states, and eligibility', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/FROM push_opt_in_events\s+WHERE tenant_id/i, () => [
      { event_type: 'subscribed', count: 3 },
      { event_type: 'unsubscribed', count: 1 },
    ]);
    env.DB.onQuery(/FROM contact_channel_identities\s+WHERE tenant_id/i, () => [
      { channel: 'push', registration_state: 'registered', consent_state: 'opted_in', suppression_state: 'clear', availability_state: 'available', count: 2 },
      { channel: 'sms', registration_state: 'pending', consent_state: 'opted_in', suppression_state: 'clear', availability_state: 'available', count: 1 },
    ]);
    env.DB.onQuery(/JOIN channel_authorities/i, () => [
      { channel: 'push', eligible_for_send: 2 },
    ]);
    env.DB.onQuery(/SELECT event_type, contact_id/i, () => [
      { event_type: 'subscribed', contact_id: 'lead@acme.com', browser_session_id: null, correlation_id: 'corr_1', metadata_json: null, occurred_at: 1 },
    ]);

    const response = await handleSkripOptInFunnel(
      makeRequest('GET', '/api/admin/outbound/skrip/opt-in-funnel?tenantId=default&windowDays=7'),
      env as any,
    );
    const body = await response.json() as { data: any };

    expect(response.status).toBe(200);
    expect(body.data.eventsByType[0].event_type).toBe('subscribed');
    expect(body.data.registrationsByState).toHaveLength(2);
    expect(body.data.eligibility[0].eligible_for_send).toBe(2);
  });

  it('upserts channel authority rollout state with validation', async () => {
    const env = createMockEnv();
    const response = await handleSkripAuthorityUpsert(
      makeRequest('POST', '/api/admin/outbound/skrip/authority', {
        tenantId: 'tenant_acme',
        campaignId: 'cmp_1',
        channel: 'push',
        authority: 'skrip',
        rolloutState: 'dry_run',
      }),
      env as any,
    );
    const body = await response.json() as { data: any };

    expect(response.status).toBe(200);
    expect(body.data.rolloutState).toBe('dry_run');
    const upsert = env.DB._queries.find((query) => query.sql.includes('INSERT INTO channel_authorities'));
    expect(upsert).toBeDefined();
    expect(upsert?.params).toContain('tenant_acme');
    expect(upsert?.params).toContain('push');
  });

  it('rejects invalid rollout states', async () => {
    const env = createMockEnv();
    const response = await handleSkripAuthorityUpsert(
      makeRequest('POST', '/api/admin/outbound/skrip/authority', {
        channel: 'push',
        rolloutState: 'live_now',
      }),
      env as any,
    );

    expect(response.status).toBe(400);
  });

  it('updates tenant-level authority rows instead of duplicating NULL campaign scope', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/campaign_id IS NULL LIMIT 1/i, () => [{ id: 42 }]);

    const response = await handleSkripAuthorityUpsert(
      makeRequest('POST', '/api/admin/outbound/skrip/authority', {
        channel: 'push',
        rolloutState: 'enabled',
      }),
      env as any,
    );

    expect(response.status).toBe(200);
    const update = env.DB._queries.find((query) => query.sql.includes('UPDATE channel_authorities'));
    expect(update).toBeDefined();
    expect(update?.params).toContain(42);
  });
});