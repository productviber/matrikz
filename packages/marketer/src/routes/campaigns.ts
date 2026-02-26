/**
 * Campaign & Referral Link Routes
 *
 * Generate, track, and manage UTM-tagged referral links for affiliates.
 */

import type { Env, CampaignRow } from '../types';
import { ok, badRequest, notFound, created, serverError, unauthorized } from '../lib/response';
import { query, queryOne, execute, now } from '../lib/db';
import {
  UTM_DEFAULTS,
  BASE_URL,
  PAGINATION,
  COOKIE,
  TTL,
  MAX_LENGTH,
} from '../constants';

/**
 * POST /api/campaigns
 *
 * Create a new campaign / referral link.
 */
export async function handleCreateCampaign(
  request: Request,
  env: Env
): Promise<Response> {
  // Admin/affiliate auth check
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${env.ADMIN_TOKEN}`) {
    return unauthorized('Authentication required to create campaigns');
  }

  try {
    const body = await request.json() as {
      name: string;
      affiliateCode?: string;
      utmSource?: string;
      utmMedium?: string;
      utmCampaign?: string;
      utmContent?: string;
      utmTerm?: string;
      destinationUrl?: string;
    };

    if (!body.name) {
      return badRequest('Missing required field: name');
    }

    const slug = generateSlug(body.name);

    // Check for duplicate slug
    const existing = await queryOne(env.DB, `SELECT id FROM campaigns WHERE slug = ?`, [slug]);
    if (existing) {
      return badRequest(`Campaign with slug "${slug}" already exists`);
    }

    await execute(
      env.DB,
      `INSERT INTO campaigns (name, slug, affiliate_code, utm_source, utm_medium, utm_campaign, utm_content, utm_term, destination_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.name,
        slug,
        body.affiliateCode ?? null,
        body.utmSource ?? UTM_DEFAULTS.SOURCE,
        body.utmMedium ?? UTM_DEFAULTS.MEDIUM,
        body.utmCampaign ?? slug,
        body.utmContent ?? null,
        body.utmTerm ?? null,
        body.destinationUrl ?? BASE_URL,
      ]
    );

    const campaign = await queryOne<CampaignRow>(
      env.DB,
      `SELECT * FROM campaigns WHERE slug = ?`,
      [slug]
    );

    return created({
      ...campaign,
      referralUrl: buildReferralUrl(campaign!),
    });
  } catch (err) {
    console.error('[Campaign:Create] Error:', err);
    return serverError('Failed to create campaign');
  }
}

/**
 * GET /api/campaigns
 *
 * List campaigns, optionally filtered by affiliate code.
 */
export async function handleListCampaigns(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const affiliateCode = url.searchParams.get('affiliate');
  const page = parseInt(url.searchParams.get('page') ?? '1', 10);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? String(PAGINATION.DEFAULT_PAGE_SIZE), 10), PAGINATION.MAX_CAMPAIGN_PAGE_SIZE);
  const offset = (page - 1) * limit;

  let sql = `SELECT * FROM campaigns`;
  const params: unknown[] = [];

  if (affiliateCode) {
    sql += ` WHERE affiliate_code = ?`;
    params.push(affiliateCode);
  }

  sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const campaigns = await query<CampaignRow>(env.DB, sql, params);

  return ok({
    campaigns: campaigns.map((c) => ({
      ...c,
      referralUrl: buildReferralUrl(c),
      conversionRate: c.clicks > 0 ? ((c.conversions / c.clicks) * 100).toFixed(1) + '%' : '0.0%',
    })),
    page,
    limit,
  });
}

/**
 * GET /api/campaigns/:slug
 *
 * Get a single campaign by slug.
 */
export async function handleGetCampaign(
  request: Request,
  env: Env,
  slug: string
): Promise<Response> {
  const campaign = await queryOne<CampaignRow>(
    env.DB,
    `SELECT * FROM campaigns WHERE slug = ?`,
    [slug]
  );

  if (!campaign) {
    return notFound('Campaign not found');
  }

  return ok({
    ...campaign,
    referralUrl: buildReferralUrl(campaign),
    conversionRate: campaign.clicks > 0
      ? ((campaign.conversions / campaign.clicks) * 100).toFixed(1) + '%'
      : '0.0%',
  });
}

/**
 * GET /r/:slug — Referral link redirect (tracks click + redirects)
 */
export async function handleReferralRedirect(
  request: Request,
  env: Env,
  slug: string
): Promise<Response> {
  const campaign = await queryOne<CampaignRow>(
    env.DB,
    `SELECT * FROM campaigns WHERE slug = ? AND is_active = 1`,
    [slug]
  );

  if (!campaign) {
    // Fall back to treating slug as affiliate code
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${BASE_URL}/?ref=${encodeURIComponent(slug)}`,
      },
    });
  }

  // Increment click count (non-blocking)
  execute(
    env.DB,
    `UPDATE campaigns SET clicks = clicks + 1, updated_at = ? WHERE id = ?`,
    [now(), campaign.id]
  ).catch(() => {});

  // Build destination URL with UTM params
  const destUrl = buildReferralUrl(campaign);

  // Set affiliate attribution cookie if applicable
  const headers: Record<string, string> = { Location: destUrl };
  if (campaign.affiliate_code) {
    headers['Set-Cookie'] =
      `${COOKIE.AFFILIATE_NAME}=${campaign.affiliate_code}; Path=/; Max-Age=${TTL.DAYS_30}; SameSite=Lax; Secure`;
  }

  return new Response(null, { status: 302, headers });
}

/**
 * PUT /api/campaigns/:slug — Update campaign
 */
export async function handleUpdateCampaign(
  request: Request,
  env: Env,
  slug: string
): Promise<Response> {
  // Admin auth check
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${env.ADMIN_TOKEN}`) {
    return unauthorized('Authentication required to update campaigns');
  }

  const campaign = await queryOne<CampaignRow>(
    env.DB,
    `SELECT * FROM campaigns WHERE slug = ?`,
    [slug]
  );

  if (!campaign) {
    return notFound('Campaign not found');
  }

  try {
    const updates = await request.json() as Partial<{
      name: string;
      isActive: boolean;
      destinationUrl: string;
      utmContent: string;
      utmTerm: string;
    }>;

    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.name) { sets.push('name = ?'); params.push(updates.name); }
    if (updates.isActive !== undefined) { sets.push('is_active = ?'); params.push(updates.isActive ? 1 : 0); }
    if (updates.destinationUrl) { sets.push('destination_url = ?'); params.push(updates.destinationUrl); }
    if (updates.utmContent !== undefined) { sets.push('utm_content = ?'); params.push(updates.utmContent); }
    if (updates.utmTerm !== undefined) { sets.push('utm_term = ?'); params.push(updates.utmTerm); }

    if (sets.length === 0) {
      return badRequest('No valid fields to update');
    }

    sets.push('updated_at = ?');
    params.push(now());
    params.push(slug);

    await execute(
      env.DB,
      `UPDATE campaigns SET ${sets.join(', ')} WHERE slug = ?`,
      params
    );

    return ok({ slug, updated: true });
  } catch (err) {
    console.error('[Campaign:Update] Error:', err);
    return serverError('Failed to update campaign');
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, MAX_LENGTH.CAMPAIGN_SLUG);
}

function buildReferralUrl(campaign: CampaignRow): string {
  const url = new URL(campaign.destination_url);
  url.searchParams.set('utm_source', campaign.utm_source);
  url.searchParams.set('utm_medium', campaign.utm_medium);
  url.searchParams.set('utm_campaign', campaign.utm_campaign);
  if (campaign.utm_content) url.searchParams.set('utm_content', campaign.utm_content);
  if (campaign.utm_term) url.searchParams.set('utm_term', campaign.utm_term);
  if (campaign.affiliate_code) url.searchParams.set('ref', campaign.affiliate_code);
  return url.toString();
}
