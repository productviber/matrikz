/**
 * Tests — Personal Email Blocking (isPersonalEmail + PERSONAL_EMAIL_DOMAINS)
 *
 * Ensures the centralized personal/freemail blocklist functions correctly
 * and stays in sync with the analytics-side COMPLIANCE.BLOCKED_DOMAINS.
 */

import { describe, it, expect } from 'vitest';
import { isPersonalEmail, PERSONAL_EMAIL_DOMAINS } from '../../src/constants';

// ═══════════════════════════════════════════════════════════════════════
// PERSONAL_EMAIL_DOMAINS constant
// ═══════════════════════════════════════════════════════════════════════

describe('PERSONAL_EMAIL_DOMAINS', () => {
  it('is a ReadonlySet', () => {
    expect(PERSONAL_EMAIL_DOMAINS).toBeInstanceOf(Set);
    expect(typeof PERSONAL_EMAIL_DOMAINS.has).toBe('function');
  });

  it('contains all major freemail providers', () => {
    const expected = [
      'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
      'icloud.com', 'mail.com', 'protonmail.com', 'zoho.com', 'yandex.com',
    ];
    for (const domain of expected) {
      expect(PERSONAL_EMAIL_DOMAINS.has(domain), `missing: ${domain}`).toBe(true);
    }
  });

  it('contains international variants', () => {
    const international = ['gmx.de', 'web.de', 'mail.ru', 'qq.com', 'yahoo.co.uk', 'yahoo.co.jp', 'outlook.de', 'outlook.fr'];
    for (const domain of international) {
      expect(PERSONAL_EMAIL_DOMAINS.has(domain), `missing: ${domain}`).toBe(true);
    }
  });

  it('contains privacy-focused providers', () => {
    const privacy = ['pm.me', 'tutanota.com', 'riseup.net'];
    for (const domain of privacy) {
      expect(PERSONAL_EMAIL_DOMAINS.has(domain), `missing: ${domain}`).toBe(true);
    }
  });

  it('does NOT contain business/custom domains', () => {
    expect(PERSONAL_EMAIL_DOMAINS.has('acme.com')).toBe(false);
    expect(PERSONAL_EMAIL_DOMAINS.has('clodo.dev')).toBe(false);
    expect(PERSONAL_EMAIL_DOMAINS.has('stripe.com')).toBe(false);
  });

  it('has at least 25 domains (comprehensive coverage)', () => {
    expect(PERSONAL_EMAIL_DOMAINS.size).toBeGreaterThanOrEqual(25);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// isPersonalEmail()
// ═══════════════════════════════════════════════════════════════════════

describe('isPersonalEmail()', () => {
  // ── Positive cases (should block) ─────────────────────────────────

  it('returns true for gmail addresses', () => {
    expect(isPersonalEmail('john@gmail.com')).toBe(true);
  });

  it('returns true for yahoo addresses', () => {
    expect(isPersonalEmail('jane@yahoo.com')).toBe(true);
  });

  it('returns true for outlook addresses', () => {
    expect(isPersonalEmail('user@outlook.com')).toBe(true);
  });

  it('returns true for protonmail addresses', () => {
    expect(isPersonalEmail('secure@protonmail.com')).toBe(true);
  });

  it('returns true for pm.me addresses', () => {
    expect(isPersonalEmail('me@pm.me')).toBe(true);
  });

  it('returns true for international yahoo variant', () => {
    expect(isPersonalEmail('user@yahoo.co.uk')).toBe(true);
  });

  // ── Negative cases (should allow) ─────────────────────────────────

  it('returns false for custom business domains', () => {
    expect(isPersonalEmail('ceo@acme.com')).toBe(false);
  });

  it('returns false for SaaS company domains', () => {
    expect(isPersonalEmail('hello@stripe.com')).toBe(false);
  });

  it('returns false for agency domains', () => {
    expect(isPersonalEmail('contact@webagency.io')).toBe(false);
  });

  // ── Edge cases ────────────────────────────────────────────────────

  it('returns true for empty string', () => {
    expect(isPersonalEmail('')).toBe(true);
  });

  it('returns true for missing @ sign', () => {
    expect(isPersonalEmail('nodomain')).toBe(true);
  });

  it('returns true for email with no domain part', () => {
    expect(isPersonalEmail('user@')).toBe(true);
  });

  it('is case-insensitive on domain matching', () => {
    expect(isPersonalEmail('John@GMAIL.COM')).toBe(true);
    expect(isPersonalEmail('USER@Outlook.Com')).toBe(true);
  });

  it('does not false-positive on domain substrings', () => {
    // "gmail.company.com" should NOT be blocked
    expect(isPersonalEmail('user@gmail-team.com')).toBe(false);
    expect(isPersonalEmail('user@notgmail.com')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cross-codebase sync invariant
// ═══════════════════════════════════════════════════════════════════════

describe('cross-codebase sync invariant', () => {
  // This test documents the exact domain count so that devs adding
  // domains to one side remember to update both.
  it('has 29 domains (change both constants.ts AND outbound-constants.mjs if updating)', () => {
    expect(PERSONAL_EMAIL_DOMAINS.size).toBe(29);
  });
});
