/**
 * Commission Tier System
 *
 * Implements escalating commission rates based on affiliate performance:
 *   Starter:  20% (0+ conversions)
 *   Silver:   25% (10+ conversions)
 *   Gold:     30% (50+ conversions)
 *   Platinum: 35% (200+ conversions)
 */

import { COMMISSION_TIERS, type CommissionTier, type Env } from '../types';
import { execute, queryOne } from './db';
import { NOTE_TYPE, EARNINGS_MILESTONES, MESSAGES } from '../constants';

/**
 * Determine the commission tier for a given conversion count.
 */
export function getTierForConversions(totalConversions: number): CommissionTier {
  // Tiers are ordered ascending; pick the highest qualifying tier
  let tier = COMMISSION_TIERS[0];
  for (const t of COMMISSION_TIERS) {
    if (totalConversions >= t.minConversions) {
      tier = t;
    }
  }
  return tier;
}

/**
 * Check if an affiliate just crossed a tier threshold.
 * Returns the new tier if upgraded, null otherwise.
 */
export function checkTierUpgrade(
  previousConversions: number,
  newConversions: number
): CommissionTier | null {
  const oldTier = getTierForConversions(previousConversions);
  const newTier = getTierForConversions(newConversions);
  if (newTier.name !== oldTier.name && newTier.rate > oldTier.rate) {
    return newTier;
  }
  return null;
}

/**
 * Get tier name string for display.
 */
export function tierLabel(totalConversions: number): string {
  const tier = getTierForConversions(totalConversions);
  return `${tier.name} (${(tier.rate * 100).toFixed(0)}%)`;
}

/**
 * Record a tier upgrade note in the affiliate activity log.
 */
export async function recordTierUpgrade(
  env: Env,
  affiliateCode: string,
  newTier: CommissionTier,
  totalConversions: number
): Promise<void> {
  await execute(
    env.DB,
    `INSERT INTO affiliate_notes (affiliate_code, note_type, content)
     VALUES (?, '${NOTE_TYPE.TIER_UPGRADE}', ?)`,
    [affiliateCode, MESSAGES.notes.tierUpgrade(newTier.name, (newTier.rate * 100).toFixed(0), totalConversions)]
  );
}

/**
 * Check if cumulative earnings crossed a milestone.
 * Returns the milestone value (cents) if crossed, null otherwise.
 */
export function checkEarningsMilestone(
  previousEarningsCents: number,
  newEarningsCents: number
): number | null {
  for (const milestone of EARNINGS_MILESTONES) {
    if (previousEarningsCents < milestone && newEarningsCents >= milestone) {
      return milestone;
    }
  }
  return null;
}
