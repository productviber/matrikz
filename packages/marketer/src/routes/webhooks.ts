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
import { execute, query, queryOne } from '../lib/db';
import { recordVariantEngagement, incrementCampaignMetric } from '../lib/email';
import { ensureWebhookAccess, accessDenied } from '../lib/access';
import { logEvent } from '../lib/observability';
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
        await trackPositiveEvent(env, emailLower, event, ts);
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
    emitTrackingEvent(env, event, emailLower, payload).catch(() => {
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

  const key = `${KV_PREFIX.OUTBOUND_BOUNCE}soft:${email}`;
  const existing = await env.KV_MARKETING.get(key);
  const bounces: number[] = existing ? JSON.parse(existing) : [];

  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - COMPLIANCE.SOFT_BOUNCE_WINDOW;

  // Keep only bounces within the compliance window
  const recent = bounces.filter((ts: number) => ts > windowStart);
  recent.push(now);

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

/**
 * Track positive deliverability signals (delivered, opened, click).
 * For opens/clicks, also update A/B variant weights so future sends
 * favour better-performing subject/body variants.
 */
async function trackPositiveEvent(
  env: Env,
  email: string,
  event: string,
  ts: number
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

  // A/B variant tracking — credit the variant used in the most recent send
  if (event === 'opened' || event === 'click') {
    try {
      const abEvent = event === 'click' ? 'click' : 'open';
      // Find the most recent *sent* send for this contact
      const rows = await query(
        env.DB,
        `SELECT id, template_key FROM email_sends
         WHERE contact_email = ? AND status = 'sent'
         ORDER BY sent_at DESC LIMIT 1`,
        [email]
      );
      const send = rows?.[0] as { id: number; template_key: string } | undefined;
      if (send) {
        const abRaw = await env.KV_MARKETING.get(`ab:send:${email}:${send.id}`);
        if (abRaw) {
          const abData = JSON.parse(abRaw) as { templateKey: string; subIdx?: number; bodyIdx?: number };
          if (typeof abData.subIdx === 'number') {
            await recordVariantEngagement(env.KV_MARKETING, abData.templateKey, 'subject', abData.subIdx, abEvent);
          }
          if (typeof abData.bodyIdx === 'number') {
            await recordVariantEngagement(env.KV_MARKETING, abData.templateKey, 'body', abData.bodyIdx, abEvent);
          }
        }
      }
    } catch {
      // Non-critical — A/B tracking failure shouldn't block webhook processing
    }
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

/**
 * Emit a reverse tracking event to the analytics worker via service binding.
 * Best-effort — failures are logged but never block the webhook response.
 */
async function emitTrackingEvent(
  env: Env,
  brevoEvent: string,
  email: string,
  payload: BrevoWebhookPayload
): Promise<void> {
  const eventType = BREVO_TO_OUTBOUND[brevoEvent];
  if (!eventType || !env.ANALYTICS) return;

  try {
    await env.ANALYTICS.fetch('https://analytics/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: eventType,
        source: 'visibility-marketing',
        data: {
          email,
          brevoEvent,
          reason: payload.reason ?? null,
          messageId: payload['message-id'] ?? null,
          tag: payload.tag ?? null,
          link: payload.link ?? null,
          ts: payload.ts_event ?? Math.floor(Date.now() / 1000),
        },
      }),
    });
  } catch (err) {
    console.warn(`[Webhook:Brevo] Failed to emit tracking event ${eventType}:`, err);
  }
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
    await execute(
      env.DB,
      `UPDATE marketing_contacts SET status = 'engaged', updated_at = ? WHERE email = ?`,
      [Math.floor(Date.now() / 1000), fromEmail]
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

    // 3b. A/B variant tracking — credit the variant that earned the reply (+10 weight)
    try {
      const rows = await query(
        env.DB,
        `SELECT id, template_key FROM email_sends
         WHERE contact_email = ? AND status = 'sent'
         ORDER BY sent_at DESC LIMIT 1`,
        [fromEmail]
      );
      const send = rows?.[0] as { id: number; template_key: string } | undefined;
      if (send) {
        const abRaw = await env.KV_MARKETING.get(`ab:send:${fromEmail}:${send.id}`);
        if (abRaw) {
          const abData = JSON.parse(abRaw) as { templateKey: string; subIdx?: number; bodyIdx?: number };
          if (typeof abData.subIdx === 'number') {
            await recordVariantEngagement(env.KV_MARKETING, abData.templateKey, 'subject', abData.subIdx, 'reply');
          }
          if (typeof abData.bodyIdx === 'number') {
            await recordVariantEngagement(env.KV_MARKETING, abData.templateKey, 'body', abData.bodyIdx, 'reply');
          }
        }
      }
    } catch { /* Non-critical — A/B tracking failure shouldn't block reply processing */ }

    // 4. Emit reply event to analytics
    if (env.ANALYTICS) {
      try {
        await env.ANALYTICS.fetch('https://analytics/api/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: EVENT_TYPES.OUTBOUND_EMAIL_REPLIED,
            source: 'visibility-marketing',
            data: {
              email: fromEmail,
              subject: payload.Subject ?? null,
              ts: Math.floor(Date.now() / 1000),
            },
          }),
        });
      } catch { /* best-effort */ }
    }

    // 5. Update deliverability counters
    await incrementDeliverabilityCounter(env, 'reply' as BrevoEventType);

    // 5b. Increment campaign-level reply metric
    const replySlug = await getActiveCampaignSlug(env);
    if (replySlug) {
      await incrementCampaignMetric(env.DB, replySlug, 'total_replied').catch(() => {});
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