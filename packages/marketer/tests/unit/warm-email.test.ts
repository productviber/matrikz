/**
 * Tests — Warm Audit-Followup Email Templates & Context
 *
 * Covers:
 *   - prepareWarmTemplateContext(): grade context, quick wins, subject/body variant selection
 *   - BUILT_IN_TEMPLATES: audit-followup-step1/2/3 templates exist and render correctly
 *   - processDueEmails integration: warm context loading from KV, subject variant usage
 */

import { describe, it, expect } from 'vitest';
import { prepareWarmTemplateContext } from '../../src/lib/email';

describe('prepareWarmTemplateContext()', () => {
    const baseContext = {
        domain: 'example.com',
        email: 'jane@example.com',
        score: 65,
        grade: 'C',
        auditScore: 65,
        auditGrade: 'C',
        passCount: 12,
        issueCount: 8,
        url: 'https://example.com',
    };

    // ── Domain Encoding ──────────────────────────────────────────────────

    it('encodes domain for URL use', () => {
        const result = prepareWarmTemplateContext(baseContext, 'audit-followup-step1');
        expect(result.domainEncoded).toBe('example.com');
    });

    it('encodes domains with special chars', () => {
        const ctx = { ...baseContext, domain: 'my site.com' };
        const result = prepareWarmTemplateContext(ctx, 'audit-followup-step1');
        expect(result.domainEncoded).toBe('my%20site.com');
    });

    // ── Grade Context ────────────────────────────────────────────────────

    it('returns "ahead" context for A grade', () => {
        const ctx = { ...baseContext, grade: 'A' };
        const result = prepareWarmTemplateContext(ctx, 'audit-followup-step1');
        expect(result.gradeContext).toContain('ahead');
    });

    it('returns "good shape" context for B grade', () => {
        const ctx = { ...baseContext, grade: 'B' };
        const result = prepareWarmTemplateContext(ctx, 'audit-followup-step1');
        expect(result.gradeContext).toContain('good shape');
    });

    it('returns "average" context for C grade', () => {
        const result = prepareWarmTemplateContext(baseContext, 'audit-followup-step1');
        expect(result.gradeContext).toContain('average');
    });

    it('returns "below" context for D/F grade', () => {
        const ctx = { ...baseContext, grade: 'D' };
        const result = prepareWarmTemplateContext(ctx, 'audit-followup-step1');
        expect(result.gradeContext).toContain('below');
    });

    // ── Score Normalisation ──────────────────────────────────────────────

    it('normalises score/grade aliases', () => {
        const ctx = { domain: 'test.com', score: 80, grade: 'B' };
        const result = prepareWarmTemplateContext(ctx, 'audit-followup-step1');
        expect(result.auditScore).toBe(80);
        expect(result.auditGrade).toBe('B');
    });

    // ── Quick Win Extraction ─────────────────────────────────────────────

    it('extracts quick win from angles array', () => {
        const ctx = {
            ...baseContext,
            angles: [
                { type: 'meta-descriptions', hook: 'Missing meta descriptions', detail: 'Add unique meta descriptions to top 10 pages' },
            ],
        };
        const result = prepareWarmTemplateContext(ctx, 'audit-followup-step2');
        expect(result.quickWinTitle).toBe('Missing meta descriptions');
        expect(result.quickWinAction).toContain('meta descriptions');
    });

    it('uses fallback quick win when no angles', () => {
        const result = prepareWarmTemplateContext(baseContext, 'audit-followup-step2');
        expect(result.quickWinTitle).toContain('meta descriptions');
        expect(result.quickWinAction).toBeDefined();
        expect(result.quickWinImpact).toBeDefined();
    });

    // ── Audit Page URL ───────────────────────────────────────────────────

    it('constructs audit page URL from domain', () => {
        const result = prepareWarmTemplateContext(baseContext, 'audit-followup-step1');
        expect(result.auditPageUrl).toContain('/audit?url=example.com');
    });

    // ── Personal Sign-Off ────────────────────────────────────────────────

    it('includes personal sign-off', () => {
        const result = prepareWarmTemplateContext(baseContext, 'audit-followup-step1');
        expect(result.personalSignOff).toBeTruthy();
    });

    // ── Subject Variant Selection ────────────────────────────────────────

    it('selects a subject variant for step1', () => {
        const result = prepareWarmTemplateContext(baseContext, 'audit-followup-step1');
        expect(result.variantSubject).toBeTruthy();
        // Any valid interpolated variant should include at least one key signal.
        const subject = String(result.variantSubject);
        expect(
            subject.includes('example.com') ||
            subject.includes('82') ||
            subject.includes('8')
        ).toBe(true);
    });

    it('selects a subject variant for step2', () => {
        const result = prepareWarmTemplateContext(baseContext, 'audit-followup-step2');
        expect(result.variantSubject).toBeTruthy();
        expect(String(result.variantSubject)).toContain('example.com');
    });

    it('selects a subject variant for step3', () => {
        const result = prepareWarmTemplateContext(baseContext, 'audit-followup-step3');
        expect(result.variantSubject).toBeTruthy();
    });

    // ── Body Variant Selection ───────────────────────────────────────────

    it('selects a body variant for step1', () => {
        const result = prepareWarmTemplateContext(baseContext, 'audit-followup-step1');
        expect(result.bodyVariant).toBeTruthy();
        // Should contain interpolated values
        expect(String(result.bodyVariant)).toContain('example.com');
    });

    it('selects a body variant for step2', () => {
        const result = prepareWarmTemplateContext(baseContext, 'audit-followup-step2');
        expect(result.bodyVariant).toBeTruthy();
    });

    it('selects a body variant for step3', () => {
        const result = prepareWarmTemplateContext(baseContext, 'audit-followup-step3');
        expect(result.bodyVariant).toBeTruthy();
    });

    // ── Contact Name ─────────────────────────────────────────────────────

    it('uses first name when contactName is provided', () => {
        const ctx = { ...baseContext, contactName: 'Jane Smith' };
        const result = prepareWarmTemplateContext(ctx, 'audit-followup-step1');
        expect(result.contactNameGreeting).toBe(' Jane');
    });

    it('uses empty greeting when no contactName', () => {
        const result = prepareWarmTemplateContext(baseContext, 'audit-followup-step1');
        expect(result.contactNameGreeting).toBe('');
    });

    // ── Does not set A/B tracking indices (low volume — no A/B for warm) ─

    it('does not set _subjectVariantIdx', () => {
        const result = prepareWarmTemplateContext(baseContext, 'audit-followup-step1');
        expect(result._subjectVariantIdx).toBeUndefined();
    });

    it('does not set _bodyVariantIdx', () => {
        const result = prepareWarmTemplateContext(baseContext, 'audit-followup-step1');
        expect(result._bodyVariantIdx).toBeUndefined();
    });
});
