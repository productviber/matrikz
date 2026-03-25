/**
 * User Milestone Event Handler Tests
 *
 * Tests for handleUserMilestone() — CRM metadata update, email sequence enrollment,
 * daily milestone counter, and affiliate note logging.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleUserMilestone } from '../../src/events/user-milestone';
import { createMockEnv, type MockEnv } from '../helpers';
import { KV_PREFIX } from '../../src/constants';

describe('handleUserMilestone()', () => {
  let env: MockEnv;
  const timestamp = new Date().toISOString();

  const milestoneData = {
    userId: 'milestone@test.com',
    milestoneType: 'keywords_tracked',
    milestoneValue: 100,
  };

  beforeEach(() => {
    env = createMockEnv();
    // Default: no existing contact
    env.DB.onQuery(/SELECT.*marketing_contacts.*WHERE email/, () => []);
    // No sequences matching user.milestone
    env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => []);
    // Affiliate note insert (always succeeds)
    env.DB.onQuery(/INSERT INTO affiliate_notes/, () => []);
  });

  describe('CRM metadata update', () => {
    it('updates contact metadata with milestone info', async () => {
      await handleUserMilestone(env as any, milestoneData, timestamp);
      const crmQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('marketing_contacts')
      );
      expect(crmQuery).toBeDefined();
    });
  });

  describe('email sequence enrollment', () => {
    it('attempts enrollment in user.milestone sequences', async () => {
      await handleUserMilestone(env as any, milestoneData, timestamp);
      const seqQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('email_sequences') && q.sql.includes('trigger_event')
      );
      expect(seqQuery).toBeDefined();
    });
  });

  describe('daily milestone counter', () => {
    it('increments KV milestone counter for today', async () => {
      await handleUserMilestone(env as any, milestoneData, timestamp);
      const today = new Date().toISOString().slice(0, 10);
      const counterKey = `${KV_PREFIX.DAILY_EVENTS}milestone:${today}`;
      const count = await env.KV_MARKETING.get(counterKey);
      expect(count).toBe('1');
    });
  });

  describe('affiliate note logging', () => {
    it('logs milestone note if user has an affiliate code', async () => {
      // Simulate user with an affiliate code
      env.DB.clearHandlers();
      env.DB.onQuery(/SELECT.*marketing_contacts.*WHERE email/, () => [{
        id: 1,
        email: 'milestone@test.com',
        status: 'customer',
        affiliate_code: 'AFF100',
        source: 'affiliate',
        first_seen_at: Date.now(),
        updated_at: Date.now(),
        total_spent_cents: 0,
        plan: 'growth',
        gateway: 'stripe',
        metadata: null,
        converted_at: null,
      }]);
      env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => []);
      env.DB.onQuery(/INSERT INTO affiliate_notes/, () => []);

      await handleUserMilestone(env as any, milestoneData, timestamp);
      const noteQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('INSERT INTO affiliate_notes')
      );
      expect(noteQuery).toBeDefined();
      expect(noteQuery!.params).toContain('AFF100');
      // Verify correct column name matches schema (content, not note)
      expect(noteQuery!.sql).toContain('content');
      expect(noteQuery!.sql).not.toMatch(/\bnote\b.*VALUES/);
    });

    it('skips affiliate note when user has no affiliate code', async () => {
      env.DB.clearHandlers();
      env.DB.onQuery(/SELECT.*marketing_contacts.*WHERE email/, () => [{
        id: 1,
        email: 'milestone@test.com',
        status: 'lead',
        affiliate_code: null,
        source: 'organic',
        first_seen_at: Date.now(),
        updated_at: Date.now(),
        total_spent_cents: 0,
        plan: null,
        gateway: null,
        metadata: null,
        converted_at: null,
      }]);
      env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => []);

      await handleUserMilestone(env as any, milestoneData, timestamp);
      const noteQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('INSERT INTO affiliate_notes')
      );
      expect(noteQuery).toBeUndefined();
    });
  });
});
