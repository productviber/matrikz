/**
 * Push Subscription Routes
 *
 * Browser Web Push opt-in capture — accepts the PushSubscription object from
 * the browser and persists it both locally (push_opt_in_events + channel
 * identity) and registers with Skrip via registerContactChannel().
 *
 * Routes:
 *   POST /api/push/subscribe   — capture push subscription
 *   DELETE /api/push/unsubscribe — record opt-out
 */

import type { Env } from '../types';
import { SKRIP_CONFIG } from '../constants';
import { execute, now } from '../lib/db';
import { badRequest, created, ok, serverError } from '../lib/response';
import { registerContactChannel } from '../lib/skrip/registration';
import { getCorrelationId } from '../lib/correlation';

// ── Validation ─────────────────────────────────────────────────────────────

interface PushSubscribeBody {
  subscription: {
    endpoint: string;
    keys?: {
      p256dh?: string;
      auth?: string;
    };
  };
  contactId?: string | null;
  tenantId?: string | null;
  browserSessionId?: string | null;
  metadata?: Record<string, unknown> | null;
}

function validateSubscribeBody(body: Partial<PushSubscribeBody>): string | null {
  if (!body.subscription) return 'Missing subscription object';
  if (typeof body.subscription.endpoint !== 'string' || !body.subscription.endpoint.startsWith('https://'))
    return 'Invalid subscription.endpoint — must be an https:// URL';
  return null;
}

// ── Handlers ───────────────────────────────────────────────────────────────

export async function handlePushSubscribe(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: Partial<PushSubscribeBody>;
  try {
    body = (await request.json()) as Partial<PushSubscribeBody>;
  } catch {
    return badRequest('Invalid JSON body');
  }

  const validationError = validateSubscribeBody(body);
  if (validationError) return badRequest(validationError);

  const tenantId = body.tenantId ?? SKRIP_CONFIG.DEFAULT_TENANT_ID;
  const contactId = body.contactId ?? null;
  const browserSessionId = body.browserSessionId ?? null;
  const correlationId = getCorrelationId();
  const epoch = now();

  // 1. Log the funnel event
  try {
    await execute(
      env.DB,
      `INSERT INTO push_opt_in_events
        (tenant_id, contact_id, browser_session_id, event_type, correlation_id, metadata_json, occurred_at)
       VALUES (?, ?, ?, 'subscribed', ?, ?, ?)`,
      [
        tenantId,
        contactId,
        browserSessionId,
        correlationId,
        body.metadata ? JSON.stringify(body.metadata) : null,
        epoch,
      ],
    );
  } catch (err) {
    console.error('[Push] Failed to log opt-in event:', err);
    return serverError('Failed to record push subscription');
  }

  // 2. Persist channel identity + register with Skrip (non-fatal if Skrip is down)
  if (contactId) {
    try {
      await registerContactChannel(env, {
        tenantId,
        externalContactId: contactId,
        channel: 'push',
        address: JSON.stringify(body.subscription),
        consentState: 'opted_in',
        suppressionState: 'clear',
        availabilityState: 'available',
        identityConfidence: 1.0,
        metadata: body.metadata ?? undefined,
      } as Parameters<typeof registerContactChannel>[1]);
    } catch (err) {
      // Degrade gracefully — subscription is logged even if registration fails
      console.warn('[Push] Registration failed (will reconcile later):', err instanceof Error ? err.message : err);
    }
  }

  return created({
    message: 'Push subscription captured',
    registered: Boolean(contactId),
    tenantId,
    correlationId,
  });
}

export async function handlePushUnsubscribe(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: { contactId?: string | null; tenantId?: string | null; browserSessionId?: string | null };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return badRequest('Invalid JSON body');
  }

  const tenantId = body.tenantId ?? SKRIP_CONFIG.DEFAULT_TENANT_ID;
  const contactId = body.contactId ?? null;
  const epoch = now();
  const correlationId = getCorrelationId();

  // Log unsubscribe event
  try {
    await execute(
      env.DB,
      `INSERT INTO push_opt_in_events
        (tenant_id, contact_id, browser_session_id, event_type, correlation_id, metadata_json, occurred_at)
       VALUES (?, ?, ?, 'unsubscribed', ?, NULL, ?)`,
      [tenantId, contactId, body.browserSessionId ?? null, correlationId, epoch],
    );
  } catch (err) {
    console.error('[Push] Failed to log unsubscribe event:', err);
    return serverError('Failed to record push unsubscribe');
  }

  // Update channel identity suppression if contact is identified
  if (contactId) {
    try {
      await execute(
        env.DB,
        `UPDATE contact_channel_identities
            SET consent_state = 'revoked',
                suppression_state = 'suppressed',
                updated_at = ?
          WHERE tenant_id = ? AND external_contact_id = ? AND channel = 'push'`,
        [epoch, tenantId, contactId],
      );
    } catch (err) {
      console.warn('[Push] Failed to update channel identity on unsubscribe:', err instanceof Error ? err.message : err);
    }
  }

  return ok({ message: 'Push unsubscribe recorded', correlationId });
}
