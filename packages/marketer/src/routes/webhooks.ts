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
import { ok, badRequest, serverError } from '../lib/response';
import { execute, query } from '../lib/db';
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
  let payload: BrevoWebhookPayload;
  try {
    payload = await request.json() as BrevoWebhookPayload;
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

    // Sync channel_attempts table with Brevo delivery outcome
    await syncChannelAttemptStatus(env, emailLower, event).catch((err) => {
      console.error(`[Webhook:Brevo] channel_attempts sync error for ${emailLower}:`, err);
    });

    // Emit reverse tracking event to analytics (non-blocking)
    emitTrackingEvent(env, event, emailLower, payload).catch(() => {
      /* best-effort — analytics binding may be unavailable */
    });

    return ok({ processed: true, event, email: emailLower });
  } catch (err) {
    console.error(`[Webhook:Brevo] Error processing ${event} for ${emailLower}:`, err);
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

  await execute(
    env.DB,
    `UPDATE email_sends SET status = ? WHERE contact_email = ? AND status = ?`,
    [EMAIL_STATUS.CANCELLED, email, EMAIL_STATUS.SCHEDULED]
  );
}

/**
 * Track positive deliverability signals (delivered, opened, click).
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
  delivered:     EVENT_TYPES.OUTBOUND_EMAIL_SENT,
  hard_bounce:   EVENT_TYPES.OUTBOUND_EMAIL_BOUNCED,
  soft_bounce:   EVENT_TYPES.OUTBOUND_EMAIL_BOUNCED,
  invalid_email: EVENT_TYPES.OUTBOUND_EMAIL_BOUNCED,
  spam:          EVENT_TYPES.OUTBOUND_EMAIL_COMPLAINED,
  unsubscribed:  EVENT_TYPES.OUTBOUND_UNSUBSCRIBED,
  opened:        EVENT_TYPES.OUTBOUND_EMAIL_OPENED,
  click:         EVENT_TYPES.OUTBOUND_EMAIL_CLICKED,
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
    delivered:     'delivered',
    opened:        'delivered',
    click:         'delivered',
    hard_bounce:   'failed',
    soft_bounce:   'failed',
    invalid_email: 'failed',
    blocked:       'failed',
    spam:          'failed',
    unsubscribed:  'failed',
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