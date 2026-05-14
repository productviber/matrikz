/**
 * Webhook Handler Tests — Comprehensive coverage for Brevo webhook processing.
 *
 * Tests:
 *   - Payload validation (missing/invalid JSON, missing fields)
 *   - All 9 Brevo event types (delivered, opened, click, hard_bounce, etc.)
 *   - Soft bounce 3-strike escalation
 *   - Permanent suppression + send cancellation
 *   - Deliverability counter increments
 *   - Engagement tracking (opens, clicks)
 *   - Reverse event emission to analytics
 *   - Complaint handling + auto-suppress
 *   - Provider-level unsubscribe
 *   - getDeliverabilityMetrics()
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleBrevoWebhook, getDeliverabilityMetrics } from '../../src/routes/webhooks';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';
import { KV_PREFIX, KV_UNSUBSCRIBE_PREFIX, EMAIL_STATUS, COMPLIANCE } from '../../src/constants';

describe('webhooks — Brevo handler', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
    // Default: UPDATE queries succeed silently
    env.DB.onQuery(/UPDATE email_sends/, () => []);
    // Spy on console
    vi.spyOn(console, 'log').mockImplementation(() => { });
    vi.spyOn(console, 'error').mockImplementation(() => { });
    vi.spyOn(console, 'warn').mockImplementation(() => { });
  });

  // ── Payload Validation ──────────────────────────────────────────────────

  describe('payload validation', () => {
    it('rejects when signing secret is set but signature headers are missing', async () => {
      env.WEBHOOK_SIGNING_SECRET = 'test-secret';
      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'delivered',
        email: 'user@example.com',
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(401);
    });

    it('accepts valid signed payload when signing secret is set', async () => {
      env.WEBHOOK_SIGNING_SECRET = 'test-secret';
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = {
        event: 'delivered',
        email: 'signed@example.com',
        ts_event: timestamp,
      };
      const raw = JSON.stringify(payload);
      const sig = await signForTest(env.WEBHOOK_SIGNING_SECRET, `${timestamp}.${raw}`);

      const req = new Request('https://test.workers.dev/webhooks/brevo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-timestamp': String(timestamp),
          'x-webhook-signature': sig,
        },
        body: raw,
      });

      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);
    });

    it('accepts valid signed payload with sha256= prefix', async () => {
      env.WEBHOOK_SIGNING_SECRET = 'test-secret';
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = {
        event: 'delivered',
        email: 'prefixed@example.com',
        ts_event: timestamp,
      };
      const raw = JSON.stringify(payload);
      const sig = await signForTest(env.WEBHOOK_SIGNING_SECRET, `${timestamp}.${raw}`);

      const req = new Request('https://test.workers.dev/webhooks/brevo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-timestamp': String(timestamp),
          'x-webhook-signature': `sha256=${sig}`,
        },
        body: raw,
      });

      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);
    });

    it('rejects signed payload with invalid signature', async () => {
      env.WEBHOOK_SIGNING_SECRET = 'test-secret';
      const timestamp = Math.floor(Date.now() / 1000);
      const raw = JSON.stringify({ event: 'delivered', email: 'bad-sig@example.com' });

      const req = new Request('https://test.workers.dev/webhooks/brevo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-timestamp': String(timestamp),
          'x-webhook-signature': 'sha256=deadbeef',
        },
        body: raw,
      });

      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(401);
    });

    it('rejects signed payload with stale timestamp', async () => {
      env.WEBHOOK_SIGNING_SECRET = 'test-secret';
      const timestamp = Math.floor(Date.now() / 1000) - 1200;
      const raw = JSON.stringify({ event: 'delivered', email: 'stale@example.com' });
      const sig = await signForTest(env.WEBHOOK_SIGNING_SECRET, `${timestamp}.${raw}`);

      const req = new Request('https://test.workers.dev/webhooks/brevo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-timestamp': String(timestamp),
          'x-webhook-signature': sig,
        },
        body: raw,
      });

      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(401);
    });

    it('rejects invalid JSON', async () => {
      const req = new Request('https://test.workers.dev/webhooks/brevo', {
        method: 'POST',
        body: 'not json{{{',
        headers: { 'Content-Type': 'application/json' },
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error || body.data?.error).toContain('Invalid webhook payload');
    });

    it('rejects missing event field', async () => {
      const req = makeRequest('POST', '/webhooks/brevo', { email: 'a@b.com' });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error || body.data?.error).toContain('Missing event or email');
    });

    it('rejects missing email field', async () => {
      const req = makeRequest('POST', '/webhooks/brevo', { event: 'delivered' });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(400);
    });
  });

  // ── Delivered / Opened / Click ──────────────────────────────────────────

  describe('positive events', () => {
    it('tracks delivered event and increments counter', async () => {
      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'delivered',
        email: 'user@example.com',
        ts_event: 1700000000,
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      const data = body.data ?? body;
      expect(data.processed).toBe(true);
      expect(data.event).toBe('delivered');

      // Check deliverability counter was incremented
      const dateKey = new Date().toISOString().slice(0, 10);
      const counterKey = `${KV_PREFIX.OUTBOUND_DELIVERABILITY}${dateKey}`;
      const counters = JSON.parse(await env.KV_MARKETING.get(counterKey) as string);
      expect(counters.delivered).toBe(1);
    });

    it('tracks opened event with engagement data', async () => {
      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'opened',
        email: 'User@Example.COM',
        ts_event: 1700000100,
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);

      // Check engagement was stored (lowercase email)
      const engKey = `${KV_PREFIX.OUTBOUND_ENGAGEMENT}user@example.com`;
      const engagement = JSON.parse(await env.KV_MARKETING.get(engKey) as string);
      expect(engagement.opened).toBe(1700000100);
      expect(engagement.lastActivity).toBe(1700000100);
    });

    it('tracks click event and preserves prior engagement', async () => {
      // Pre-populate with an opened event
      const engKey = `${KV_PREFIX.OUTBOUND_ENGAGEMENT}user@example.com`;
      await env.KV_MARKETING.put(engKey, JSON.stringify({
        opened: 1700000100,
        lastActivity: 1700000100,
      }));

      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'click',
        email: 'user@example.com',
        ts_event: 1700000200,
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);

      const engagement = JSON.parse(await env.KV_MARKETING.get(engKey) as string);
      expect(engagement.opened).toBe(1700000100); // Preserved
      expect(engagement.click).toBe(1700000200); // Added
      expect(engagement.lastActivity).toBe(1700000200); // Updated
    });
  });

  // ── Hard Bounce / Invalid Email ─────────────────────────────────────────

  describe('permanent bounces', () => {
    it('suppresses email on hard_bounce', async () => {
      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'hard_bounce',
        email: 'bad@example.com',
        reason: 'Mailbox does not exist',
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);

      // Check unsubscribe flag set
      const unsubKey = `${KV_UNSUBSCRIBE_PREFIX}bad@example.com`;
      expect(await env.KV_MARKETING.get(unsubKey)).toBe('1');

      // Check bounce record stored
      const bounceKey = `${KV_PREFIX.OUTBOUND_BOUNCE}bad@example.com`;
      const bounce = JSON.parse(await env.KV_MARKETING.get(bounceKey) as string);
      expect(bounce.type).toBe('hard_bounce');
      expect(bounce.permanent).toBe(true);
      expect(bounce.reason).toBe('Mailbox does not exist');

      // Check sends cancelled
      const cancelQuery = env.DB._queries.find(q => /UPDATE email_sends/.test(q.sql));
      expect(cancelQuery).toBeDefined();
      expect(cancelQuery!.params).toContain(EMAIL_STATUS.CANCELLED);
      expect(cancelQuery!.params).toContain(EMAIL_STATUS.SCHEDULED);
    });

    it('suppresses email on invalid_email', async () => {
      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'invalid_email',
        email: 'invalid@bad.com',
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);

      const unsubKey = `${KV_UNSUBSCRIBE_PREFIX}invalid@bad.com`;
      expect(await env.KV_MARKETING.get(unsubKey)).toBe('1');
    });
  });

  // ── Soft Bounce Escalation ──────────────────────────────────────────────

  describe('soft bounce escalation', () => {
    it('stores first soft bounce without suppression', async () => {
      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'soft_bounce',
        email: 'flaky@example.com',
        reason: 'Mailbox full',
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);

      // Should NOT suppress
      const unsubKey = `${KV_UNSUBSCRIBE_PREFIX}flaky@example.com`;
      expect(await env.KV_MARKETING.get(unsubKey)).toBeNull();

      // Should store bounce record
      const bounceKey = `${KV_PREFIX.OUTBOUND_BOUNCE}soft:flaky@example.com`;
      const bounces = JSON.parse(await env.KV_MARKETING.get(bounceKey) as string);
      expect(bounces).toHaveLength(1);
    });

    it('stores second soft bounce without suppression', async () => {
      // Pre-populate with 1 recent bounce
      const now = Math.floor(Date.now() / 1000);
      const bounceKey = `${KV_PREFIX.OUTBOUND_BOUNCE}soft:flaky@example.com`;
      await env.KV_MARKETING.put(bounceKey, JSON.stringify([now - 3600]));

      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'soft_bounce',
        email: 'flaky@example.com',
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);

      // Still NOT suppressed
      const unsubKey = `${KV_UNSUBSCRIBE_PREFIX}flaky@example.com`;
      expect(await env.KV_MARKETING.get(unsubKey)).toBeNull();

      // Should have 2 bounces
      const bounces = JSON.parse(await env.KV_MARKETING.get(bounceKey) as string);
      expect(bounces).toHaveLength(2);
    });

    it('auto-suppresses after 3 soft bounces within window', async () => {
      const now = Math.floor(Date.now() / 1000);
      const bounceKey = `${KV_PREFIX.OUTBOUND_BOUNCE}soft:flaky@example.com`;
      await env.KV_MARKETING.put(bounceKey, JSON.stringify([now - 7200, now - 3600]));

      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'soft_bounce',
        email: 'flaky@example.com',
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);

      // Should NOW be suppressed
      const unsubKey = `${KV_UNSUBSCRIBE_PREFIX}flaky@example.com`;
      expect(await env.KV_MARKETING.get(unsubKey)).toBe('1');

      // Soft bounce tracking key should be cleaned up
      expect(await env.KV_MARKETING.get(bounceKey)).toBeNull();
    });

    it('does not count bounces outside 7-day window', async () => {
      const now = Math.floor(Date.now() / 1000);
      const eightDaysAgo = now - (8 * 86400);
      const bounceKey = `${KV_PREFIX.OUTBOUND_BOUNCE}soft:old@example.com`;
      // 2 bounces 8 days ago — should be filtered out
      await env.KV_MARKETING.put(bounceKey, JSON.stringify([eightDaysAgo, eightDaysAgo + 100]));

      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'soft_bounce',
        email: 'old@example.com',
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);

      // Should NOT be suppressed — only 1 recent bounce
      const unsubKey = `${KV_UNSUBSCRIBE_PREFIX}old@example.com`;
      expect(await env.KV_MARKETING.get(unsubKey)).toBeNull();
    });
  });

  // ── Spam Complaint ──────────────────────────────────────────────────────

  describe('spam complaints', () => {
    it('permanently suppresses on spam complaint', async () => {
      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'spam',
        email: 'angry@example.com',
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);

      // Suppressed
      const unsubKey = `${KV_UNSUBSCRIBE_PREFIX}angry@example.com`;
      expect(await env.KV_MARKETING.get(unsubKey)).toBe('1');

      // Complaint stored
      const complaintKey = `${KV_PREFIX.OUTBOUND_BOUNCE}complaint:angry@example.com`;
      const complaint = JSON.parse(await env.KV_MARKETING.get(complaintKey) as string);
      expect(complaint.ts).toBeGreaterThan(0);

      // Sends cancelled
      expect(env.DB._queries.some(q => /UPDATE email_sends/.test(q.sql))).toBe(true);
    });
  });

  // ── Provider Unsubscribe ────────────────────────────────────────────────

  describe('provider unsubscribe', () => {
    it('suppresses on List-Unsubscribe click', async () => {
      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'unsubscribed',
        email: 'optout@example.com',
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);

      const unsubKey = `${KV_UNSUBSCRIBE_PREFIX}optout@example.com`;
      expect(await env.KV_MARKETING.get(unsubKey)).toBe('1');
    });
  });

  // ── Blocked Event ───────────────────────────────────────────────────────

  describe('blocked event', () => {
    it('logs but does not suppress', async () => {
      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'blocked',
        email: 'blocked@example.com',
        reason: 'Temporarily blocked by ISP',
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);

      // Should NOT suppress
      const unsubKey = `${KV_UNSUBSCRIBE_PREFIX}blocked@example.com`;
      expect(await env.KV_MARKETING.get(unsubKey)).toBeNull();
    });
  });

  // ── Unknown Event ───────────────────────────────────────────────────────

  describe('unknown events', () => {
    it('handles gracefully without error', async () => {
      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'some_future_event' as any,
        email: 'unknown@example.com',
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);
    });
  });

  // ── Email Normalisation ─────────────────────────────────────────────────

  describe('email normalisation', () => {
    it('lowercases and trims email', async () => {
      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'delivered',
        email: '  User@EXAMPLE.COM  ',
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      const data = body.data ?? body;
      expect(data.email).toBe('user@example.com');
    });
  });

  // ── Deliverability Counters ─────────────────────────────────────────────

  describe('deliverability counters', () => {
    it('accumulates multiple events per day', async () => {
      const events: Array<{ event: string; email: string }> = [
        { event: 'delivered', email: 'a@test.com' },
        { event: 'delivered', email: 'b@test.com' },
        { event: 'opened', email: 'a@test.com' },
        { event: 'click', email: 'a@test.com' },
        { event: 'hard_bounce', email: 'c@test.com' },
        { event: 'spam', email: 'd@test.com' },
      ];

      for (const e of events) {
        const req = makeRequest('POST', '/webhooks/brevo', e);
        await handleBrevoWebhook(req, env as any);
      }

      const dateKey = new Date().toISOString().slice(0, 10);
      const counterKey = `${KV_PREFIX.OUTBOUND_DELIVERABILITY}${dateKey}`;
      const counters = JSON.parse(await env.KV_MARKETING.get(counterKey) as string);

      expect(counters.delivered).toBe(2);
      expect(counters.opened).toBe(1);
      expect(counters.clicked).toBe(1);
      expect(counters.bounced).toBe(1);
      expect(counters.complained).toBe(1);
    });
  });

  // ── getDeliverabilityMetrics ────────────────────────────────────────────

  describe('getDeliverabilityMetrics', () => {
    it('calculates bounce and complaint rates', async () => {
      const dateKey = '2025-01-28';
      const counterKey = `${KV_PREFIX.OUTBOUND_DELIVERABILITY}${dateKey}`;
      await env.KV_MARKETING.put(counterKey, JSON.stringify({
        delivered: 95,
        bounced: 5,
        complained: 1,
        opened: 40,
        clicked: 10,
      }));

      const metrics = await getDeliverabilityMetrics(env.KV_MARKETING as any, dateKey);
      expect(metrics.delivered).toBe(95);
      expect(metrics.bounced).toBe(5);
      expect(metrics.bounceRate).toBeCloseTo(0.05, 2); // 5 / 100
      expect(metrics.complaintRate).toBeCloseTo(0.01, 2); // 1 / 100
    });

    it('returns zero rates when no data', async () => {
      const metrics = await getDeliverabilityMetrics(env.KV_MARKETING as any, '2020-01-01');
      expect(metrics.delivered).toBe(0);
      expect(metrics.bounceRate).toBe(0);
      expect(metrics.complaintRate).toBe(0);
    });
  });

  // ── Reverse Event Emission ──────────────────────────────────────────────

  describe('reverse event emission', () => {
    it('emits tracking event to analytics on delivered', async () => {
      let fetchCalled = false;
      let fetchBody: any = null;

      env.ANALYTICS = {
        async fetch(url: string, init: any) {
          fetchCalled = true;
          fetchBody = JSON.parse(init.body);
          return new Response('{}', { status: 200 });
        },
      } as any;

      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'delivered',
        email: 'tracked@example.com',
        tag: 'campaign-1',
      });

      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);

      // Wait for async emit
      await new Promise(r => setTimeout(r, 50));

      expect(fetchCalled).toBe(true);
      expect(fetchBody.type).toBe('outbound.email_sent');
      expect(fetchBody.source).toBe('visibility-marketing');
      expect(fetchBody.data.prospect_email).toBe('tracked@example.com');
      expect(fetchBody.data.metadata?.tag).toBe('campaign-1');
    });

    it('does not throw if analytics binding is unavailable', async () => {
      env.ANALYTICS = undefined as any;

      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'opened',
        email: 'noanalytics@example.com',
      });

      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200); // No crash
    });
  });

  // ── A/B Variant Engagement Tracking ─────────────────────────────────────

  describe('A/B variant tracking on opens/clicks', () => {
    it('records variant engagement on open when ab:send data exists', async () => {
      // Set up: a send with variant data was stored (legacy row — variant indices not persisted).
      env.DB.onQuery(/FROM email_sends es\s+JOIN email_steps est/i, () => [
        { id: 42, template_key: 'cold-outreach-step1' },
      ]);
      await env.KV_MARKETING.put('ab:send:user@example.com:42', JSON.stringify({
        templateKey: 'cold-outreach-step1',
        subIdx: 2,
        bodyIdx: 1,
      }));

      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'opened',
        email: 'user@example.com',
        ts_event: 1700000100,
      });
      await handleBrevoWebhook(req, env as any);

      // Variant weights should be updated
      const raw = await env.KV_MARKETING.get('ab:variants:cold-outreach-step1');
      expect(raw).toBeTruthy();
      const data = JSON.parse(raw as string);
      // Subject idx 2 should have been bumped (+2 for open)
      expect(data['subject:cold-outreach-step1']).toBeDefined();
      expect(data['subject:cold-outreach-step1'][2]).toBeGreaterThanOrEqual(3); // base(1) + open(2)
    });

    it('records variant engagement on click with +5 weight', async () => {
      env.DB.onQuery(/FROM email_sends es\s+JOIN email_steps est/i, () => [
        { id: 99, template_key: 'cold-outreach-step2' },
      ]);
      await env.KV_MARKETING.put('ab:send:clicker@example.com:99', JSON.stringify({
        templateKey: 'cold-outreach-step2',
        subIdx: 0,
        bodyIdx: 0,
      }));

      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'click',
        email: 'clicker@example.com',
        ts_event: 1700000200,
      });
      await handleBrevoWebhook(req, env as any);

      const raw = await env.KV_MARKETING.get('ab:variants:cold-outreach-step2');
      expect(raw).toBeTruthy();
      const data = JSON.parse(raw as string);
      // Both subject and body index 0 should be bumped (+5 for click)
      expect(data['subject:cold-outreach-step2'][0]).toBeGreaterThanOrEqual(6); // base(1) + click(5)
      expect(data['body:cold-outreach-step2'][0]).toBeGreaterThanOrEqual(6);
    });

    it('does not fail when no ab:send data exists for the email', async () => {
      env.DB.onQuery(/FROM email_sends es\s+JOIN email_steps est/i, () => [
        { id: 50, template_key: 'step1' },
      ]);
      // No ab:send entry → should still succeed

      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'opened',
        email: 'noresult@example.com',
        ts_event: 1700000100,
      });
      const res = await handleBrevoWebhook(req, env as any);
      expect(res.status).toBe(200);
    });

    it('does not attempt A/B tracking for delivered events', async () => {
      const req = makeRequest('POST', '/webhooks/brevo', {
        event: 'delivered',
        email: 'user@example.com',
        ts_event: 1700000000,
      });
      await handleBrevoWebhook(req, env as any);

      // No ab:variants key should be created
      const raw = await env.KV_MARKETING.get('ab:variants:cold-outreach-step1');
      expect(raw).toBeNull();
    });
  });
});

async function signForTest(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
