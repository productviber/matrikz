import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { handleBrevoWebhook } from '../../src/routes/webhooks';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';
import { KV_PREFIX } from '../../src/constants';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * P0: Webhook engagement update.
 *
 * For opened/click events, handleBrevoWebhook → trackPositiveEvent must:
 *  1. Resolve the email_sends row using the sendId encoded in payload.tag (`send:<id>`).
 *  2. Fall back to brevo_message_id matching when tag is missing.
 *  3. Fall back to latest-sent-by-email when neither correlator is present.
 *  4. UPDATE email_sends with COALESCE(opened_at, ?) and incrementing counters.
 *  5. Call recordVariantEngagement with the row's subject_variant_idx / body_variant_idx.
 */

async function post(env: MockEnv, event: string, extras: Record<string, unknown> = {}) {
    const payload = {
        event,
        email: 'Lead@Example.com',
        ts_event: 1_711_000_000,
        ...extras,
    };
    const req = makeRequest('POST', '/webhooks/brevo', payload);
    return handleBrevoWebhook(req, env as any);
}

describe('handleBrevoWebhook — P0 engagement UPDATE + correlation', () => {
    let env: MockEnv;

    beforeEach(() => {
        env = createMockEnv() as unknown as MockEnv;
        // Disable signature verification path — webhooks.ts tolerates absence of the secret.
        // (Signature behavior already covered by brevo-inbound tests.)
        delete (env as any).BREVO_WEBHOOK_SECRET;
        vi.spyOn(console, 'warn').mockImplementation(() => { });
    });

    afterEach(() => { vi.restoreAllMocks(); });

    it('resolves row via sendId tag and UPDATEs opened_at with COALESCE + open_count+1', async () => {
        // Tier-1 resolver: SELECT … WHERE es.id = ? AND es.contact_email = ?
        env.DB.onQuery(/WHERE es\.id\s*=\s*\?\s+AND\s+es\.contact_email/i, (params) => {
            expect(params[0]).toBe(99);
            expect(String(params[1]).toLowerCase()).toBe('lead@example.com');
            return [{ id: 99, template_key: 'cold_outreach', subject_variant_idx: 1, body_variant_idx: 0 }];
        });

        const res = await post(env, 'opened', { tag: 'send:99', 'message-id': '<brevo-xyz>' });
        expect(res.status).toBeLessThan(500);

        const update = env.DB._queries.find((q) =>
            /UPDATE email_sends\s+SET\s+opened_at\s*=\s*COALESCE\(opened_at,\s*\?\)/i.test(q.sql) &&
            /open_count\s*=\s*open_count\s*\+\s*1/i.test(q.sql),
        );
        expect(update).toBeDefined();
        if (update) {
            // params: [ts, sendId]
            expect(update.params[0]).toBe(1_711_000_000);
            expect(update.params[1]).toBe(99);
        }
    });

    it('click event UPDATEs clicked_at AND opened_at (both COALESCEd) and increments click_count', async () => {
        env.DB.onQuery(/WHERE es\.id\s*=\s*\?\s+AND\s+es\.contact_email/i, () => [
            { id: 7, template_key: 'cold_outreach', subject_variant_idx: 0, body_variant_idx: 2 },
        ]);

        await post(env, 'click', { tag: 'send:7' });

        const update = env.DB._queries.find((q) =>
            /UPDATE email_sends\s+SET\s+clicked_at\s*=\s*COALESCE\(clicked_at,\s*\?\)/i.test(q.sql) &&
            /click_count\s*=\s*click_count\s*\+\s*1/i.test(q.sql) &&
            /opened_at\s*=\s*COALESCE\(opened_at,\s*\?\)/i.test(q.sql),
        );
        expect(update).toBeDefined();
        if (update) {
            // params: [clickTs, clickTs, id]
            expect(update.params[0]).toBe(1_711_000_000);
            expect(update.params[1]).toBe(1_711_000_000);
            expect(update.params[2]).toBe(7);
        }
    });

    it('falls back to brevo_message_id resolver when no send tag is present', async () => {
        // Tier-1 (sendId) never matches because no tag → tier-2 must hit.
        env.DB.onQuery(/WHERE es\.brevo_message_id\s*=\s*\?/i, (params) => {
            expect(params[0]).toBe('<brevo-only-id>');
            return [{ id: 555, template_key: 'cold_outreach', subject_variant_idx: null, body_variant_idx: null }];
        });

        await post(env, 'opened', { 'message-id': '<brevo-only-id>' });

        const update = env.DB._queries.find((q) =>
            /UPDATE email_sends[\s\S]+opened_at\s*=\s*COALESCE/i.test(q.sql),
        );
        expect(update).toBeDefined();
        if (update) {
            expect(update.params[update.params.length - 1]).toBe(555);
        }
    });

    it('falls back to latest-sent-by-email when neither sendId nor messageId is present (legacy rows)', async () => {
        env.DB.onQuery(
            /WHERE es\.contact_email\s*=\s*\?\s+AND\s+es\.status\s*=\s*'sent'[\s\S]+ORDER BY es\.sent_at DESC/i,
            (params) => {
                expect(String(params[0]).toLowerCase()).toBe('lead@example.com');
                return [{ id: 123, template_key: 'cold_outreach', subject_variant_idx: 0, body_variant_idx: 0 }];
            },
        );

        await post(env, 'opened');

        const update = env.DB._queries.find((q) =>
            /UPDATE email_sends[\s\S]+opened_at\s*=\s*COALESCE/i.test(q.sql),
        );
        expect(update).toBeDefined();
        if (update) {
            expect(update.params[update.params.length - 1]).toBe(123);
        }
    });

    it('prefers row-column variant indices and writes ab:variants KV feedback', async () => {
        env.DB.onQuery(/WHERE es\.id\s*=\s*\?\s+AND\s+es\.contact_email/i, () => [
            { id: 11, template_key: 'cold_outreach', subject_variant_idx: 2, body_variant_idx: 1 },
        ]);

        await post(env, 'click', { tag: 'send:11' });

        const raw = await env.KV_MARKETING.get('ab:variants:cold_outreach');
        expect(raw).toBeTruthy();
        if (raw) {
            const data = JSON.parse(raw);
            // recordVariantEngagement applies +5 for click on subject[2] and body[1].
            expect(Array.isArray(data['subject:cold_outreach'])).toBe(true);
            expect(Array.isArray(data['body:cold_outreach'])).toBe(true);
            expect(data['subject:cold_outreach'][2]).toBeGreaterThan(0);
            expect(data['body:cold_outreach'][1]).toBeGreaterThan(0);
        }
    });

    it('falls back to KV ab:send correlator when row variant indices are null', async () => {
        env.DB.onQuery(/WHERE es\.id\s*=\s*\?\s+AND\s+es\.contact_email/i, () => [
            {
                id: 21,
                sequence_id: 77,
                trigger_event: 'outbound.prospect_discovered',
                template_key: 'cold_outreach',
                subject_variant_idx: null,
                body_variant_idx: null,
            },
        ]);
        // Pre-seed KV ab:send correlator (simulates legacy row written before migration 0011).
        await env.KV_MARKETING.put(
            `${KV_PREFIX.AB_SEND}lead@example.com:21`,
            JSON.stringify({ templateKey: 'cold_outreach', subIdx: 1, bodyIdx: 0, sentAt: 1 }),
        );

        await post(env, 'opened', { tag: 'send:21' });

        const raw = await env.KV_MARKETING.get('ab:variants:cold_outreach');
        expect(raw).toBeTruthy();
        if (raw) {
            const data = JSON.parse(raw);
            expect(data['subject:cold_outreach'][1]).toBeGreaterThan(0);
        }
    });

    it('marks cold context as opened and tightens next scheduled touch on open', async () => {
        env.DB.onQuery(/WHERE es\.id\s*=\s*\?\s+AND\s+es\.contact_email/i, () => [
            {
                id: 31,
                sequence_id: 123,
                trigger_event: 'outbound.prospect_discovered',
                template_key: 'cold_outreach',
                subject_variant_idx: 0,
                body_variant_idx: 0,
            },
        ]);

        await env.KV_MARKETING.put('email-ctx:lead@example.com:cold-outreach', JSON.stringify({ domain: 'acme.com' }));
        await env.KV_MARKETING.put('email-ctx:lead@example.com:123', JSON.stringify({ domain: 'acme.com' }));

        await post(env, 'opened', { tag: 'send:31' });

        const coldCtx = JSON.parse((await env.KV_MARKETING.get('email-ctx:lead@example.com:cold-outreach')) as string);
        const seqCtx = JSON.parse((await env.KV_MARKETING.get('email-ctx:lead@example.com:123')) as string);
        expect(coldCtx._hasOpened).toBe(true);
        expect(seqCtx._hasOpened).toBe(true);

        const reschedule = env.DB._queries.find((q) =>
            /UPDATE email_sends[\s\S]+SET scheduled_at = CASE WHEN scheduled_at > \?/i.test(q.sql) &&
            /AND sequence_id = \?/i.test(q.sql),
        );
        expect(reschedule).toBeDefined();
        if (reschedule) {
            // nextAt, nextAt, email, sequence_id, status, ts
            expect(reschedule.params[2]).toBe('lead@example.com');
            expect(reschedule.params[3]).toBe(123);
            expect(reschedule.params[4]).toBe('scheduled');
            expect(Number(reschedule.params[0])).toBe(Number(reschedule.params[5]) + 86_400);
        }
    });

    it('marks click signal and applies faster cadence tightening on click', async () => {
        env.DB.onQuery(/WHERE es\.id\s*=\s*\?\s+AND\s+es\.contact_email/i, () => [
            {
                id: 32,
                sequence_id: 222,
                trigger_event: 'outbound.prospect_discovered',
                template_key: 'cold_outreach',
                subject_variant_idx: 0,
                body_variant_idx: 0,
            },
        ]);

        await env.KV_MARKETING.put('email-ctx:lead@example.com:cold-outreach', JSON.stringify({ domain: 'acme.com' }));
        await env.KV_MARKETING.put('email-ctx:lead@example.com:222', JSON.stringify({ domain: 'acme.com' }));

        await post(env, 'click', { tag: 'send:32' });

        const coldCtx = JSON.parse((await env.KV_MARKETING.get('email-ctx:lead@example.com:cold-outreach')) as string);
        expect(coldCtx._hasOpened).toBe(true);
        expect(coldCtx._hasClicked).toBe(true);

        const reschedule = env.DB._queries.find((q) =>
            /UPDATE email_sends[\s\S]+SET scheduled_at = CASE WHEN scheduled_at > \?/i.test(q.sql) &&
            /AND sequence_id = \?/i.test(q.sql) &&
            q.params[3] === 222,
        );
        expect(reschedule).toBeDefined();
        if (reschedule) {
            expect(Number(reschedule.params[0])).toBe(Number(reschedule.params[5]) + 43_200);
        }
    });
});
