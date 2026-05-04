/**
 * Multi-Channel Subscription Routes (WhatsApp · SMS · Telegram)
 *
 * Capture user consent and channel identity for each non-push Skrip channel.
 * All handlers follow the same contract as skrip-push.ts:
 *   1. Validate the request body
 *   2. Log the event to push_opt_in_events (same table, different event_type)
 *   3. Register/revoke the channel identity via registerContactChannel (non-fatal)
 *
 * Routes (registered in index.ts, all in the 'user' access lane):
 *   POST   /api/channels/whatsapp/subscribe
 *   DELETE /api/channels/whatsapp/unsubscribe
 *   POST   /api/channels/sms/subscribe
 *   DELETE /api/channels/sms/unsubscribe
 *   POST   /api/channels/telegram/subscribe
 *   DELETE /api/channels/telegram/unsubscribe
 */

import type { Env } from '../types';
import { SKRIP_CHANNEL, SKRIP_CONFIG } from '../constants';
import { execute, now } from '../lib/db';
import { badRequest, created, ok, serverError } from '../lib/response';
import { registerContactChannel } from '../lib/skrip/registration';
import { getCorrelationId } from '../lib/correlation';

// ── Types ──────────────────────────────────────────────────────────────────

type SkripUserChannel = 'whatsapp' | 'sms' | 'telegram';

interface ChannelSubscribeBody {
  /** Canonical channel address: E.164 phone for WhatsApp/SMS, chat_id for Telegram. */
  address: string;
  contactId?: string | null;
  tenantId?: string | null;
  browserSessionId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Consent provenance — optional but recommended for audit trail. */
  consentMeta?: {
    source?: string | null;       // e.g. 'landing_page', 'checkout_widget'
    campaign?: string | null;     // campaign slug or ID
    step?: string | null;         // journey step name
    landingRoute?: string | null; // URL path where consent was captured
  } | null;
}

interface ChannelUnsubscribeBody {
  /** Address to revoke — required to prevent accidental broad revocation. */
  address: string;
  contactId?: string | null;
  tenantId?: string | null;
  browserSessionId?: string | null;
}

// ── Validation helpers ──────────────────────────────────────────────────────

function validateE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value.trim());
}

function validateTelegramChatId(value: string): boolean {
  return /^-?\d+$/.test(value.trim());
}

function validateAddress(channel: SkripUserChannel, address: string): string | null {
  const trimmed = address.trim();
  if (!trimmed) return 'address is required';

  if (channel === 'whatsapp' || channel === 'sms') {
    if (!validateE164(trimmed)) {
      return `address must be a valid E.164 phone number (e.g. +14155551234) for ${channel}`;
    }
  }

  if (channel === 'telegram') {
    if (!validateTelegramChatId(trimmed)) {
      return 'address must be a numeric Telegram chat_id for telegram';
    }
  }

  return null;
}

// ── Generic subscribe handler ───────────────────────────────────────────────

async function handleChannelSubscribe(
  request: Request,
  env: Env,
  channel: SkripUserChannel,
): Promise<Response> {
  let body: Partial<ChannelSubscribeBody>;
  try {
    body = (await request.json()) as Partial<ChannelSubscribeBody>;
  } catch {
    return badRequest('Invalid JSON body');
  }

  if (!body.address || typeof body.address !== 'string') {
    return badRequest('Missing required field: address');
  }

  const addressError = validateAddress(channel, body.address);
  if (addressError) return badRequest(addressError);

  const tenantId = body.tenantId ?? SKRIP_CONFIG.DEFAULT_TENANT_ID;
  const contactId = body.contactId ?? null;
  const browserSessionId = body.browserSessionId ?? null;
  const correlationId = getCorrelationId();
  const epoch = now();
  const address = body.address.trim();

  // Merge consent provenance into the metadata blob for audit trail.
  const mergedMeta = {
    ...(body.metadata ?? {}),
    ...(body.consentMeta ? { consentMeta: body.consentMeta } : {}),
  };
  const metaJson = Object.keys(mergedMeta).length > 0 ? JSON.stringify(mergedMeta) : null;

  // 1. Log the funnel event (idempotent: IGNORE duplicate for same contact+session)
  try {
    await execute(
      env.DB,
      `INSERT OR IGNORE INTO push_opt_in_events
        (tenant_id, contact_id, browser_session_id, event_type, correlation_id, metadata_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        contactId,
        browserSessionId,
        `${channel}.subscribed`,
        correlationId,
        metaJson,
        epoch,
      ],
    );
  } catch (err) {
    console.error(`[Channels] Failed to log ${channel} subscribe event:`, err);
    return serverError(`Failed to record ${channel} subscription`);
  }

  // 2. Register channel identity with Skrip (non-fatal)
  if (contactId) {
    try {
      await registerContactChannel(env, {
        tenantId,
        externalContactId: contactId,
        channel,
        address,
        consentState: 'opted_in',
        suppressionState: 'clear',
        availabilityState: 'available',
        identityConfidence: 1.0,
        metadata: body.metadata ?? undefined,
      } as Parameters<typeof registerContactChannel>[1]);
    } catch (err) {
      console.warn(
        `[Channels] ${channel} registration failed (will reconcile):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return created({
    message: `${channel} subscription captured`,
    channel,
    registered: Boolean(contactId),
    tenantId,
    correlationId,
  });
}

// ── Generic unsubscribe handler ────────────────────────────────────────────

async function handleChannelUnsubscribe(
  request: Request,
  env: Env,
  channel: SkripUserChannel,
): Promise<Response> {
  let body: Partial<ChannelUnsubscribeBody>;
  try {
    body = (await request.json()) as Partial<ChannelUnsubscribeBody>;
  } catch {
    return badRequest('Invalid JSON body');
  }

  // Require address for parity with subscribe — prevents broad accidental revocations.
  if (!body.address || typeof body.address !== 'string') {
    return badRequest('Missing required field: address');
  }
  const addressError = validateAddress(channel, body.address);
  if (addressError) return badRequest(addressError);

  const tenantId = body.tenantId ?? SKRIP_CONFIG.DEFAULT_TENANT_ID;
  const contactId = body.contactId ?? null;
  const browserSessionId = body.browserSessionId ?? null;
  const correlationId = getCorrelationId();
  const epoch = now();
  const address = body.address.trim();

  // Log the opt-out event
  try {
    await execute(
      env.DB,
      `INSERT OR IGNORE INTO push_opt_in_events
        (tenant_id, contact_id, browser_session_id, event_type, correlation_id, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [tenantId, contactId, browserSessionId, `${channel}.unsubscribed`, correlationId, epoch],
    );
  } catch (err) {
    console.error(`[Channels] Failed to log ${channel} unsubscribe event:`, err);
    return serverError(`Failed to record ${channel} unsubscription`);
  }

  // Revoke channel identity (non-fatal)
  if (contactId) {
    try {
      await registerContactChannel(env, {
        tenantId,
        externalContactId: contactId,
        channel,
        address,
        consentState: 'revoked',
        suppressionState: 'suppressed',
        availabilityState: 'unavailable',
        identityConfidence: 1.0,
      } as Parameters<typeof registerContactChannel>[1]);
    } catch (err) {
      console.warn(
        `[Channels] ${channel} revocation failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return ok({ message: `${channel} unsubscribed`, channel, tenantId, correlationId });
}

// ── Named exports per channel ──────────────────────────────────────────────

export function handleWhatsAppSubscribe(request: Request, env: Env): Promise<Response> {
  return handleChannelSubscribe(request, env, SKRIP_CHANNEL.WHATSAPP as SkripUserChannel);
}
export function handleWhatsAppUnsubscribe(request: Request, env: Env): Promise<Response> {
  return handleChannelUnsubscribe(request, env, SKRIP_CHANNEL.WHATSAPP as SkripUserChannel);
}

export function handleSmsSubscribe(request: Request, env: Env): Promise<Response> {
  return handleChannelSubscribe(request, env, SKRIP_CHANNEL.SMS as SkripUserChannel);
}
export function handleSmsUnsubscribe(request: Request, env: Env): Promise<Response> {
  return handleChannelUnsubscribe(request, env, SKRIP_CHANNEL.SMS as SkripUserChannel);
}

export function handleTelegramSubscribe(request: Request, env: Env): Promise<Response> {
  return handleChannelSubscribe(request, env, SKRIP_CHANNEL.TELEGRAM as SkripUserChannel);
}
export function handleTelegramUnsubscribe(request: Request, env: Env): Promise<Response> {
  return handleChannelUnsubscribe(request, env, SKRIP_CHANNEL.TELEGRAM as SkripUserChannel);
}
