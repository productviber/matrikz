import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { processDueEmails } from '../../src/lib/email';
import { createMockEnv, type MockEnv } from '../helpers';
import { KV_PREFIX, EMAIL_STATUS } from '../../src/constants';

/**
 * P0: Variant persistence at send time.
 *
 * Asserts processDueEmails → processSingleSend:
 *  1. Writes KV ab:send:<email>:<sendId> correlator.
 *  2. Persists rendered_subject, subject_variant_idx, body_variant_idx, brevo_message_id
 *     on email_sends via the UPDATE path.
 *  3. Tags the Brevo provider call with `send:<id>` so webhook events correlate back.
 */

function makeDueRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: 42,
        contact_email: 'lead@example.com',
        sequence_id: 1,
        step_id: 10,
        status: EMAIL_STATUS.SCHEDULED,
        scheduled_at: 1_700_000_000,
        subject: 'Quick SEO check for {{companyName}}',
        template_key: 'cold_outreach',
        sequence_name: 'cold_outreach_v1',
        trigger_event: null,
        context_ref: null,
        ...overrides,
    };
}

describe('processDueEmails — P0 variant persistence', () => {
    let env: MockEnv;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fetchSpy: any;

    beforeEach(() => {
        env = createMockEnv({ ENVIRONMENT: 'production' }) as unknown as MockEnv;
        // Silence noisy console output inside processSingleSend.
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });

        // Stub Brevo HTTP response so sendWithProvider resolves with a messageId.
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            return new Response(JSON.stringify({ messageId: 'brevo-msg-abc-123' }), {
                status: 201,
                headers: { 'content-type': 'application/json' },
            });
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('persists rendered_subject + variant indices + brevo_message_id and writes ab:send KV', async () => {
        const due = makeDueRow();

        // SELECT due sends returns our row; subsequent queries return empty by default.
        env.DB.onQuery(/FROM email_sends es\s+JOIN email_steps est/i, () => [due]);
        // Active campaign lookup (any SELECT against campaigns) → none, so no warmup gate.
        env.DB.onQuery(/FROM marketing_campaigns/i, () => []);
        // Throttle / counter lookups → safe defaults.
        env.DB.onQuery(/FROM domain_send_counts/i, () => []);
        env.DB.onQuery(/FROM email_context/i, () => []);
        env.DB.onQuery(/FROM marketing_contacts/i, () => [
            { email: 'lead@example.com', unsubscribed: 0, status: 'active' },
        ]);
        // Catch-all for any other SELECT.
        env.DB.onQuery(/SELECT/i, () => []);

        const processed = await processDueEmails(env as any, 10, { force: true });

        expect(processed).toBeGreaterThanOrEqual(0); // may be 0 if gated; focus on side effects below.

        // ── Assertion 1: the persist UPDATE ran with rendered_subject + brevo_message_id ──
        const persistQuery = env.DB._queries.find((q) =>
            /UPDATE email_sends\s+SET status\s*=\s*'sent'[\s\S]+rendered_subject\s*=\s*\?[\s\S]+brevo_message_id\s*=\s*\?/i.test(
                q.sql,
            ),
        );
        expect(persistQuery).toBeDefined();
        if (persistQuery) {
            // params order: [sentAt, localMessageId, renderedSubject, subjectVariantIdx, bodyVariantIdx, brevoMessageId, framingTier, id]
            expect(typeof persistQuery.params[1]).toBe('string');
            expect((persistQuery.params[1] as string).length).toBeGreaterThan(0);
            expect(persistQuery.params[5]).toBe('brevo-msg-abc-123');
            // framing_tier is a string (resolved from score) or null for scoreless sends.
            expect(
                persistQuery.params[6] === null || typeof persistQuery.params[6] === 'string',
            ).toBe(true);
            expect(persistQuery.params[7]).toBe(42);
            // rendered_subject should be a non-empty string (template will have had companyName replaced or left as-is).
            expect(typeof persistQuery.params[2]).toBe('string');
            expect((persistQuery.params[2] as string).length).toBeGreaterThan(0);
            // variant indices are either numeric or null but must be present (not undefined).
            expect(persistQuery.params[3] === null || typeof persistQuery.params[3] === 'number').toBe(true);
            expect(persistQuery.params[4] === null || typeof persistQuery.params[4] === 'number').toBe(true);
        }

        // ── Assertion 2: KV ab:send correlator written ──
        const kvKey = `${KV_PREFIX.AB_SEND}lead@example.com:42`;
        const stored = await env.KV_MARKETING.get(kvKey);
        expect(stored).toBeTruthy();
        if (stored) {
            const parsed = JSON.parse(stored);
            expect(parsed.templateKey).toBe('cold_outreach');
            expect(typeof parsed.sentAt).toBe('number');
        }

        // ── Assertion 3: Brevo call tagged with send:<id> ──
        expect(fetchSpy).toHaveBeenCalled();
        const [, init] = fetchSpy.mock.calls[0];
        const body = JSON.parse(((init as RequestInit).body as string) ?? '{}');
        expect(Array.isArray(body.tags)).toBe(true);
        expect(body.tags).toContain('send:42');
        expect(body.tags).toContain('tpl:cold_outreach');
    });

    it('marks the row failed when the provider throws (no rendered_subject persisted)', async () => {
        const due = makeDueRow({ id: 77 });
        env.DB.onQuery(/FROM email_sends es\s+JOIN email_steps est/i, () => [due]);
        env.DB.onQuery(/SELECT/i, () => []);

        fetchSpy.mockImplementationOnce(async () => new Response('boom', { status: 500 }));

        await processDueEmails(env as any, 10, { force: true });

        const failUpdate = env.DB._queries.find((q) =>
            /UPDATE email_sends\s+SET status\s*=\s*'failed'/i.test(q.sql),
        );
        expect(failUpdate).toBeDefined();
        if (failUpdate) {
            expect(failUpdate.params[1]).toBe(77);
        }

        // ab:send correlator must NOT be written when send fails.
        const kvKey = `${KV_PREFIX.AB_SEND}lead@example.com:77`;
        const stored = await env.KV_MARKETING.get(kvKey);
        expect(stored).toBeFalsy();
    });
});
