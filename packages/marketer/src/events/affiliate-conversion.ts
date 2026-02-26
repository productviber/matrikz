/**
 * Affiliate Conversion Event Handler
 *
 * Triggered when: A user referred by an affiliate completes a purchase.
 *
 * Responsibilities:
 * 1. Update affiliate leaderboard / CRM
 * 2. Queue commission payout notification to the affiliate
 * 3. Trigger "thank you" drip email to the affiliate
 * 4. Send real-time notification (Slack/Discord)
 * 5. Track cumulative earnings & check for tier upgrades
 */

import type { Env, AffiliateConversionData } from '../types';
import { KV_PREFIX, TTL, NOTE_TYPE, MESSAGES } from '../constants';
import { execute, queryOne, now, formatCents, hashEmail } from '../lib/db';
import { enrollInSequences } from '../lib/email';
import {
  getTierForConversions,
  checkTierUpgrade,
  recordTierUpgrade,
  checkEarningsMilestone,
} from '../lib/commission-tiers';
import {
  notifyAffiliateConversion,
  notifyTierUpgrade,
  notifyEarningsMilestone,
} from '../lib/notifications';
import { markAsCustomer } from '../lib/crm';

export async function handleAffiliateConversion(
  env: Env,
  data: AffiliateConversionData,
  timestamp: string
): Promise<void> {
  const {
    affiliateCode,
    userId,
    eventType,
    amountCents,
    commissionCents,
    plan,
  } = data;

  // ── Guard: reject self-referrals ──
  // A user cannot be both the affiliate and the converting user
  const userHash = await hashEmail(userId);
  const affiliateEmailCached = await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_EMAIL}${affiliateCode}`);
  if (affiliateEmailCached) {
    const affiliateHash = await hashEmail(affiliateEmailCached);
    if (affiliateHash === userHash) {
      console.warn(`[AffiliateConversion] Self-referral blocked for ${affiliateCode} / user ${userHash}`);
      return;
    }
  }

  console.log(
    `[AffiliateConversion] code=${affiliateCode} user=${userHash} ` +
    `amount=${formatCents(amountCents)} commission=${formatCents(commissionCents)} plan=${plan}`
  );

  // ── 1. Record conversion note in affiliate activity log ──
  await execute(
    env.DB,
    `INSERT INTO affiliate_notes (affiliate_code, note_type, content)
     VALUES (?, '${NOTE_TYPE.CONVERSION}', ?)`,
    [
      affiliateCode,
      `Conversion: ${plan} plan, sale ${formatCents(amountCents)}, ` +
      `commission ${formatCents(commissionCents)}, event: ${eventType}`,
    ]
  );

  // ── 2. Update CRM — mark buyer as customer with affiliate attribution ──
  await markAsCustomer(env, userId, plan, 'affiliate', amountCents, affiliateCode);

  // ── 3. Track cumulative affiliate stats in KV for fast reads ──
  const kvKey = `${KV_PREFIX.AFFILIATE_STATS}${affiliateCode}`;
  const existingJson = await env.KV_MARKETING.get(kvKey);
  const stats = existingJson
    ? JSON.parse(existingJson)
    : { totalConversions: 0, totalEarnedCents: 0, lastConversionAt: null };

  const previousConversions = stats.totalConversions;
  const previousEarnings = stats.totalEarnedCents;

  stats.totalConversions += 1;
  stats.totalEarnedCents += commissionCents;
  stats.lastConversionAt = timestamp;

  await env.KV_MARKETING.put(kvKey, JSON.stringify(stats), {
    expirationTtl: TTL.YEAR_1,
  });

  // ── 4. Check for tier upgrade ──
  const tierUpgrade = checkTierUpgrade(previousConversions, stats.totalConversions);
  if (tierUpgrade) {
    console.log(
      `[AffiliateConversion] Tier upgrade for ${affiliateCode}: ${tierUpgrade.name} (${(tierUpgrade.rate * 100).toFixed(0)}%)`
    );
    await recordTierUpgrade(env, affiliateCode, tierUpgrade, stats.totalConversions);
    await notifyTierUpgrade(env, affiliateCode, tierUpgrade.name, tierUpgrade.rate);

    // Notify analytics worker to update commission rate (if service binding available)
    try {
      const { createAffiliate } = await import('../lib/analytics-client');
      await createAffiliate(env, {
        code: affiliateCode,
        name: affiliateCode, // Analytics worker should upsert
        email: '', // Not needed for commission rate update
        commissionRate: tierUpgrade.rate,
      });
      console.log(`[AffiliateConversion] Updated commission rate in analytics for ${affiliateCode}`);
    } catch (err) {
      console.warn(`[AffiliateConversion] Non-critical: failed to update analytics commission rate`, err);
    }
  }

  // ── 5. Check for earnings milestone ──
  const milestone = checkEarningsMilestone(previousEarnings, stats.totalEarnedCents);
  if (milestone) {
    console.log(`[AffiliateConversion] Earnings milestone for ${affiliateCode}: ${formatCents(milestone)}`);
    await notifyEarningsMilestone(env, affiliateCode, milestone);

    await execute(
      env.DB,
      `INSERT INTO affiliate_notes (affiliate_code, note_type, content)
       VALUES (?, '${NOTE_TYPE.GENERAL}', ?)`,
      [affiliateCode, `Reached earnings milestone: ${formatCents(milestone)}`]
    );
  }

  // ── 6. Enroll affiliate in commission notification email sequence ──
  // We need the affiliate's email — try KV cache first, then fall back to notes context
  const affiliateEmailKey = `${KV_PREFIX.AFFILIATE_EMAIL}${affiliateCode}`;
  let affiliateEmail = await env.KV_MARKETING.get(affiliateEmailKey);

  if (!affiliateEmail) {
    // Try to get from analytics service binding
    try {
      const { getAffiliateByCode } = await import('../lib/analytics-client');
      const affData = await getAffiliateByCode(env, affiliateCode);
      if (affData && (affData as any).owner_email) {
        affiliateEmail = (affData as any).owner_email;
        await env.KV_MARKETING.put(affiliateEmailKey, affiliateEmail!, {
          expirationTtl: TTL.DAYS_30,
        });
      }
    } catch {
      console.warn(`[AffiliateConversion] Could not fetch affiliate email for ${affiliateCode}`);
    }
  }

  if (affiliateEmail) {
    const currentTier = getTierForConversions(stats.totalConversions);
    await enrollInSequences(env, affiliateEmail, 'affiliate.conversion', {
      affiliateCode,
      plan,
      saleAmount: formatCents(amountCents),
      commissionAmount: formatCents(commissionCents),
      totalEarnings: formatCents(stats.totalEarnedCents),
      tierName: currentTier.name,
      tierRate: `${(currentTier.rate * 100).toFixed(0)}%`,
    });
  }

  // ── 7. Send real-time notifications to team ──
  await notifyAffiliateConversion(env, {
    affiliateCode,
    plan,
    amountCents,
    commissionCents,
  });

  console.log(`[AffiliateConversion] Completed processing for ${affiliateCode}`);
}
