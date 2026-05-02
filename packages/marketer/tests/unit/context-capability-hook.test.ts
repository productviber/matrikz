/**
 * Tests — capability-hook flattening in template context
 *
 * Covers:
 *   - Flat capabilityHook* fields populated from the structured hook
 *   - capabilityHookBlock renders as HTML snippet when hook present
 *   - capabilityHookBlock is empty string when hook absent
 *   - XSS-escape on headline and oneLiner (defense in depth)
 *   - Pre-existing context fields are preserved
 */

import { describe, it, expect } from 'vitest';
import { prepareTemplateContext } from '../../src/lib/email';

const baseCtx = {
    domain: 'example.com',
    email: 'a@b.c',
    auditScore: 70,
    auditGrade: 'B',
    passCount: 12,
    issueCount: 3,
    angles: [],
};

describe('capability-hook context flattening', () => {
    it('populates flat capabilityHook* fields', () => {
        const ctx = {
            ...baseCtx,
            capabilityHook: {
                id: 'stack-shopify-revenue-attribution',
                headline: 'Tie every Shopify order back to search',
                oneLiner: 'Stitch checkouts to keywords.',
                cta: 'See revenue attribution',
            },
        };
        const out = prepareTemplateContext(ctx, 'cold-outreach-step1');
        expect(out.capabilityHookId).toBe('stack-shopify-revenue-attribution');
        expect(out.capabilityHookHeadline).toBe('Tie every Shopify order back to search');
        expect(out.capabilityHookOneLiner).toBe('Stitch checkouts to keywords.');
        expect(out.capabilityHookCta).toBe('See revenue attribution');
    });

    it('builds an HTML block with headline + oneLiner when hook present', () => {
        const ctx = {
            ...baseCtx,
            capabilityHook: {
                id: 'x',
                headline: 'Big Headline',
                oneLiner: 'Great details.',
            },
        };
        const out = prepareTemplateContext(ctx, 'cold-outreach-step1');
        const block = out.capabilityHookBlock as string;
        expect(block).toContain('<strong>Big Headline</strong>');
        expect(block).toContain('Great details.');
        expect(block).toContain('border-left:3px solid');
    });

    it('capabilityHookBlock is empty when no hook', () => {
        const out = prepareTemplateContext({ ...baseCtx }, 'cold-outreach-step1');
        expect(out.capabilityHookBlock).toBe('');
        expect(out.capabilityHookId).toBe('');
        expect(out.capabilityHookHeadline).toBe('');
    });

    it('capabilityHookBlock is empty when hook has no headline', () => {
        const ctx = { ...baseCtx, capabilityHook: { id: 'x', oneLiner: 'only' } };
        const out = prepareTemplateContext(ctx, 'cold-outreach-step1');
        expect(out.capabilityHookBlock).toBe('');
    });

    it('escapes HTML in headline (XSS defense)', () => {
        const ctx = {
            ...baseCtx,
            capabilityHook: {
                id: 'x',
                headline: '<script>alert(1)</script>Title',
                oneLiner: 'Plain',
            },
        };
        const out = prepareTemplateContext(ctx, 'cold-outreach-step1');
        const block = out.capabilityHookBlock as string;
        expect(block).not.toContain('<script>');
        expect(block).toContain('&lt;script&gt;');
    });

    it('escapes quotes and ampersands in oneLiner', () => {
        const ctx = {
            ...baseCtx,
            capabilityHook: {
                id: 'x',
                headline: 'Hdr',
                oneLiner: 'A "quoted" & ampersand',
            },
        };
        const out = prepareTemplateContext(ctx, 'cold-outreach-step1');
        const block = out.capabilityHookBlock as string;
        expect(block).toContain('&quot;quoted&quot;');
        expect(block).toContain('&amp; ampersand');
    });

    it('preserves pre-existing context fields', () => {
        const ctx = { ...baseCtx, capabilityHook: { id: 'x', headline: 'h', oneLiner: 'o' } };
        const out = prepareTemplateContext(ctx, 'cold-outreach-step1');
        expect(out.domain).toBe('example.com');
        expect(out.auditScore).toBe(70);
        expect(out.domainEncoded).toBe('example.com');
    });
});
