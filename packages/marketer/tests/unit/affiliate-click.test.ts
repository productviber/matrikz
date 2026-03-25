/**
 * Affiliate Click Event Handler Tests
 *
 * Tests for handleAffiliateClick() — KV stats increment, campaign click counter,
 * and daily click counter tracking.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleAffiliateClick } from '../../src/events/affiliate-click';
import { createMockEnv, type MockEnv } from '../helpers';
import { KV_PREFIX } from '../../src/constants';

describe('handleAffiliateClick()', () => {
  let env: MockEnv;
  const timestamp = new Date().toISOString();

  const clickData = {
    affiliateCode: 'AFF200',
    landingPage: '/pricing',
    referrer: 'https://blog.example.com',
    country: 'US',
  };

  beforeEach(() => {
    env = createMockEnv();
    // Campaign click update (always succeeds)
    env.DB.onQuery(/UPDATE campaigns SET clicks/, () => []);
  });

  describe('KV affiliate stats', () => {
    it('increments click count in affiliate stats KV', async () => {
      await handleAffiliateClick(env as any, clickData, timestamp);
      const statsKey = `${KV_PREFIX.AFFILIATE_STATS}AFF200`;
      const statsRaw = await env.KV_MARKETING.get(statsKey);
      const stats = JSON.parse(statsRaw!);
      expect(stats.clicks).toBe(1);
    });

    it('increments existing click count', async () => {
      const statsKey = `${KV_PREFIX.AFFILIATE_STATS}AFF200`;
      await env.KV_MARKETING.put(statsKey, JSON.stringify({ clicks: 5, conversions: 2, revenue: 1000 }));

      await handleAffiliateClick(env as any, clickData, timestamp);
      const statsRaw = await env.KV_MARKETING.get(statsKey);
      const stats = JSON.parse(statsRaw!);
      expect(stats.clicks).toBe(6);
      expect(stats.conversions).toBe(2); // unchanged
      expect(stats.revenue).toBe(1000);  // unchanged
    });
  });

  describe('campaign click counter', () => {
    it('updates campaigns table click count', async () => {
      await handleAffiliateClick(env as any, clickData, timestamp);
      const campaignQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('UPDATE campaigns') && q.sql.includes('clicks')
      );
      expect(campaignQuery).toBeDefined();
      expect(campaignQuery!.params).toContain('AFF200');
    });
  });

  describe('daily click counter', () => {
    it('increments daily click counter in KV', async () => {
      await handleAffiliateClick(env as any, clickData, timestamp);
      const today = new Date().toISOString().slice(0, 10);
      const counterKey = `${KV_PREFIX.DAILY_EVENTS}clicks:${today}`;
      const count = await env.KV_MARKETING.get(counterKey);
      expect(count).toBe('1');
    });

    it('increments existing daily counter', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const counterKey = `${KV_PREFIX.DAILY_EVENTS}clicks:${today}`;
      await env.KV_MARKETING.put(counterKey, '10');
      await handleAffiliateClick(env as any, clickData, timestamp);
      const count = await env.KV_MARKETING.get(counterKey);
      expect(count).toBe('11');
    });
  });
});
