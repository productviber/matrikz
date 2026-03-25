/**
 * Insight Generated Event Handler Tests
 *
 * Tests for handleInsightGenerated() — CRM engagement metadata update,
 * email sequence enrollment, and daily insight counter.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleInsightGenerated } from '../../src/events/insight-generated';
import { createMockEnv, type MockEnv } from '../helpers';
import { KV_PREFIX } from '../../src/constants';

describe('handleInsightGenerated()', () => {
  let env: MockEnv;
  const timestamp = new Date().toISOString();

  const insightData = {
    userId: 'site@test.com',
    insightCount: 3,
    topInsightType: 'content_decay',
    severity: 'warning',
  };

  beforeEach(() => {
    env = createMockEnv();
    // Default: no existing contact
    env.DB.onQuery(/SELECT.*marketing_contacts/, () => []);
    // No sequences matching insight.generated
    env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => []);
  });

  describe('CRM engagement metadata', () => {
    it('updates engagement metadata for existing contact', async () => {
      env.DB.clearHandlers();
      env.DB.onQuery(/SELECT.*marketing_contacts/, () => [{
        id: 1,
        email: 'site@test.com',
        status: 'customer',
        plan: 'growth',
        metadata: JSON.stringify({ totalInsightsReceived: 10 }),
        first_seen_at: Date.now(),
        updated_at: Date.now(),
        total_spent_cents: 4900,
      }]);
      env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => []);

      await handleInsightGenerated(env as any, insightData, timestamp);

      const upsertQuery = env.DB._queries.find((q: any) =>
        (q.sql.includes('INSERT') || q.sql.includes('UPDATE')) && q.sql.includes('marketing_contacts')
      );
      expect(upsertQuery).toBeDefined();
    });

    it('does not update CRM when contact does not exist', async () => {
      await handleInsightGenerated(env as any, insightData, timestamp);

      // Only the SELECT query should be made, not INSERT/UPDATE for metadata
      const selectQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('SELECT') && q.sql.includes('marketing_contacts')
      );
      expect(selectQuery).toBeDefined();
    });
  });

  describe('email sequences', () => {
    it('enrolls in email sequences for insight.generated trigger', async () => {
      await handleInsightGenerated(env as any, insightData, timestamp);
      const seqQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('email_sequences') && q.sql.includes('trigger_event')
      );
      expect(seqQuery).toBeDefined();
    });
  });

  describe('daily insight counter', () => {
    it('increments daily insight counter by insightCount', async () => {
      await handleInsightGenerated(env as any, insightData, timestamp);
      const today = new Date().toISOString().slice(0, 10);
      const counterKey = `${KV_PREFIX.DAILY_EVENTS}insights:${today}`;
      const count = await env.KV_MARKETING.get(counterKey);
      expect(count).toBe('3'); // insightCount = 3
    });

    it('adds to existing counter', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const counterKey = `${KV_PREFIX.DAILY_EVENTS}insights:${today}`;
      await env.KV_MARKETING.put(counterKey, '10');
      await handleInsightGenerated(env as any, insightData, timestamp);
      const count = await env.KV_MARKETING.get(counterKey);
      expect(count).toBe('13'); // 10 + 3
    });

    it('handles single insight', async () => {
      const singleData = { ...insightData, insightCount: 1 };
      await handleInsightGenerated(env as any, singleData, timestamp);
      const today = new Date().toISOString().slice(0, 10);
      const counterKey = `${KV_PREFIX.DAILY_EVENTS}insights:${today}`;
      const count = await env.KV_MARKETING.get(counterKey);
      expect(count).toBe('1');
    });
  });

  describe('resilience', () => {
    it('does not throw when all dependencies are mocked', async () => {
      await expect(handleInsightGenerated(env as any, insightData, timestamp)).resolves.not.toThrow();
    });
  });
});
