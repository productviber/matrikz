/**
 * Unit Tests — Commission Tiers Module
 *
 * Tests tier assignment, upgrades, and earnings milestones.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTierForConversions,
  checkTierUpgrade,
  tierLabel,
  checkEarningsMilestone,
  recordTierUpgrade,
} from '../../src/lib/commission-tiers';
import { createMockEnv, MockD1Database } from '../helpers';

describe('commission-tiers', () => {
  describe('getTierForConversions', () => {
    it('returns Starter for 0 conversions', () => {
      const tier = getTierForConversions(0);
      expect(tier.name).toBe('Starter');
      expect(tier.rate).toBe(0.20);
    });

    it('returns Starter for 9 conversions', () => {
      expect(getTierForConversions(9).name).toBe('Starter');
    });

    it('returns Silver at exactly 10 conversions', () => {
      const tier = getTierForConversions(10);
      expect(tier.name).toBe('Silver');
      expect(tier.rate).toBe(0.25);
    });

    it('returns Gold at 50 conversions', () => {
      const tier = getTierForConversions(50);
      expect(tier.name).toBe('Gold');
      expect(tier.rate).toBe(0.30);
    });

    it('returns Platinum at 200 conversions', () => {
      const tier = getTierForConversions(200);
      expect(tier.name).toBe('Platinum');
      expect(tier.rate).toBe(0.35);
    });

    it('returns Platinum for very high conversion count', () => {
      expect(getTierForConversions(10_000).name).toBe('Platinum');
    });
  });

  describe('checkTierUpgrade', () => {
    it('returns null when staying in same tier', () => {
      expect(checkTierUpgrade(5, 6)).toBeNull();
      expect(checkTierUpgrade(15, 20)).toBeNull();
    });

    it('returns Silver tier when crossing 10 threshold', () => {
      const upgrade = checkTierUpgrade(9, 10);
      expect(upgrade).not.toBeNull();
      expect(upgrade!.name).toBe('Silver');
      expect(upgrade!.rate).toBe(0.25);
    });

    it('returns Gold tier when crossing 50 threshold', () => {
      const upgrade = checkTierUpgrade(49, 50);
      expect(upgrade).not.toBeNull();
      expect(upgrade!.name).toBe('Gold');
    });

    it('returns Platinum when crossing 200 threshold', () => {
      const upgrade = checkTierUpgrade(199, 200);
      expect(upgrade).not.toBeNull();
      expect(upgrade!.name).toBe('Platinum');
    });

    it('returns highest tier when jumping multiple thresholds', () => {
      // If somehow we go from 5 to 60 conversions in one batch
      const upgrade = checkTierUpgrade(5, 60);
      expect(upgrade).not.toBeNull();
      expect(upgrade!.name).toBe('Gold');
    });

    it('returns null for equal counts', () => {
      expect(checkTierUpgrade(10, 10)).toBeNull();
    });
  });

  describe('tierLabel', () => {
    it('returns formatted tier label', () => {
      expect(tierLabel(0)).toBe('Starter (20%)');
      expect(tierLabel(10)).toBe('Silver (25%)');
      expect(tierLabel(50)).toBe('Gold (30%)');
      expect(tierLabel(200)).toBe('Platinum (35%)');
    });
  });

  describe('checkEarningsMilestone', () => {
    it('returns null when no milestone crossed', () => {
      expect(checkEarningsMilestone(0, 5000)).toBeNull();
    });

    it('detects $100 milestone (10000 cents)', () => {
      const milestone = checkEarningsMilestone(9_999, 10_000);
      expect(milestone).toBe(10_000);
    });

    it('detects $500 milestone (50000 cents)', () => {
      const milestone = checkEarningsMilestone(49_999, 50_000);
      expect(milestone).toBe(50_000);
    });

    it('detects $1K milestone', () => {
      expect(checkEarningsMilestone(99_999, 100_000)).toBe(100_000);
    });

    it('detects $5K milestone', () => {
      expect(checkEarningsMilestone(499_999, 500_000)).toBe(500_000);
    });

    it('returns only the first milestone when crossing multiple', () => {
      // Crossing $100 and $500 at once — returns $100 (first)
      const milestone = checkEarningsMilestone(5_000, 50_000);
      expect(milestone).toBe(10_000);
    });

    it('returns null when already past a milestone', () => {
      expect(checkEarningsMilestone(15_000, 20_000)).toBeNull();
    });
  });

  describe('recordTierUpgrade', () => {
    it('inserts a tier_upgrade note via D1', async () => {
      const env = createMockEnv();
      const tier = { name: 'Gold', minConversions: 50, rate: 0.30 };
      await recordTierUpgrade(env as any, 'aff-123', tier, 55);

      expect(env.DB._queries).toHaveLength(1);
      const q = env.DB._queries[0];
      expect(q.sql).toContain('INSERT INTO affiliate_notes');
      expect(q.params).toContain('aff-123');
      // 'tier_upgrade' is a hardcoded literal in the SQL, not a bind param
      expect(q.sql).toContain('tier_upgrade');
    });
  });
});
