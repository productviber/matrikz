/**
 * Unit Tests — Email Sequence Engine
 *
 * Tests enrollment, deduplication, and cancellation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { enrollInSequences, cancelPendingEmails } from '../../src/lib/email';
import { createMockEnv, type MockEnv } from '../helpers';

describe('email', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
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
});
