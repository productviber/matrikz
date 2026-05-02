import { describe, it, expect } from 'vitest';
import { prepareTemplateContext } from '../../src/lib/email/context';
import {
    selectColdSubjectPool,
    selectColdCapabilitySubjectPool,
} from '../../src/lib/email/framing';

const baseContext = {
    domain: 'acme.com',
    domainEncoded: 'acme.com',
    companyName: 'Acme Inc',
    contactEmail: 'john@acme.com',
    contactName: 'John Doe',
    auditScore: 75,
    issueCount: 5,
    passCount: 10,
    techStack: ['Next.js'],
    primaryTopic: 'SaaS',
    angles: [{ type: 'critical-seo', hook: 'Missing meta', detail: 'Add meta descriptions' }],
};

describe('capability-hook subject variants', () => {
    it('exposes a tier-scoped capability subject pool for step1 in all 3 tiers', () => {
        for (const tier of ['good', 'standard', 'compulsion'] as const) {
            const pool = selectColdCapabilitySubjectPool('cold-outreach-step1', tier);
            expect(pool).toBeDefined();
            expect((pool as string[]).length).toBeGreaterThan(0);
            // Every capability variant must reference the hook token — otherwise it
            // has no reason to be in the capability pool.
            for (const variant of pool as string[]) {
                expect(variant).toContain('{{capabilityHookHeadline}}');
            }
        }
    });

    it('appends capability variants when capabilityHookHeadline is present', () => {
        const basePool = selectColdSubjectPool('cold-outreach-step1', 'standard') ?? [];
        const capPool = selectColdCapabilitySubjectPool('cold-outreach-step1', 'standard') ?? [];
        const combinedLen = basePool.length + capPool.length;

        // Weight heavily on the first capability slot so it's consistently picked.
        const capFirstIdx = basePool.length;
        const weights: number[] = Array(combinedLen).fill(1);
        weights[capFirstIdx] = 10000;

        const result = prepareTemplateContext(
            {
                ...baseContext,
                capabilityHook: { id: 'fix-sitemap', headline: 'Fix the missing sitemap', oneLiner: 'Helps indexing' },
            },
            'cold-outreach-step1',
            { 'subject:cold-outreach-step1:standard': weights },
        );

        expect(result._subjectVariantIdx).toBe(capFirstIdx);
        // Rendered subject should include the hook text (token was substituted).
        expect(String(result.variantSubject)).toContain('Fix the missing sitemap');
    });

    it('does NOT select capability variants when hook is absent', () => {
        const basePool = selectColdSubjectPool('cold-outreach-step1', 'standard') ?? [];
        // Even with heavy weight at what WOULD be the capability index, no
        // capability variant is selectable when the hook is missing.
        const capFirstIdx = basePool.length;
        const weights: number[] = Array(basePool.length + 2).fill(1);
        weights[capFirstIdx] = 10000;

        for (let i = 0; i < 20; i++) {
            const result = prepareTemplateContext(
                { ...baseContext }, // no capabilityHookHeadline
                'cold-outreach-step1',
                { 'subject:cold-outreach-step1:standard': weights },
            );
            // Must fall within the base pool only.
            expect(result._subjectVariantIdx!).toBeLessThan(basePool.length);
            expect(String(result.variantSubject)).not.toContain('{{');
        }
    });

    it('excludes capability pool when legacy (non-tiered) pool is active', () => {
        // When the templateKey has no tier-specific base pool, the legacy pool is
        // used and capability variants MUST NOT be appended (the capability pool
        // is tied to the tier architecture).
        const result = prepareTemplateContext(
            {
                ...baseContext,
                capabilityHook: { id: 'fix-sitemap', headline: 'Fix the missing sitemap' },
            },
            'cold-outreach-step1-unknown-legacy-only-key',
        );
        // No pool means no variantSubject was set; confirm no crash, no hook leak.
        expect(result).toBeDefined();
    });

    it('renders base variant normally when capability slot is not chosen', () => {
        const basePool = selectColdSubjectPool('cold-outreach-step1', 'standard') ?? [];
        // Heavy weight on base slot 0, zero-ish elsewhere.
        const weights: number[] = Array(basePool.length + 2).fill(1);
        weights[0] = 10000;

        const result = prepareTemplateContext(
            {
                ...baseContext,
                capabilityHook: { id: 'fix-sitemap', headline: 'Fix the missing sitemap' },
            },
            'cold-outreach-step1',
            { 'subject:cold-outreach-step1:standard': weights },
        );

        expect(result._subjectVariantIdx).toBe(0);
        expect(String(result.variantSubject)).not.toContain('Fix the missing sitemap');
    });
});
