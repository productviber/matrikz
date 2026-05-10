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
import { evaluateGovernanceExecution } from '../lib/governance-execution-client';

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
  /** Consent provenance — required for audit trail but treated as optional for
   *  graceful backwards-compatibility with existing integrations. */
  consentMeta?: {
    source?: string | null;      // e.g. 'email_link', 'embedded_widget'
    campaign?: string | null;    // campaign slug or ID
    step?: string | null;        // journey step name
    landingRoute?: string | null; // URL path where consent was captured
  } | null;
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
  const consentMeta = body.consentMeta ?? null;

  // Subscribe is a state-changing consent transition; evaluate governance
  // before writing subscription side effects.
  const govDecision = await evaluateGovernanceExecution(env, {
    actionType: 'channel.push.subscribe',
    actorTenantId: tenantId,
    targetTenantId: tenantId,
    subjectId: contactId ?? body.subscription?.endpoint ?? 'unknown',
    context: { endpoint: body.subscription?.endpoint ?? '', correlationId },
  });

  if (!govDecision.allowed) {
    return badRequest(`subscription blocked by governance: ${govDecision.reason}`);
  }

  // Merge consent provenance into the metadata blob so it is persisted with
  // the opt-in event without changing the table schema.
  const mergedMeta = {
    ...(body.metadata ?? {}),
    ...(consentMeta ? { consentMeta } : {}),
  };
  const metaJson = Object.keys(mergedMeta).length > 0 ? JSON.stringify(mergedMeta) : null;

  // 1. Log the funnel event (idempotent: IGNORE duplicate for same contact+session)
  try {
    await execute(
      env.DB,
      `INSERT OR IGNORE INTO push_opt_in_events
        (tenant_id, contact_id, browser_session_id, event_type, correlation_id, metadata_json, occurred_at)
       VALUES (?, ?, ?, 'subscribed', ?, ?, ?)`,
      [
        tenantId,
        contactId,
        browserSessionId,
        correlationId,
        metaJson,
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

  // Unsubscribe is also state-changing and must be gated consistently.
  const govDecision = await evaluateGovernanceExecution(env, {
    actionType: 'channel.push.unsubscribe',
    actorTenantId: tenantId,
    targetTenantId: tenantId,
    subjectId: contactId ?? body.browserSessionId ?? 'anonymous',
    context: { browserSessionId: body.browserSessionId ?? null, correlationId },
  });

  if (!govDecision.allowed) {
    return badRequest(`unsubscription blocked by governance: ${govDecision.reason}`);
  }

  // Log unsubscribe event (idempotent write)
  try {
    await execute(
      env.DB,
      `INSERT OR IGNORE INTO push_opt_in_events
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
