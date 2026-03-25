import type { Env, DashboardMetrics } from '../../types';
import { ok, serverError } from '../../lib/response';
import { queryOne, todayKey, formatCents } from '../../lib/db';
import { getContactStats, getLatestMrrSnapshot, getMrrHistory } from '../../lib/crm';
import {
  KV_PREFIX,
  PAYOUT_STATUS,
  EMAIL_STATUS,
  NOTE_TYPE,
  SQLITE_BOOL,
  DEFAULTS,
  MESSAGES,
} from '../../constants';

export async function handleAdminDashboard(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const [mrrSnapshot, contactStats] = await Promise.all([
      getLatestMrrSnapshot(env),
      getContactStats(env),
    ]);

    const today = todayKey();
    const dailyConversions = parseInt(
      await env.KV_MARKETING.get(`${KV_PREFIX.DAILY_CONVERSIONS}${today}`) ?? '0',
      10
    );
    const dailyRevenue = parseInt(
      await env.KV_MARKETING.get(`${KV_PREFIX.DAILY_REVENUE}${today}`) ?? '0',
      10
    );

    const pendingPayouts = await queryOne<{ total: number }>(
      env.DB,
      `SELECT COALESCE(SUM(total_amount_cents), 0) as total
       FROM payout_batches WHERE status = '${PAYOUT_STATUS.PENDING}'`
    );

    const activeSequences = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM email_sequences WHERE is_active = ${SQLITE_BOOL.TRUE}`
    );

    const emailsSentToday = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM email_sends WHERE status = '${EMAIL_STATUS.SENT}' AND sent_at >= ?`,
      [Math.floor(new Date(today).getTime() / 1000)]
    );

    const affConversionsToday = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM affiliate_notes
       WHERE note_type = '${NOTE_TYPE.CONVERSION}' AND created_at >= ?`,
      [Math.floor(new Date(today).getTime() / 1000)]
    );

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

export async function handleMrrHistory(
  request: Request,
  env: Env
): Promise<Response> {
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
