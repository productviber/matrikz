/**
 * Unit Tests — Email Sequence Engine
 *
 * Tests enrollment, deduplication, and cancellation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { enrollInSequences, cancelPendingEmails, prepareTemplateContext } from '../../src/lib/email';
import { createMockEnv, type MockEnv } from '../helpers';

describe('email', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('enrollInSequences()', () => {
    it('returns 0 when no active sequences match the event', async () => {
      // No handler → query returns [] (no matching sequences)
      const count = await enrollInSequences(env as any, 'user@test.com', 'some.unknown.event');
      expect(count).toBe(0);
    });

    it('schedules email sends for matching sequences', async () => {
      let queryCount = 0;
      env.DB.onQuery(/SELECT id, name FROM email_sequences/, () => {
        return [{ id: 1, name: 'Onboarding' }];
      });
      env.DB.onQuery(/SELECT id FROM email_sends/, () => {
        return []; // Not already enrolled
      });
      env.DB.onQuery(/SELECT id, step_order, delay_seconds FROM email_steps/, () => {
        return [
          { id: 10, step_order: 1, delay_seconds: 0 },
          { id: 11, step_order: 2, delay_seconds: 86_400 },
        ];
      });

      const count = await enrollInSequences(env as any, 'user@test.com', 'user.converted', {
        plan: 'pro',
      });

      expect(count).toBe(2);

      // Should have INSERT queries for the 2 email sends
      const inserts = env.DB._queries.filter((q) => q.sql.includes('INSERT INTO email_sends'));
      expect(inserts).toHaveLength(2);

      // Context data should be stored in KV
      const ctx = await env.KV_MARKETING.get('email-ctx:user@test.com:1');
      expect(ctx).toBeTruthy();
      expect(JSON.parse(ctx!)).toEqual({ plan: 'pro' });
    });

    it('skips enrollment when already enrolled (dedup)', async () => {
      env.DB.onQuery(/SELECT id, name FROM email_sequences/, () => {
        return [{ id: 1, name: 'Onboarding' }];
      });
      env.DB.onQuery(/SELECT id FROM email_sends/, () => {
        return [{ id: 999 }]; // Already enrolled
      });

      const count = await enrollInSequences(env as any, 'user@test.com', 'user.converted');
      expect(count).toBe(0);
    });

    it('aligns outbound scheduled_at to recipient local weekday send window', async () => {
      // Fixed UTC time: 03:00. For .com (UTC-5), local time is 22:00 (outside window),
      // so step1 should align to next local 09:00 => 14:00 UTC.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-23T03:00:00.000Z'));

      env.DB.onQuery(/SELECT id, name FROM email_sequences/, () => {
        return [{ id: 1, name: 'Cold Outreach' }];
      });
      env.DB.onQuery(/SELECT id FROM email_sends/, () => {
        return [];
      });
      env.DB.onQuery(/SELECT id, step_order, delay_seconds FROM email_steps/, () => {
        return [
          { id: 10, step_order: 1, delay_seconds: 0 },
          { id: 11, step_order: 2, delay_seconds: 86_400 },
        ];
      });

      const count = await enrollInSequences(
        env as any,
        'user@example.com',
        'outbound.prospect_discovered',
      );
      expect(count).toBe(2);

      const inserts = env.DB._queries.filter((q) => q.sql.includes('INSERT INTO email_sends'));
      expect(inserts).toHaveLength(2);

      // step1: 2026-04-23 14:00:00 UTC
      const expectedStep1 = Math.floor(new Date('2026-04-23T14:00:00.000Z').getTime() / 1000);
      // step2 base is +1 day at 03:00 UTC, still outside local window => 14:00 UTC same day
      const expectedStep2 = Math.floor(new Date('2026-04-24T14:00:00.000Z').getTime() / 1000);

      expect(inserts[0].params[3]).toBe(expectedStep1);
      expect(inserts[1].params[3]).toBe(expectedStep2);
    });
  });

  describe('cancelPendingEmails()', () => {
    it('updates scheduled emails to cancelled', async () => {
      // Mock: there are 3 scheduled emails for this contact + sequence
      env.DB.onQuery(/UPDATE email_sends/, () => []);
      // The function also queries to count — mock the count query
      env.DB.onQuery(/SELECT COUNT/, () => [{ 'COUNT(*)': 3 }]);

      const cancelled = await cancelPendingEmails(env as any, 'user@test.com', 'trial.expiring');

      // Should have at least one update query
      const updateQuery = env.DB._queries.find((q) => q.sql.includes('UPDATE'));
      expect(updateQuery).toBeTruthy();
    });
  });

  // ─── prepareTemplateContext() ─────────────────────────────────────────

  describe('prepareTemplateContext()', () => {
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
      angles: [{ type: 'critical-seo', hook: 'Missing meta descriptions', detail: 'Add meta descriptions to key pages' }],
    };

    it('produces auditPageUrl pointing to /audit?url=', () => {
      const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1');
      expect(result.auditPageUrl).toBe('https://visibility.clodo.dev/audit?url=acme.com');
    });

    it('encodes domain for URL usage', () => {
      const result = prepareTemplateContext({ ...baseContext, domain: 'my site.com' }, 'cold-outreach-step1');
      expect(result.domainEncoded).toBe('my%20site.com');
      expect(result.auditPageUrl).toContain('my%20site.com');
    });

    it('does not generate socialProof (removed to avoid Promotions tab)', () => {
      const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1');
      expect(result.socialProof).toBeUndefined();
    });

    it('generates personalSignOff', () => {
      const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1');
      expect(result.personalSignOff).toBe('— Alex from AXEO');
    });

    it('generates bodyVariant for step1', () => {
      const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1');
      expect(result.bodyVariant).toBeTruthy();
      expect(String(result.bodyVariant)).toContain('acme.com');
    });

    it('generates bodyVariant for step2', () => {
      const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step2');
      expect(result.bodyVariant).toBeTruthy();
      expect(String(result.bodyVariant)).toContain('acme.com');
    });

    it('generates bodyVariant for step3', () => {
      const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step3');
      expect(result.bodyVariant).toBeTruthy();
    });

    it('generates variantSubject with interpolated variables', () => {
      const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1');
      expect(result.variantSubject).toBeTruthy();
      const subject = String(result.variantSubject);
      // Should have interpolated company name or domain
      expect(subject.includes('Acme Inc') || subject.includes('acme.com')).toBe(true);
    });

    it('extracts quick win from angles', () => {
      const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step2');
      expect(result.quickWinTitle).toBe('Missing meta descriptions');
      expect(result.quickWinAction).toBe('Add meta descriptions to key pages');
    });

    it('provides default quick win when no angles', () => {
      const result = prepareTemplateContext({ ...baseContext, angles: [] }, 'cold-outreach-step2');
      expect(result.quickWinTitle).toBe('Optimise your meta descriptions');
    });

    it('generates greetingPrefix from variation pool', () => {
      const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1');
      expect(['Hi', 'Hey', 'Hello', 'Hi there', 'Good morning']).toContain(result.greetingPrefix);
    });

    it('generates closingLine from variation pool', () => {
      const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1');
      expect(['Best,', 'Cheers,', 'Thanks,', 'Talk soon,', 'All the best,', 'Looking forward to hearing from you,', 'Warmly,', 'Until next time,']).toContain(result.closingLine);
    });

    it('uses first name only for contactNameGreeting', () => {
      const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1');
      expect(result.contactNameGreeting).toBe(' John');
    });

    it('handles missing contactName gracefully', () => {
      const result = prepareTemplateContext({ ...baseContext, contactName: null }, 'cold-outreach-step1');
      expect(result.contactNameGreeting).toBe('');
    });

    it('truncates techStack to 5 items', () => {
      const result = prepareTemplateContext({
        ...baseContext,
        techStack: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      }, 'cold-outreach-step1');
      expect(String(result.techStackDisplay).split(', ').length).toBe(5);
    });

    it('generates unsubscribeLink HTML', () => {
      const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1');
      expect(String(result.unsubscribeLink)).toContain('unsubscribe');
      expect(String(result.unsubscribeLink)).toContain('john%40acme.com');
    });

    it('non-deterministic: bodyVariant varies across calls', () => {
      const results = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const r = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1');
        results.add(String(r.bodyVariant));
      }
      // With 3 variants and 50 iterations, we should see more than 1
      expect(results.size).toBeGreaterThan(1);
    });
  });
});
