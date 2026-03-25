import type { Env } from '../../types';
import { ok, badRequest, unauthorized, notFound, serverError, created } from '../../lib/response';
import { query, queryOne, execute, now } from '../../lib/db';
import { checkThrottle, getSentToday, todayDateKey, WARMUP_PRESETS, isValidSchedule, resolveWarmupProfile } from '../../lib/warmup';
import { getProspectChannels, getChannelStats, recordChannelAttempt } from '../../lib/channel-orchestrator';
import { KV_PREFIX } from '../../constants';
import { parsePositiveIntParam, safeJsonParse } from './admin-lib';
import { getCorrelationId } from '../../lib/correlation';
import { getReputationTrend } from '../../lib/reputation';

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

export async function handleOutboundHealth(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const prospectCount = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM marketing_contacts WHERE source = 'outbound'`
    );

    const prospectsByStatus = await query<{ status: string; count: number }>(
      env.DB,
      `SELECT status, COUNT(*) as count FROM marketing_contacts WHERE source = 'outbound' GROUP BY status`
    );

    const coldSends = await query<{ status: string; count: number }>(
      env.DB,
      `SELECT es.status, COUNT(*) as count
       FROM email_sends es
       JOIN email_sequences seq ON es.sequence_id = seq.id
       WHERE seq.trigger_event = 'outbound.prospect_discovered'
       GROUP BY es.status`
    );

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

export async function handleAbStats(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const listResult = await env.KV_MARKETING.list({ prefix: 'ab:variants:' });
    const stats: Record<string, Record<string, number[]>> = {};

    // Fetch variant payloads in parallel to avoid sequential KV fanout latency.
    const keyPayloadPairs = await Promise.all(
      listResult.keys.map(async (key) => {
        const raw = await env.KV_MARKETING.get(key.name);
        return { key: key.name, raw };
      })
    );

    for (const item of keyPayloadPairs) {
      if (!item.raw) continue;
      try {
        stats[item.key.replace('ab:variants:', '')] = JSON.parse(item.raw) as Record<string, number[]>;
      } catch {
        // Ignore malformed payloads to keep admin endpoint resilient.
      }
    }

    return ok({ templates: stats, count: Object.keys(stats).length });
  } catch (err) {
    console.error('[Admin] handleAbStats error:', err);
    return serverError('Failed to load A/B stats');
  }
}

export async function handleLinkedinQueue(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const limit = parsePositiveIntParam(url.searchParams.get('limit'), 50, 200);

    const prospects = await query<{
      email: string;
      status: string;
      metadata: string | null;
    }>(
      env.DB,
      `SELECT email, status, metadata FROM marketing_contacts
       WHERE source = 'outbound' AND status IN ('prospect', 'lead')
       ORDER BY updated_at DESC
       LIMIT ?`,
      [limit]
    );

    const queue = prospects
      .map((p) => {
        const meta = safeJsonParse<Record<string, unknown>>(p.metadata, {});
        const socialHandles = (meta.socialHandles as Record<string, unknown> | undefined) ?? {};
        const score = Number(meta.prospectScore ?? 0);
        return {
          email: p.email,
          status: p.status,
          domain: meta.domain ?? null,
          companyName: meta.companyName ?? null,
          contactName: meta.contactName ?? null,
          contactTitle: meta.contactTitle ?? null,
          score,
          linkedinUrl: typeof socialHandles.linkedin === 'string' ? socialHandles.linkedin : null,
        };
      })
      .filter((p) => p.score >= 60)
      .sort((a, b) => b.score - a.score);

    return ok({ queue, count: queue.length });
  } catch (err) {
    console.error('[Admin] handleLinkedinQueue error:', err);
    return serverError('Failed to load LinkedIn queue');
  }
}

export async function handleListOutboundCampaigns(
  request: Request,
  env: Env
): Promise<Response> {
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

export async function handleGetOutboundCampaign(
  request: Request,
  env: Env,
  campaignId: number
): Promise<Response> {
  try {
    const campaign = await queryOne<CampaignRow>(
      env.DB,
      `SELECT * FROM outbound_campaigns WHERE id = ?`,
      [campaignId]
    );

    if (!campaign) return notFound('Campaign not found');

    const dateKey = todayDateKey();
    const epoch = now();
    const throttle = await checkThrottle(env.KV_MARKETING, campaign.slug, dateKey, epoch);

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

export async function handleCreateOutboundCampaign(
  request: Request,
  env: Env
): Promise<Response> {
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

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(body.slug)) {
      return badRequest('slug must be lowercase alphanumeric with hyphens');
    }

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

export async function handleStartOutboundCampaign(
  request: Request,
  env: Env,
  campaignId: number
): Promise<Response> {
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
      message: isFirstStart ? 'Campaign started - warmup begins at day 1' : 'Campaign resumed',
    });
  } catch (err) {
    console.error('[Admin] handleStartCampaign error:', err);
    return serverError('Failed to start campaign');
  }
}

export async function handlePauseOutboundCampaign(
  request: Request,
  env: Env,
  campaignId: number
): Promise<Response> {
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

export async function handleOutboundChannels(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const stats = await getChannelStats(env);
    return ok(stats);
  } catch (err) {
    console.error('[Admin] handleOutboundChannels error:', err);
    return serverError('Failed to load channel stats');
  }
}

export async function handleOutboundChannelsByDomain(
  request: Request,
  env: Env,
  domain: string
): Promise<Response> {
  try {
    const channels = await getProspectChannels(env, domain);

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

export async function handleRecordManualAttempt(
  request: Request,
  env: Env,
  domain: string
): Promise<Response> {
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

// ─── Campaign Funnel Metrics ────────────────────────────────────────────────

/**
 * GET /admin/outbound/funnel
 *
 * Returns the full outbound funnel metrics by querying both the local D1
 * (marketing data) and the analytics worker via service binding (discovery data).
 * Funnel: discovered → enriched → qualified → enrolled → sent → opened → clicked → replied → converted
 */
export async function handleOutboundFunnel(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // ── Marketing-side metrics (D1) ──
    const [campaigns, prospectsByStatus, sendsByStatus, suppressedCount] = await Promise.all([
      query<CampaignRow>(
        env.DB,
        `SELECT * FROM outbound_campaigns ORDER BY created_at DESC LIMIT 5`
      ),
      query<{ status: string; count: number }>(
        env.DB,
        `SELECT status, COUNT(*) as count FROM marketing_contacts WHERE source = 'outbound' GROUP BY status`
      ),
      query<{ status: string; count: number }>(
        env.DB,
        `SELECT es.status, COUNT(*) as count
         FROM email_sends es
         JOIN email_sequences seq ON es.sequence_id = seq.id
         WHERE seq.trigger_event = 'outbound.prospect_discovered'
         GROUP BY es.status`
      ),
      queryOne<{ count: number }>(
        env.DB,
        `SELECT COUNT(*) as count FROM suppression_list`
      ),
    ]);

    const prospectStatusMap: Record<string, number> = {};
    for (const row of prospectsByStatus) {
      prospectStatusMap[row.status] = row.count;
    }

    const sendStatusMap: Record<string, number> = {};
    for (const row of sendsByStatus) {
      sendStatusMap[row.status] = row.count;
    }

    // ── Analytics-side metrics (via service binding) ──
    let analyticsFunnel: Record<string, unknown> | null = null;
    if (env.ANALYTICS) {
      try {
        const resp = await env.ANALYTICS.fetch('https://analytics/admin/outbound?format=json', {
          headers: { 'cf-worker': 'visibility-marketing' },
        });
        if (resp.ok) {
          analyticsFunnel = await resp.json() as Record<string, unknown>;
        }
      } catch {
        // Analytics binding may be unavailable
      }
    }

    // ── Aggregate campaign metrics ──
    const activeCampaign = campaigns.find(c => c.status === 'active') ?? campaigns[0];
    const campaignMetrics = activeCampaign ? {
      name: activeCampaign.name,
      slug: activeCampaign.slug,
      status: activeCampaign.status,
      warmupDay: activeCampaign.warmup_day,
      totalSent: activeCampaign.total_sent,
      totalOpened: activeCampaign.total_opened,
      totalClicked: activeCampaign.total_clicked,
      totalReplied: activeCampaign.total_replied,
      totalBounced: activeCampaign.total_bounced,
      totalUnsub: activeCampaign.total_unsub,
      openRate: activeCampaign.total_sent > 0
        ? ((activeCampaign.total_opened / activeCampaign.total_sent) * 100).toFixed(1) + '%'
        : '0.0%',
      clickRate: activeCampaign.total_sent > 0
        ? ((activeCampaign.total_clicked / activeCampaign.total_sent) * 100).toFixed(1) + '%'
        : '0.0%',
      replyRate: activeCampaign.total_sent > 0
        ? ((activeCampaign.total_replied / activeCampaign.total_sent) * 100).toFixed(1) + '%'
        : '0.0%',
      bounceRate: activeCampaign.total_sent > 0
        ? ((activeCampaign.total_bounced / activeCampaign.total_sent) * 100).toFixed(1) + '%'
        : '0.0%',
    } : null;

    // ── Build unified funnel ──
    const analyticsData = analyticsFunnel as { counts?: Record<string, number> } | null;
    const funnel = {
      // Analytics-side (discovery/enrichment)
      discovered: analyticsData?.counts?.total ?? null,
      enriched: analyticsData?.counts?.enriched ?? null,
      qualified: analyticsData?.counts?.qualified ?? null,
      withEmail: analyticsData?.counts?.withEmail ?? null,

      // Marketing-side (enrollment → conversion)
      enrolled: (prospectStatusMap['prospect'] ?? 0) + (prospectStatusMap['engaged'] ?? 0) + (prospectStatusMap['lead'] ?? 0),
      sent: sendStatusMap['sent'] ?? 0,
      scheduled: sendStatusMap['scheduled'] ?? 0,
      failed: sendStatusMap['failed'] ?? 0,
      cancelled: sendStatusMap['cancelled'] ?? 0,

      // Engagement (from campaign metrics)
      opened: activeCampaign?.total_opened ?? 0,
      clicked: activeCampaign?.total_clicked ?? 0,
      replied: activeCampaign?.total_replied ?? 0,
      bounced: activeCampaign?.total_bounced ?? 0,
      unsubscribed: activeCampaign?.total_unsub ?? 0,

      // Conversion
      converted: prospectStatusMap['customer'] ?? 0,
      engaged: prospectStatusMap['engaged'] ?? 0,

      // Compliance
      suppressed: suppressedCount?.count ?? 0,
    };

    return ok({
      funnel,
      campaign: campaignMetrics,
      campaigns: campaigns.map(c => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        status: c.status,
        totalSent: c.total_sent,
        totalReplied: c.total_replied,
      })),
    });
  } catch (err) {
    console.error('[Admin] handleOutboundFunnel error:', err);
    return serverError('Failed to load funnel metrics');
  }
}

// ─── Cross-System Health Dashboard ──────────────────────────────────────────

/**
 * Unified health dashboard that aggregates marketing-side health
 * plus analytics-side pipeline health via service binding.
 */
export async function handleCrossSystemHealth(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    // ── Marketing-side health (local queries) ──
    const [
      prospectCount,
      sendStats,
      scheduledCount,
      suppressionCount,
      lastCronRun,
    ] = await Promise.all([
      queryOne<{ total: number; enrolled: number }>(env.DB,
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status IN ('prospect','lead') THEN 1 ELSE 0 END) as enrolled
         FROM marketing_contacts WHERE source = 'outbound'`),
      queryOne<{
        sent_24h: number; failed_24h: number; sent_7d: number; failed_7d: number;
      }>(env.DB,
        `SELECT
           SUM(CASE WHEN sent_at > ? THEN 1 ELSE 0 END) as sent_24h,
           SUM(CASE WHEN status = 'failed' AND scheduled_at > ? THEN 1 ELSE 0 END) as failed_24h,
           SUM(CASE WHEN sent_at > ? THEN 1 ELSE 0 END) as sent_7d,
           SUM(CASE WHEN status = 'failed' AND scheduled_at > ? THEN 1 ELSE 0 END) as failed_7d
         FROM email_sends`,
        [now() - 86400, now() - 86400, now() - 604800, now() - 604800]),
      queryOne<{ count: number }>(env.DB,
        `SELECT COUNT(*) as count FROM email_sends WHERE status = 'scheduled'`),
      queryOne<{ count: number }>(env.DB,
        `SELECT COUNT(*) as count FROM suppression_list`),
      env.KV_MARKETING.get('cron:summary:latest'),
    ]);

    const marketingHealth = {
      prospects: { total: prospectCount?.total ?? 0, enrolled: prospectCount?.enrolled ?? 0 },
      sends: {
        last24h: { sent: sendStats?.sent_24h ?? 0, failed: sendStats?.failed_24h ?? 0 },
        last7d: { sent: sendStats?.sent_7d ?? 0, failed: sendStats?.failed_7d ?? 0 },
        queueDepth: scheduledCount?.count ?? 0,
      },
      compliance: { suppressions: suppressionCount?.count ?? 0 },
      lastCron: lastCronRun ? safeJsonParse(lastCronRun, null) : null,
    };

    // ── Analytics-side health (via service binding) ──
    let analyticsHealth: Record<string, unknown> | null = null;
    try {
      const analyticsResp = await env.ANALYTICS.fetch('https://internal/api/health', {
        headers: { 'cf-worker': 'visibility-marketing', 'x-correlation-id': getCorrelationId() },
      });
      if (analyticsResp.ok) {
        const data = await analyticsResp.json() as { data?: Record<string, unknown> };
        analyticsHealth = data.data ?? data as Record<string, unknown>;
      }
    } catch (err) {
      console.warn('[Health] Analytics service binding unreachable:', err instanceof Error ? err.message : err);
    }

    // ── Analytics pipeline health (cron status) ──
    let pipelineHealth: Record<string, unknown> | null = null;
    try {
      const pipelineResp = await env.ANALYTICS.fetch('https://internal/admin/cron-status', {
        headers: { 'cf-worker': 'visibility-marketing', 'x-correlation-id': getCorrelationId() },
      });
      if (pipelineResp.ok) {
        const data = await pipelineResp.json() as { data?: Record<string, unknown> };
        pipelineHealth = data.data ?? data as Record<string, unknown>;
      }
    } catch {
      // Non-critical — already logged above
    }

    return ok({
      timestamp: new Date().toISOString(),
      marketing: marketingHealth,
      analytics: analyticsHealth,
      pipeline: pipelineHealth,
      overall: {
        marketingUp: true,
        analyticsUp: analyticsHealth !== null,
        sendFailRate24h: (sendStats?.sent_24h ?? 0) > 0
          ? ((sendStats?.failed_24h ?? 0) / (sendStats!.sent_24h + sendStats!.failed_24h) * 100).toFixed(1) + '%'
          : 'N/A',
      },
    });
  } catch (err) {
    console.error('[Admin] handleCrossSystemHealth error:', err);
    return serverError('Failed to load cross-system health');
  }
}

// ─── SLI/SLO Compliance ────────────────────────────────────────────────────

/** Outbound pipeline SLOs — targets we commit to. */
const OUTBOUND_SLOS = {
  /** Email delivery rate target (excluding cancelled/suppressed). */
  DELIVERY_RATE: 0.95,
  /** Max bounce rate (hard + soft). */
  MAX_BOUNCE_RATE: 0.05,
  /** Max complaint rate. */
  MAX_COMPLAINT_RATE: 0.001,
  /** Enrichment success rate (enriched / attempted). */
  ENRICHMENT_SUCCESS_RATE: 0.70,
  /** Max scheduled-to-sent latency (seconds) — sends should happen within 10 min of schedule. */
  MAX_SEND_LATENCY_SECS: 600,
  /** Discovery-to-enrichment pipeline: prospects should be enriched within 48h of discovery. */
  MAX_ENRICHMENT_LAG_HOURS: 48,
} as const;

/**
 * SLI/SLO compliance report for the outbound pipeline.
 * Measures actual SLIs against defined SLOs over the last 7 days.
 */
export async function handleOutboundSLO(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const sevenDaysAgo = now() - 604800;

    const [
      deliveryStats,
      latencyStats,
      enrichmentStats,
    ] = await Promise.all([
      // SLI: delivery rate, bounce rate, complaint rate (7-day window)
      queryOne<{
        total_attempted: number;
        total_delivered: number;
        total_bounced: number;
        total_failed: number;
      }>(env.DB,
        `SELECT
           COUNT(*) as total_attempted,
           SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as total_delivered,
           SUM(CASE WHEN error LIKE '%bounce%' THEN 1 ELSE 0 END) as total_bounced,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as total_failed
         FROM email_sends
         WHERE scheduled_at > ? AND status IN ('sent', 'failed')`,
        [sevenDaysAgo]),

      // SLI: send latency (avg and p95 of sent_at - scheduled_at)
      queryOne<{ avg_latency: number; max_latency: number; p95_count: number }>(env.DB,
        `SELECT
           AVG(sent_at - scheduled_at) as avg_latency,
           MAX(sent_at - scheduled_at) as max_latency,
           COUNT(CASE WHEN (sent_at - scheduled_at) > ${OUTBOUND_SLOS.MAX_SEND_LATENCY_SECS} THEN 1 END) as p95_count
         FROM email_sends
         WHERE sent_at IS NOT NULL AND scheduled_at > ?`,
        [sevenDaysAgo]),

      // SLI: enrichment success rate
      queryOne<{ total: number; enriched: number; avg_lag_hours: number }>(env.DB,
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status != 'new' THEN 1 ELSE 0 END) as enriched,
           AVG(CASE WHEN enriched_at IS NOT NULL THEN
             (julianday(enriched_at) - julianday(created_at)) * 24
           END) as avg_lag_hours
         FROM marketing_contacts WHERE source = 'outbound'`),
    ]);

    const totalAttempted = deliveryStats?.total_attempted ?? 0;
    const totalDelivered = deliveryStats?.total_delivered ?? 0;
    const totalBounced = deliveryStats?.total_bounced ?? 0;
    const totalFailed = deliveryStats?.total_failed ?? 0;

    const deliveryRate = totalAttempted > 0 ? totalDelivered / totalAttempted : 1;
    const bounceRate = totalAttempted > 0 ? totalBounced / totalAttempted : 0;
    const failRate = totalAttempted > 0 ? totalFailed / totalAttempted : 0;

    const enrichTotal = enrichmentStats?.total ?? 0;
    const enriched = enrichmentStats?.enriched ?? 0;
    const enrichRate = enrichTotal > 0 ? enriched / enrichTotal : 1;

    const slis = {
      delivery_rate: { value: deliveryRate, target: OUTBOUND_SLOS.DELIVERY_RATE, met: deliveryRate >= OUTBOUND_SLOS.DELIVERY_RATE },
      bounce_rate: { value: bounceRate, target: OUTBOUND_SLOS.MAX_BOUNCE_RATE, met: bounceRate <= OUTBOUND_SLOS.MAX_BOUNCE_RATE },
      send_latency_avg: { value: latencyStats?.avg_latency ?? 0, target: OUTBOUND_SLOS.MAX_SEND_LATENCY_SECS, met: (latencyStats?.avg_latency ?? 0) <= OUTBOUND_SLOS.MAX_SEND_LATENCY_SECS },
      sends_over_latency_slo: { value: latencyStats?.p95_count ?? 0 },
      enrichment_rate: { value: enrichRate, target: OUTBOUND_SLOS.ENRICHMENT_SUCCESS_RATE, met: enrichRate >= OUTBOUND_SLOS.ENRICHMENT_SUCCESS_RATE },
      enrichment_lag_hours: { value: enrichmentStats?.avg_lag_hours ?? 0, target: OUTBOUND_SLOS.MAX_ENRICHMENT_LAG_HOURS, met: (enrichmentStats?.avg_lag_hours ?? 0) <= OUTBOUND_SLOS.MAX_ENRICHMENT_LAG_HOURS },
    };

    const allMet = Object.values(slis).every(s => 'met' in s ? s.met : true);

    return ok({
      window: '7d',
      slos: OUTBOUND_SLOS,
      slis,
      overall: allMet ? 'HEALTHY' : 'DEGRADED',
      sample: { totalAttempted, totalDelivered, totalBounced, totalFailed, enrichTotal, enriched },
    });
  } catch (err) {
    console.error('[Admin] handleOutboundSLO error:', err);
    return serverError('Failed to compute SLI/SLO compliance');
  }
}

// ─── Domain Reputation Trend ────────────────────────────────────────────────

/**
 * Returns the rolling 30-day domain reputation trend.
 * Each entry contains: date, sent, bounced, complained, openRate, healthScore.
 */
export async function handleReputationTrend(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const days = Math.min(parseInt(url.searchParams.get('days') ?? '30', 10) || 30, 90);
    const trend = await getReputationTrend(env.KV_MARKETING, days);

    const avgHealth = trend.length > 0
      ? Math.round(trend.reduce((sum, s) => sum + s.healthScore, 0) / trend.length)
      : 100;

    return ok({
      days,
      entries: trend.length,
      avgHealthScore: avgHealth,
      status: avgHealth >= 80 ? 'GOOD' : avgHealth >= 60 ? 'WARNING' : 'CRITICAL',
      trend,
    });
  } catch (err) {
    console.error('[Admin] handleReputationTrend error:', err);
    return serverError('Failed to load reputation trend');
  }
}
