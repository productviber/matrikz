/**
 * Event Router — Routes incoming events from visibility-analytics
 * to the appropriate handler. Unknown events are logged and ignored
 * for forward compatibility.
 */

import type { Env, EventEnvelope, AffiliateConversionData, UserConvertedData, UserSignupData } from '../types';
import {
  TRUSTED_SOURCE,
  EVENT_TYPES,
  CONTENT_TYPE_JSON,
  MAX_LENGTH,
  CONTACT_STATUS,
  CONTACT_SOURCE,
  CF_SERVICE_HEADER,
} from '../constants';
import { handleAffiliateConversion } from './affiliate-conversion';
import { handleUserConverted } from './user-converted';
import { handleUserSignup } from './user-signup';

/**
 * Main event handler — called by the worker entry point for POST /events.
 */
export async function routeEvent(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const envelope: EventEnvelope = await request.json();
    const { event, source, timestamp, data } = envelope;

    // ── Validate the Cloudflare service-binding header ──
    // When visibility-analytics calls us via a service binding, Cloudflare
    // automatically sets the cf-worker header.  Plain HTTP requests never
    // carry this header, so its absence indicates a spoofed request.
    const cfWorker = request.headers.get(CF_SERVICE_HEADER);
    if (!cfWorker) {
      console.warn('[Events] Missing cf-worker header — not a service binding call');
      return new Response(JSON.stringify({ ok: false, error: 'Service binding header required' }), {
        status: 401,
        headers: { 'Content-Type': CONTENT_TYPE_JSON },
      });
    }

    // ── Validate source ──
    if (source !== TRUSTED_SOURCE) {
      console.warn(`[Events] Rejected event from unknown source: ${source}`);
      return new Response(JSON.stringify({ ok: false, error: 'Unknown source' }), {
        status: 400,
        headers: { 'Content-Type': CONTENT_TYPE_JSON },
      });
    }

    // ── Validate envelope ──
    if (!event || !timestamp || !data) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid event envelope' }), {
        status: 400,
        headers: { 'Content-Type': CONTENT_TYPE_JSON },
      });
    }

    console.log(`[Events] Received: ${event} at ${timestamp}`);

    // ── Route by event type ──
    switch (event) {
      case EVENT_TYPES.AFFILIATE_CONVERSION:
        ctx.waitUntil(
          handleAffiliateConversion(env, data as AffiliateConversionData, timestamp)
        );
        break;

      case EVENT_TYPES.USER_CONVERTED:
        ctx.waitUntil(
          handleUserConverted(env, data as UserConvertedData, timestamp)
        );
        break;

      // ── User signup — welcome sequence + CRM upsert ──
      case EVENT_TYPES.USER_SIGNUP:
        ctx.waitUntil(
          handleUserSignup(env, data as UserSignupData, timestamp)
        );
        break;

      case EVENT_TYPES.USER_CHURNED:
        ctx.waitUntil(handleFutureEvent(env, event, data, timestamp));
        break;

      case EVENT_TYPES.USER_MILESTONE:
        ctx.waitUntil(handleFutureEvent(env, event, data, timestamp));
        break;

      case EVENT_TYPES.AFFILIATE_CLICK:
        ctx.waitUntil(handleFutureEvent(env, event, data, timestamp));
        break;

      case EVENT_TYPES.INSIGHT_GENERATED:
        ctx.waitUntil(handleFutureEvent(env, event, data, timestamp));
        break;

      default:
        console.log(
          `[Events] Unknown event type: ${event}`,
          JSON.stringify(data).slice(0, MAX_LENGTH.JSON_PREVIEW_SHORT)
        );
    }

    return new Response(JSON.stringify({ ok: true, event }), {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE_JSON },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[Events] Handler error:', errMsg);
    return new Response(JSON.stringify({ ok: false, error: 'Event processing error' }), {
      status: 500,
      headers: { 'Content-Type': CONTENT_TYPE_JSON },
    });
  }
}

/**
 * Stub handler for future events — logs them and enrolls in sequences if applicable.
 */
async function handleFutureEvent(
  env: Env,
  eventType: string,
  data: unknown,
  timestamp: string
): Promise<void> {
  console.log(`[Events:Future] ${eventType} received, data:`, JSON.stringify(data).slice(0, MAX_LENGTH.JSON_PREVIEW_LONG));

  // Attempt to enroll in email sequences if the data has a userId
  const payload = data as Record<string, unknown>;
  if (payload.userId && typeof payload.userId === 'string') {
    try {
      const { enrollInSequences } = await import('../lib/email');
      const { upsertContact } = await import('../lib/crm');

      // Enroll in any sequences matching this event type
      await enrollInSequences(env, payload.userId, eventType, payload as Record<string, unknown>);

      // Handle user.churned specifically
      if (eventType === EVENT_TYPES.USER_CHURNED) {
        await upsertContact(env, payload.userId, { status: CONTACT_STATUS.CHURNED });
      }

      // Handle user.signup specifically
      if (eventType === EVENT_TYPES.USER_SIGNUP) {
        await upsertContact(env, payload.userId, {
          status: CONTACT_STATUS.LEAD,
          source: payload.affiliateCode ? CONTACT_SOURCE.AFFILIATE : CONTACT_SOURCE.ORGANIC,
          affiliate_code: payload.affiliateCode as string | undefined,
        });
      }
    } catch (err) {
      console.error(`[Events:Future] Error processing ${eventType}:`, err);
    }
  }
}
