import { describe, it, expect } from 'vitest';
import { prepareTemplateContext } from '../../src/lib/email/context';
import {
    selectColdSubjectPool,
    DEFAULT_FRAMING_TIER,
} from '../../src/lib/email/framing';

const baseContext = {
    domain: 'acme.com',
    domainEncoded: 'acme.com',
    companyName: 'Acme Inc',
    contactEmail: 'john@acme.com',
    contactName: 'John Doe',
    issueCount: 5,
    passCount: 10,
    techStack: ['Next.js'],
    primaryTopic: 'SaaS',
    angles: [{ type: 'critical-seo', hook: 'Missing meta', detail: 'Add meta descriptions' }],
};

describe('prepareTemplateContext — score-band framing tier selection', () => {
    it('resolves tier=good and picks from good pool when auditScore>=90', () => {
        const result = prepareTemplateContext(
            { ...baseContext, auditScore: 95 },
            'cold-outreach-step1',
        );
        expect(result._framingTier).toBe('good');
        const goodPool = selectColdSubjectPool('cold-outreach-step1', 'good') ?? [];
        // Subject has template placeholders substituted — verify the chosen
        // template _pattern_ came from the good pool by checking _subjectVariantIdx
        // points into a valid slot of that pool.
        expect(typeof result._subjectVariantIdx).toBe('number');
        expect(result._subjectVariantIdx!).toBeGreaterThanOrEqual(0);
        expect(result._subjectVariantIdx!).toBeLessThan(goodPool.length);
    });

    it('resolves tier=standard when score is 60..89', () => {
        const result = prepareTemplateContext(
            { ...baseContext, auditScore: 75 },
            'cold-outreach-step1',
        );
        expect(result._framingTier).toBe('standard');
    });

    it('resolves tier=compulsion when score<60', () => {
        const result = prepareTemplateContext(
            { ...baseContext, auditScore: 40 },
            'cold-outreach-step1',
        );
        expect(result._framingTier).toBe('compulsion');
    });

    it('falls back to default tier when auditScore is missing', () => {
        const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1');
        expect(result._framingTier).toBe(DEFAULT_FRAMING_TIER);
    });

    it('tier-keyed weights bias selection for the correct tier', () => {
        const weights = {
            'subject:cold-outreach-step1:good': [100, 1, 1],
            // A bogus legacy entry that should NOT affect good-tier selection.
            'subject:cold-outreach-step1': [1, 1, 100, 1, 1],
        };
        let zeroCount = 0;
        for (let i = 0; i < 50; i++) {
            const result = prepareTemplateContext(
                { ...baseContext, auditScore: 95 },
                'cold-outreach-step1',
                weights,
            );
            if (result._subjectVariantIdx === 0) zeroCount++;
        }
        // Heavy weight on index 0 of the good pool should dominate.
        expect(zeroCount).toBeGreaterThan(35);
    });

    it('legacy un-tiered weights are ignored when a tier pool is active', () => {
        // With only legacy weights and no tier-keyed weights, pool is the tier pool
        // (length 3 for standard). Legacy weights length 5 can't align → uniform
        // random. We just assert the tier pool is still used (no crash) and the
        // chosen idx is within the tier pool bounds.
        const weights = {
            'subject:cold-outreach-step1': [100, 1, 1, 1, 1],
        };
        const result = prepareTemplateContext(
            { ...baseContext, auditScore: 75 },
            'cold-outreach-step1',
            weights,
        );
        expect(result._framingTier).toBe('standard');
        const standardPool =
            selectColdSubjectPool('cold-outreach-step1', 'standard') ?? [];
        expect(result._subjectVariantIdx!).toBeLessThan(standardPool.length);
    });
});
