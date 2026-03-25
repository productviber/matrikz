/**
 * Tests — Brevo Inbound Webhook (Reply Detection)
 *
 * Covers handleBrevoInbound(): inbound email parsing, sequence auto-pause,
 * status update to 'engaged', KV reply metadata, analytics event emission,
 * suppressed contact guard, and reply→A/B variant tracking.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleBrevoInbound } from '../../src/routes/webhooks';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';
import { KV_PREFIX, EMAIL_STATUS, KV_UNSUBSCRIBE_PREFIX } from '../../src/constants';

describe('handleBrevoInbound — reply detection', () => {
    let env: MockEnv;

    beforeEach(() => {
        env = createMockEnv();
        // Default: UPDATE queries succeed
        env.DB.onQuery(/UPDATE email_sends/, () => []);
        env.DB.onQuery(/UPDATE marketing_contacts/, () => []);
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
    });

    // ── Payload Validation ──────────────────────────────────────────────────

    it('rejects invalid JSON', async () => {
        const req = new Request('https://test.workers.dev/webhooks/brevo/inbound', {
            method: 'POST',
            body: 'not json{',
            headers: { 'Content-Type': 'application/json' },
        });
        const res = await handleBrevoInbound(req, env as any);
        expect(res.status).toBe(400);
    });

    it('rejects when signing secret is set but signature headers are missing', async () => {
        env.WEBHOOK_SIGNING_SECRET = 'test-secret';
        const req = makeRequest('POST', '/webhooks/brevo/inbound', {
            From: { Address: 'prospect@company.com' },
            Subject: 'Re: Hello',
        });
        const res = await handleBrevoInbound(req, env as any);
        expect(res.status).toBe(401);
    });

    it('accepts valid signed inbound payload', async () => {
        env.WEBHOOK_SIGNING_SECRET = 'test-secret';
        const timestamp = Math.floor(Date.now() / 1000);
        const payload = {
            From: { Address: 'prospect@company.com' },
            Subject: 'Re: Hello',
        };
        const raw = JSON.stringify(payload);
        const sig = await signForTest(env.WEBHOOK_SIGNING_SECRET, `${timestamp}.${raw}`);

        const req = new Request('https://test.workers.dev/webhooks/brevo/inbound', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-timestamp': String(timestamp),
                'x-webhook-signature': `sha256=${sig}`,
            },
            body: raw,
        });

        const res = await handleBrevoInbound(req, env as any);
        expect(res.status).toBe(200);
    });

    it('rejects inbound payload with invalid signature', async () => {
        env.WEBHOOK_SIGNING_SECRET = 'test-secret';
        const timestamp = Math.floor(Date.now() / 1000);
        const raw = JSON.stringify({
            From: { Address: 'prospect@company.com' },
            Subject: 'Re: Hello',
        });

        const req = new Request('https://test.workers.dev/webhooks/brevo/inbound', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-timestamp': String(timestamp),
                'x-webhook-signature': 'sha256=deadbeef',
            },
            body: raw,
        });

        const res = await handleBrevoInbound(req, env as any);
        expect(res.status).toBe(401);
    });

    it('rejects missing sender email', async () => {
        const req = makeRequest('POST', '/webhooks/brevo/inbound', {
            From: {},
            Subject: 'Re: Hello',
        });
        const res = await handleBrevoInbound(req, env as any);
        expect(res.status).toBe(400);
        const body = await res.json() as any;
        const msg = body.error || body.data?.error;
        expect(msg).toContain('Missing sender email');
    });

    // ── Successful Reply Processing ─────────────────────────────────────────

    it('returns 200 for valid inbound reply', async () => {
        const req = makeRequest('POST', '/webhooks/brevo/inbound', {
            From: { Address: 'prospect@company.com' },
            Subject: 'Re: Quick question about your SEO',
        });
        const res = await handleBrevoInbound(req, env as any);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        const data = body.data ?? body;
        expect(data.processed).toBe(true);
        expect(data.action).toBe('reply_detected');
        expect(data.email).toBe('prospect@company.com');
    });

    it('cancels scheduled sends for the contact', async () => {
        const req = makeRequest('POST', '/webhooks/brevo/inbound', {
            From: { Address: 'PROSPECT@Company.COM' },
            Subject: 'Re: Hello',
        });
        await handleBrevoInbound(req, env as any);

        const cancelQuery = env.DB._queries.find(q => /UPDATE email_sends/.test(q.sql));
        expect(cancelQuery).toBeDefined();
        expect(cancelQuery!.params).toContain(EMAIL_STATUS.CANCELLED);
        expect(cancelQuery!.params).toContain('prospect@company.com'); // lowercased
        expect(cancelQuery!.params).toContain(EMAIL_STATUS.SCHEDULED);
    });

    it('updates marketing contact status to engaged', async () => {
        const req = makeRequest('POST', '/webhooks/brevo/inbound', {
            From: { Address: 'prospect@company.com' },
            Subject: 'Re: Hello',
        });
        await handleBrevoInbound(req, env as any);

        const updateQuery = env.DB._queries.find(q => /UPDATE marketing_contacts/.test(q.sql));
        expect(updateQuery).toBeDefined();
        expect(updateQuery!.params).toContain('prospect@company.com');
    });

    it('stores reply metadata in KV', async () => {
        const req = makeRequest('POST', '/webhooks/brevo/inbound', {
            From: { Address: 'prospect@company.com' },
            Subject: 'Re: Your audit results',
        });
        await handleBrevoInbound(req, env as any);

        const replyKey = `${KV_PREFIX.OUTBOUND_ENGAGEMENT}reply:prospect@company.com`;
        const raw = await env.KV_MARKETING.get(replyKey);
        expect(raw).toBeTruthy();
        const data = JSON.parse(raw!);
        expect(data.from).toBe('prospect@company.com');
        expect(data.subject).toBe('Re: Your audit results');
        expect(data.ts).toBeGreaterThan(0);
    });

    it('emits reply event to analytics service binding', async () => {
        // Use a fetcher that records calls
        const fetchCalls: string[] = [];
        env.ANALYTICS = {
            async fetch(url: string | URL, init?: RequestInit) {
                fetchCalls.push(typeof url === 'string' ? url : url.toString());
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            },
        } as any;

        const req = makeRequest('POST', '/webhooks/brevo/inbound', {
            From: { Address: 'prospect@company.com' },
            Subject: 'Re: Hello',
        });
        await handleBrevoInbound(req, env as any);

        expect(fetchCalls.length).toBeGreaterThan(0);
        expect(fetchCalls[0]).toContain('/api/events');
    });

    it('handles missing analytics binding gracefully', async () => {
        (env as any).ANALYTICS = undefined;

        const req = makeRequest('POST', '/webhooks/brevo/inbound', {
            From: { Address: 'prospect@company.com' },
            Subject: 'Re: Hello',
        });
        const res = await handleBrevoInbound(req, env as any);
        // Should still succeed even without analytics binding
        expect(res.status).toBe(200);
    });

    it('normalises email to lowercase', async () => {
        const req = makeRequest('POST', '/webhooks/brevo/inbound', {
            From: { Address: '  UPPER@Example.COM  ' },
            Subject: 'Re: Hello',
        });
        const res = await handleBrevoInbound(req, env as any);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        const data = body.data ?? body;
        expect(data.email).toBe('upper@example.com');
    });

    it('stores null subject when Subject is missing', async () => {
        const req = makeRequest('POST', '/webhooks/brevo/inbound', {
            From: { Address: 'prospect@company.com' },
        });
        await handleBrevoInbound(req, env as any);

        const replyKey = `${KV_PREFIX.OUTBOUND_ENGAGEMENT}reply:prospect@company.com`;
        const raw = await env.KV_MARKETING.get(replyKey);
        expect(raw).toBeTruthy();
        const data = JSON.parse(raw!);
        expect(data.subject).toBeNull();
    });

    // ── Suppressed Contact Guard ────────────────────────────────────────────

    it('returns suppressed_contact_replied for unsubscribed contacts', async () => {
        // Pre-set unsubscribe flag
        await env.KV_MARKETING.put(`${KV_UNSUBSCRIBE_PREFIX}prospect@company.com`, '1');

        const req = makeRequest('POST', '/webhooks/brevo/inbound', {
            From: { Address: 'prospect@company.com' },
            Subject: 'Re: Hello',
        });
        const res = await handleBrevoInbound(req, env as any);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        const data = body.data ?? body;
        expect(data.action).toBe('suppressed_contact_replied');
    });

    it('does not cancel sends for suppressed contacts', async () => {
        await env.KV_MARKETING.put(`${KV_UNSUBSCRIBE_PREFIX}prospect@company.com`, '1');

        const req = makeRequest('POST', '/webhooks/brevo/inbound', {
            From: { Address: 'prospect@company.com' },
            Subject: 'Re: Hello',
        });
        await handleBrevoInbound(req, env as any);

        const cancelQuery = env.DB._queries.find(q => /UPDATE email_sends/.test(q.sql));
        expect(cancelQuery).toBeUndefined();
    });

    // ── Reply → A/B Variant Tracking ────────────────────────────────────────

    it('credits A/B variant on reply when ab:send data exists', async () => {
        // Set up a sent email and its A/B data
        env.DB.onQuery(/SELECT.*email_sends.*status.*sent/s, () => [
            { id: 100, template_key: 'cold-outreach-step1' }
        ]);
        await env.KV_MARKETING.put(
            'ab:send:prospect@company.com:100',
            JSON.stringify({ templateKey: 'cold-outreach-step1', subIdx: 2, bodyIdx: 1 })
        );

        const req = makeRequest('POST', '/webhooks/brevo/inbound', {
            From: { Address: 'prospect@company.com' },
            Subject: 'Re: Hello',
        });
        await handleBrevoInbound(req, env as any);

        // Check that variant weights were updated with +10 for reply
        const variantsRaw = await env.KV_MARKETING.get('ab:variants:cold-outreach-step1');
        expect(variantsRaw).not.toBeNull();
        const variants = JSON.parse(variantsRaw!);
        // Subject variant at idx 2 should have base (1) + reply bonus (10) = 11
        expect(variants['subject:cold-outreach-step1'][2]).toBe(11);
        // Body variant at idx 1 should have base (1) + reply bonus (10) = 11
        expect(variants['body:cold-outreach-step1'][1]).toBe(11);
    });

    it('handles reply A/B tracking when no ab:send data exists', async () => {
        env.DB.onQuery(/SELECT.*email_sends.*status.*sent/s, () => [
            { id: 101, template_key: 'cold-outreach-step1' }
        ]);
        // No ab:send data in KV

        const req = makeRequest('POST', '/webhooks/brevo/inbound', {
            From: { Address: 'prospect@company.com' },
            Subject: 'Re: Hello',
        });
        const res = await handleBrevoInbound(req, env as any);
        // Should still succeed
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        const data = body.data ?? body;
        expect(data.action).toBe('reply_detected');
    });

    it('handles reply A/B tracking when no sent email exists', async () => {
        // No sent emails for this contact
        env.DB.onQuery(/SELECT.*email_sends.*status.*sent/s, () => []);

        const req = makeRequest('POST', '/webhooks/brevo/inbound', {
            From: { Address: 'prospect@company.com' },
            Subject: 'Re: Hello',
        });
        const res = await handleBrevoInbound(req, env as any);
        expect(res.status).toBe(200);
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
