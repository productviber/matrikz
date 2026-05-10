import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { handleVariantMetrics } from '../../src/routes/admin/metrics';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';

/**
 * P0: Variant metrics aggregation endpoint.
 *
 * Asserts handleVariantMetrics:
 *  1. Clamps windowDays between 1 and 365 (default 30).
 *  2. Applies LIMIT (METRICS_LIMITS.MAX_VARIANT_ROWS / MAX_SUBJECT_ROWS = 200).
 *  3. Computes open_rate / click_rate / reply_rate = count / sent, guarding divide-by-zero.
 *  4. Returns { windowDays, totals, byVariant, bySubject } shape.
 */

async function callVariants(env: MockEnv, query = '') {
    const req = makeRequest('GET', `/api/internal/outbound/variants${query}`, undefined, {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleVariantMetrics(req, env as any);
    const json = await res.json();
    return { res, body: (json as any).data ?? json };
}

describe('handleVariantMetrics — P0 aggregation', () => {
    let env: MockEnv;

    beforeEach(() => {
        env = createMockEnv() as unknown as MockEnv;
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => { vi.restoreAllMocks(); });

    it('computes rates correctly and returns expected shape', async () => {
        // byVariant rows (first query: GROUP BY template_key, subject_variant_idx)
        env.DB.onQuery(/GROUP BY[\s\S]+template_key[\s\S]+subject_variant_idx/i, () => [
            { template_key: 'cold_outreach', subject_variant_idx: 0, body_variant_idx: 0, sent: 100, opened: 25, clicked: 5, replied: 1 },
            { template_key: 'cold_outreach', subject_variant_idx: 1, body_variant_idx: 0, sent: 0, opened: 0, clicked: 0, replied: 0 },
        ]);
        // bySubject rows
        env.DB.onQuery(/GROUP BY[\s\S]+rendered_subject/i, () => [
            { rendered_subject: 'Quick SEO check for Acme', template_key: 'cold_outreach', sent: 50, opened: 20, clicked: 4 },
        ]);
        // totals queryOne (no GROUP BY)
        env.DB.onQuery(/FROM email_sends[\s\S]+WHERE status\s*=\s*'sent'\s+AND sent_at\s*>=\s*\?\s*$/im, () => [
            { sent: 100, opened: 25, clicked: 5, replied: 1 },
        ]);
        env.DB.onQuery(/GROUP BY campaign_slug/i, () => [
            { campaign_slug: 'cold-outreach-v1', sent: 100, opened: 25, clicked: 5, replied: 1 },
        ]);

        const { res, body } = await callVariants(env, '?windowDays=30');

        expect(res.status).toBe(200);
        expect(body.windowDays).toBe(30);
        expect(body.totals).toMatchObject({ sent: 100, opened: 25, clicked: 5, replied: 1 });
        expect(Array.isArray(body.byVariant)).toBe(true);
        expect(Array.isArray(body.bySubject)).toBe(true);
        expect(Array.isArray(body.winners)).toBe(true);
        expect(Array.isArray(body.campaignAttribution)).toBe(true);

        const v0 = body.byVariant.find(
            (r: any) => r.template_key === 'cold_outreach' && r.subject_variant_idx === 0,
        );
        expect(v0).toBeDefined();
        expect(v0.open_rate).toBeCloseTo(0.25, 3);
        expect(v0.click_rate).toBeCloseTo(0.05, 3);
        expect(v0.reply_rate).toBeCloseTo(0.01, 3);

        // Divide-by-zero guard: sent=0 must not produce NaN/Infinity.
        const v1 = body.byVariant.find(
            (r: any) => r.template_key === 'cold_outreach' && r.subject_variant_idx === 1,
        );
        expect(v1).toBeDefined();
        expect(Number.isFinite(v1.open_rate)).toBe(true);
        expect(v1.open_rate).toBe(0);

        const s0 = body.bySubject[0];
        expect(s0.open_rate).toBeCloseTo(0.4, 3);
        expect(s0.click_rate).toBeCloseTo(0.08, 3);

        expect(body.winners[0]).toMatchObject({
            template_key: 'cold_outreach',
            subject_variant_idx: 0,
        });
        expect(body.campaignAttribution[0].sent).toBe(100);
        expect(typeof body.campaignAttribution[0].campaign_slug).toBe('string');
    });

    it('clamps windowDays: default 30, cap 365, floor 1', async () => {
        env.DB.onQuery(/SELECT/i, () => []);

        let { body } = await callVariants(env); // no query
        expect(body.windowDays).toBe(30);

        ({ body } = await callVariants(env, '?windowDays=9999'));
        expect(body.windowDays).toBe(365);

        ({ body } = await callVariants(env, '?windowDays=0'));
        expect(body.windowDays).toBeGreaterThanOrEqual(1);

        ({ body } = await callVariants(env, '?windowDays=notanumber'));
        expect(body.windowDays).toBe(30);
    });

    it('enforces LIMIT caps from METRICS_LIMITS on all aggregation queries', async () => {
        env.DB.onQuery(/SELECT/i, () => []);

        await callVariants(env, '?windowDays=7');

        const limited = env.DB._queries.filter((q) => /LIMIT\s+\?/i.test(q.sql));
        // byTier (16), byVariant (200), bySubject (200), byCampaign (50).
        expect(limited.length).toBeGreaterThanOrEqual(3);
        for (const q of limited) {
            const last = q.params[q.params.length - 1];
            expect([16, 50, 200]).toContain(last);
        }
    });

    it('returns zero-defaulted totals when no rows exist', async () => {
        env.DB.onQuery(/SELECT/i, () => []);

        const { res, body } = await callVariants(env, '?windowDays=30');
        expect(res.status).toBe(200);
        expect(body.totals).toMatchObject({ sent: 0, opened: 0, clicked: 0, replied: 0 });
        expect(body.byVariant).toEqual([]);
        expect(body.bySubject).toEqual([]);
    });
});
