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
    return badRequest('Missing required params: code, email');
  }

  // Verify affiliate identity via KV cache or analytics service
  const isVerified = await verifyAffiliate(env, code, email);
  if (!isVerified) {
    return unauthorized('Invalid affiliate credentials');
  }

  // Load stats from KV
  const statsJson = await env.KV_MARKETING.get(`affiliate-stats:${code}`);
  const stats = statsJson
    ? JSON.parse(statsJson)
    : { totalConversions: 0, totalEarnedCents: 0, lastConversionAt: null };

  const tier = getTierForConversions(stats.totalConversions);

  // Load recent conversion notes
  const recentNotes = await query<{ content: string; created_at: number }>(
    env.DB,
    `SELECT content, created_at FROM affiliate_notes
     WHERE affiliate_code = ? AND note_type = 'conversion'
     ORDER BY created_at DESC LIMIT 20`,
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
     WHERE affiliate_code = ? AND status = 'sent'
     ORDER BY created_at DESC LIMIT 20`,
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
      userId: 'redacted',
      plan: extractPlanFromNote(n.content),
      amountCents: extractAmountFromNote(n.content),
      commissionCents: extractCommissionFromNote(n.content),
      convertedAt: new Date(n.created_at * 1000).toISOString(),
    })),
    payoutHistory: payouts.map((p) => ({
      amountCents: p.amount_cents,
      method: p.method ?? 'pending',
      reference: p.reference ?? '',
      createdAt: new Date(p.created_at * 1000).toISOString(),
    })),
  };

  return ok(portalData);
}

/**
 * GET /api/affiliate/stats?code=<code>
 *
 * Quick stats endpoint (lighter than full portal).
 */
export async function handleAffiliateStats(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) {
    return badRequest('Missing required param: code');
  }

  const statsJson = await env.KV_MARKETING.get(`affiliate-stats:${code}`);
  if (!statsJson) {
    return ok({
      code,
      tier: 'Starter',
      totalConversions: 0,
      totalEarnedCents: 0,
      commissionRate: 0.20,
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
  const cachedEmail = await env.KV_MARKETING.get(`affiliate-email:${code}`);
  if (cachedEmail && cachedEmail.toLowerCase() === email.toLowerCase()) {
    return true;
  }

  // Try analytics service binding
  try {
    const { getAffiliateByCode } = await import('../lib/analytics-client');
    const data = await getAffiliateByCode(env, code);
    if (data && (data as any).owner_email?.toLowerCase() === email.toLowerCase()) {
      // Cache for future lookups
      await env.KV_MARKETING.put(`affiliate-email:${code}`, email, {
        expirationTtl: 30 * 86_400,
      });
      return true;
    }
  } catch {
    // Fall through
  }

  return false;
}

function extractPlanFromNote(content: string): string {
  const match = content.match(/Conversion:\s*(\w+)\s*plan/);
  return match?.[1] ?? 'unknown';
}

function extractAmountFromNote(content: string): number {
  const match = content.match(/sale\s*\$(\d+\.\d+)/);
  return match ? Math.round(parseFloat(match[1]) * 100) : 0;
}

function extractCommissionFromNote(content: string): number {
  const match = content.match(/commission\s*\$(\d+\.\d+)/);
  return match ? Math.round(parseFloat(match[1]) * 100) : 0;
}
