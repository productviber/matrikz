/**
 * Affiliate Portal API Routes
 *
 * Self-service dashboard for affiliates to view their stats,
 * earnings, referral links, and payout history.
 */

import type { Env, AffiliatePortalData } from '../types';
import { ok, badRequest, notFound, unauthorized } from '../lib/response';
import { query, queryOne, hashEmail, formatCents } from '../lib/db';
import { getTierForConversions, tierLabel } from '../lib/commission-tiers';
import { COMMISSION_TIERS } from '../types';
import { KV_PREFIX, TTL, PAGINATION, PAYOUT_STATUS, NOTE_TYPE, DEFAULTS, PATTERNS, MESSAGES } from '../constants';

/**
 * GET /api/affiliate/portal?code=<code>&email=<email>
 *
 * Returns the affiliate's dashboard data. Requires both code and email for auth.
 */
export async function handleAffiliatePortal(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const email = url.searchParams.get('email');

  if (!code || !email) {
    return badRequest(MESSAGES.errors.missingCodeEmail);
  }

  // Verify affiliate identity via KV cache or analytics service
  const isVerified = await verifyAffiliate(env, code, email);
  if (!isVerified) {
    return unauthorized(MESSAGES.errors.invalidCredentials);
  }

  // Load stats from KV
  const statsJson = await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_STATS}${code}`);
  const stats = statsJson
    ? JSON.parse(statsJson)
    : { totalConversions: 0, totalEarnedCents: 0, lastConversionAt: null };

  const tier = getTierForConversions(stats.totalConversions);

  // Load recent conversion notes
  const recentNotes = await query<{ content: string; created_at: number }>(
    env.DB,
    `SELECT content, created_at FROM affiliate_notes
     WHERE affiliate_code = ? AND note_type = '${NOTE_TYPE.CONVERSION}'
     ORDER BY created_at DESC LIMIT ${PAGINATION.PORTAL_RECENT_ITEMS}`,
    [code]
  );

  // Load payout history
  const payouts = await query<{
    amount_cents: number;
    method: string;
    reference: string;
    created_at: number;
  }>(
    env.DB,
    `SELECT amount_cents, method, reference, created_at
     FROM payout_items
     WHERE affiliate_code = ? AND status = '${PAYOUT_STATUS.SENT}'
     ORDER BY created_at DESC LIMIT ${PAGINATION.PORTAL_RECENT_ITEMS}`,
    [code]
  );

  // Calculate unpaid earnings
  const totalPaid = payouts.reduce((sum, p) => sum + p.amount_cents, 0);
  const unpaidCents = stats.totalEarnedCents - totalPaid;

  // Load campaigns for this affiliate
  const campaigns = await query<{
    name: string;
    slug: string;
    clicks: number;
    conversions: number;
    is_active: number;
  }>(
    env.DB,
    `SELECT name, slug, clicks, conversions, is_active
     FROM campaigns WHERE affiliate_code = ? ORDER BY created_at DESC`,
    [code]
  );

  const portalData: AffiliatePortalData = {
    code,
    label: code,
    tier: tier.name,
    commissionRate: tier.rate,
    totalClicks: campaigns.reduce((sum, c) => sum + c.clicks, 0),
    totalConversions: stats.totalConversions,
    totalEarnedCents: stats.totalEarnedCents,
    unpaidEarningsCents: Math.max(0, unpaidCents),
    recentConversions: recentNotes.map((n) => ({
      userId: DEFAULTS.REDACTED_USER_ID,
      plan: extractPlanFromNote(n.content),
      amountCents: extractAmountFromNote(n.content),
      commissionCents: extractCommissionFromNote(n.content),
      convertedAt: new Date(n.created_at * 1000).toISOString(),
    })),
    payoutHistory: payouts.map((p) => ({
      amountCents: p.amount_cents,
      method: p.method ?? DEFAULTS.PAYOUT_METHOD,
      reference: p.reference ?? '',
      createdAt: new Date(p.created_at * 1000).toISOString(),
    })),
  };

  return ok(portalData);
}

/**
 * GET /api/affiliate/stats?code=<code>&email=<email>
 *
 * Quick stats endpoint (lighter than full portal).
 * Requires code + email for auth (same as portal).
 */
export async function handleAffiliateStats(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const email = url.searchParams.get('email');

  if (!code || !email) {
    return badRequest(MESSAGES.errors.missingCodeEmail);
  }

  // Require the same code+email verification used by the portal
  const isVerified = await verifyAffiliate(env, code, email);
  if (!isVerified) {
    return unauthorized(MESSAGES.errors.invalidCredentials);
  }

  const statsJson = await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_STATS}${code}`);
  if (!statsJson) {
    return ok({
      code,
      tier: COMMISSION_TIERS[0].name,
      totalConversions: 0,
      totalEarnedCents: 0,
      commissionRate: COMMISSION_TIERS[0].rate,
    });
  }

  const stats = JSON.parse(statsJson);
  const tier = getTierForConversions(stats.totalConversions);

  return ok({
    code,
    tier: tier.name,
    totalConversions: stats.totalConversions,
    totalEarnedCents: stats.totalEarnedCents,
    commissionRate: tier.rate,
    lastConversionAt: stats.lastConversionAt,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function verifyAffiliate(env: Env, code: string, email: string): Promise<boolean> {
  // Check KV cache first
  const cachedEmail = await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_EMAIL}${code}`);
  if (cachedEmail && cachedEmail.toLowerCase() === email.toLowerCase()) {
    return true;
  }

  // Try analytics service binding
  try {
    const { getAffiliateByCode } = await import('../lib/analytics-client');
    const data = await getAffiliateByCode(env, code);
    if (data && (data as any).owner_email?.toLowerCase() === email.toLowerCase()) {
      // Cache for future lookups
      await env.KV_MARKETING.put(`${KV_PREFIX.AFFILIATE_EMAIL}${code}`, email, {
        expirationTtl: TTL.DAYS_30,
      });
      return true;
    }
  } catch {
    // Fall through
  }

  return false;
}

function extractPlanFromNote(content: string): string {
  const match = content.match(PATTERNS.NOTE_PLAN);
  return match?.[1] ?? DEFAULTS.UNKNOWN_PLAN;
}

function extractAmountFromNote(content: string): number {
  const match = content.match(PATTERNS.NOTE_SALE_AMOUNT);
  return match ? Math.round(parseFloat(match[1]) * 100) : 0;
}

function extractCommissionFromNote(content: string): number {
  const match = content.match(PATTERNS.NOTE_COMMISSION);
  return match ? Math.round(parseFloat(match[1]) * 100) : 0;
}
