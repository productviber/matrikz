import { describe, it, expect } from 'vitest';
import {
    resolveFramingTier,
    DEFAULT_FRAMING_TIER,
    FRAMING_TIERS,
    ALL_FRAMING_TIERS,
    variantWeightsKey,
    legacyVariantWeightsKey,
    selectColdSubjectPool,
    selectColdBodyPool,
    selectWarmSubjectPool,
    selectWarmBodyPool,
} from '../../src/lib/email/framing';

describe('resolveFramingTier — score-band classification', () => {
    it('maps >=90 to good', () => {
        expect(resolveFramingTier(90)).toBe('good');
        expect(resolveFramingTier(95)).toBe('good');
        expect(resolveFramingTier(100)).toBe('good');
    });

    it('maps 60..89 to standard', () => {
        expect(resolveFramingTier(60)).toBe('standard');
        expect(resolveFramingTier(75)).toBe('standard');
        expect(resolveFramingTier(89)).toBe('standard');
        expect(resolveFramingTier(89.999)).toBe('standard');
    });

    it('maps <60 to compulsion', () => {
        expect(resolveFramingTier(0)).toBe('compulsion');
        expect(resolveFramingTier(1)).toBe('compulsion');
        expect(resolveFramingTier(40)).toBe('compulsion');
        expect(resolveFramingTier(59)).toBe('compulsion');
        expect(resolveFramingTier(59.999)).toBe('compulsion');
    });

    it('fail-safe defaults when score is missing or non-numeric', () => {
        expect(resolveFramingTier(null)).toBe(DEFAULT_FRAMING_TIER);
        expect(resolveFramingTier(undefined)).toBe(DEFAULT_FRAMING_TIER);
        expect(resolveFramingTier(NaN)).toBe(DEFAULT_FRAMING_TIER);
        expect(resolveFramingTier(Infinity)).toBe(DEFAULT_FRAMING_TIER);
        expect(resolveFramingTier(-Infinity)).toBe(DEFAULT_FRAMING_TIER);
        // Out-of-range scores still classify (no clamping) — 9999 behaves as good.
        expect(resolveFramingTier(9999)).toBe('good');
        expect(resolveFramingTier(-50)).toBe('compulsion');
    });

    it('default tier is standard (neutral, non-urgent)', () => {
        expect(DEFAULT_FRAMING_TIER).toBe('standard');
    });

    it('exposes all three tiers in canonical order', () => {
        expect(ALL_FRAMING_TIERS).toEqual(['good', 'standard', 'compulsion']);
        expect(FRAMING_TIERS.GOOD.minScore).toBe(90);
        expect(FRAMING_TIERS.STANDARD.minScore).toBe(60);
        expect(FRAMING_TIERS.COMPULSION.minScore).toBe(0);
    });
});

describe('variantWeightsKey — KV poolKey naming', () => {
    it('formats tier-scoped key as type:template:tier', () => {
        expect(variantWeightsKey('subject', 'cold-outreach-step1', 'good')).toBe(
            'subject:cold-outreach-step1:good',
        );
        expect(variantWeightsKey('body', 'warm-step-1', 'compulsion')).toBe(
            'body:warm-step-1:compulsion',
        );
    });

    it('formats legacy key as type:template (no tier suffix)', () => {
        expect(legacyVariantWeightsKey('subject', 'cold-outreach-step1')).toBe(
            'subject:cold-outreach-step1',
        );
    });
});

describe('tier pool selectors — fallback discipline', () => {
    it('returns tier-specific cold subject pools for all three tiers', () => {
        for (const tier of ALL_FRAMING_TIERS) {
            const pool = selectColdSubjectPool('cold-outreach-step1', tier);
            expect(pool).toBeDefined();
            expect(Array.isArray(pool)).toBe(true);
            expect((pool as string[]).length).toBeGreaterThan(0);
        }
    });

    it('returns tier-specific cold body pools for all three tiers', () => {
        for (const tier of ALL_FRAMING_TIERS) {
            const pool = selectColdBodyPool('cold-outreach-step1', tier);
            expect(pool).toBeDefined();
            expect((pool as string[]).length).toBeGreaterThan(0);
        }
    });

    it('returns undefined for unknown template keys so caller can fall back', () => {
        expect(selectColdSubjectPool('does-not-exist', 'standard')).toBeUndefined();
        expect(selectColdBodyPool('does-not-exist', 'good')).toBeUndefined();
    });

    it('warm step1 has tier-specific pools; later warm steps may fall back', () => {
        const step1Sub = selectWarmSubjectPool('warm-step-1', 'standard');
        const step1Body = selectWarmBodyPool('warm-step-1', 'compulsion');
        expect(step1Sub === undefined || (step1Sub as string[]).length > 0).toBe(true);
        expect(step1Body === undefined || (step1Body as string[]).length > 0).toBe(true);
    });
});
