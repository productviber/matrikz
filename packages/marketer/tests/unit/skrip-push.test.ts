/**
 * Skrip Push Subscription Route Tests
 *
 * Covers: subscribe happy path, unsubscribe, missing subscription object,
 * invalid endpoint, and graceful degradation when Skrip is down.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { handlePushSubscribe, handlePushUnsubscribe } from '../../src/routes/skrip-push';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';

const mockFetch = vi.fn();
beforeEach(() => { mockFetch.mockClear(); vi.stubGlobal('fetch', mockFetch); });
afterEach(() => vi.unstubAllGlobals());

// ── POST /api/push/subscribe ───────────────────────────────────────────────

describe('handlePushSubscribe()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('returns 201 and logs the opt-in event for an identified contact', async () => {
    // Skrip not configured — should degrade gracefully
    const req = makeRequest('POST', '/api/push/subscribe', {
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/tok123',
        keys: { p256dh: 'abc', auth: 'xyz' },
      },
      contactId: 'lead@acme.com',
      tenantId: 'default',
      browserSessionId: 'sess_1',
    });

    const res = await handlePushSubscribe(req, env as any);
    expect(res.status).toBe(201);

    const body = await res.json() as { ok: boolean; data: { registered: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.registered).toBe(true);

    const insertQ = env.DB._queries.find((q) =>
      q.sql.includes('INSERT INTO push_opt_in_events') && q.params.includes('lead@acme.com'),
    );
    expect(insertQ).toBeDefined();
    expect(insertQ?.sql).toContain('subscribed');
  });

  it('returns 201 even for anonymous sessions (no contactId)', async () => {
    const req = makeRequest('POST', '/api/push/subscribe', {
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/anon_tok',
      },
      browserSessionId: 'sess_anon',
    });

    const res = await handlePushSubscribe(req, env as any);
    expect(res.status).toBe(201);

    const body = await res.json() as { ok: boolean; data: { registered: boolean } };
    expect(body.data.registered).toBe(false);
  });

  it('returns 400 when subscription object is missing', async () => {
    const req = makeRequest('POST', '/api/push/subscribe', { contactId: 'lead@acme.com' });
    const res = await handlePushSubscribe(req, env as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 when endpoint is not an https URL', async () => {
    const req = makeRequest('POST', '/api/push/subscribe', {
      subscription: { endpoint: 'http://insecure.example.com/sub' },
    });
    const res = await handlePushSubscribe(req, env as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is not valid JSON', async () => {
    const req = new Request('https://test.workers.dev/api/push/subscribe', {
      method: 'POST',
      body: 'not-json',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await handlePushSubscribe(req, env as any);
    expect(res.status).toBe(400);
  });
});

// ── DELETE /api/push/unsubscribe ───────────────────────────────────────────

describe('handlePushUnsubscribe()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('returns 200 and logs the unsubscribe event for an identified contact', async () => {
    const req = makeRequest('DELETE', '/api/push/unsubscribe', {
      contactId: 'lead@acme.com',
      tenantId: 'default',
    });

    const res = await handlePushUnsubscribe(req, env as any);
    expect(res.status).toBe(200);

    const insertQ = env.DB._queries.find((q) =>
      q.sql.includes('INSERT INTO push_opt_in_events') && q.params.includes('lead@acme.com'),
    );
    expect(insertQ).toBeDefined();
    expect(insertQ?.sql).toContain('unsubscribed');

    const updateQ = env.DB._queries.find((q) =>
      q.sql.includes('UPDATE contact_channel_identities') && q.params.includes('lead@acme.com'),
    );
    expect(updateQ).toBeDefined();
  });

  it('returns 200 for anonymous unsubscribe (no contactId)', async () => {
    const req = makeRequest('DELETE', '/api/push/unsubscribe', {
      browserSessionId: 'sess_anon',
    });

    const res = await handlePushUnsubscribe(req, env as any);
    expect(res.status).toBe(200);

    const updateQ = env.DB._queries.find((q) =>
      q.sql.includes('UPDATE contact_channel_identities'),
    );
    // Should NOT attempt an identity update for anonymous contact
    expect(updateQ).toBeUndefined();
  });

  it('returns 400 when body is not valid JSON', async () => {
    const req = new Request('https://test.workers.dev/api/push/unsubscribe', {
      method: 'DELETE',
      body: 'bad',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await handlePushUnsubscribe(req, env as any);
    expect(res.status).toBe(400);
  });
});
