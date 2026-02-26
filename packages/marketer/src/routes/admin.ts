/**
 * Admin API Routes
 *
 * Dashboard metrics, email management, and system admin.
 * All routes require Bearer ADMIN_TOKEN authentication.
 */

import type { Env, DashboardMetrics } from '../types';
import { ok, badRequest, unauthorized, serverError } from '../lib/response';
import { query, queryOne, execute, now, todayKey, formatCents } from '../lib/db';
import { getContactStats, getLatestMrrSnapshot, getMrrHistory } from '../lib/crm';
import { processDueEmails } from '../lib/email';

// ─── Auth Middleware ─────────────────────────────────────────────────────────

function isAdmin(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${env.ADMIN_TOKEN}`;
}

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
      await env.KV_MARKETING.get(`daily-conversions:${today}`) ?? '0',
      10
    );
    const dailyRevenue = parseInt(
      await env.KV_MARKETING.get(`daily-revenue:${today}`) ?? '0',
      10
    );

    // Pending payouts
    const pendingPayouts = await queryOne<{ total: number }>(
      env.DB,
      `SELECT COALESCE(SUM(total_amount_cents), 0) as total
       FROM payout_batches WHERE status = 'pending'`
    );

    // Active sequences
    const activeSequences = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM email_sequences WHERE is_active = 1`
    );

    // Emails sent today
    const emailsSentToday = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM email_sends WHERE status = 'sent' AND sent_at >= ?`,
      [Math.floor(new Date(today).getTime() / 1000)]
    );

    // Affiliate conversions today
    const affConversionsToday = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM affiliate_notes
       WHERE note_type = 'conversion' AND created_at >= ?`,
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
    };

    return ok({
      metrics,
      contacts: contactStats,
      dailyRevenueCents: dailyRevenue,
      dailyRevenueFormatted: formatCents(dailyRevenue),
    });
  } catch (err) {
    console.error('[Admin:Dashboard] Error:', err);
    return serverError('Failed to load dashboard');
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
  const start = url.searchParams.get('start') ?? '2024-01-01';
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
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);

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
    const sent = await processDueEmails(env);
    return ok({ processed: sent, message: `Processed ${sent} due emails` });
  } catch (err) {
    console.error('[Admin:ProcessEmails] Error:', err);
    return serverError('Failed to process emails');
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
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
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
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);

  const notifications = await query(
    env.DB,
    `SELECT * FROM notification_log ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );

  return ok({ notifications, limit });
}
