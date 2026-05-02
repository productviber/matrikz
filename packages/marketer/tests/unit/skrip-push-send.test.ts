/**
 * Admin Push Send Tests
 *
 * Covers: POST /api/admin/push/send — direct push enqueue for product
 * lifecycle events and admin-initiated notifications.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { handleAdminPushSend } from '../../src/routes/admin/skrip';
import { createMockEnv, makeRequest } from '../helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRegisteredIdentity(channel = 'push') {
  return {
    id: 1,
    tenant_id: 'default',
    external_contact_id: 'user@acme.com',
    canonical_id: 'skrip_can_1',
    channel,
    consent_state: 'opted_in',
    suppression_state: 'clear',
    availability_state: 'available',
    identity_confidence: 1,
    registration_state: 'registered',
    last_reconciled_at: null,
    created_at: 1,
    updated_at: 1,
  };
}

function makeEnabledAuthority(channel = 'push', rollout_state = 'enabled') {
  return {
    id: 1,
    tenant_id: 'default',
    campaign_id: 'report-ready',
    channel,
    authority: 'skrip',
    rollout_state,
    feature_flag_key: null,
    created_at: 1,
    updated_at: 1,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('handleAdminPushSend()', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns 400 when contactId is missing', async () => {
    const env = createMockEnv();
    const req = makeRequest('POST', '/api/admin/push/send', {
      campaignId: 'report-ready',
      stepId: 'notify-1',
    });
    const res = await handleAdminPushSend(req, env as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 when campaignId is missing', async () => {
    const env = createMockEnv();
    const req = makeRequest('POST', '/api/admin/push/send', {
      contactId: 'user@acme.com',
      stepId: 'notify-1',
    });
    const res = await handleAdminPushSend(req, env as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 when stepId is missing', async () => {
    const env = createMockEnv();
    const req = makeRequest('POST', '/api/admin/push/send', {
      contactId: 'user@acme.com',
      campaignId: 'report-ready',
    });
    const res = await handleAdminPushSend(req, env as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid JSON body', async () => {
    const env = createMockEnv();
    const req = new Request('https://test.workers.dev/api/admin/push/send', {
      method: 'POST',
      body: 'not-json',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await handleAdminPushSend(req, env as any);
    expect(res.status).toBe(400);
  });

  it('returns 200 with hint when no eligible identities exist', async () => {
    const env = createMockEnv({
      SKRIP_DEFAULT_ENABLEMENT: 'true',
    });
    // no contact_channel_identities rows → no eligible channels
    const req = makeRequest('POST', '/api/admin/push/send', {
      contactId: 'nobody@acme.com',
      campaignId: 'report-ready',
      stepId: 'notify-1',
    });
    const res = await handleAdminPushSend(req, env as any);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { enqueued: unknown[] } };
    expect(body.data.enqueued).toHaveLength(0);
    expect((body.data as any).hint).toBeDefined();
  });

  it('returns 201 and stages outbox row for an enabled identity', async () => {
    const env = createMockEnv({
      SKRIP_DEFAULT_ENABLEMENT: 'true',
    });

    env.DB.onQuery(/FROM contact_channel_identities/i, () => [makeRegisteredIdentity()]);
    env.DB.onQuery(/FROM channel_authorities/i, () => [makeEnabledAuthority()]);

    const req = makeRequest('POST', '/api/admin/push/send', {
      contactId: 'user@acme.com',
      campaignId: 'report-ready',
      stepId: 'notify-1',
      context: { reportUrl: 'https://app.acme.com/report/123', score: 92 },
    });

    const res = await handleAdminPushSend(req, env as any);
    expect(res.status).toBe(201);

    const body = await res.json() as { data: { enqueued: { channel: string; status: string }[] } };
    expect(body.data.enqueued).toHaveLength(1);
    expect(body.data.enqueued[0].channel).toBe('push');
    expect(body.data.enqueued[0].status).toBe('pending');

    const outboxInsert = env.DB._queries.find((q) =>
      q.sql.includes('channel_execution_outbox') && q.sql.toUpperCase().includes('INSERT'),
    );
    expect(outboxInsert).toBeDefined();
    expect(outboxInsert?.params).toContain('user@acme.com');
  });

  it('returns 201 with dry-run status when authority is in dry_run mode', async () => {
    const env = createMockEnv({
      SKRIP_DEFAULT_ENABLEMENT: 'true',
    });

    env.DB.onQuery(/FROM contact_channel_identities/i, () => [makeRegisteredIdentity()]);
    env.DB.onQuery(/FROM channel_authorities/i, () => [makeEnabledAuthority('push', 'dry_run')]);

    const req = makeRequest('POST', '/api/admin/push/send', {
      contactId: 'user@acme.com',
      campaignId: 'report-ready',
      stepId: 'notify-1',
    });

    const res = await handleAdminPushSend(req, env as any);
    expect(res.status).toBe(201);

    const body = await res.json() as { data: { enqueued: { status: string }[] } };
    expect(body.data.enqueued[0].status).toBe('dry_run');
  });
});
