/**
 * Skrip Registration Tests
 *
 * Covers: contact registration happy path, Skrip-down graceful degradation
 * (keeps pending), and reconciliation of pending identity rows.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { registerContactChannel, reconcilePendingIdentities } from '../../src/lib/skrip/registration';
import { createMockEnv, type MockEnv } from '../helpers';

const mockFetch = vi.fn();
beforeEach(() => { mockFetch.mockClear(); vi.stubGlobal('fetch', mockFetch); });
afterEach(() => vi.unstubAllGlobals());

// ── registerContactChannel() ───────────────────────────────────────────────

describe('registerContactChannel()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv({
      SKRIP_BASE_URL: 'https://api.skrip.example',
      SKRIP_SERVICE_TOKEN: 'tok_test',
      SKRIP_SIGNING_SECRET: 'secret_32_bytes_long_test_string!',
    });
  });

  it('persists pending row then registers with Skrip and marks registered', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ canonicalId: 'skrip_can_1', status: 'created' }),
        { status: 200 },
      ),
    );

    const result = await registerContactChannel(env as any, {
      tenantId: 'default',
      externalContactId: 'lead@acme.com',
      channel: 'push',
      address: '{"endpoint":"https://fcm.googleapis.com/fcm/send/tok"}',
    });

    expect(result.canonicalId).toBe('skrip_can_1');
    expect(result.registrationState).toBe('registered');
    expect(result.skripStatus).toBe('created');
    expect(result.localUpdated).toBe(true);

    const insertQ = env.DB._queries.find(
      (q) => q.sql.includes('INSERT INTO contact_channel_identities'),
    );
    expect(insertQ).toBeDefined();
    expect(insertQ?.params).toContain('lead@acme.com');
    expect(insertQ?.params).toContain('push');
  });

  it('returns pending state when Skrip client is not configured', async () => {
    const unconfiguredEnv = createMockEnv(); // no Skrip vars

    const result = await registerContactChannel(unconfiguredEnv as any, {
      externalContactId: 'lead@acme.com',
      channel: 'push',
      address: '{"endpoint":"https://fcm.googleapis.com/fcm/send/tok"}',
    });

    expect(result.registrationState).toBe('pending');
    expect(result.skripStatus).toBe('local_only');
    expect(result.canonicalId).toBeNull();
    // Local row was still written
    const insertQ = unconfiguredEnv.DB._queries.find(
      (q) => q.sql.includes('INSERT INTO contact_channel_identities'),
    );
    expect(insertQ).toBeDefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('degrades gracefully when Skrip returns 5xx error', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Service Unavailable', { status: 503 }),
    );

    const result = await registerContactChannel(env as any, {
      externalContactId: 'lead@acme.com',
      channel: 'push',
      address: '{"endpoint":"https://fcm.googleapis.com/fcm/send/tok"}',
    });

    expect(result.registrationState).toBe('pending');
    expect(result.canonicalId).toBeNull();
    expect(result.localUpdated).toBe(true);
  });
});

// ── reconcilePendingIdentities() ───────────────────────────────────────────

describe('reconcilePendingIdentities()', () => {
  it('returns zeros when no pending rows exist', async () => {
    const env = createMockEnv({
      SKRIP_BASE_URL: 'https://api.skrip.example',
      SKRIP_SERVICE_TOKEN: 'tok_test',
      SKRIP_SIGNING_SECRET: 'secret_32_bytes_long_test_string!',
    });

    const result = await reconcilePendingIdentities(env as any, 10);
    expect(result).toEqual({ scanned: 0, registered: 0, failed: 0 });
  });

  it('registers pending identity rows and marks them registered', async () => {
    const env = createMockEnv({
      SKRIP_BASE_URL: 'https://api.skrip.example',
      SKRIP_SERVICE_TOKEN: 'tok_test',
      SKRIP_SIGNING_SECRET: 'secret_32_bytes_long_test_string!',
    });

    env.DB.onQuery(/FROM contact_channel_identities\s+WHERE registration_state = 'pending'/i, () => [
      {
        id: 5,
        tenant_id: 'default',
        external_contact_id: 'pending@acme.com',
        canonical_id: null,
        channel: 'push',
        consent_state: 'opted_in',
        suppression_state: 'clear',
        availability_state: 'available',
        identity_confidence: 1,
        registration_state: 'pending',
        last_reconciled_at: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ canonicalId: 'skrip_can_pending_1', status: 'created' }),
        { status: 200 },
      ),
    );

    const result = await reconcilePendingIdentities(env as any, 10);

    expect(result.scanned).toBe(1);
    expect(result.registered).toBe(1);
    expect(result.failed).toBe(0);

    const updateQ = env.DB._queries.find(
      (q) => q.sql.includes('UPDATE contact_channel_identities') && q.params.includes('skrip_can_pending_1'),
    );
    expect(updateQ).toBeDefined();
  });

  it('counts failed when Skrip errors on a row', async () => {
    const env = createMockEnv({
      SKRIP_BASE_URL: 'https://api.skrip.example',
      SKRIP_SERVICE_TOKEN: 'tok_test',
      SKRIP_SIGNING_SECRET: 'secret_32_bytes_long_test_string!',
    });

    env.DB.onQuery(/FROM contact_channel_identities\s+WHERE registration_state = 'pending'/i, () => [
      {
        id: 6, tenant_id: 'default', external_contact_id: 'bad@acme.com', canonical_id: null,
        channel: 'push', consent_state: 'opted_in', suppression_state: 'clear',
        availability_state: 'available', identity_confidence: 1, registration_state: 'pending',
        last_reconciled_at: null, created_at: 1, updated_at: 1,
      },
    ]);

    mockFetch.mockResolvedValueOnce(new Response('Error', { status: 500 }));

    const result = await reconcilePendingIdentities(env as any, 10);

    expect(result.scanned).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.registered).toBe(0);
  });
});
