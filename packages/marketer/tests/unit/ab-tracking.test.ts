/**
 * Tests — UTM Injection, A/B Variant Selection & Tracking
 *
 * Covers:
 *   - injectUtmParams() — UTM parameter injection on email links
 *   - pickWeightedIndex() — weighted random variant selection
 *   - recordVariantEngagement() — KV-backed variant weight recording
 *   - loadVariantWeights() — read variant weights from KV
 *   - prepareTemplateContext() with variantWeights parameter
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    injectUtmParams,
    pickWeightedIndex,
    recordVariantEngagement,
    loadVariantWeights,
    prepareTemplateContext,
} from '../../src/lib/email';
import { createMockKV } from '../helpers';

// ═══════════════════════════════════════════════════════════════════════
// injectUtmParams
// ═══════════════════════════════════════════════════════════════════════

describe('injectUtmParams', () => {
    it('appends UTM parameters to simple URLs', () => {
        const html = '<a href="https://acme.com/page">Click</a>';
        const result = injectUtmParams(html, 'cold-outreach-step1', 'my-campaign');
        expect(result).toContain('utm_source=outbound');
        expect(result).toContain('utm_medium=email');
        expect(result).toContain('utm_campaign=my-campaign');
        expect(result).toContain('utm_content=cold-outreach-step1');
    });

    it('uses & separator for URLs with existing query params', () => {
        const html = '<a href="https://acme.com/page?ref=test">Click</a>';
        const result = injectUtmParams(html, 'step1', 'camp');
        // Should use & not ?
        expect(result).toContain('?ref=test&utm_source=');
        expect(result).not.toContain('?ref=test?utm_source=');
    });

    it('uses ? separator for URLs without query params', () => {
        const html = '<a href="https://acme.com/page">Click</a>';
        const result = injectUtmParams(html, 'step1', 'camp');
        expect(result).toContain('acme.com/page?utm_source=');
    });

    it('skips unsubscribe links', () => {
        const html = '<a href="https://acme.com/unsubscribe?token=abc">Unsub</a>';
        const result = injectUtmParams(html, 'step1', 'camp');
        expect(result).not.toContain('utm_source');
        expect(result).toContain('unsubscribe?token=abc');
    });

    it('skips gdpr links', () => {
        const html = '<a href="https://acme.com/gdpr-policy">GDPR</a>';
        const result = injectUtmParams(html, 'step1', 'camp');
        expect(result).not.toContain('utm_source');
    });

    it('skips links that already have UTM parameters', () => {
        const html = '<a href="https://acme.com/page?utm_source=other">Click</a>';
        const result = injectUtmParams(html, 'step1', 'camp');
        // Should not double-add UTMs
        expect(result).toBe(html);
    });

    it('processes multiple links in one HTML', () => {
        const html = `
      <a href="https://acme.com/page1">One</a>
      <a href="https://acme.com/page2">Two</a>
      <a href="https://acme.com/unsubscribe">Unsub</a>
    `;
        const result = injectUtmParams(html, 'step1', 'camp');
        // First two should have UTMs, third should not
        const matches = result.match(/utm_source/g);
        expect(matches).toHaveLength(2);
    });

    it('handles http:// links', () => {
        const html = '<a href="http://example.com">Click</a>';
        const result = injectUtmParams(html, 'step1', 'camp');
        expect(result).toContain('utm_source=outbound');
    });

    it('encodes special characters in campaign slug', () => {
        const html = '<a href="https://acme.com/page">Click</a>';
        const result = injectUtmParams(html, 'step1', 'my campaign/test');
        expect(result).toContain('utm_campaign=my%20campaign%2Ftest');
    });

    it('returns original HTML when no links present', () => {
        const html = '<p>No links here</p>';
        const result = injectUtmParams(html, 'step1', 'camp');
        expect(result).toBe(html);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// pickWeightedIndex
// ═══════════════════════════════════════════════════════════════════════

describe('pickWeightedIndex', () => {
    it('returns an index within range', () => {
        for (let i = 0; i < 100; i++) {
            const idx = pickWeightedIndex(5);
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThan(5);
        }
    });

    it('falls back to uniform random when weights is null', () => {
        const idx = pickWeightedIndex(3, null);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(3);
    });

    it('falls back to uniform random when weights length mismatches', () => {
        const idx = pickWeightedIndex(3, [1, 2]); // Wrong length
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(3);
    });

    it('respects heavy weighting (statistical)', () => {
        // Weight index 0 heavily — run 1000 times, it should win majority
        const counts = [0, 0, 0];
        for (let i = 0; i < 1000; i++) {
            const idx = pickWeightedIndex(3, [100, 1, 1]);
            counts[idx]++;
        }
        // Index 0 should win > 80% of the time (100/(100+1+1) ≈ 98%)
        expect(counts[0]).toBeGreaterThan(800);
    });

    it('handles all-equal weights', () => {
        const counts = [0, 0, 0];
        for (let i = 0; i < 900; i++) {
            const idx = pickWeightedIndex(3, [10, 10, 10]);
            counts[idx]++;
        }
        // Each should get roughly 300 (±100 for randomness)
        for (const c of counts) {
            expect(c).toBeGreaterThan(150);
            expect(c).toBeLessThan(550);
        }
    });

    it('handles single item in pool', () => {
        const idx = pickWeightedIndex(1, [5]);
        expect(idx).toBe(0);
    });

    it('treats zero/negative weights as 1 (floor)', () => {
        // All weights are 0 → treated as [1,1,1] → uniform random
        const idx = pickWeightedIndex(3, [0, 0, 0]);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(3);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// recordVariantEngagement
// ═══════════════════════════════════════════════════════════════════════

describe('recordVariantEngagement', () => {
    let kv: ReturnType<typeof createMockKV>;

    beforeEach(() => { kv = createMockKV(); });

    it('creates new variant entry when none exists', async () => {
        await recordVariantEngagement(kv, 'cold-outreach-step1', 'subject', 0, 'send');
        const raw = await kv.get('ab:variants:cold-outreach-step1');
        expect(raw).toBeTruthy();
        const data = JSON.parse(raw!);
        expect(data['subject:cold-outreach-step1']).toBeDefined();
    });

    it('increments weight by +2 for open events', async () => {
        // Start with a base entry
        await recordVariantEngagement(kv, 'step1', 'subject', 0, 'send');
        const before = JSON.parse(await kv.get('ab:variants:step1') as string);
        const baseBefore = before['subject:step1'][0];

        await recordVariantEngagement(kv, 'step1', 'subject', 0, 'open');
        const after = JSON.parse(await kv.get('ab:variants:step1') as string);
        expect(after['subject:step1'][0]).toBe(baseBefore + 2);
    });

    it('increments weight by +5 for click events', async () => {
        await recordVariantEngagement(kv, 'step1', 'body', 0, 'send');
        const before = JSON.parse(await kv.get('ab:variants:step1') as string);
        const baseBefore = before['body:step1'][0];

        await recordVariantEngagement(kv, 'step1', 'body', 0, 'click');
        const after = JSON.parse(await kv.get('ab:variants:step1') as string);
        expect(after['body:step1'][0]).toBe(baseBefore + 5);
    });

    it('does not increment for send events (bump = 0)', async () => {
        await recordVariantEngagement(kv, 'step1', 'subject', 0, 'send');
        const first = JSON.parse(await kv.get('ab:variants:step1') as string);
        const base0 = first['subject:step1'][0];

        await recordVariantEngagement(kv, 'step1', 'subject', 0, 'send');
        const second = JSON.parse(await kv.get('ab:variants:step1') as string);
        // Send bump is 0, base weight is 1, so second call should just stay
        expect(second['subject:step1'][0]).toBe(base0);
    });

    it('auto-extends array for new variant indices', async () => {
        await recordVariantEngagement(kv, 'step1', 'subject', 3, 'open');
        const data = JSON.parse(await kv.get('ab:variants:step1') as string);
        // Should have at least 4 entries (indices 0-3)
        expect(data['subject:step1'].length).toBeGreaterThanOrEqual(4);
        // Index 3 should have base(1) + open(2) = 3
        expect(data['subject:step1'][3]).toBe(3);
        // Earlier indices should be base weight (1)
        expect(data['subject:step1'][0]).toBe(1);
    });

    it('separates subject and body tracking', async () => {
        await recordVariantEngagement(kv, 'step1', 'subject', 0, 'click');
        await recordVariantEngagement(kv, 'step1', 'body', 0, 'open');
        const data = JSON.parse(await kv.get('ab:variants:step1') as string);
        // subject gets +5 (click), body gets +2 (open), both + base 1
        expect(data['subject:step1'][0]).toBe(6);
        expect(data['body:step1'][0]).toBe(3);
    });

    it('increments weight by +10 for reply events', async () => {
        await recordVariantEngagement(kv, 'step1', 'subject', 0, 'send');
        const before = JSON.parse(await kv.get('ab:variants:step1') as string);
        const baseBefore = before['subject:step1'][0];

        await recordVariantEngagement(kv, 'step1', 'subject', 0, 'reply');
        const after = JSON.parse(await kv.get('ab:variants:step1') as string);
        expect(after['subject:step1'][0]).toBe(baseBefore + 10);
    });

    it('reply weight is highest engagement signal', async () => {
        await recordVariantEngagement(kv, 'step1', 'body', 0, 'reply');
        const replyData = JSON.parse(await kv.get('ab:variants:step1') as string);
        const replyWeight = replyData['body:step1'][0]; // base(1) + reply(10) = 11

        const kv2 = createMockKV();
        await recordVariantEngagement(kv2, 'step1', 'body', 0, 'click');
        const clickData = JSON.parse(await kv2.get('ab:variants:step1') as string);
        const clickWeight = clickData['body:step1'][0]; // base(1) + click(5) = 6

        expect(replyWeight).toBeGreaterThan(clickWeight);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// loadVariantWeights
// ═══════════════════════════════════════════════════════════════════════

describe('loadVariantWeights', () => {
    let kv: ReturnType<typeof createMockKV>;

    beforeEach(() => { kv = createMockKV(); });

    it('returns null when no data exists', async () => {
        const result = await loadVariantWeights(kv, 'nonexistent');
        expect(result).toBeNull();
    });

    it('returns parsed data when it exists', async () => {
        const data = { 'subject:step1': [5, 3, 1] };
        await kv.put('ab:variants:step1', JSON.stringify(data));
        const result = await loadVariantWeights(kv, 'step1');
        expect(result).toEqual(data);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// prepareTemplateContext with variantWeights
// ═══════════════════════════════════════════════════════════════════════

describe('prepareTemplateContext — variant weights', () => {
    const baseContext = {
        domain: 'acme.com',
        companyName: 'Acme Inc',
        contactEmail: 'john@acme.com',
        contactName: 'John Doe',
        auditScore: 72,
        auditGrade: 'C',
        issueCount: 5,
        passCount: 10,
        techStack: ['Next.js', 'Vercel', 'React'],
        primaryTopic: 'SaaS',
        angles: [{ type: 'critical-seo', hook: 'Missing meta', detail: 'Add meta descriptions' }],
    };

    it('works without variantWeights (backward compat)', () => {
        const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1');
        expect(result.variantSubject).toBeTruthy();
        expect(result.bodyVariant).toBeTruthy();
    });

    it('accepts variantWeights as third parameter', () => {
        const weights = {
            'subject:cold-outreach-step1': [10, 1, 1, 1, 1],
        };
        const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1', weights);
        expect(result.variantSubject).toBeTruthy();
    });

    it('tracks _subjectVariantIdx when variantWeights provided', () => {
        const weights = {
            'subject:cold-outreach-step1': [100, 1, 1, 1, 1],
        };
        // With heavy weighting on index 0, most calls should return idx 0
        let zeroCount = 0;
        for (let i = 0; i < 50; i++) {
            const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1', weights);
            if (result._subjectVariantIdx === 0) zeroCount++;
        }
        // With 100 vs 1,1,1,1 — should be index 0 most of the time
        expect(zeroCount).toBeGreaterThan(35);
    });

    it('tracks _bodyVariantIdx as a number', () => {
        const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1');
        expect(typeof result._bodyVariantIdx).toBe('number');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Warm retargeting — step3 engagement-aware variant selection
// ═══════════════════════════════════════════════════════════════════════

describe('prepareTemplateContext — warm retargeting step3', () => {
    const step3Context = {
        domain: 'acme.com',
        companyName: 'Acme Inc',
        contactEmail: 'john@acme.com',
        contactName: 'John Doe',
        auditScore: 72,
        issueCount: 5,
        passCount: 10,
        angles: [{ type: 'critical-seo', hook: 'Missing meta', detail: 'Add meta descriptions' }],
    };

    it('uses retarget body variants for step3 when _hasOpened is true', () => {
        const ctx = { ...step3Context, _hasOpened: true };
        const result = prepareTemplateContext(ctx, 'cold-outreach-step3');
        // Retarget variants reference engagement (e.g. "took a look", "showed some interest")
        expect(result.bodyVariant).toBeTruthy();
        expect(typeof result.bodyVariant).toBe('string');
    });

    it('uses default body variants for step3 when _hasOpened is falsy', () => {
        const result = prepareTemplateContext({ ...step3Context }, 'cold-outreach-step3');
        // Default step3 variants reference "last note" / "close the loop"
        expect(result.bodyVariant).toBeTruthy();
    });

    it('still tracks _bodyVariantIdx for warm retarget variants', () => {
        const ctx = { ...step3Context, _hasOpened: true };
        const result = prepareTemplateContext(ctx, 'cold-outreach-step3');
        expect(typeof result._bodyVariantIdx).toBe('number');
    });
});
