import type { Env } from '../../types';
import { ok, serverError, badRequest, created } from '../../lib/response';
import { execute, query, queryOne, now } from '../../lib/db';
import { createSkripClient } from '../../lib/skrip/client';
import { getSkripFlagSnapshot } from '../../lib/skrip/flags';
import { runDispatcherSweep } from '../../lib/skrip/dispatcher';
import { reconcilePendingIdentities } from '../../lib/skrip/registration';
import { enqueueEligibleSkripChannels } from '../../lib/skrip/outbox';
import { SKRIP_AUTHORITY, SKRIP_CHANNEL, SKRIP_ROLLOUT_STATE } from '../../constants';

const ALLOWED_CHANNELS = new Set<string>(Object.values(SKRIP_CHANNEL));
const ALLOWED_AUTHORITIES = new Set<string>(Object.values(SKRIP_AUTHORITY));
const ALLOWED_ROLLOUT_STATES = new Set<string>(Object.values(SKRIP_ROLLOUT_STATE));

function clampWindowDays(request: Request, fallback = 30): number {
  const raw = parseInt(new URL(request.url).searchParams.get('windowDays') ?? String(fallback), 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 365) : fallback;
}

export async function handleSkripOptInFunnel(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const tenantId = url.searchParams.get('tenantId') ?? 'default';
    const windowDays = clampWindowDays(request);
    const since = now() - windowDays * 86_400;

    const [eventsByType, registrationsByState, eligibility, recentEvents] = await Promise.all([
      query<{ event_type: string; count: number }>(
        env.DB,
        `SELECT event_type, COUNT(*) AS count
           FROM push_opt_in_events
          WHERE tenant_id = ? AND occurred_at >= ?
          GROUP BY event_type
          ORDER BY count DESC`,
        [tenantId, since],
      ),
      query<{ channel: string; registration_state: string; consent_state: string; suppression_state: string; availability_state: string; count: number }>(
        env.DB,
        `SELECT channel, registration_state, consent_state, suppression_state, availability_state, COUNT(*) AS count
           FROM contact_channel_identities
          WHERE tenant_id = ?
          GROUP BY channel, registration_state, consent_state, suppression_state, availability_state
          ORDER BY channel ASC, count DESC`,
        [tenantId],
      ),
      query<{ channel: string; eligible_for_send: number }>(
        env.DB,
        `SELECT cci.channel, COUNT(*) AS eligible_for_send
           FROM contact_channel_identities cci
           JOIN channel_authorities ca
             ON ca.tenant_id = cci.tenant_id
            AND ca.channel = cci.channel
            AND ca.authority = 'skrip'
            AND ca.rollout_state IN ('dry_run', 'enabled')
          WHERE cci.tenant_id = ?
            AND cci.consent_state IN ('opted_in', 'subscribed', 'granted')
            AND cci.suppression_state IN ('clear', 'allowed', 'unsuppressed')
            AND cci.availability_state IN ('available', 'reachable')
            AND cci.registration_state IN ('registered', 'active')
          GROUP BY cci.channel
          ORDER BY eligible_for_send DESC`,
        [tenantId],
      ),
      query(
        env.DB,
        `SELECT event_type, contact_id, browser_session_id, correlation_id, metadata_json, occurred_at
           FROM push_opt_in_events
          WHERE tenant_id = ? AND occurred_at >= ?
          ORDER BY occurred_at DESC
          LIMIT 25`,
        [tenantId, since],
      ),
    ]);

    return ok({ tenantId, windowDays, eventsByType, registrationsByState, eligibility, recentEvents });
  } catch (err) {
    console.error('[Admin] handleSkripOptInFunnel error:', err);
    return serverError('Failed to load Skrip opt-in funnel');
  }
}

export async function handleSkripAuthorityUpsert(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return badRequest('Invalid JSON body'); }

  const tenantId = typeof body.tenantId === 'string' && body.tenantId.trim() ? body.tenantId.trim() : 'default';
  const campaignId = typeof body.campaignId === 'string' && body.campaignId.trim() ? body.campaignId.trim() : null;
  const channel = typeof body.channel === 'string' ? body.channel.trim().toLowerCase() : '';
  const authority = typeof body.authority === 'string' ? body.authority.trim() : SKRIP_AUTHORITY.SKRIP;
  const rolloutState = typeof body.rolloutState === 'string' ? body.rolloutState.trim() : SKRIP_ROLLOUT_STATE.DRY_RUN;
  const featureFlagKey = typeof body.featureFlagKey === 'string' && body.featureFlagKey.trim() ? body.featureFlagKey.trim() : null;

  if (!ALLOWED_CHANNELS.has(channel)) return badRequest('channel must be one of email, push, sms, whatsapp, telegram');
  if (!ALLOWED_AUTHORITIES.has(authority)) return badRequest('authority must be visibility_marketing or skrip');
  if (!ALLOWED_ROLLOUT_STATES.has(rolloutState)) return badRequest('rolloutState must be disabled, dry_run, enabled, or rollback');

  const epoch = now();
  if (campaignId === null) {
    const existing = await queryOne<{ id: number }>(
      env.DB,
      `SELECT id FROM channel_authorities WHERE tenant_id = ? AND channel = ? AND campaign_id IS NULL LIMIT 1`,
      [tenantId, channel],
    );
    if (existing) {
      await execute(
        env.DB,
        `UPDATE channel_authorities
            SET authority = ?, rollout_state = ?, feature_flag_key = ?, updated_at = ?
          WHERE id = ?`,
        [authority, rolloutState, featureFlagKey, epoch, existing.id],
      );
    } else {
      await execute(
        env.DB,
        `INSERT INTO channel_authorities
          (tenant_id, campaign_id, channel, authority, rollout_state, feature_flag_key, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
        [tenantId, channel, authority, rolloutState, featureFlagKey, epoch, epoch],
      );
    }
  } else {
    await execute(
      env.DB,
      `INSERT INTO channel_authorities
        (tenant_id, campaign_id, channel, authority, rollout_state, feature_flag_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, campaign_id, channel) DO UPDATE SET
         authority = excluded.authority,
         rollout_state = excluded.rollout_state,
         feature_flag_key = excluded.feature_flag_key,
         updated_at = excluded.updated_at`,
      [tenantId, campaignId, channel, authority, rolloutState, featureFlagKey, epoch, epoch],
    );
  }

  return ok({ tenantId, campaignId, channel, authority, rolloutState, featureFlagKey, updatedAt: epoch });
}

export async function handleSkripDiagnostics(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const tenantId = url.searchParams.get('tenantId') ?? 'default';
    const campaignId = url.searchParams.get('campaignId');
    const channel = url.searchParams.get('channel') ?? 'push';

    const [authorities, authorityCount, pendingOutbox, outboxByStatus, recentOutbox, dlqPending, flags] = await Promise.all([
      query<{
        tenant_id: string;
        campaign_id: string | null;
        channel: string;
        authority: string;
        rollout_state: string;
      }>(
        env.DB,
        `SELECT tenant_id, campaign_id, channel, authority, rollout_state
           FROM channel_authorities
          WHERE tenant_id = ?
          ORDER BY CASE WHEN campaign_id IS NULL THEN 1 ELSE 0 END, channel ASC`,
        [tenantId],
      ),
      queryOne<{ count: number }>(env.DB, `SELECT COUNT(*) AS count FROM channel_authorities`),
      queryOne<{ count: number }>(
        env.DB,
        `SELECT COUNT(*) AS count FROM channel_execution_outbox WHERE status IN ('pending', 'retrying')`,
      ),
      query<{
        status: string;
        count: number;
      }>(
        env.DB,
        `SELECT status, COUNT(*) AS count
           FROM channel_execution_outbox
          GROUP BY status
          ORDER BY count DESC`,
      ),
      query<{
        tenant_id: string;
        campaign_id: string;
        contact_id: string;
        channel: string;
        status: string;
        schedule_slot: string;
        created_at: number;
      }>(
        env.DB,
        `SELECT tenant_id, campaign_id, contact_id, channel, status, schedule_slot, created_at
           FROM channel_execution_outbox
          ORDER BY created_at DESC
          LIMIT 10`,
      ),
      queryOne<{ count: number }>(
        env.DB,
        `SELECT COUNT(*) AS count FROM channel_outcome_dead_letter WHERE replayed_at IS NULL`,
      ),
      getSkripFlagSnapshot(env, tenantId, campaignId, channel),
    ]);

    const client = createSkripClient(env);

    return ok({
      configured: {
        baseUrl: env.SKRIP_BASE_URL ?? null,
        serviceToken: Boolean(env.SKRIP_SERVICE_TOKEN),
        signingSecret: Boolean(env.SKRIP_SIGNING_SECRET),
        webhookSigningSecret: Boolean(env.SKRIP_WEBHOOK_SIGNING_SECRET),
        clientConfigured: client.configured,
      },
      scope: {
        tenantId,
        campaignId,
        channel,
      },
      flags,
      counts: {
        authorityRows: authorityCount?.count ?? 0,
        pendingOutbox: pendingOutbox?.count ?? 0,
        pendingDlq: dlqPending?.count ?? 0,
      },
      outboxByStatus,
      recentOutbox,
      authorities,
    });
  } catch (err) {
    console.error('[Admin] handleSkripDiagnostics error:', err);
    return serverError('Failed to load Skrip diagnostics');
  }
}

/**
 * POST /api/admin/outbound/skrip/dispatch
 *
 * Manually trigger an outbox dispatch sweep. Useful for operational catch-up
 * outside the cron schedule.
 *
 * Query params:
 *   batchSize  — max rows to process (default 25, max 100)
 *   preview    — if 'true', return what would be dispatched without sending
 */
export async function handleSkripDispatchTrigger(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const rawSize = parseInt(url.searchParams.get('batchSize') ?? '25', 10);
    const batchSize = Number.isFinite(rawSize) ? Math.min(Math.max(rawSize, 1), 100) : 25;
    const preview = url.searchParams.get('preview') === 'true';

    const result = await runDispatcherSweep(env, { batchSize, dryRunOnly: preview });

    return ok({
      preview,
      batchSize,
      ...result,
    });
  } catch (err) {
    console.error('[Admin] handleSkripDispatchTrigger error:', err);
    return serverError('Failed to run Skrip dispatch sweep');
  }
}

/**
 * POST /api/admin/outbound/skrip/reconcile
 *
 * Trigger a reconciliation pass for contact_channel_identities rows that are
 * still in registration_state='pending' (Skrip was down during original capture).
 *
 * Query params:
 *   batchSize  — max rows to reconcile (default 50, max 200)
 */
export async function handleSkripReconcileTrigger(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const rawSize = parseInt(url.searchParams.get('batchSize') ?? '50', 10);
    const batchSize = Number.isFinite(rawSize) ? Math.min(Math.max(rawSize, 1), 200) : 50;

    const result = await reconcilePendingIdentities(env, batchSize);

    return ok({ batchSize, ...result });
  } catch (err) {
    console.error('[Admin] handleSkripReconcileTrigger error:', err);
    return serverError('Failed to run Skrip reconciliation');
  }
}

/**
 * GET /api/admin/outbound/skrip/lineage
 *
 * Return recent message lineage rows for a given tenant/campaign.
 *
 * Query params:
 *   tenantId   — required
 *   campaignId — optional filter
 *   channel    — optional filter
 *   limit      — max rows (default 50, max 200)
 */
export async function handleSkripLineage(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const tenantId = url.searchParams.get('tenantId') ?? 'default';
    const campaignId = url.searchParams.get('campaignId');
    const channel = url.searchParams.get('channel');
    const rawLimit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;

    const conditions: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (campaignId) { conditions.push('campaign_id = ?'); params.push(campaignId); }
    if (channel)    { conditions.push('channel = ?');     params.push(channel); }
    params.push(limit);

    const rows = await query<{
      id: number;
      campaign_id: string;
      step_id: string;
      contact_id: string;
      channel: string;
      message_id: string;
      latest_status: string;
      first_sent_at: number | null;
      last_outcome_at: number | null;
      created_at: number;
    }>(
      env.DB,
      `SELECT id, campaign_id, step_id, contact_id, channel, message_id, latest_status,
              first_sent_at, last_outcome_at, created_at
         FROM channel_message_lineage
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ?`,
      params,
    );

    return ok({ tenantId, campaignId, channel, total: rows.length, rows });
  } catch (err) {
    console.error('[Admin] handleSkripLineage error:', err);
    return serverError('Failed to load Skrip lineage');
  }
}

/**
 * POST /api/admin/push/send
 *
 * Directly enqueue a push notification for a specific contact without
 * requiring a scheduled email campaign step. Useful for:
 *   - Product lifecycle events (report ready, weekly digest, trial expiry)
 *   - Admin-initiated ad-hoc pushes
 *   - Testing the full Skrip send path against a real contact
 *
 * The call stages a row in channel_execution_outbox which the next cron
 * (or POST /api/admin/outbound/skrip/dispatch) will send via Skrip.
 *
 * Body (JSON):
 *   contactId   — required; externalContactId that has a registered push identity
 *   campaignId  — required; logical campaign / notification type slug
 *   stepId      — required; step identifier for deduplication (idempotency key)
 *   tenantId    — optional; defaults to 'default'
 *   scheduleAt  — optional; unix epoch seconds, defaults to now (immediate)
 *   context     — optional; arbitrary key-value pairs forwarded to Skrip as message context
 */
export async function handleAdminPushSend(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: {
    contactId?: unknown;
    campaignId?: unknown;
    stepId?: unknown;
    tenantId?: unknown;
    scheduleAt?: unknown;
    context?: unknown;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return badRequest('Invalid JSON body');
  }

  if (!body.contactId || typeof body.contactId !== 'string') {
    return badRequest('contactId is required and must be a string');
  }
  if (!body.campaignId || typeof body.campaignId !== 'string') {
    return badRequest('campaignId is required and must be a string');
  }
  if (!body.stepId || typeof body.stepId !== 'string') {
    return badRequest('stepId is required and must be a string');
  }

  const tenantId = typeof body.tenantId === 'string' ? body.tenantId : undefined;
  const scheduleAt =
    typeof body.scheduleAt === 'number' && body.scheduleAt > 0 ? body.scheduleAt : now();
  const context =
    body.context && typeof body.context === 'object' && !Array.isArray(body.context)
      ? (body.context as Record<string, unknown>)
      : {};

  try {
    const enqueued = await enqueueEligibleSkripChannels(env, {
      tenantId,
      campaignId: body.campaignId,
      stepId: body.stepId,
      contactId: body.contactId,
      context,
      scheduleAt,
    });

    if (enqueued.length === 0) {
      return ok({
        message: 'No eligible Skrip channels found for this contact',
        hint: 'Ensure the contact has a registered push identity, consent is opted_in, and channel_authorities has an enabled row for this campaign/channel.',
        enqueued: [],
      });
    }

    const staged = enqueued.filter((e) => e.status !== 'dry_run');
    const dryRun = enqueued.filter((e) => e.status === 'dry_run');

    return created({
      message: `${staged.length} channel(s) staged for dispatch, ${dryRun.length} dry-run`,
      enqueued,
    });
  } catch (err) {
    console.error('[Admin] handleAdminPushSend error:', err);
    return serverError('Failed to enqueue push notification');
  }
}

/**
 * GET /api/admin/outbound/skrip/attribution
 *
 * Multi-channel attribution dashboard.
 * Compares delivery / engagement rates across push, SMS, WhatsApp, and Telegram
 * versus the email baseline drawn from email_sends.
 *
 * Query params:
 *   tenantId   — default 'default'
 *   campaignId — optional filter
 *   since      — ISO 8601 date (default: 30 days ago)
 */
export async function handleSkripAttribution(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const tenantId = url.searchParams.get('tenantId') ?? 'default';
    const campaignId = url.searchParams.get('campaignId');
    const rawSince = url.searchParams.get('since');
    const sinceTs = rawSince
      ? Math.floor(new Date(rawSince).getTime() / 1000)
      : now() - 30 * 24 * 3600;

    if (Number.isNaN(sinceTs)) {
      return badRequest('Invalid since date');
    }

    // ── Skrip channel lineage breakdown ────────────────────────────────────
    const channelConditions: string[] = ['tenant_id = ?', 'first_sent_at >= ?'];
    const channelParams: unknown[] = [tenantId, sinceTs];
    if (campaignId) { channelConditions.push('campaign_id = ?'); channelParams.push(campaignId); }

    const lineageBreakdown = await query<{
      channel: string;
      latest_status: string;
      count: number;
    }>(
      env.DB,
      `SELECT channel, latest_status, COUNT(*) AS count
         FROM channel_message_lineage
        WHERE ${channelConditions.join(' AND ')}
        GROUP BY channel, latest_status
        ORDER BY channel, count DESC`,
      channelParams,
    );

    // ── Email baseline from email_sends ────────────────────────────────────
    const emailBaselineConditions: string[] = ['scheduled_at >= ?'];
    const emailBaselineParams: unknown[] = [sinceTs];

    const emailBreakdown = await query<{
      status: string;
      count: number;
    }>(
      env.DB,
      `SELECT status, COUNT(*) AS count
         FROM email_sends
        WHERE ${emailBaselineConditions.join(' AND ')}
        GROUP BY status
        ORDER BY count DESC`,
      emailBaselineParams,
    );

    // ── Aggregate per-channel metrics ──────────────────────────────────────
    const channelStats: Record<string, Record<string, number>> = {};
    for (const row of lineageBreakdown) {
      if (!channelStats[row.channel]) channelStats[row.channel] = {};
      channelStats[row.channel][row.latest_status] = row.count;
    }

    const emailStats: Record<string, number> = {};
    for (const row of emailBreakdown) {
      emailStats[row.status] = row.count;
    }

    // ── Compute summary rates ──────────────────────────────────────────────
    function computeRate(stats: Record<string, number>, numeratorKey: string, denominatorKey: string): number | null {
      const num = stats[numeratorKey] ?? 0;
      const den = stats[denominatorKey] ?? 0;
      if (den === 0) return null;
      return Math.round((num / den) * 10000) / 100; // percent, 2 dp
    }

    const channelSummary: Record<string, { delivered: number | null; failed: number | null; total: number }> = {};
    for (const [ch, stats] of Object.entries(channelStats)) {
      const total = Object.values(stats).reduce((a, b) => a + b, 0);
      channelSummary[ch] = {
        delivered: computeRate(stats, 'delivered', 'sent') ?? computeRate(stats, 'delivered', 'dispatched'),
        failed: computeRate(stats, 'failed', 'sent') ?? computeRate(stats, 'failed', 'dispatched'),
        total,
      };
    }

    const emailTotal = Object.values(emailStats).reduce((a, b) => a + b, 0);
    const emailSummary = {
      sent: emailStats['sent'] ?? 0,
      failed: emailStats['failed'] ?? 0,
      scheduled: emailStats['scheduled'] ?? 0,
      total: emailTotal,
      deliveryRate: emailTotal > 0 ? Math.round(((emailStats['sent'] ?? 0) / emailTotal) * 10000) / 100 : null,
    };

    return ok({
      scope: { tenantId, campaignId, sinceTs, sinceIso: new Date(sinceTs * 1000).toISOString() },
      email: { breakdown: emailBreakdown, summary: emailSummary },
      channels: { breakdown: lineageBreakdown, summary: channelSummary },
    });
  } catch (err) {
    console.error('[Admin] handleSkripAttribution error:', err);
    return serverError('Failed to load Skrip attribution data');
  }
}
