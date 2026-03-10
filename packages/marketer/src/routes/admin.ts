/**
 * Admin API Routes
 *
 * Dashboard metrics, email management, and system admin.
 * All routes require Bearer ADMIN_TOKEN authentication.
 */

import type { Env, DashboardMetrics } from '../types';
import { ok, badRequest, unauthorized, notFound, serverError, isAdmin, created } from '../lib/response';
import { query, queryOne, execute, now, todayKey, formatCents } from '../lib/db';
import { getContactStats, getLatestMrrSnapshot, getMrrHistory } from '../lib/crm';
import { processDueEmails } from '../lib/email';
import { checkThrottle, getWarmupState, getSentToday, todayDateKey, WARMUP_SCHEDULE, COMPLIANCE, WARMUP_PRESETS, isValidSchedule, resolveWarmupProfile } from '../lib/warmup';
import { getProspectChannels, getChannelStats, recordChannelAttempt } from '../lib/channel-orchestrator';
import { KV_PREFIX, PAGINATION, DEFAULTS, PAYOUT_STATUS, EMAIL_STATUS, NOTE_TYPE, SQLITE_BOOL, MESSAGES } from '../constants';

// ─── Dashboard ──────────────────────────────────────────────────────────────

/**
 * GET /api/admin/dashboard
 *
 * Returns key marketing metrics for the admin dashboard.
 */
export async function handleAdminDashboard(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  try {
    const [mrrSnapshot, contactStats] = await Promise.all([
      getLatestMrrSnapshot(env),
      getContactStats(env),
    ]);

    const today = todayKey();

    // Daily conversions from KV
    const dailyConversions = parseInt(
      await env.KV_MARKETING.get(`${KV_PREFIX.DAILY_CONVERSIONS}${today}`) ?? '0',
      10
    );
    const dailyRevenue = parseInt(
      await env.KV_MARKETING.get(`${KV_PREFIX.DAILY_REVENUE}${today}`) ?? '0',
      10
    );

    // Pending payouts
    const pendingPayouts = await queryOne<{ total: number }>(
      env.DB,
      `SELECT COALESCE(SUM(total_amount_cents), 0) as total
       FROM payout_batches WHERE status = '${PAYOUT_STATUS.PENDING}'`
    );

    // Active sequences
    const activeSequences = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM email_sequences WHERE is_active = ${SQLITE_BOOL.TRUE}`
    );

    // Emails sent today
    const emailsSentToday = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM email_sends WHERE status = '${EMAIL_STATUS.SENT}' AND sent_at >= ?`,
      [Math.floor(new Date(today).getTime() / 1000)]
    );

    // Affiliate conversions today
    const affConversionsToday = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM affiliate_notes
       WHERE note_type = '${NOTE_TYPE.CONVERSION}' AND created_at >= ?`,
      [Math.floor(new Date(today).getTime() / 1000)]
    );

    // ── Share PLG metrics ──
    const dailyShareViews = parseInt(
      await env.KV_MARKETING.get(`${KV_PREFIX.DAILY_SHARE_VIEWS}${today}`) ?? '0',
      10
    );
    const totalPQLs = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM share_leads WHERE status = 'pql'`
    );
    const shareConversionsToday = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM share_leads
       WHERE status = 'converted' AND converted_at >= ?`,
      [Math.floor(new Date(today).getTime() / 1000)]
    );

    const metrics: DashboardMetrics = {
      mrr: mrrSnapshot?.mrr_cents ?? 0,
      arr: mrrSnapshot?.arr_cents ?? 0,
      totalCustomers: contactStats.customers,
      newCustomersToday: dailyConversions,
      affiliateConversionsToday: affConversionsToday?.count ?? 0,
      pendingPayoutsCents: pendingPayouts?.total ?? 0,
      activeSequences: activeSequences?.count ?? 0,
      emailsSentToday: emailsSentToday?.count ?? 0,
      dailyShareViews,
      totalPQLs: totalPQLs?.count ?? 0,
      shareConversionsToday: shareConversionsToday?.count ?? 0,
    };

    return ok({
      metrics,
      contacts: contactStats,
      dailyRevenueCents: dailyRevenue,
      dailyRevenueFormatted: formatCents(dailyRevenue),
    });
  } catch (err) {
    console.error('[Admin:Dashboard] Error:', err);
    return serverError(MESSAGES.errors.failedDashboard);
  }
}

// ─── MRR History ────────────────────────────────────────────────────────────

/**
 * GET /api/admin/mrr?start=YYYY-MM-DD&end=YYYY-MM-DD
 */
export async function handleMrrHistory(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  const url = new URL(request.url);
  const start = url.searchParams.get('start') ?? DEFAULTS.MRR_HISTORY_START;
  const end = url.searchParams.get('end') ?? todayKey();

  const snapshots = await getMrrHistory(env, start, end);

  return ok({
    snapshots: snapshots.map((s) => ({
      ...s,
      mrrFormatted: formatCents(s.mrr_cents),
      arrFormatted: formatCents(s.arr_cents),
    })),
    range: { start, end },
  });
}

// ─── Email Management ───────────────────────────────────────────────────────

/**
 * GET /api/admin/emails/sequences
 *
 * List all email sequences with step counts.
 */
export async function handleListSequences(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  const sequences = await query<{
    id: number;
    name: string;
    trigger_event: string;
    is_active: number;
    step_count: number;
    created_at: number;
  }>(
    env.DB,
    `SELECT es.*, COUNT(est.id) as step_count
     FROM email_sequences es
     LEFT JOIN email_steps est ON es.id = est.sequence_id
     GROUP BY es.id
     ORDER BY es.id`
  );

  return ok({ sequences });
}

/**
 * GET /api/admin/emails/sends?status=<status>&limit=<n>
 *
 * List recent email sends.
 */
export async function handleListEmailSends(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? String(PAGINATION.DEFAULT_PAGE_SIZE), 10), PAGINATION.MAX_PAGE_SIZE);

  let sql = `SELECT es.*, est.subject, est.template_key, seq.name as sequence_name
     FROM email_sends es
     JOIN email_steps est ON es.step_id = est.id
     JOIN email_sequences seq ON es.sequence_id = seq.id`;
  const params: unknown[] = [];

  if (status) {
    sql += ` WHERE es.status = ?`;
    params.push(status);
  }

  sql += ` ORDER BY es.created_at DESC LIMIT ?`;
  params.push(limit);

  const sends = await query(env.DB, sql, params);

  return ok({ sends, limit });
}

/**
 * POST /api/admin/emails/process
 *
 * Manually trigger processing of due emails (normally done via Cron).
 */
export async function handleProcessEmails(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  try {
    const url = new URL(request.url);
    const force = url.searchParams.get('force') === 'true';
    const sent = await processDueEmails(env, undefined, { force });
    return ok({ processed: sent, force, message: MESSAGES.success.processedEmails(sent) });
  } catch (err) {
    console.error('[Admin:ProcessEmails] Error:', err);
    return serverError(MESSAGES.errors.failedProcessEmails);
  }
}

// ─── Contacts ───────────────────────────────────────────────────────────────

/**
 * GET /api/admin/contacts?status=<status>&page=<n>&limit=<n>
 */
export async function handleListContacts(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const page = parseInt(url.searchParams.get('page') ?? '1', 10);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? String(PAGINATION.DEFAULT_PAGE_SIZE), 10), PAGINATION.MAX_PAGE_SIZE);
  const offset = (page - 1) * limit;

  let sql = `SELECT * FROM marketing_contacts`;
  const params: unknown[] = [];

  if (status) {
    sql += ` WHERE status = ?`;
    params.push(status);
  }

  sql += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const contacts = await query(env.DB, sql, params);

  return ok({ contacts, page, limit });
}

// ─── Notifications Log ──────────────────────────────────────────────────────

/**
 * GET /api/admin/notifications?limit=<n>
 */
export async function handleListNotifications(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? String(PAGINATION.DEFAULT_PAGE_SIZE), 10), PAGINATION.MAX_PAGE_SIZE);

  const notifications = await query(
    env.DB,
    `SELECT * FROM notification_log ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );

  return ok({ notifications, limit });
}

// ─── Share Admin Endpoints ───────────────────────────────────────────────────

/**
 * GET /api/admin/shares?status=<status>&owner=<email>&page=<n>&limit=<n>
 *
 * List share leads with optional filtering by status or owner.
 */
export async function handleListShareLeads(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const owner = url.searchParams.get('owner');
    const page = parseInt(url.searchParams.get('page') ?? '1', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? String(PAGINATION.DEFAULT_PAGE_SIZE), 10), PAGINATION.MAX_PAGE_SIZE);
    const offset = (page - 1) * limit;

    let sql = `SELECT * FROM share_leads`;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      conditions.push(`status = ?`);
      params.push(status);
    }
    if (owner) {
      conditions.push(`owner_email = ?`);
      params.push(owner);
    }

    if (conditions.length) {
      sql += ` WHERE ` + conditions.join(' AND ');
    }

    sql += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const leads = await query(env.DB, sql, params);
    const total = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM share_leads` + (conditions.length ? ` WHERE ` + conditions.join(' AND ') : ''),
      conditions.length ? params.slice(0, conditions.length) : []
    );

    return ok({ leads, total: total?.count ?? 0, page, limit });
  } catch (err) {
    console.error('[Admin] handleListShareLeads error:', err);
    return serverError('Failed to load share leads');
  }
}

/**
 * GET /api/admin/share-owners?page=<n>&limit=<n>
 *
 * List share owner stats sorted by total conversions (top performers first).
 */
export async function handleListShareOwners(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  try {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') ?? '1', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? String(PAGINATION.DEFAULT_PAGE_SIZE), 10), PAGINATION.MAX_PAGE_SIZE);
    const offset = (page - 1) * limit;

    const owners = await query(
      env.DB,
      `SELECT * FROM share_owner_stats ORDER BY total_conversions DESC, total_views DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    const total = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM share_owner_stats`
    );

    return ok({ owners, total: total?.count ?? 0, page, limit });
  } catch (err) {
    console.error('[Admin] handleListShareOwners error:', err);
    return serverError('Failed to load share owners');
  }
}

/**
 * GET /api/admin/pql-leads?minScore=<n>&page=<n>&limit=<n>
 *
 * List PQL-qualified share leads (hot + pql status) for priority follow-up.
 */
export async function handleListPQLLeads(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  try {
    const url = new URL(request.url);
    const minScore = parseInt(url.searchParams.get('minScore') ?? '50', 10);
    const page = parseInt(url.searchParams.get('page') ?? '1', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? String(PAGINATION.DEFAULT_PAGE_SIZE), 10), PAGINATION.MAX_PAGE_SIZE);
    const offset = (page - 1) * limit;

    const leads = await query(
      env.DB,
      `SELECT * FROM share_leads WHERE pql_score >= ? AND status NOT IN ('converted', 'revoked')
       ORDER BY pql_score DESC LIMIT ? OFFSET ?`,
      [minScore, limit, offset]
    );
    const total = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM share_leads WHERE pql_score >= ? AND status NOT IN ('converted', 'revoked')`,
      [minScore]
    );

    return ok({ leads, total: total?.count ?? 0, minScore, page, limit });
  } catch (err) {
    console.error('[Admin] handleListPQLLeads error:', err);
    return serverError('Failed to load PQL leads');
  }
}

// ─── Outbound Health ────────────────────────────────────────────────────────

/**
 * GET /api/admin/outbound/health
 *
 * Returns delivery health metrics for outbound cold outreach.
 * Includes: prospect contacts, sequence enrollment, send stats, bounce rate.
 * See: docs/OUTBOUND_SYSTEM_ARCHITECTURE.md §9.2
 */
export async function handleOutboundHealth(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  try {
    // Count prospect contacts
    const prospectCount = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM marketing_contacts WHERE source = 'outbound'`
    );

    // Count by status
    const prospectsByStatus = await query<{ status: string; count: number }>(
      env.DB,
      `SELECT status, COUNT(*) as count FROM marketing_contacts WHERE source = 'outbound' GROUP BY status`
    );

    // Cold outreach sequence sends
    const coldSends = await query<{ status: string; count: number }>(
      env.DB,
      `SELECT es.status, COUNT(*) as count
       FROM email_sends es
       JOIN email_sequences seq ON es.sequence_id = seq.id
       WHERE seq.trigger_event = 'outbound.prospect_discovered'
       GROUP BY es.status`
    );

    // Recent sends (last 20)
    const recentSends = await query<{
      id: number;
      contact_email: string;
      status: string;
      scheduled_at: number;
      sent_at: number | null;
      subject: string;
    }>(
      env.DB,
      `SELECT es.id, es.contact_email, es.status, es.scheduled_at, es.sent_at, est.subject
       FROM email_sends es
       JOIN email_steps est ON es.step_id = est.id
       JOIN email_sequences seq ON es.sequence_id = seq.id
       WHERE seq.trigger_event = 'outbound.prospect_discovered'
       ORDER BY es.id DESC
       LIMIT 20`
    );

    // Cold outreach sequence info
    const coldSequence = await queryOne<{
      id: number;
      name: string;
      is_active: number;
      step_count: number;
    }>(
      env.DB,
      `SELECT seq.*, COUNT(est.id) as step_count
       FROM email_sequences seq
       LEFT JOIN email_steps est ON seq.id = est.sequence_id
       WHERE seq.trigger_event = 'outbound.prospect_discovered'
       GROUP BY seq.id`
    );

    // Compute bounce rate from sends
    const sendCounts: Record<string, number> = {};
    for (const s of coldSends) {
      sendCounts[s.status] = s.count;
    }
    const totalSent = (sendCounts['sent'] ?? 0) + (sendCounts['failed'] ?? 0);
    const bounceRate = totalSent > 0 ? ((sendCounts['failed'] ?? 0) / totalSent * 100).toFixed(1) : '0.0';

    return ok({
      prospects: {
        total: prospectCount?.count ?? 0,
        byStatus: prospectsByStatus.reduce((acc, s) => ({ ...acc, [s.status]: s.count }), {}),
      },
      sequence: coldSequence ? {
        id: coldSequence.id,
        name: coldSequence.name,
        isActive: !!coldSequence.is_active,
        stepCount: coldSequence.step_count,
      } : null,
      sends: {
        byStatus: sendCounts,
        bounceRate: `${bounceRate}%`,
        recentSends,
      },
    });
  } catch (err) {
    console.error('[Admin] handleOutboundHealth error:', err);
    return serverError('Failed to load outbound health');
  }
}

// ─── Campaign CRUD ──────────────────────────────────────────────────────────

/** D1 row shape for outbound_campaigns table. */
interface CampaignRow {
  id: number;
  name: string;
  slug: string;
  sequence_id: number | null;
  source_filter: string | null;
  status: string;
  daily_limit: number;
  warmup_day: number;
  warmup_schedule: string | null;
  total_sent: number;
  total_opened: number;
  total_clicked: number;
  total_replied: number;
  total_bounced: number;
  total_unsub: number;
  started_at: number | null;
  paused_at: number | null;
  created_at: number;
  updated_at: number;
}

const VALID_CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'completed'] as const;

/**
 * GET /api/admin/campaigns/outbound
 *
 * List all outbound campaigns with delivery metrics.
 */
export async function handleListOutboundCampaigns(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');

    let sql = `SELECT * FROM outbound_campaigns`;
    const params: unknown[] = [];

    if (status && VALID_CAMPAIGN_STATUSES.includes(status as typeof VALID_CAMPAIGN_STATUSES[number])) {
      sql += ` WHERE status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY created_at DESC`;

    const campaigns = await query<CampaignRow>(env.DB, sql, params);

    // Augment with warmup info
    const dateKey = todayDateKey();
    const sentToday = await getSentToday(env.KV_MARKETING, dateKey);

    return ok({
      campaigns: campaigns.map((c) => ({
        ...c,
        sourceFilter: c.source_filter ? JSON.parse(c.source_filter) : null,
      })),
      throttle: {
        sentToday,
        dateKey,
      },
    });
  } catch (err) {
    console.error('[Admin] handleListCampaigns error:', err);
    return serverError('Failed to load campaigns');
  }
}

/**
 * GET /api/admin/campaigns/outbound/:id
 *
 * Get a single campaign by ID with full metrics.
 */
export async function handleGetOutboundCampaign(
  request: Request,
  env: Env,
  campaignId: number
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  try {
    const campaign = await queryOne<CampaignRow>(
      env.DB,
      `SELECT * FROM outbound_campaigns WHERE id = ?`,
      [campaignId]
    );

    if (!campaign) return notFound('Campaign not found');

    // Get warmup state + throttle info
    const dateKey = todayDateKey();
    const epoch = now();
    const throttle = await checkThrottle(env.KV_MARKETING, campaign.slug, dateKey, epoch);

    // Count sends linked to this campaign's sequence
    const sendStats = campaign.sequence_id
      ? await query<{ status: string; count: number }>(
          env.DB,
          `SELECT es.status, COUNT(*) as count
           FROM email_sends es
           WHERE es.sequence_id = ?
           GROUP BY es.status`,
          [campaign.sequence_id]
        )
      : [];

    return ok({
      campaign: {
        ...campaign,
        sourceFilter: campaign.source_filter ? JSON.parse(campaign.source_filter) : null,
      },
      throttle,
      sendsByStatus: sendStats.reduce(
        (acc: Record<string, number>, s) => ({ ...acc, [s.status]: s.count }),
        {}
      ),
    });
  } catch (err) {
    console.error('[Admin] handleGetCampaign error:', err);
    return serverError('Failed to load campaign');
  }
}

/**
 * POST /api/admin/campaigns/outbound
 *
 * Create a new outbound campaign.
 * Body: { name, slug, sequence_id?, source_filter?, daily_limit?,
 *         warmup_profile?, warmup_schedule? }
 *
 * warmup_profile: Named preset — "conservative-30day", "aggressive-7day", or "flat-150"
 * warmup_schedule: Custom array — [{ "day": 1, "dailyLimit": 20 }, { "day": 3, "dailyLimit": 50 }]
 *
 * If both are provided, warmup_schedule takes precedence.
 * If neither is provided, defaults to conservative-30day.
 */
export async function handleCreateOutboundCampaign(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  try {
    const body = await request.json() as {
      name?: string;
      slug?: string;
      sequence_id?: number;
      source_filter?: { sources?: string[]; min_score?: number };
      daily_limit?: number;
      warmup_profile?: string;
      warmup_schedule?: Array<{ day: number; dailyLimit: number }>;
    };

    if (!body.name || typeof body.name !== 'string') {
      return badRequest('name is required');
    }
    if (!body.slug || typeof body.slug !== 'string') {
      return badRequest('slug is required');
    }

    // Validate slug format (lowercase, alphanumeric + hyphens)
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(body.slug)) {
      return badRequest('slug must be lowercase alphanumeric with hyphens');
    }

    // Check uniqueness
    const existing = await queryOne(
      env.DB,
      `SELECT id FROM outbound_campaigns WHERE slug = ?`,
      [body.slug]
    );
    if (existing) return badRequest('A campaign with this slug already exists');

    const dailyLimit = body.daily_limit && body.daily_limit > 0
      ? Math.min(body.daily_limit, 200)
      : 10;

    const sourceFilter = body.source_filter
      ? JSON.stringify(body.source_filter)
      : null;

    // Resolve warmup schedule: custom array > named preset > default
    let warmupScheduleJson: string | null = null;
    if (body.warmup_schedule) {
      if (!isValidSchedule(body.warmup_schedule)) {
        return badRequest('warmup_schedule must be a non-empty array of { day, dailyLimit } with ascending days');
      }
      warmupScheduleJson = JSON.stringify(body.warmup_schedule);
    } else if (body.warmup_profile) {
      if (!WARMUP_PRESETS[body.warmup_profile]) {
        const validNames = Object.keys(WARMUP_PRESETS).join(', ');
        return badRequest(`Unknown warmup_profile "${body.warmup_profile}". Valid: ${validNames}`);
      }
      warmupScheduleJson = JSON.stringify(resolveWarmupProfile(body.warmup_profile));
    }

    await execute(
      env.DB,
      `INSERT INTO outbound_campaigns (name, slug, sequence_id, source_filter, daily_limit, warmup_schedule)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [body.name, body.slug, body.sequence_id ?? null, sourceFilter, dailyLimit, warmupScheduleJson]
    );

    const campaign = await queryOne<CampaignRow>(
      env.DB,
      `SELECT * FROM outbound_campaigns WHERE slug = ?`,
      [body.slug]
    );

    return created(campaign);
  } catch (err) {
    console.error('[Admin] handleCreateCampaign error:', err);
    return serverError('Failed to create campaign');
  }
}

/**
 * POST /api/admin/campaigns/outbound/:id/start
 *
 * Activate a campaign (set status to 'active', record started_at).
 * Only draft or paused campaigns can be started.
 */
export async function handleStartOutboundCampaign(
  request: Request,
  env: Env,
  campaignId: number
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  try {
    const campaign = await queryOne<CampaignRow>(
      env.DB,
      `SELECT * FROM outbound_campaigns WHERE id = ?`,
      [campaignId]
    );

    if (!campaign) return notFound('Campaign not found');

    if (campaign.status === 'active') {
      return badRequest('Campaign is already active');
    }
    if (campaign.status === 'completed') {
      return badRequest('Cannot restart a completed campaign');
    }

    const epoch = now();
    const isFirstStart = !campaign.started_at;

    await execute(
      env.DB,
      `UPDATE outbound_campaigns
       SET status = 'active',
           started_at = COALESCE(started_at, ?),
           paused_at = NULL,
           warmup_day = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        epoch,
        isFirstStart ? 1 : Math.max(1, Math.floor((epoch - (campaign.started_at ?? epoch)) / 86_400) + 1),
        epoch,
        campaignId,
      ]
    );

    console.log(`[Campaign] Started campaign ${campaign.slug} (id=${campaignId})`);

    return ok({
      id: campaignId,
      status: 'active',
      warmupDay: isFirstStart ? 1 : campaign.warmup_day,
      message: isFirstStart ? 'Campaign started — warmup begins at day 1' : 'Campaign resumed',
    });
  } catch (err) {
    console.error('[Admin] handleStartCampaign error:', err);
    return serverError('Failed to start campaign');
  }
}

/**
 * POST /api/admin/campaigns/outbound/:id/pause
 *
 * Pause an active campaign. Scheduled sends remain but won't be processed
 * while paused (they stay as 'scheduled' and the cron won't pick them up
 * until the campaign is restarted).
 */
export async function handlePauseOutboundCampaign(
  request: Request,
  env: Env,
  campaignId: number
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  try {
    const campaign = await queryOne<CampaignRow>(
      env.DB,
      `SELECT * FROM outbound_campaigns WHERE id = ?`,
      [campaignId]
    );

    if (!campaign) return notFound('Campaign not found');

    if (campaign.status !== 'active') {
      return badRequest(`Cannot pause a ${campaign.status} campaign`);
    }

    const epoch = now();

    await execute(
      env.DB,
      `UPDATE outbound_campaigns
       SET status = 'paused', paused_at = ?, updated_at = ?
       WHERE id = ?`,
      [epoch, epoch, campaignId]
    );

    console.log(`[Campaign] Paused campaign ${campaign.slug} (id=${campaignId})`);

    return ok({
      id: campaignId,
      status: 'paused',
      message: `Campaign paused. ${campaign.total_sent} emails sent so far.`,
    });
  } catch (err) {
    console.error('[Admin] handlePauseCampaign error:', err);
    return serverError('Failed to pause campaign');
  }
}

// ─── Channel Visibility ─────────────────────────────────────────────────────

/**
 * GET /api/admin/outbound/channels
 *
 * Returns aggregate channel statistics: how many prospects have each
 * channel type, and attempt/delivery counts per channel.
 */
export async function handleOutboundChannels(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  try {
    const stats = await getChannelStats(env);
    return ok(stats);
  } catch (err) {
    console.error('[Admin] handleOutboundChannels error:', err);
    return serverError('Failed to load channel stats');
  }
}

/**
 * GET /api/admin/outbound/channels/:domain
 *
 * Returns all detected channels and outreach attempts for a specific prospect.
 */
export async function handleOutboundChannelsByDomain(
  request: Request,
  env: Env,
  domain: string
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  try {
    const channels = await getProspectChannels(env, domain);

    // Also get recent attempts for this domain
    const attempts = await query<{
      channel_type: string;
      channel_value: string;
      step_key: string | null;
      status: string;
      response_code: number | null;
      error: string | null;
      attempted_at: number;
    }>(
      env.DB,
      `SELECT channel_type, channel_value, step_key, status, response_code, error, attempted_at
       FROM channel_attempts
       WHERE prospect_domain = ?
       ORDER BY attempted_at DESC
       LIMIT 50`,
      [domain]
    );

    return ok({ domain, channels, attempts });
  } catch (err) {
    console.error(`[Admin] handleOutboundChannelsByDomain error for ${domain}:`, err);
    return serverError('Failed to load channel data');
  }
}

/**
 * POST /api/admin/outbound/channels/:domain/attempt
 *
 * Records a manual outreach attempt (e.g. Twitter DM, LinkedIn message).
 * Body: { channelType, channelValue, status?, notes? }
 */
export async function handleRecordManualAttempt(
  request: Request,
  env: Env,
  domain: string
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  try {
    const body = await request.json() as {
      channelType?: string;
      channelValue?: string;
      status?: string;
      notes?: string;
    };

    if (!body.channelType || !body.channelValue) {
      return badRequest('channelType and channelValue are required');
    }

    const validStatuses = ['attempted', 'delivered', 'failed'];
    const status = validStatuses.includes(body.status ?? '') ? body.status! : 'attempted';

    await recordChannelAttempt(env, {
      domain,
      contactEmail: null,
      channelType: body.channelType,
      channelValue: body.channelValue,
      stepKey: 'manual',
      status: status as 'attempted' | 'delivered' | 'failed',
      error: body.notes ?? undefined,
    });

    return ok({ recorded: true, domain, channelType: body.channelType, status });
  } catch (err) {
    console.error(`[Admin] handleRecordManualAttempt error for ${domain}:`, err);
    return serverError('Failed to record attempt');
  }
}
