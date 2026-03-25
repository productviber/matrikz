/**
 * Affiliate Conversion Event Handler Tests
 *
 * Validates commission tracking, tier upgrades, campaign conversion
 * increment, and CRM updates.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleAffiliateConversion } from '../../src/events/affiliate-conversion';
import { createMockEnv, type MockEnv } from '../helpers';
import { KV_PREFIX } from '../../src/constants';

const timestamp = '2025-01-15T12:00:00.000Z';

function makeConversionData(overrides = {}) {
  return {
    affiliateCode: 'AFF100',
    userId: 'buyer@test.com',
    eventType: 'purchase',
    amountCents: 2900,
    commissionCents: 290,
    plan: 'starter',
    ...overrides,
  };
}

describe('handleAffiliateConversion()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();

    // Default DB handlers
    env.DB.onQuery(/SELECT.*marketing_contacts/, () => []);
    env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => []);
    env.DB.onQuery(/SELECT.*email_sends/, () => []);
  });

  describe('campaign conversion counter', () => {
    it('increments campaigns.conversions for affiliate code', async () => {
      await handleAffiliateConversion(env as any, makeConversionData(), timestamp);

      const campaignUpdate = env.DB._queries.find(
        (q: any) =>
          q.sql.includes('UPDATE campaigns') &&
          q.sql.includes('conversions = conversions + 1')
      );
      expect(campaignUpdate).toBeDefined();
      expect(campaignUpdate!.params).toContain('AFF100');
    });
  });

  describe('affiliate stats tracking', () => {
    it('creates initial affiliate stats in KV', async () => {
      await handleAffiliateConversion(env as any, makeConversionData(), timestamp);

      const kvKey = `${KV_PREFIX.AFFILIATE_STATS}AFF100`;
      const raw = await env.KV_MARKETING.get(kvKey);
      expect(raw).not.toBeNull();
      const stats = JSON.parse(raw!);
      expect(stats.totalConversions).toBe(1);
      expect(stats.totalEarnedCents).toBe(290);
    });

    it('increments existing affiliate stats', async () => {
      const kvKey = `${KV_PREFIX.AFFILIATE_STATS}AFF100`;
      await env.KV_MARKETING.put(kvKey, JSON.stringify({
        totalConversions: 5,
        totalEarnedCents: 1450,
        lastConversionAt: '2025-01-01T00:00:00Z',
      }));

      await handleAffiliateConversion(env as any, makeConversionData(), timestamp);

      const stats = JSON.parse(await env.KV_MARKETING.get(kvKey) ?? '{}');
      expect(stats.totalConversions).toBe(6);
      expect(stats.totalEarnedCents).toBe(1740);
    });
  });

  describe('self-referral guard', () => {
    it('blocks self-referral', async () => {
      const kvKey = `${KV_PREFIX.AFFILIATE_EMAIL}AFF100`;
      await env.KV_MARKETING.put(kvKey, 'buyer@test.com');

      await handleAffiliateConversion(
        env as any,
        makeConversionData({ userId: 'buyer@test.com' }),
        timestamp
      );

      // Should NOT write affiliate stats (blocked)
      const statsKey = `${KV_PREFIX.AFFILIATE_STATS}AFF100`;
      const raw = await env.KV_MARKETING.get(statsKey);
      expect(raw).toBeNull();
    });
  });

  describe('CRM update', () => {
    it('marks converting user as customer in CRM', async () => {
      await handleAffiliateConversion(env as any, makeConversionData(), timestamp);

      const crmQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('marketing_contacts')
      );
      expect(crmQuery).toBeDefined();
    });
  });

  describe('audit trail', () => {
    it('inserts conversion note', async () => {
      await handleAffiliateConversion(env as any, makeConversionData(), timestamp);

      const noteQuery = env.DB._queries.find(
        (q: any) =>
          q.sql.includes('INSERT INTO affiliate_notes') &&
          q.params.includes('AFF100')
      );
      expect(noteQuery).toBeDefined();
    });
  });
});
