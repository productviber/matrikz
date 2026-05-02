import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { handlePruneVariants } from '../../src/routes/admin/metrics';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';

/**
 * P2b: Prune-weakest admin endpoint.
 *
 * Asserts handlePruneVariants:
 *  1. Validates inputs (templateKey, tier, variantType).
 *  2. Honours dryRun (default true) — never writes to KV unless dryRun:false.
 *  3. Skips prune when fewer than MIN_ELIGIBLE_VARIANTS hit minSamples.
 *  4. Skips prune when weakest ≥ 50% of pool median.
 *  5. Prunes the lowest-score variant that beats the threshold.
 *  6. Writes weight=0 at that index under the tier-scoped KV poolKey.
 */

async function callPrune(env: MockEnv, body: Record<string, unknown>) {
    const req = makeRequest('POST', '/api/internal/outbound/variants/prune', body, {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handlePruneVariants(req, env as any);
    const json = await res.json();
    return { res, body: (json as any).data ?? json };
}

const TPL = 'cold-outreach-step1';
const TIER = 'standard';
const POOL_KEY = `subject:${TPL}:${TIER}`;

describe('handlePruneVariants — P2b', () => {
    let env: MockEnv;

    beforeEach(() => {
        env = createMockEnv() as unknown as MockEnv;
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => { vi.restoreAllMocks(); });

    it('rejects non-POST', async () => {
        const req = makeRequest('GET', '/api/internal/outbound/variants/prune');
        const res = await handlePruneVariants(req, env as any);
        expect(res.status).toBe(400);
    });

    it('rejects invalid inputs', async () => {
        const { res } = await callPrune(env, { templateKey: '', tier: 'bad', variantType: 'subject' });
        expect(res.status).toBe(400);
    });

    it('returns no_candidate when too few variants meet minSamples', async () => {
        env.DB.onQuery(/GROUP BY subject_variant_idx/i, () => [
            { idx: 0, sent: 100, opened: 30, clicked: 5, replied: 1 },
            { idx: 1, sent: 5, opened: 0, clicked: 0, replied: 0 }, // below minSamples
        ]);

        const { res, body } = await callPrune(env, {
            templateKey: TPL,
            tier: TIER,
            variantType: 'subject',
            dryRun: true,
        });
        expect(res.status).toBe(200);
        expect(body.action).toBe('no_candidate');
        expect(body.reason).toBe('insufficient_eligible_variants');
    });

    it('returns no_candidate when weakest score is above threshold', async () => {
        // Three eligible variants with similar scores — weakest still > 50% of median.
        env.DB.onQuery(/GROUP BY subject_variant_idx/i, () => [
            { idx: 0, sent: 100, opened: 30, clicked: 5, replied: 1 }, // score high
            { idx: 1, sent: 100, opened: 25, clicked: 4, replied: 1 }, // mid
            { idx: 2, sent: 100, opened: 22, clicked: 3, replied: 1 }, // weakest but similar
        ]);

        const { res, body } = await callPrune(env, {
            templateKey: TPL,
            tier: TIER,
            variantType: 'subject',
            dryRun: true,
        });
        expect(res.status).toBe(200);
        expect(body.action).toBe('no_candidate');
        expect(body.reason).toBe('weakest_above_threshold');
    });

    it('returns dry_run report when weakest qualifies but dryRun=true (no KV write)', async () => {
        env.DB.onQuery(/GROUP BY subject_variant_idx/i, () => [
            { idx: 0, sent: 100, opened: 50, clicked: 20, replied: 5 }, // strong
            { idx: 1, sent: 100, opened: 40, clicked: 15, replied: 4 }, // strong
            { idx: 2, sent: 100, opened: 2, clicked: 0, replied: 0 },   // very weak
        ]);

        const { res, body } = await callPrune(env, {
            templateKey: TPL,
            tier: TIER,
            variantType: 'subject',
            dryRun: true,
        });
        expect(res.status).toBe(200);
        expect(body.action).toBe('dry_run');
        expect(body.wouldPrune.idx).toBe(2);

        // KV was NOT written.
        const kvAfter = await env.KV_MARKETING.get(`ab:variants:${TPL}`);
        expect(kvAfter).toBeNull();
    });

    it('writes weight=0 at weakest index when dryRun=false', async () => {
        env.DB.onQuery(/GROUP BY subject_variant_idx/i, () => [
            { idx: 0, sent: 100, opened: 50, clicked: 20, replied: 5 },
            { idx: 1, sent: 100, opened: 40, clicked: 15, replied: 4 },
            { idx: 2, sent: 100, opened: 2, clicked: 0, replied: 0 },
        ]);
        // Seed existing weights so we can assert preservation of non-pruned slots.
        await env.KV_MARKETING.put(
            `ab:variants:${TPL}`,
            JSON.stringify({ [POOL_KEY]: [10, 8, 3] }),
        );

        const { res, body } = await callPrune(env, {
            templateKey: TPL,
            tier: TIER,
            variantType: 'subject',
            dryRun: false,
        });
        expect(res.status).toBe(200);
        expect(body.action).toBe('pruned');
        expect(body.pruned.idx).toBe(2);

        const raw = await env.KV_MARKETING.get(`ab:variants:${TPL}`);
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw as string);
        expect(parsed[POOL_KEY][0]).toBe(10);
        expect(parsed[POOL_KEY][1]).toBe(8);
        expect(parsed[POOL_KEY][2]).toBe(0); // pruned
    });

    it('returns no_candidate when weakest is already disabled (weight=0)', async () => {
        env.DB.onQuery(/GROUP BY subject_variant_idx/i, () => [
            { idx: 0, sent: 100, opened: 50, clicked: 20, replied: 5 },
            { idx: 1, sent: 100, opened: 40, clicked: 15, replied: 4 },
            { idx: 2, sent: 100, opened: 2, clicked: 0, replied: 0 },
        ]);
        await env.KV_MARKETING.put(
            `ab:variants:${TPL}`,
            JSON.stringify({ [POOL_KEY]: [10, 8, 0] }), // idx 2 already disabled
        );

        const { res, body } = await callPrune(env, {
            templateKey: TPL,
            tier: TIER,
            variantType: 'subject',
            dryRun: false,
        });
        expect(res.status).toBe(200);
        expect(body.action).toBe('no_candidate');
        expect(body.reason).toBe('weakest_already_disabled');
    });
});
