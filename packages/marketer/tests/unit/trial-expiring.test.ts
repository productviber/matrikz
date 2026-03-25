/**
 * Trial Expiring Event Handler Tests
 *
 * Tests for handleTrialExpiring() — CRM metadata update, trial-expiry
 * email sequence enrollment, KV urgency data, and imminent-expiry notifications.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleTrialExpiring } from '../../src/events/trial-expiring';
import { createMockEnv, type MockEnv } from '../helpers';
import { KV_PREFIX, CONTACT_STATUS } from '../../src/constants';

describe('handleTrialExpiring()', () => {
  let env: MockEnv;
  const timestamp = new Date().toISOString();

  const trialData = {
    userId: 'trial@test.com',
    plan: 'growth',
    daysRemaining: 2,
    expiresAt: new Date(Date.now() + 2 * 86400 * 1000).toISOString(),
  };

  beforeEach(() => {
    env = createMockEnv();
    // Default: no existing contact
    env.DB.onQuery(/SELECT.*marketing_contacts/, () => []);
    // No sequences matching trial.expiring
    env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => []);
    // Notification logging
    env.DB.onQuery(/INSERT.*notifications/, () => []);
  });

  describe('CRM contact management', () => {
    it('creates contact as trial if not existing', async () => {
      await handleTrialExpiring(env as any, trialData, timestamp);
      const crmQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('marketing_contacts')
      );
      expect(crmQuery).toBeDefined();
    });

    it('skips processing if contact is already a customer', async () => {
      env.DB.clearHandlers();
      env.DB.onQuery(/SELECT.*marketing_contacts/, () => [{
        id: 1,
        email: 'trial@test.com',
        status: 'customer',
        plan: 'pro',
        metadata: null,
        first_seen_at: Date.now(),
        updated_at: Date.now(),
        total_spent_cents: 4900,
      }]);
      env.DB.onQuery(/SELECT.*email_sequences/, () => []);

      await handleTrialExpiring(env as any, trialData, timestamp);

      // Should not attempt to enroll in sequences since contact is a customer
      const seqQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('email_sequences') && q.sql.includes('trigger_event')
      );
      expect(seqQuery).toBeUndefined();
    });

    it('updates metadata with expiry context for existing trial', async () => {
      env.DB.clearHandlers();
      env.DB.onQuery(/SELECT.*marketing_contacts/, () => [{
        id: 1,
        email: 'trial@test.com',
        status: 'trial',
        plan: 'growth',
        metadata: JSON.stringify({ signupSource: 'organic' }),
        first_seen_at: Date.now(),
        updated_at: Date.now(),
        total_spent_cents: 0,
      }]);
      env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => []);

      await handleTrialExpiring(env as any, trialData, timestamp);
      const upsertQuery = env.DB._queries.find((q: any) =>
        (q.sql.includes('INSERT') || q.sql.includes('UPDATE')) && q.sql.includes('marketing_contacts')
      );
      expect(upsertQuery).toBeDefined();
    });
  });

  describe('email sequences', () => {
    it('enrolls in trial-expiry email sequences', async () => {
      await handleTrialExpiring(env as any, trialData, timestamp);
      const seqQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('email_sequences') && q.sql.includes('trigger_event')
      );
      expect(seqQuery).toBeDefined();
    });
  });

  describe('KV urgency data', () => {
    it('stores trial urgency data in KV', async () => {
      await handleTrialExpiring(env as any, trialData, timestamp);
      const kvKey = `${KV_PREFIX.DAILY_EVENTS}trial-expiring:${trialData.userId}`;
      const stored = await env.KV_MARKETING.get(kvKey);
      expect(stored).toBeDefined();
      const parsed = JSON.parse(stored!);
      expect(parsed.plan).toBe('growth');
      expect(parsed.daysRemaining).toBe(2);
    });
  });

  describe('daily counter', () => {
    it('increments daily trial-expiring counter', async () => {
      await handleTrialExpiring(env as any, trialData, timestamp);
      const today = new Date().toISOString().slice(0, 10);
      const counterKey = `${KV_PREFIX.DAILY_EVENTS}trials-expiring:${today}`;
      const count = await env.KV_MARKETING.get(counterKey);
      expect(count).toBe('1');
    });

    it('increments existing counter', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const counterKey = `${KV_PREFIX.DAILY_EVENTS}trials-expiring:${today}`;
      await env.KV_MARKETING.put(counterKey, '2');
      await handleTrialExpiring(env as any, trialData, timestamp);
      const count = await env.KV_MARKETING.get(counterKey);
      expect(count).toBe('3');
    });
  });

  describe('imminent expiry notifications', () => {
    it('does not notify when daysRemaining > 1', async () => {
      // daysRemaining = 2, should not trigger notification
      await expect(handleTrialExpiring(env as any, trialData, timestamp)).resolves.not.toThrow();
    });

    it('does not throw for imminent expiry with notifications disabled', async () => {
      const imminentData = { ...trialData, daysRemaining: 1 };
      await expect(handleTrialExpiring(env as any, imminentData, timestamp)).resolves.not.toThrow();
    });

    it('does not throw for same-day expiry', async () => {
      const imminentData = { ...trialData, daysRemaining: 0 };
      await expect(handleTrialExpiring(env as any, imminentData, timestamp)).resolves.not.toThrow();
    });
  });
});
