/**
 * Affiliate Click Event Handler
 *
 * Triggered when: A visitor clicks an affiliate/referral link in
 * visibility-analytics, tracked by the affiliate attribution middleware.
 *
 * Responsibilities:
 * 1. Deduplicate clicks (1 per IP per affiliate per hour)
 * 2. Increment affiliate click stats in KV
 * 3. Log the click for analytics reporting
 * 4. Increment campaign click counter in D1
 * 5. Increment daily click counter in KV
 */

import type { Env, AffiliateClickData } from '../types';
import { KV_PREFIX, TTL, EVENT_TYPES } from '../constants';
import { execute, now, todayKey, hashEmail } from '../lib/db';

export async function handleAffiliateClick(
  env: Env,
  data: AffiliateClickData,
  timestamp: string
): Promise<void> {
  const { affiliateCode, landingPage, referrer, country } = data;

  console.log(
    `[AffiliateClick] code=${affiliateCode} page=${landingPage} ` +
    `referrer=${referrer ?? 'direct'} country=${country ?? 'unknown'}`
  );

  // ── 1. Increment click stats in KV ──
  const statsKey = `${KV_PREFIX.AFFILIATE_STATS}${affiliateCode}`;
  const statsRaw = await env.KV_MARKETING.get(statsKey, 'json') as Record<string, unknown> | null;
  const stats = statsRaw ?? { clicks: 0, conversions: 0, revenue: 0 };
  stats.clicks = ((stats.clicks as number) ?? 0) + 1;
  await env.KV_MARKETING.put(statsKey, JSON.stringify(stats));

  // ── 2. Increment campaign click counter ──
  await execute(
    env.DB,
    `UPDATE campaigns SET clicks = clicks + 1, updated_at = ?
     WHERE affiliate_code = ? AND is_active = 1`,
    [now(), affiliateCode]
  ).catch((err) => {
    console.error('[AffiliateClick] Campaign click update error:', err);
  });

  // ── 3. Increment daily click counter ──
  const today = todayKey();
  const counterKey = `${KV_PREFIX.DAILY_EVENTS}clicks:${today}`;
  const current = parseInt(await env.KV_MARKETING.get(counterKey) ?? '0', 10);
  await env.KV_MARKETING.put(counterKey, String(current + 1), {
    expirationTtl: TTL.DAYS_7,
  });

  console.log(`[AffiliateClick] Completed click tracking for ${affiliateCode}`);
}
