import type { Env } from '../types';
import { KV_PREFIX, TTL } from '../constants';
import { timingSafeEqual } from './security.ts';

interface VerifyAffiliateOptions {
  /** @deprecated No-op. Retained for call-site compatibility only. The analytics fallback
   *  was removed because the analytics worker does not implement /admin/affiliates.
   *  D1 payout_items is used as the authoritative fallback instead. */
  allowAnalyticsFallback?: boolean;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export async function verifyAffiliateCredentials(
  env: Env,
  code: string,
  email: string,
  _options: VerifyAffiliateOptions = {}
): Promise<boolean> {
  const normalizedCode = code.trim();
  const normalizedEmail = normalize(email);

  if (!normalizedCode || !normalizedEmail) return false;

  // ── Primary path: KV credential cache ────────────────────────────────────
  const kvKey = `${KV_PREFIX.AFFILIATE_EMAIL}${normalizedCode}`;
  const cachedEmail = await env.KV_MARKETING.get(kvKey);
  if (cachedEmail && timingSafeEqual(normalize(cachedEmail), normalizedEmail)) {
    return true;
  }

  // ── Fallback: D1 payout_items (authoritative local source) ───────────────
  // The analytics worker does not implement /admin/affiliates, so the previous
  // analytics service-binding fallback always failed silently. payout_items
  // is the reliable source of truth for affiliate code ↔ email associations.
  try {
    const row = await env.DB
      .prepare('SELECT affiliate_email FROM payout_items WHERE affiliate_code = ? LIMIT 1')
      .bind(normalizedCode)
      .first<{ affiliate_email: string }>();

    if (!row || !timingSafeEqual(normalize(row.affiliate_email), normalizedEmail)) {
      return false;
    }

    // Warm KV so subsequent logins hit the fast path.
    await env.KV_MARKETING.put(kvKey, normalizedEmail, {
      expirationTtl: TTL.DAYS_30,
    });
    return true;
  } catch {
    return false;
  }
}
