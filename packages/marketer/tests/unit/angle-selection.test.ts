/**
 * Tests — Template Context Preparation & Angle Selection
 *
 * Covers prepareTemplateContext() and prepareWarmTemplateContext() —
 * smart angle selection per email step, template variable interpolation,
 * variant tracking, and edge case handling.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { prepareTemplateContext, prepareWarmTemplateContext } from '../../src/lib/email/context';

// ═══════════════════════════════════════════════════════════════════════
// Angle selection via prepareTemplateContext
// ═══════════════════════════════════════════════════════════════════════

const multipleAngles = [
  { type: 'social-tags', hook: 'Missing OG tags', detail: 'Add OpenGraph meta tags' },
  { type: 'critical-seo', hook: 'No HTTPS redirect', detail: 'Set up 301 redirect to HTTPS' },
  { type: 'missing-schema', hook: 'No JSON-LD', detail: 'Add Organization schema markup' },
];

describe('prepareTemplateContext() — angle selection', () => {
  const baseContext = {
    domain: 'acme.com',
    companyName: 'Acme Inc',
    contactName: 'John Doe',
    contactEmail: 'john@acme.com',
    score: 72,
    auditScore: 45,
    auditGrade: 'D',
    issueCount: 8,
    passCount: 3,
    techStack: ['Next.js', 'Vercel'],
    angles: multipleAngles,
  };

  it('step1 picks highest-priority angle (critical-seo)', () => {
    const result = prepareTemplateContext(baseContext, 'cold-outreach-step1');
    expect(result._angleType).toBe('critical-seo');
    expect(result.quickWinTitle).toBe('No HTTPS redirect');
  });

  it('step2 picks second-best angle for variety', () => {
    const result = prepareTemplateContext(baseContext, 'cold-outreach-step2');
    expect(result._angleType).toBe('missing-schema');
    expect(result.quickWinTitle).toBe('No JSON-LD');
  });

  it('step3 picks third angle for maximum coverage', () => {
    const result = prepareTemplateContext(baseContext, 'cold-outreach-step3');
    expect(result._angleType).toBe('social-tags');
    expect(result.quickWinTitle).toBe('Missing OG tags');
  });

  it('step1 with single angle uses that angle', () => {
    const ctx = { ...baseContext, angles: [multipleAngles[0]] };
    const result = prepareTemplateContext(ctx, 'cold-outreach-step1');
    expect(result._angleType).toBe('social-tags');
  });

  it('step2 with two angles uses position #2', () => {
    const ctx = { ...baseContext, angles: [multipleAngles[0], multipleAngles[1]] };
    const result = prepareTemplateContext(ctx, 'cold-outreach-step2');
    // sorted: critical-seo (100), social-tags (40) → step2 picks social-tags
    expect(result._angleType).toBe('social-tags');
  });

  it('step3 with only two angles falls back to highest', () => {
    const ctx = { ...baseContext, angles: [multipleAngles[0], multipleAngles[1]] };
    const result = prepareTemplateContext(ctx, 'cold-outreach-step3');
    // Only 2 angles, step3 wants sorted[2] but falls back to sorted[0]
    expect(result._angleType).toBe('critical-seo');
  });

  it('exposes secondary angle for recap', () => {
    const result = prepareTemplateContext(baseContext, 'cold-outreach-step1');
    expect(result.secondaryWinTitle).toBeDefined();
    expect(typeof result.secondaryWinTitle).toBe('string');
  });

  it('no angles uses fallback defaults', () => {
    const ctx = { ...baseContext, angles: [] };
    const result = prepareTemplateContext(ctx, 'cold-outreach-step1');
    expect(result._angleType).toBe('default');
    expect(result._angleIdx).toBe(-1);
    expect(result.quickWinTitle).toBe('Optimise your meta descriptions');
  });

  it('undefined angles uses fallback defaults', () => {
    const ctx = { ...baseContext };
    delete (ctx as any).angles;
    const result = prepareTemplateContext(ctx, 'cold-outreach-step1');
    expect(result._angleType).toBe('default');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Template variable interpolation
// ═══════════════════════════════════════════════════════════════════════

describe('prepareTemplateContext() — variables', () => {
  const baseContext = {
    domain: 'test.io',
    companyName: 'TestCo',
    contactName: 'Jane Smith',
    contactEmail: 'jane@test.io',
    score: 65,
    auditScore: 55,
    auditGrade: 'C',
    issueCount: 5,
    passCount: 6,
    techStack: ['React', 'AWS', 'Stripe'],
    angles: [{ type: 'content-gaps', hook: 'Missing blog', detail: 'Start content program' }],
  };

  it('sets domainEncoded correctly', () => {
    const ctx = { ...baseContext, domain: 'my site.com' };
    const result = prepareTemplateContext(ctx, 'cold-outreach-step1');
    expect(result.domainEncoded).toBe('my%20site.com');
  });

  it('sets contactNameGreeting to first name only', () => {
    const result = prepareTemplateContext(baseContext, 'cold-outreach-step1');
    expect(result.contactNameGreeting).toBe(' Jane');
  });

  it('handles missing contactName gracefully', () => {
    const ctx = { ...baseContext, contactName: null };
    const result = prepareTemplateContext(ctx, 'cold-outreach-step1');
    expect(result.contactNameGreeting).toBe('');
  });

  it('renders techStackDisplay (max 5)', () => {
    const result = prepareTemplateContext(baseContext, 'cold-outreach-step1');
    expect(result.techStackDisplay).toBe('React, AWS, Stripe');
  });

  it('handles empty techStack gracefully', () => {
    const ctx = { ...baseContext, techStack: [] };
    const result = prepareTemplateContext(ctx, 'cold-outreach-step1');
    expect(result.techStackDisplay).toBe('Not detected');
  });

  it('generates unsubscribe link with contact email', () => {
    const result = prepareTemplateContext(baseContext, 'cold-outreach-step1');
    expect(result.unsubscribeLink).toContain('jane%40test.io');
    expect(result.unsubscribeLink).toContain('Unsubscribe');
  });

  it('tracks _subjectVariantIdx when subject variants exist', () => {
    const result = prepareTemplateContext(baseContext, 'cold-outreach-step1');
    expect(typeof result._subjectVariantIdx).toBe('number');
    expect(result._subjectVariantIdx as number).toBeGreaterThanOrEqual(0);
  });

  it('tracks _bodyVariantIdx when body variants exist', () => {
    const result = prepareTemplateContext(baseContext, 'cold-outreach-step1');
    if (result._bodyVariantIdx !== undefined) {
      expect(typeof result._bodyVariantIdx).toBe('number');
      expect(result._bodyVariantIdx as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('includes reportUrl with encoded domain', () => {
    const result = prepareTemplateContext(baseContext, 'cold-outreach-step1');
    expect(result.reportUrl).toContain('test.io');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Warm template context
// ═══════════════════════════════════════════════════════════════════════

describe('prepareWarmTemplateContext()', () => {
  const baseWarmContext = {
    domain: 'warm-lead.com',
    companyName: 'Warm Lead Corp',
    contactName: 'Alice Johnson',
    auditScore: 78,
    auditGrade: 'B',
    grade: 'B',
    angles: multipleAngles,
  };

  it('selects highest-priority angle for warm sequences', () => {
    const result = prepareWarmTemplateContext(baseWarmContext, 'warm-followup-step1');
    expect(result._angleType).toBe('critical-seo');
  });

  it('maps grade B to correct gradeContext', () => {
    const result = prepareWarmTemplateContext(baseWarmContext, 'warm-followup-step1');
    expect(result.gradeContext).toBe('in good shape with room to grow');
  });

  it('maps grade A to "ahead of most" context', () => {
    const ctx = { ...baseWarmContext, grade: 'A', auditGrade: 'A' };
    const result = prepareWarmTemplateContext(ctx, 'warm-followup-step1');
    expect(result.gradeContext).toContain('ahead');
  });

  it('maps grade D to "below where" context', () => {
    const ctx = { ...baseWarmContext, grade: 'D', auditGrade: 'D' };
    const result = prepareWarmTemplateContext(ctx, 'warm-followup-step1');
    expect(result.gradeContext).toContain('below');
  });

  it('uses weighted subject variant selection when variantWeights supplied', () => {
    // Force variant 0 by giving it a huge weight
    const weights = { 'subject:warm-followup-step1': [1000, 1] };
    const result = prepareWarmTemplateContext(baseWarmContext, 'warm-followup-step1', weights);
    if (result._subjectVariantIdx !== undefined) {
      // With 1000:1 weight ratio, should almost always pick index 0
      expect(result._subjectVariantIdx).toBe(0);
    }
  });

  it('uses weighted body variant selection when variantWeights supplied', () => {
    const weights = { 'body:warm-followup-step1': [1, 1000] };
    const result = prepareWarmTemplateContext(baseWarmContext, 'warm-followup-step1', weights);
    if (result._bodyVariantIdx !== undefined) {
      // With 1:1000 weight ratio, should almost always pick index 1
      expect(result._bodyVariantIdx).toBe(1);
    }
  });

  it('falls back to default angle text when angles are empty', () => {
    const ctx = { ...baseWarmContext, angles: [] };
    const result = prepareWarmTemplateContext(ctx, 'warm-followup-step1');
    expect(result.quickWinTitle).toBe('Optimise your meta descriptions');
  });
});
