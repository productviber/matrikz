/**
 * User Churned Event Handler Tests
 *
 * Tests for handleUserChurned() — CRM status update, win-back sequence enrollment,
 * daily churn counter, MRR snapshot update, and admin notifications.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleUserChurned } from '../../src/events/user-churned';
import { createMockEnv, type MockEnv } from '../helpers';
import { KV_PREFIX } from '../../src/constants';

describe('handleUserChurned()', () => {
  let env: MockEnv;
  const timestamp = new Date().toISOString();

  const churnData = {
    userId: 'churned@test.com',
    previousPlan: 'growth',
    daysActive: 45,
    lastActivity: '2024-01-15T10:00:00Z',
  };

  beforeEach(() => {
    env = createMockEnv();
    // Default: no existing contact
    env.DB.onQuery(/SELECT.*marketing_contacts/, () => []);
    // No sequences matching user.churned
    env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => []);
    // MRR update
    env.DB.onQuery(/UPDATE.*mrr_snapshots/, () => []);
  });

  describe('CRM status update', () => {
    it('marks contact as churned', async () => {
      await handleUserChurned(env as any, churnData, timestamp);
      const crmQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('marketing_contacts')
      );
      expect(crmQuery).toBeDefined();
    });

    it('stores churn metadata', async () => {
      await handleUserChurned(env as any, churnData, timestamp);
      const crmQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('INSERT INTO marketing_contacts') || q.sql.includes('UPDATE marketing_contacts')
      );
      expect(crmQuery).toBeDefined();
    });
  });

  describe('win-back sequence', () => {
    it('enrolls in email sequences for user.churned trigger', async () => {
      await handleUserChurned(env as any, churnData, timestamp);
      const seqQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('email_sequences') && q.sql.includes('trigger_event')
      );
      expect(seqQuery).toBeDefined();
    });
  });

  describe('daily churn counter', () => {
    it('increments KV churn counter for today', async () => {
      await handleUserChurned(env as any, churnData, timestamp);
      const today = new Date().toISOString().slice(0, 10);
      const counterKey = `${KV_PREFIX.DAILY_EVENTS}churn:${today}`;
      const count = await env.KV_MARKETING.get(counterKey);
      expect(count).toBe('1');
    });

    it('increments existing counter', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const counterKey = `${KV_PREFIX.DAILY_EVENTS}churn:${today}`;
      await env.KV_MARKETING.put(counterKey, '3');
      await handleUserChurned(env as any, churnData, timestamp);
      const count = await env.KV_MARKETING.get(counterKey);
      expect(count).toBe('4');
    });
  });

  describe('MRR snapshot', () => {
    it('increments churned_customers in mrr_snapshots', async () => {
      await handleUserChurned(env as any, churnData, timestamp);
      const mrrQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('UPDATE mrr_snapshots') && q.sql.includes('churned_customers')
      );
      expect(mrrQuery).toBeDefined();
    });
  });

  describe('admin notifications', () => {
    it('does not throw when notifications are disabled', async () => {
      // env has empty SLACK_WEBHOOK_URL by default
      await expect(handleUserChurned(env as any, churnData, timestamp)).resolves.not.toThrow();
    });
  });
});
