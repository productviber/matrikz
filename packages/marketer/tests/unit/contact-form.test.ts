/**
 * Contact Form Submission Channel Tests
 *
 * Tests for buildFormPayload field mapping, submitContactForm(),
 * and attemptFormOutreach() dedup logic.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { submitContactForm, attemptFormOutreach } from '../../src/lib/contact-form';
import { createMockEnv, type MockEnv } from '../helpers';
import type { ContactForm } from '../../src/types';

// Mock global fetch
const mockFetch = vi.fn();

describe('Contact Form Channel', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv({ ENVIRONMENT: 'production' as any });
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseForm: ContactForm = {
    action: 'https://acme.com/api/contact',
    method: 'POST',
    fields: ['name', 'email', 'message'],
    pageUrl: 'https://acme.com/contact',
    type: 'contact',
  };

  const baseContext = {
    domain: 'acme.com',
    companyName: 'Acme Inc',
    auditScore: 65,
    auditGrade: 'C',
    issueCount: 12,
    passCount: 8,
    contactForms: [baseForm],
    socialHandles: {},
  };

  // ─── Field Mapping ───────────────────────────────────────────────────

  describe('submitContactForm()', () => {
    it('maps name, email, and message fields correctly', async () => {
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      await submitContactForm(env as any, baseForm, baseContext);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://acme.com/api/contact');
      expect(opts.method).toBe('POST');

      const body = new URLSearchParams(opts.body);
      expect(body.get('name')).toBe('Test'); // FROM_NAME from mock env
      expect(body.get('email')).toBe('test@clodo.dev'); // FROM_EMAIL from mock env
      expect(body.get('message')).toContain('acme.com');
      expect(body.get('message')).toContain('65/100');
      expect(body.get('message')).toContain('Grade C');
    });

    it('returns true on 200 response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));
      const result = await submitContactForm(env as any, baseForm, baseContext);
      expect(result).toBe(true);
    });

    it('returns true on 302 redirect (common for form submissions)', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 302 }));
      const result = await submitContactForm(env as any, baseForm, baseContext);
      expect(result).toBe(true);
    });

    it('returns false on 4xx/5xx errors', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
      const result = await submitContactForm(env as any, baseForm, baseContext);
      expect(result).toBe(false);
    });

    it('returns false on network timeout', async () => {
      mockFetch.mockRejectedValueOnce(new Error('timeout'));
      const result = await submitContactForm(env as any, baseForm, baseContext);
      expect(result).toBe(false);
    });

    it('handles forms with subject field', async () => {
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));
      const form = { ...baseForm, fields: ['name', 'email', 'subject', 'message'] };
      await submitContactForm(env as any, form, baseContext);

      const body = new URLSearchParams(mockFetch.mock.calls[0][1].body);
      expect(body.get('subject')).toContain('acme.com');
      expect(body.get('subject')).toContain('search visibility');
    });

    it('handles forms with company and website fields', async () => {
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));
      const form = { ...baseForm, fields: ['name', 'email', 'company', 'website', 'message'] };
      await submitContactForm(env as any, form, baseContext);

      const body = new URLSearchParams(mockFetch.mock.calls[0][1].body);
      expect(body.get('company')).toBe('AXEO');
      expect(body.get('website')).toBe('https://visibility.clodo.dev');
    });

    it('skips form if no message field is mappable', async () => {
      // Form with only name+email, no message → we can't send our content
      const form = { ...baseForm, fields: ['name', 'email'] };
      const result = await submitContactForm(env as any, form, baseContext);
      expect(result).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sends Referer and Origin headers matching the form page', async () => {
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));
      await submitContactForm(env as any, baseForm, baseContext);

      const opts = mockFetch.mock.calls[0][1];
      expect(opts.headers.Referer).toBe('https://acme.com/contact');
      expect(opts.headers.Origin).toBe('https://acme.com');
    });
  });

  // ─── Dedup & Orchestration ─────────────────────────────────────────

  describe('attemptFormOutreach()', () => {
    it('submits to the first available form', async () => {
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const result = await attemptFormOutreach(env as any, 'john@acme.com', baseContext);
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('skips if no contactForms in context', async () => {
      const ctx = { ...baseContext, contactForms: [] };
      const result = await attemptFormOutreach(env as any, 'john@acme.com', ctx);
      expect(result).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('skips if contactForms is undefined', async () => {
      const { contactForms, ...ctx } = baseContext;
      const result = await attemptFormOutreach(env as any, 'john@acme.com', ctx);
      expect(result).toBe(false);
    });

    it('stores dedup key in KV after successful submission', async () => {
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      await attemptFormOutreach(env as any, 'john@acme.com', baseContext);

      const dedupKey = 'outbound:form:acme.com';
      const stored = env.KV_MARKETING._store.get(dedupKey);
      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored!);
      expect(parsed.formAction).toBe('https://acme.com/api/contact');
      expect(parsed.email).toBe('john@acme.com');
    });

    it('skips if already submitted for this domain', async () => {
      // Pre-set dedup key
      env.KV_MARKETING._store.set('outbound:form:acme.com', JSON.stringify({ submittedAt: '2025-01-01' }));

      const result = await attemptFormOutreach(env as any, 'john@acme.com', baseContext);
      expect(result).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('tries next form if first one fails', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response('Error', { status: 500 }))
        .mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const form2: ContactForm = {
        action: 'https://acme.com/alternate-contact',
        method: 'POST',
        fields: ['name', 'email', 'message'],
        pageUrl: 'https://acme.com/about',
        type: 'contact',
      };
      const ctx = { ...baseContext, contactForms: [baseForm, form2] };

      const result = await attemptFormOutreach(env as any, 'john@acme.com', ctx);
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('returns false if all forms fail', async () => {
      mockFetch.mockResolvedValue(new Response('Error', { status: 500 }));

      const result = await attemptFormOutreach(env as any, 'john@acme.com', baseContext);
      expect(result).toBe(false);
    });
  });
});
