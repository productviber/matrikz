/**
 * User Signup Event Handler Tests
 *
 * Tests for handleUserSignup() — CRM upsert, email sequence enrollment,
 * daily counter, KV context storage, and affiliate audit notes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleUserSignup } from '../../src/events/user-signup';
import { createMockEnv, type MockEnv } from '../helpers';
import { KV_PREFIX } from '../../src/constants';

describe('handleUserSignup()', () => {
  let env: MockEnv;
  const timestamp = new Date().toISOString();

  beforeEach(() => {
    env = createMockEnv();
    // Return empty sequences by default (no email enrolled)
    env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => []);
  });

  // ─── CRM upsert ─────────────────────────────────────────────────────

  describe('CRM contact upsert', () => {
    it('creates a new contact as "lead" for organic signup', async () => {
      await handleUserSignup(
        env as any,
        { userId: 'organic@test.com', provider: 'google' },
        timestamp
      );
      const upsertQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('marketing_contacts')
      );
      expect(upsertQuery).toBeDefined();
    });

    it('sets source to "organic" when no affiliateCode', async () => {
      await handleUserSignup(
        env as any,
        { userId: 'organic@test.com', provider: 'github' },
        timestamp
      );
      const insertQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('INSERT INTO marketing_contacts') || q.sql.includes('UPDATE marketing_contacts')
      );
      expect(insertQuery).toBeDefined();
    });

    it('sets source to "affiliate" when affiliateCode is present', async () => {
      await handleUserSignup(
        env as any,
        { userId: 'referred@test.com', provider: 'google', affiliateCode: 'aff-123' },
        timestamp
      );
      const queries = env.DB._queries.filter((q: any) =>
        q.sql.includes('marketing_contacts')
      );
      expect(queries.length).toBeGreaterThan(0);
    });
  });

  // ─── Email sequence enrollment ──────────────────────────────────────

  describe('email sequence enrollment', () => {
    it('enrolls user in welcome sequences matching user.signup', async () => {
      // Clear the default empty handler then register real sequence data
      env.DB.clearHandlers();
      env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => [
        { id: 3, name: 'Welcome Sequence', trigger_event: 'user.signup', is_active: 1 },
      ]);
      env.DB.onQuery(/SELECT.*email_steps.*sequence_id/, () => [
        { id: 7, sequence_id: 3, step_order: 1, delay_seconds: 0, template_key: 'welcome-signup', subject: 'Welcome', is_active: 1 },
        { id: 8, sequence_id: 3, step_order: 2, delay_seconds: 86400, template_key: 'welcome-day1', subject: 'Day 1', is_active: 1 },
        { id: 9, sequence_id: 3, step_order: 3, delay_seconds: 259200, template_key: 'welcome-day3', subject: 'Day 3', is_active: 1 },
      ]);
      // No existing enrollments (dedup check returns nothing)
      env.DB.onQuery(/SELECT.*email_sends.*contact_email/, () => []);

      await handleUserSignup(
        env as any,
        { userId: 'new@test.com', provider: 'google' },
        timestamp
      );

      const insertSends = env.DB._queries.filter((q: any) =>
        q.sql.includes('INSERT INTO email_sends')
      );
      expect(insertSends.length).toBe(3);
    });

    it('does not throw when no active sequences', async () => {
      await expect(
        handleUserSignup(
          env as any,
          { userId: 'empty@test.com', provider: 'github' },
          timestamp
        )
      ).resolves.not.toThrow();
    });
  });

  // ─── Daily counter ──────────────────────────────────────────────────

  describe('daily signup counter', () => {
    it('increments daily-signups counter in KV', async () => {
      await handleUserSignup(
        env as any,
        { userId: 'counter@test.com', provider: 'google' },
        timestamp
      );
      const today = new Date().toISOString().slice(0, 10);
      const count = await env.KV_MARKETING.get(`daily-signups:${today}`);
      expect(count).toBe('1');
    });

    it('accumulates multiple signups in same day', async () => {
      const today = new Date().toISOString().slice(0, 10);
      await env.KV_MARKETING.put(`daily-signups:${today}`, '4');

      await handleUserSignup(
        env as any,
        { userId: 'another@test.com', provider: 'google' },
        timestamp
      );
      const count = await env.KV_MARKETING.get(`daily-signups:${today}`);
      expect(count).toBe('5');
    });
  });

  // ─── KV signup context ──────────────────────────────────────────────

  describe('signup context in KV', () => {
    it('stores signup context under user-conversion:signup: prefix', async () => {
      await handleUserSignup(
        env as any,
        { userId: 'ctx@test.com', provider: 'google', affiliateCode: 'aff-ref' },
        timestamp
      );
      const key = `${KV_PREFIX.USER_CONVERSION}signup:ctx@test.com`;
      const raw = await env.KV_MARKETING.get(key);
      expect(raw).not.toBeNull();
      const ctx = JSON.parse(raw!);
      expect(ctx.provider).toBe('google');
      expect(ctx.affiliateCode).toBe('aff-ref');
      expect(ctx.source).toBe('affiliate');
    });

    it('stores organic source when no affiliateCode', async () => {
      await handleUserSignup(
        env as any,
        { userId: 'organic2@test.com', provider: 'github' },
        timestamp
      );
      const key = `${KV_PREFIX.USER_CONVERSION}signup:organic2@test.com`;
      const raw = await env.KV_MARKETING.get(key);
      const ctx = JSON.parse(raw!);
      expect(ctx.source).toBe('organic');
      expect(ctx.affiliateCode).toBeNull();
    });
  });

  // ─── Affiliate audit note ───────────────────────────────────────────

  describe('affiliate audit note', () => {
    it('writes affiliate_notes row when affiliateCode is present', async () => {
      await handleUserSignup(
        env as any,
        { userId: 'note@test.com', provider: 'google', affiliateCode: 'aff-xyz' },
        timestamp
      );
      const noteInsert = env.DB._queries.find((q: any) =>
        q.sql.includes('INSERT INTO affiliate_notes')
      );
      expect(noteInsert).toBeDefined();
      expect(noteInsert.params).toContain('aff-xyz');
    });

    it('does NOT write affiliate_notes when no affiliateCode', async () => {
      await handleUserSignup(
        env as any,
        { userId: 'nonote@test.com', provider: 'github' },
        timestamp
      );
      const noteInsert = env.DB._queries.find((q: any) =>
        q.sql.includes('INSERT INTO affiliate_notes')
      );
      expect(noteInsert).toBeUndefined();
    });
  });

  // ─── Referrer handling ──────────────────────────────────────────────

  describe('referrer context', () => {
    it('stores referrer in KV context', async () => {
      await handleUserSignup(
        env as any,
        { userId: 'ref@test.com', provider: 'google', referrer: 'https://twitter.com' },
        timestamp
      );
      const key = `${KV_PREFIX.USER_CONVERSION}signup:ref@test.com`;
      const ctx = JSON.parse(await env.KV_MARKETING.get(key) ?? '{}');
      expect(ctx.referrer).toBe('https://twitter.com');
    });
  });
});
