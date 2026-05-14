/**
 * Webhook Handlers
 *
 * Processes inbound webhooks from email service providers for
 * deliverability tracking: bounces, complaints, unsubscribes, opens, clicks.
 *
 *   POST /webhooks/brevo  — Brevo (Sendinblue) transactional webhooks
 *
 * Brevo webhook payload reference:
 *   https://developers.brevo.com/docs/how-to-use-webhooks
 *
 * @module routes/webhooks
 */

import type { Env } from '../types';
import { ok, badRequest, serverError, unauthorized } from '../lib/response';
import { execute, now, query, queryOne } from '../lib/db';
import { recordVariantEngagement, incrementCampaignMetric } from '../lib/email';
import { upsertGrowthSignal } from '../lib/growth/signals';
import { ensureWebhookAccess, accessDenied } from '../lib/access';
import { logEvent } from '../lib/observability';
import { emitTelemetryEvent } from '../lib/telemetry';
import { addSuppression } from '../lib/suppression';
import {
  KV_UNSUBSCRIBE_PREFIX,
  TTL,
  SECONDS_PER_DAY,
  MESSAGES,
  KV_PREFIX,
  COMPLIANCE,
  EVENT_TYPES,
  EMAIL_STATUS,
  GROWTH_SIGNAL_SEVERITY,
  GROWTH_SIGNAL_TYPE,
  GROWTH_SUBJECT_TYPE,
} from '../constants';

// ─── Brevo Event Types ──────────────────────────────────────────────────────

type BrevoEventType =
  | 'delivered'
  | 'request'
  | 'hard_bounce'
  | 'soft_bounce'
  | 'blocked'
  | 'spam'
  | 'invalid_email'
  | 'unsubscribed'
  | 'opened'
  | 'click'
  | 'reply'
  | 'error';

interface BrevoWebhookPayload {
  event: BrevoEventType;
  email: string;
  /** ISO 8601 timestamp */
  date?: string;
  /** Message ID from Brevo */
  'message-id'?: string;
  /** Bounce sub-type / reason */
  reason?: string;
  /** Subject line of the email */
  subject?: string;
  /** Link clicked (for click events) */
  link?: string;
  /** Tag (campaign identifier) */
  tag?: string;
  /** Additional bounce details */
  ts_event?: number;
}

const RETARGET_ACCELERATION_SECONDS = Object.freeze({
  opened: SECONDS_PER_DAY,
  click: 12 * 3600,
});

// ─── KV Keys ────────────────────────────────────────────────────────────────

// KV prefixes are centralised in constants.ts — use KV_PREFIX.OUTBOUND_*

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * POST /webhooks/brevo
 *
 * Processes Brevo webhook events. Key actions:
 *   - hard_bounce / invalid_email → permanent suppress (unsubscribe + cancel sends)
 *   - soft_bounce → log, auto-suppress after 3 within 7 days
 *   - spam (complaint) → permanent suppress + flag for auto-pause check
 *   - unsubscribed → permanent suppress
 *   - delivered / opened / click → track for deliverability metrics
 */
export async function handleBrevoWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const webhookAccess = ensureWebhookAccess(request, env);
  if (!webhookAccess.ok) {
    await logEvent(env, 'webhook.denied', {
      lane: webhookAccess.lane,
      reason: webhookAccess.error ?? 'unauthorized',
    }, 'warn');
    return accessDenied(webhookAccess);
  }

  let rawBody = '';
  try {
    rawBody = await request.text();
  } catch {
    return badRequest(MESSAGES.errors.invalidWebhookPayload);
  }

  const signatureCheck = await verifyWebhookSignature(request, env, rawBody);
  if (signatureCheck) {
    await logEvent(env, 'webhook.denied.signature', {
      status: signatureCheck.status,
    }, 'warn');
    return signatureCheck;
  }

  let payload: BrevoWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as BrevoWebhookPayload;
  } catch {
    return badRequest(MESSAGES.errors.invalidWebhookPayload);
  }

  const { event, email } = payload;
  if (!event || !email) {
    return badRequest(MESSAGES.errors.missingWebhookFields);
  }

  const emailLower = email.trim().toLowerCase();
  const ts = payload.ts_event ?? Math.floor(Date.now() / 1000);

  // Extract our send-id from the Brevo tag ("send:<id>") we attach at send-time.
  // Brevo surfaces the first tag in `payload.tag`. Other tags (e.g. "tpl:...")
  // are ignored here.
  const correlation: { sendId?: number | null; providerMessageId?: string | null; localMessageId?: string | null } = {
    sendId: null,
    providerMessageId: payload['message-id'] ?? null,
    localMessageId: null,
  };
  if (typeof payload.tag === 'string' && payload.tag.startsWith('send:')) {
    const n = Number.parseInt(payload.tag.slice(5), 10);
    if (Number.isFinite(n) && n > 0) correlation.sendId = n;
  } else if (typeof payload.tag === 'string' && payload.tag.startsWith('msg:')) {
    const localMessageId = payload.tag.slice(4).trim();
    if (localMessageId.length > 0) correlation.localMessageId = localMessageId;
  }

  const resolvedLineage = await resolveEmailSendLineage(env, emailLower, correlation);

  try {
    switch (event) {
      case 'hard_bounce':
      case 'invalid_email':
        await handlePermanentBounce(env, emailLower, event, payload.reason);
        break;

      case 'soft_bounce':
        await handleSoftBounce(env, emailLower, payload.reason);
        break;

      case 'spam':
        await handleComplaint(env, emailLower);
        break;

      case 'unsubscribed':
        await handleProviderUnsubscribe(env, emailLower);
        break;

      case 'delivered':
      case 'opened':
      case 'click':
        await trackPositiveEvent(env, emailLower, event, ts, correlation, resolvedLineage);
        break;

      case 'blocked':
        // Blocked = temporary suppression by Brevo, log but don't suppress
        console.log(`[Webhook:Brevo] Blocked: ${emailLower} — ${payload.reason}`);
        break;

      default:
        console.log(`[Webhook:Brevo] Unknown event: ${event} for ${emailLower}`);
    }

    // Update daily deliverability counters for auto-pause checks
    await incrementDeliverabilityCounter(env, event);

    // Increment campaign-level aggregate metrics (P0: metrics were never counted)
    await incrementCampaignMetricFromWebhook(env, event).catch((err) => {
      console.warn(`[Webhook:Brevo] campaign metric increment error:`, err);
    });

    // Sync channel_attempts table with Brevo delivery outcome
    await syncChannelAttemptStatus(env, emailLower, event).catch((err) => {
      console.error(`[Webhook:Brevo] channel_attempts sync error for ${emailLower}:`, err);
    });

    await logEvent(env, 'webhook.processed', {
      provider: 'brevo',
      event,
      email: emailLower,
    });

    // Emit reverse tracking event to analytics (non-blocking)
    emitTrackingEvent(env, event, emailLower, payload, correlation, resolvedLineage).catch(() => {
      /* best-effort — analytics binding may be unavailable */
    });

    return ok({ processed: true, event, email: emailLower });
  } catch (err) {
    console.error(`[Webhook:Brevo] Error processing ${event} for ${emailLower}:`, err);
    await logEvent(env, 'webhook.error', {
      provider: 'brevo',
      event,
      email: emailLower,
      error: err instanceof Error ? err.message : String(err),
    }, 'error');
    return serverError(MESSAGES.errors.internalError);
  }
}

// ─── Event Processors ───────────────────────────────────────────────────────

/**
 * Hard bounce / invalid email → permanently suppress the address.
 * - Sets KV unsubscribe flag  
 * - Cancels all scheduled sends  
 * - Logs the bounce reason for diagnostics  
 */
async function handlePermanentBounce(
  env: Env,
  email: string,
  type: string,
  reason?: string
): Promise<void> {
  console.log(`[Webhook:Brevo] ${type}: ${email} — ${reason ?? 'no reason'}`);

  // Suppress permanently
  await env.KV_MARKETING.put(`${KV_UNSUBSCRIBE_PREFIX}${email}`, '1', {
    expirationTtl: COMPLIANCE.PERMANENT_SUPPRESS_TTL,
  });

  // Persist to D1 suppression_list (survives KV TTL expiry)
  await addSuppression(env.DB, email, type === 'invalid_email' ? 'hard_bounce' : 'hard_bounce', 'brevo_webhook', { reason: reason ?? 'unknown' });

  // Store bounce record for diagnostics
  await env.KV_MARKETING.put(`${KV_PREFIX.OUTBOUND_BOUNCE}${email}`, JSON.stringify({
    type,
    reason: reason ?? 'unknown',
    ts: Math.floor(Date.now() / 1000),
    permanent: true,
  }), { expirationTtl: TTL.DAYS_90 });

  // Cancel all future sends
  await execute(
    env.DB,
    `UPDATE email_sends SET status = ? WHERE contact_email = ? AND status = ?`,
    [EMAIL_STATUS.CANCELLED, email, EMAIL_STATUS.SCHEDULED]
  );

  await execute(
    env.DB,
    `UPDATE marketing_contacts
        SET email_bounce_type = 'permanent',
            updated_at = ?
      WHERE email = ?`,
    [now(), email],
  );
}

/**
 * Soft bounce → log, auto-suppress after 3 occurrences within 7 days.
 */
async function handleSoftBounce(
  env: Env,
  email: string,
  reason?: string
): Promise<void> {
  console.log(`[Webhook:Brevo] soft_bounce: ${email} — ${reason ?? 'no reason'}`);

  await execute(
    env.DB,
    `UPDATE marketing_contacts
        SET email_bounce_type = 'transient',
            updated_at = ?
      WHERE email = ?`,
    [now(), email],
  );

  const key = `${KV_PREFIX.OUTBOUND_BOUNCE}soft:${email}`;
  const existing = await env.KV_MARKETING.get(key);
  const bounces: number[] = existing ? JSON.parse(existing) : [];

  const currentTs = Math.floor(Date.now() / 1000);
  const windowStart = currentTs - COMPLIANCE.SOFT_BOUNCE_WINDOW;

  // Keep only bounces within the compliance window
  const recent = bounces.filter((ts: number) => ts > windowStart);
  recent.push(currentTs);

  if (recent.length >= COMPLIANCE.SOFT_BOUNCE_THRESHOLD) {
    // Auto-suppress after threshold soft bounces in window
    console.log(`[Webhook:Brevo] Auto-suppressing ${email} after ${recent.length} soft bounces`);
    await handlePermanentBounce(env, email, 'soft_bounce_repeated', reason);
    await env.KV_MARKETING.delete(key);
  } else {
    await env.KV_MARKETING.put(key, JSON.stringify(recent), {
      expirationTtl: COMPLIANCE.SOFT_BOUNCE_WINDOW,
    });
  }
}

/**
 * Spam complaint → permanent suppress + flag for auto-pause evaluation.
 */
async function handleComplaint(env: Env, email: string): Promise<void> {
  console.log(`[Webhook:Brevo] SPAM COMPLAINT: ${email}`);

  // Permanent suppress
  await env.KV_MARKETING.put(`${KV_UNSUBSCRIBE_PREFIX}${email}`, '1', {
    expirationTtl: COMPLIANCE.PERMANENT_SUPPRESS_TTL,
  });

  // Persist to D1 suppression_list (survives KV TTL expiry)
  await addSuppression(env.DB, email, 'spam_complaint', 'brevo_webhook');

  // Cancel all future sends
  await execute(
    env.DB,
    `UPDATE email_sends SET status = ? WHERE contact_email = ? AND status = ?`,
    [EMAIL_STATUS.CANCELLED, email, EMAIL_STATUS.SCHEDULED]
  );

  await execute(
    env.DB,
    `UPDATE marketing_contacts
        SET email_bounce_type = 'permanent',
            updated_at = ?
      WHERE email = ?`,
    [now(), email],
  );

  // Store complaint for threshold checking
  await env.KV_MARKETING.put(`${KV_PREFIX.OUTBOUND_BOUNCE}complaint:${email}`, JSON.stringify({
    ts: Math.floor(Date.now() / 1000),
  }), { expirationTtl: TTL.DAYS_90 });
}

/**
 * Provider-level unsubscribe (List-Unsubscribe header clicked).
 */
async function handleProviderUnsubscribe(env: Env, email: string): Promise<void> {
  console.log(`[Webhook:Brevo] Unsubscribed via provider: ${email}`);

  await env.KV_MARKETING.put(`${KV_UNSUBSCRIBE_PREFIX}${email}`, '1', {
    expirationTtl: COMPLIANCE.PERMANENT_SUPPRESS_TTL,
  });

  // Persist to D1 suppression_list (survives KV TTL expiry)
  await addSuppression(env.DB, email, 'unsubscribed', 'brevo_webhook');

  await execute(
    env.DB,
    `UPDATE email_sends SET status = ? WHERE contact_email = ? AND status = ?`,
    [EMAIL_STATUS.CANCELLED, email, EMAIL_STATUS.SCHEDULED]
  );
}

interface ResolvedEmailLineage {
  id: number;
  sequence_id: number;
  trigger_event: string | null;
  template_key: string;
  subject_variant_idx: number | null;
  body_variant_idx: number | null;
  framing_tier: string | null;
  sent_at: number | null;
  message_id: string | null;
  brevo_message_id: string | null;
}

async function resolveEmailSendLineage(
  env: Env,
  email: string,
  correlation?: { sendId?: number | null; providerMessageId?: string | null; localMessageId?: string | null },
): Promise<ResolvedEmailLineage | null> {
  const baseSql =
    `SELECT es.id, es.sequence_id, seq.trigger_event, est.template_key,
            es.subject_variant_idx, es.body_variant_idx, es.framing_tier,
            es.sent_at, es.message_id, es.brevo_message_id
       FROM email_sends es
       JOIN email_steps est ON est.id = es.step_id
       JOIN email_sequences seq ON seq.id = es.sequence_id`;

  if (correlation?.sendId) {
    const bySendId = await queryOne<ResolvedEmailLineage>(
      env.DB,
      `${baseSql} WHERE es.id = ? AND es.contact_email = ? LIMIT 1`,
      [correlation.sendId, email],
    );
    if (bySendId) return bySendId;
  }

  if (correlation?.localMessageId) {
    const byLocalMessage = await queryOne<ResolvedEmailLineage>(
      env.DB,
      `${baseSql} WHERE es.message_id = ? LIMIT 1`,
      [correlation.localMessageId],
    );
    if (byLocalMessage) return byLocalMessage;
  }

  if (correlation?.providerMessageId) {
    const byProviderMessage = await queryOne<ResolvedEmailLineage>(
      env.DB,
      `${baseSql} WHERE es.brevo_message_id = ? LIMIT 1`,
      [correlation.providerMessageId],
    );
    if (byProviderMessage) return byProviderMessage;
  }

  const mostRecent = await queryOne<ResolvedEmailLineage>(
    env.DB,
    `${baseSql}
      WHERE es.contact_email = ?
        AND es.status = 'sent'
      ORDER BY es.sent_at DESC
      LIMIT 1`,
    [email],
  );

  return mostRecent ?? null;
}

/**
 * Track positive deliverability signals (delivered, opened, click).
 * For opens/clicks, also:
 *   - UPDATE the matching email_sends row (opened_at / clicked_at / counters)
 *     so the admin dashboard can segment engagement by step / variant /
 *     capability hook without scanning KV.
 *   - call recordVariantEngagement so future sends favour winning variants.
 *
 * Correlation precedence (most → least reliable):
 *   1. payload.tag = "send:<id>"          — threaded by provider.ts on send
 *   2. payload['message-id'] matches      brevo_message_id column
 *   3. most recent sent row for the email (legacy path)
 */
async function trackPositiveEvent(
  env: Env,
  email: string,
  event: string,
  ts: number,
  correlation?: { sendId?: number | null; providerMessageId?: string | null; localMessageId?: string | null },
  preResolvedLineage?: ResolvedEmailLineage | null,
): Promise<void> {
  // Store last engagement for the contact (useful for re-engagement logic)
  const key = `${KV_PREFIX.OUTBOUND_ENGAGEMENT}${email}`;
  const existing = await env.KV_MARKETING.get(key);
  const data = existing ? JSON.parse(existing) : {};

  data[event] = ts;
  data.lastActivity = ts;

  await env.KV_MARKETING.put(key, JSON.stringify(data), {
    expirationTtl: TTL.DAYS_90,
  });

  if (event !== 'opened' && event !== 'click') {
    return;
  }

  const send = preResolvedLineage ?? await resolveEmailSendLineage(env, email, correlation);

  if (!send) {
    return; // No row to credit — likely an old contact from before persistence was wired.
  }

  // ── Persist per-send engagement onto email_sends (authoritative source) ──
  try {
    if (event === 'opened') {
      await execute(
        env.DB,
        `UPDATE email_sends
            SET opened_at = COALESCE(opened_at, ?),
                open_count = open_count + 1
          WHERE id = ?`,
        [ts, send.id],
      );

      await execute(
        env.DB,
        `UPDATE marketing_contacts
            SET email_opened_at = COALESCE(email_opened_at, ?),
                last_engaged_at = CASE
                  WHEN last_engaged_at IS NULL THEN ?
                  ELSE MAX(last_engaged_at, ?)
                END,
                status = CASE WHEN status = 'prospect' THEN 'engaged' ELSE status END,
                updated_at = ?
          WHERE email = ?`,
        [ts, ts, ts, now(), email],
      );
    } else {
      await execute(
        env.DB,
        `UPDATE email_sends
            SET clicked_at = COALESCE(clicked_at, ?),
                click_count = click_count + 1,
                opened_at = COALESCE(opened_at, ?)
          WHERE id = ?`,
        [ts, ts, send.id],
      );

      await execute(
        env.DB,
        `UPDATE marketing_contacts
            SET email_opened_at = COALESCE(email_opened_at, ?),
                last_engaged_at = CASE
                  WHEN last_engaged_at IS NULL THEN ?
                  ELSE MAX(last_engaged_at, ?)
                END,
                status = CASE WHEN status = 'prospect' THEN 'engaged' ELSE status END,
                updated_at = ?
          WHERE email = ?`,
        [ts, ts, ts, now(), email],
      );
    }
  } catch (err) {
    console.warn(`[Webhook:Brevo] email_sends engagement update failed for ${send.id}:`, err);
  }

  // P5: tighten cadence for engaged outbound contacts and expose engagement
  // flags to template context (step3 retarget copy reads _hasOpened).
  const isOutbound = typeof send.trigger_event === 'string' && send.trigger_event.startsWith('outbound.');
  if (isOutbound) {
    if (event === 'click') {
      await upsertGrowthSignal(env, {
        subjectType: GROWTH_SUBJECT_TYPE.CONTACT,
        subjectId: email,
        signalType: GROWTH_SIGNAL_TYPE.COLD_CLICKED_NO_REPLY,
        severity: GROWTH_SIGNAL_SEVERITY.HIGH,
        confidence: 84,
        sourceEventId: correlation?.providerMessageId ?? correlation?.localMessageId ?? send.message_id ?? `email_send_${send.id}`,
        evidence: { provider: 'brevo', sendId: send.id, sequenceId: send.sequence_id, templateKey: send.template_key },
      }).catch(() => { /* Non-critical growth signal projection. */ });
    }

    await markEngagementContext(env, email, send.sequence_id, event).catch(() => {
      // Non-critical best effort.
    });

    const tightenBy = event === 'click'
      ? RETARGET_ACCELERATION_SECONDS.click
      : RETARGET_ACCELERATION_SECONDS.opened;
    const nextAt = ts + tightenBy;
    await execute(
      env.DB,
      `UPDATE email_sends
          SET scheduled_at = CASE WHEN scheduled_at > ? THEN ? ELSE scheduled_at END
        WHERE contact_email = ?
          AND sequence_id = ?
          AND status = ?
          AND scheduled_at > ?`,
      [nextAt, nextAt, email, send.sequence_id, EMAIL_STATUS.SCHEDULED, ts],
    ).catch(() => {
      // Non-critical best effort.
    });
  }

  // ── A/B variant tracking — prefer indices stored on the row (set at send
  //    time by email.ts), fall back to KV correlator for legacy rows. ──
  try {
    const abEvent = event === 'click' ? 'click' : 'open';
    let subIdx: number | null = send.subject_variant_idx;
    let bodyIdx: number | null = send.body_variant_idx;
    let templateKey: string = send.template_key;
    let tier: string | null = send.framing_tier;

    if (subIdx == null && bodyIdx == null) {
      const abRaw = await env.KV_MARKETING.get(`${KV_PREFIX.AB_SEND}${email}:${send.id}`);
      if (abRaw) {
        const abData = JSON.parse(abRaw) as {
          templateKey: string;
          subIdx?: number;
          bodyIdx?: number;
          tier?: string | null;
        };
        if (typeof abData.subIdx === 'number') subIdx = abData.subIdx;
        if (typeof abData.bodyIdx === 'number') bodyIdx = abData.bodyIdx;
        if (abData.templateKey) templateKey = abData.templateKey;
        if (typeof abData.tier === 'string' && !tier) tier = abData.tier;
      }
    }

    if (typeof subIdx === 'number') {
      await recordVariantEngagement(env.KV_MARKETING, templateKey, 'subject', subIdx, abEvent, tier);
    }
    if (typeof bodyIdx === 'number') {
      await recordVariantEngagement(env.KV_MARKETING, templateKey, 'body', bodyIdx, abEvent, tier);
    }
  } catch {
    // Non-critical — A/B tracking failure shouldn't block webhook processing
  }
}

async function markEngagementContext(
  env: Env,
  email: string,
  sequenceId: number,
  event: 'opened' | 'click',
): Promise<void> {
  const keys = [
    `${KV_PREFIX.EMAIL_CONTEXT}${email}:cold-outreach`,
    `${KV_PREFIX.EMAIL_CONTEXT}${email}:${sequenceId}`,
  ];

  for (const key of keys) {
    const raw = await env.KV_MARKETING.get(key);
    const existing = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    existing._hasOpened = true;
    if (event === 'click') {
      existing._hasClicked = true;
    }
    await env.KV_MARKETING.put(key, JSON.stringify(existing), { expirationTtl: TTL.DAYS_90 });
  }
}

// ─── Deliverability Counters ────────────────────────────────────────────────

/**
 * Increment daily counters for deliverability threshold monitoring.
 * Key: outbound:deliverability:YYYY-MM-DD
 * Value: JSON { delivered, bounced, complained, opened, clicked }
 */
async function incrementDeliverabilityCounter(
  env: Env,
  event: BrevoEventType
): Promise<void> {
  const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `${KV_PREFIX.OUTBOUND_DELIVERABILITY}${dateKey}`;

  const existing = await env.KV_MARKETING.get(key);
  const counters = existing ? JSON.parse(existing) : {
    delivered: 0,
    bounced: 0,
    complained: 0,
    opened: 0,
    clicked: 0,
  };

  switch (event) {
    case 'delivered':
      counters.delivered++;
      break;
    case 'hard_bounce':
    case 'soft_bounce':
    case 'invalid_email':
      counters.bounced++;
      break;
    case 'spam':
      counters.complained++;
      break;
    case 'opened':
      counters.opened++;
      break;
    case 'click':
      counters.clicked++;
      break;
  }

  await env.KV_MARKETING.put(key, JSON.stringify(counters), {
    expirationTtl: COMPLIANCE.DELIVERABILITY_RETENTION,
  });
}

/**
 * Resolve the active campaign slug for metric attribution.
 * Cached in-memory for the duration of the request.
 */
let _cachedCampaignSlug: string | null = null;
async function getActiveCampaignSlug(env: Env): Promise<string | null> {
  if (_cachedCampaignSlug !== null) return _cachedCampaignSlug;
  try {
    const row = await queryOne<{ slug: string }>(
      env.DB,
      `SELECT slug FROM outbound_campaigns WHERE status IN ('active', 'paused') ORDER BY started_at DESC LIMIT 1`,
    );
    _cachedCampaignSlug = row?.slug ?? null;
  } catch {
    _cachedCampaignSlug = null;
  }
  return _cachedCampaignSlug;
}

/**
 * Increment the appropriate campaign metric based on a Brevo webhook event.
 * Best-effort — never blocks the webhook response.
 */
async function incrementCampaignMetricFromWebhook(
  env: Env,
  event: BrevoEventType,
): Promise<void> {
  const metricMap: Partial<Record<BrevoEventType, 'total_opened' | 'total_clicked' | 'total_bounced' | 'total_unsub'>> = {
    opened: 'total_opened',
    click: 'total_clicked',
    hard_bounce: 'total_bounced',
    soft_bounce: 'total_bounced',
    invalid_email: 'total_bounced',
    spam: 'total_unsub',
    unsubscribed: 'total_unsub',
  };
  const metric = metricMap[event];
  if (!metric) return;
  const slug = await getActiveCampaignSlug(env);
  if (!slug) return;
  await incrementCampaignMetric(env.DB, slug, metric);
}

/**
 * Get deliverability metrics for a given date.
 * Used by the auto-pause system to check thresholds.
 */
export async function getDeliverabilityMetrics(
  kv: { get(key: string): Promise<string | null> },
  dateKey?: string
): Promise<{
  delivered: number;
  bounced: number;
  complained: number;
  opened: number;
  clicked: number;
  bounceRate: number;
  complaintRate: number;
}> {
  const key = `${KV_PREFIX.OUTBOUND_DELIVERABILITY}${dateKey ?? new Date().toISOString().slice(0, 10)}`;
  const existing = await kv.get(key);
  const counters = existing ? JSON.parse(existing) : {
    delivered: 0,
    bounced: 0,
    complained: 0,
    opened: 0,
    clicked: 0,
  };

  const totalSent = counters.delivered + counters.bounced;
  return {
    ...counters,
    bounceRate: totalSent > 0 ? counters.bounced / totalSent : 0,
    complaintRate: totalSent > 0 ? counters.complained / totalSent : 0,
  };
}

// ─── Reverse Event Emission (Marketing → Analytics) ─────────────────────────

/** Map Brevo event names → outbound tracking event types. */
const BREVO_TO_OUTBOUND: Record<string, string> = {
  delivered: EVENT_TYPES.OUTBOUND_EMAIL_SENT,
  hard_bounce: EVENT_TYPES.OUTBOUND_EMAIL_BOUNCED,
  soft_bounce: EVENT_TYPES.OUTBOUND_EMAIL_BOUNCED,
  invalid_email: EVENT_TYPES.OUTBOUND_EMAIL_BOUNCED,
  spam: EVENT_TYPES.OUTBOUND_EMAIL_COMPLAINED,
  reply: EVENT_TYPES.OUTBOUND_EMAIL_REPLIED,
  unsubscribed: EVENT_TYPES.OUTBOUND_UNSUBSCRIBED,
  opened: EVENT_TYPES.OUTBOUND_EMAIL_OPENED,
  click: EVENT_TYPES.OUTBOUND_EMAIL_CLICKED,
};

async function resolveTelemetryTenantId(env: Env, email: string): Promise<string> {
  const identity = await queryOne<{ tenant_id: string }>(
    env.DB,
    `SELECT tenant_id
       FROM contact_channel_identities
      WHERE external_contact_id = ?
        AND channel = 'email'
      ORDER BY updated_at DESC
      LIMIT 1`,
    [email],
  );

  return identity?.tenant_id ?? 'default';
}

/**
 * Emit a reverse tracking event to the analytics worker via service binding.
 * Best-effort — failures are logged but never block the webhook response.
 */
async function emitTrackingEvent(
  env: Env,
  brevoEvent: string,
  email: string,
  payload: BrevoWebhookPayload,
  correlation?: { sendId?: number | null; providerMessageId?: string | null; localMessageId?: string | null },
  resolvedLineage?: ResolvedEmailLineage | null,
): Promise<void> {
  const eventType = BREVO_TO_OUTBOUND[brevoEvent];
  if (!eventType) return;

  const receiptTs = payload.ts_event ?? Math.floor(Date.now() / 1000);
  const sendTs = resolvedLineage?.sent_at ?? null;
  const localMessageId = resolvedLineage?.message_id
    ?? correlation?.localMessageId
    ?? correlation?.providerMessageId
    ?? `brevo:${email}:${receiptTs}`;
  const tenantId = await resolveTelemetryTenantId(env, email);
  const activeCampaignSlug = await getActiveCampaignSlug(env);
  const bounceType = brevoEvent === 'soft_bounce'
    ? 'transient'
    : brevoEvent === 'hard_bounce' || brevoEvent === 'invalid_email'
      ? 'permanent'
      : null;

  await emitTelemetryEvent(env, {
    type: eventType,
    tenantId,
    messageId: localMessageId,
    correlationId: localMessageId,
    channel: 'email',
    timestamp: receiptTs,
    sendTimestamp: sendTs,
    receiptTimestamp: receiptTs,
    prospectEmail: email,
    providerMessageId: correlation?.providerMessageId ?? resolvedLineage?.brevo_message_id ?? null,
    campaignId: activeCampaignSlug,
    stepId: resolvedLineage?.template_key ?? null,
    contactId: email,
    metadata: {
      brevoEvent,
      reason: payload.reason ?? null,
      link: payload.link ?? null,
      tag: payload.tag ?? null,
      sendId: correlation?.sendId ?? null,
      bounceType,
    },
  });

  const lineageStatus =
    brevoEvent === 'opened' ? 'message.opened'
      : brevoEvent === 'click' ? 'message.clicked'
        : brevoEvent === 'delivered' ? 'message.delivered'
          : brevoEvent === 'reply' ? 'message.replied'
            : brevoEvent === 'spam' ? 'message.complained'
              : brevoEvent === 'unsubscribed' ? 'message.unsubscribed'
                : brevoEvent === 'hard_bounce' || brevoEvent === 'soft_bounce' || brevoEvent === 'invalid_email'
                  ? 'message.bounced'
                  : null;

  if (!lineageStatus) return;

  const epoch = now();
  await execute(
    env.DB,
    `INSERT INTO channel_message_lineage
      (tenant_id, campaign_id, journey_id, step_id, contact_id, channel, message_id, skrip_outbound_id, provider_ref, idempotency_key, latest_status, first_sent_at, last_outcome_at, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 'email', ?, NULL, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       provider_ref = COALESCE(excluded.provider_ref, channel_message_lineage.provider_ref),
       latest_status = excluded.latest_status,
       first_sent_at = COALESCE(channel_message_lineage.first_sent_at, excluded.first_sent_at),
       last_outcome_at = excluded.last_outcome_at,
       updated_at = excluded.updated_at`,
    [
      tenantId,
      activeCampaignSlug ?? 'cold-outreach-v1',
      resolvedLineage?.template_key ?? 'brevo-webhook',
      email,
      localMessageId,
      correlation?.providerMessageId ?? resolvedLineage?.brevo_message_id ?? null,
      `email-webhook:${localMessageId}`,
      lineageStatus,
      sendTs,
      receiptTs,
      epoch,
      epoch,
    ],
  );
}

// ─── Channel Attempt Sync ───────────────────────────────────────────────────

// ─── Reply Detection ────────────────────────────────────────────────────────

/**
 * POST /webhooks/brevo/inbound
 *
 * Handles Brevo inbound parsing webhook for reply detection.
 * When a prospect replies to a cold outreach email, Brevo sends the
 * inbound email payload here. We use it to:
 *   1. Auto-pause the sequence for that contact (no more follow-ups)
 *   2. Update prospect status to 'engaged'
 *   3. Emit OUTBOUND_EMAIL_REPLIED event to analytics
 */
export async function handleBrevoInbound(
  request: Request,
  env: Env
): Promise<Response> {
  const webhookAccess = ensureWebhookAccess(request, env);
  if (!webhookAccess.ok) {
    return accessDenied(webhookAccess);
  }

  let rawBody = '';
  try {
    rawBody = await request.text();
  } catch {
    return badRequest(MESSAGES.errors.invalidWebhookPayload);
  }

  const signatureCheck = await verifyWebhookSignature(request, env, rawBody);
  if (signatureCheck) {
    return signatureCheck;
  }

  let payload: { From?: { Address?: string }; To?: { Address?: string }[]; Subject?: string; RawHtmlBody?: string; TextBody?: string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return badRequest(MESSAGES.errors.invalidWebhookPayload);
  }

  const fromEmail = payload.From?.Address?.trim().toLowerCase();
  if (!fromEmail) {
    return badRequest('Missing sender email in inbound payload');
  }

  console.log(`[Webhook:Inbound] Reply detected from ${fromEmail}`);

  // Guard: if contact is unsubscribed/suppressed, log but don't re-engage
  const isSuppressed = await env.KV_MARKETING.get(`${KV_UNSUBSCRIBE_PREFIX}${fromEmail}`);
  if (isSuppressed) {
    console.log(`[Webhook:Inbound] Suppressed contact replied: ${fromEmail} — skipping re-engagement`);
    return ok({ processed: true, action: 'suppressed_contact_replied', email: fromEmail });
  }

  try {
    // 1. Cancel all pending sends for this contact (auto-pause sequence)
    await execute(
      env.DB,
      `UPDATE email_sends SET status = ? WHERE contact_email = ? AND status = ?`,
      [EMAIL_STATUS.CANCELLED, fromEmail, EMAIL_STATUS.SCHEDULED]
    );

    // 2. Update marketing contact status to indicate engagement
    const engagedTs = Math.floor(Date.now() / 1000);
    await execute(
      env.DB,
      `UPDATE marketing_contacts
          SET status = 'engaged',
              last_engaged_at = CASE
                WHEN last_engaged_at IS NULL THEN ?
                ELSE MAX(last_engaged_at, ?)
              END,
              updated_at = ?
        WHERE email = ?`,
      [engagedTs, engagedTs, engagedTs, fromEmail]
    );

    // 3. Store reply metadata in KV for admin visibility
    await env.KV_MARKETING.put(
      `${KV_PREFIX.OUTBOUND_ENGAGEMENT}reply:${fromEmail}`,
      JSON.stringify({
        from: fromEmail,
        subject: payload.Subject ?? null,
        ts: Math.floor(Date.now() / 1000),
      }),
      { expirationTtl: TTL.DAYS_90 }
    );

    // 3b. A/B variant tracking — credit the variant that earned the reply (+10 weight),
    //     and stamp replied_at on the latest sent row for dashboard analytics.
    try {
      const rows = await query(
        env.DB,
        `SELECT es.id, est.template_key, es.subject_variant_idx, es.body_variant_idx, es.framing_tier
           FROM email_sends es
           JOIN email_steps est ON est.id = es.step_id
          WHERE es.contact_email = ? AND es.status = 'sent'
          ORDER BY es.sent_at DESC LIMIT 1`,
        [fromEmail]
      );
      const send = rows?.[0] as {
        id: number;
        template_key: string;
        subject_variant_idx: number | null;
        body_variant_idx: number | null;
        framing_tier: string | null;
      } | undefined;
      if (send) {
        await execute(
          env.DB,
          `UPDATE email_sends SET replied_at = COALESCE(replied_at, ?) WHERE id = ?`,
          [Math.floor(Date.now() / 1000), send.id],
        ).catch(() => { /* non-critical */ });

        let subIdx: number | null = send.subject_variant_idx;
        let bodyIdx: number | null = send.body_variant_idx;
        let templateKey: string = send.template_key;
        let tier: string | null = send.framing_tier;
        if (subIdx == null && bodyIdx == null) {
          const abRaw = await env.KV_MARKETING.get(`${KV_PREFIX.AB_SEND}${fromEmail}:${send.id}`);
          if (abRaw) {
            const abData = JSON.parse(abRaw) as {
              templateKey: string;
              subIdx?: number;
              bodyIdx?: number;
              tier?: string | null;
            };
            if (typeof abData.subIdx === 'number') subIdx = abData.subIdx;
            if (typeof abData.bodyIdx === 'number') bodyIdx = abData.bodyIdx;
            if (abData.templateKey) templateKey = abData.templateKey;
            if (typeof abData.tier === 'string' && !tier) tier = abData.tier;
          }
        }
        if (typeof subIdx === 'number') {
          await recordVariantEngagement(env.KV_MARKETING, templateKey, 'subject', subIdx, 'reply', tier);
        }
        if (typeof bodyIdx === 'number') {
          await recordVariantEngagement(env.KV_MARKETING, templateKey, 'body', bodyIdx, 'reply', tier);
        }
      }
    } catch { /* Non-critical — A/B tracking failure shouldn't block reply processing */ }

    // 4. Emit reply event to analytics with send/receipt lineage.
    const replyTs = Math.floor(Date.now() / 1000);
    const replyLineage = await resolveEmailSendLineage(env, fromEmail);
    const tenantId = await resolveTelemetryTenantId(env, fromEmail);
    const messageId = replyLineage?.message_id ?? `reply:${fromEmail}:${replyTs}`;

    await emitTelemetryEvent(env, {
      type: EVENT_TYPES.OUTBOUND_EMAIL_REPLIED,
      tenantId,
      messageId,
      correlationId: messageId,
      channel: 'email',
      timestamp: replyTs,
      sendTimestamp: replyLineage?.sent_at ?? null,
      receiptTimestamp: replyTs,
      prospectEmail: fromEmail,
      providerMessageId: replyLineage?.brevo_message_id ?? null,
      campaignId: await getActiveCampaignSlug(env),
      stepId: replyLineage?.template_key ?? null,
      contactId: fromEmail,
      metadata: {
        subject: payload.Subject ?? null,
        source: 'brevo-inbound',
      },
    });

    // 5. Update deliverability counters
    await incrementDeliverabilityCounter(env, 'reply' as BrevoEventType);

    // 5b. Increment campaign-level reply metric
    const replySlug = await getActiveCampaignSlug(env);
    if (replySlug) {
      await incrementCampaignMetric(env.DB, replySlug, 'total_replied').catch(() => { });
    }

    return ok({ processed: true, action: 'reply_detected', email: fromEmail });
  } catch (err) {
    console.error(`[Webhook:Inbound] Error processing reply from ${fromEmail}:`, err);
    return serverError(MESSAGES.errors.internalError);
  }
}

// ─── Channel Attempt Sync (continued) ───────────────────────────────────

/**
 * Map Brevo webhook events to channel_attempts status updates.
 *
 * When the orchestrator records an email attempt, it marks it as 'attempted'.
 * This function upgrades that status based on Brevo's actual outcome:
 *   - delivered / opened / click → 'delivered'
 *   - hard_bounce / soft_bounce / invalid_email / blocked → 'failed'
 *   - spam / unsubscribed → 'failed'
 */
async function syncChannelAttemptStatus(
  env: Env,
  email: string,
  brevoEvent: string
): Promise<void> {
  const statusMap: Record<string, string> = {
    delivered: 'delivered',
    opened: 'delivered',
    click: 'delivered',
    hard_bounce: 'failed',
    soft_bounce: 'failed',
    invalid_email: 'failed',
    blocked: 'failed',
    spam: 'failed',
    unsubscribed: 'failed',
  };

  const newStatus = statusMap[brevoEvent];
  if (!newStatus) return;

  // Update the most recent 'attempted' email channel_attempt for this contact.
  // Only upgrade 'attempted' → delivered/failed (never downgrade 'delivered' → 'failed').
  await execute(
    env.DB,
    `UPDATE channel_attempts
     SET status = ?, response_code = NULL, error = ?
     WHERE contact_email = ? AND channel_type = 'email' AND status = 'attempted'
     ORDER BY attempted_at DESC LIMIT 1`,
    [newStatus, brevoEvent === 'delivered' || brevoEvent === 'opened' || brevoEvent === 'click' ? null : brevoEvent, email]
  );
}

const WEBHOOK_SIGNATURE_SKEW_SECS = 300;

async function verifyWebhookSignature(
  request: Request,
  env: Env,
  rawBody: string
): Promise<Response | null> {
  const secret = env.WEBHOOK_SIGNING_SECRET;
  if (!secret) return null;

  const timestampRaw = request.headers.get('x-webhook-timestamp');
  const signature = request.headers.get('x-webhook-signature');
  if (!timestampRaw || !signature) {
    return unauthorized('Missing webhook signature headers');
  }

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) {
    return unauthorized('Invalid webhook timestamp');
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > WEBHOOK_SIGNATURE_SKEW_SECS) {
    return unauthorized('Stale webhook timestamp');
  }

  const expected = await hmacSha256(secret, `${timestamp}.${rawBody}`);
  const presented = normalizeWebhookSignature(signature);
  if (!presented) {
    return unauthorized('Invalid webhook signature format');
  }

  if (!timingSafeEqual(expected, presented)) {
    return unauthorized('Invalid webhook signature');
  }

  return null;
}

async function hmacSha256(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function normalizeWebhookSignature(signatureHeader: string): string | null {
  const raw = signatureHeader.trim();
  if (!raw) return null;

  const withoutPrefix = raw.toLowerCase().startsWith('sha256=')
    ? raw.slice('sha256='.length)
    : raw;

  const normalized = withoutPrefix.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}