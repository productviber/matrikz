/**
 * Event Router — Routes incoming events from visibility-analytics
 * to the appropriate handler. Unknown events are logged and ignored
 * for forward compatibility.
 */

import type { Env, EventEnvelope, AffiliateConversionData, UserConvertedData } from '../types';
import { handleAffiliateConversion } from './affiliate-conversion';
import { handleUserConverted } from './user-converted';

const TRUSTED_SOURCE = 'visibility-analytics';

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

    // ── Validate source ──
    if (source !== TRUSTED_SOURCE) {
      console.warn(`[Events] Rejected event from unknown source: ${source}`);
      return new Response(JSON.stringify({ ok: false, error: 'Unknown source' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Validate envelope ──
    if (!event || !timestamp || !data) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid event envelope' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log(`[Events] Received: ${event} at ${timestamp}`);

    // ── Route by event type ──
    switch (event) {
      case 'affiliate.conversion':
        ctx.waitUntil(
          handleAffiliateConversion(env, data as AffiliateConversionData, timestamp)
        );
        break;

      case 'user.converted':
        ctx.waitUntil(
          handleUserConverted(env, data as UserConvertedData, timestamp)
        );
        break;

      // ── Future events (forward-compatible stubs) ──
      case 'user.signup':
        ctx.waitUntil(handleFutureEvent(env, event, data, timestamp));
        break;

      case 'user.churned':
        ctx.waitUntil(handleFutureEvent(env, event, data, timestamp));
        break;

      case 'user.milestone':
        ctx.waitUntil(handleFutureEvent(env, event, data, timestamp));
        break;

      case 'affiliate.click':
        ctx.waitUntil(handleFutureEvent(env, event, data, timestamp));
        break;

      case 'insight.generated':
        ctx.waitUntil(handleFutureEvent(env, event, data, timestamp));
        break;

      default:
        console.log(
          `[Events] Unknown event type: ${event}`,
          JSON.stringify(data).slice(0, 200)
        );
    }

    return new Response(JSON.stringify({ ok: true, event }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[Events] Handler error:', errMsg);
    return new Response(JSON.stringify({ ok: false, error: 'Event processing error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
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
  console.log(`[Events:Future] ${eventType} received, data:`, JSON.stringify(data).slice(0, 300));

  // Attempt to enroll in email sequences if the data has a userId
  const payload = data as Record<string, unknown>;
  if (payload.userId && typeof payload.userId === 'string') {
    try {
      const { enrollInSequences } = await import('../lib/email');
      const { upsertContact } = await import('../lib/crm');

      // Enroll in any sequences matching this event type
      await enrollInSequences(env, payload.userId, eventType, payload as Record<string, unknown>);

      // Handle user.churned specifically
      if (eventType === 'user.churned') {
        await upsertContact(env, payload.userId, { status: 'churned' });
      }

      // Handle user.signup specifically
      if (eventType === 'user.signup') {
        await upsertContact(env, payload.userId, {
          status: 'lead',
          source: payload.affiliateCode ? 'affiliate' : 'organic',
          affiliate_code: payload.affiliateCode as string | undefined,
        });
      }
    } catch (err) {
      console.error(`[Events:Future] Error processing ${eventType}:`, err);
    }
  }
}
