import type { Env } from '../types';
import { CONTENT_TYPE_JSON, KV_PREFIX, SKRIP_CONFIG } from '../constants';
import { execute, now } from '../lib/db';
import { ok, badRequest, serverError } from '../lib/response';
import { verifySkripSignature } from '../lib/skrip/signing';
import { logEvent } from '../lib/observability';
import { recordAgentActionOutcome } from '../lib/growth/actions';

interface SkripOutcomePayload {
  version?: string;
  eventId: string;
  eventType: string;
  tenantId: string;
  contactId: string;
  canonicalId?: string | null;
  campaignId: string;
  journeyId?: string | null;
  stepId: string;
  channel: string;
  messageId: string;
  skripOutboundId?: string | null;
  providerRef?: string | null;
  occurredAt: string;
  sourceSystem: string;
  correlationId: string;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

function validateOutcomePayload(payload: Partial<SkripOutcomePayload>): string | null {
  if (!payload.eventId) return 'Missing eventId';
  if (!payload.eventType) return 'Missing eventType';
  if (!payload.tenantId) return 'Missing tenantId';
  if (!payload.contactId) return 'Missing contactId';
  if (!payload.campaignId) return 'Missing campaignId';
  if (!payload.stepId) return 'Missing stepId';
  if (!payload.channel) return 'Missing channel';
  if (!payload.messageId) return 'Missing messageId';
  if (!payload.occurredAt || !Number.isFinite(Date.parse(payload.occurredAt))) return 'Invalid occurredAt';
  if (!payload.sourceSystem) return 'Missing sourceSystem';
  if (!payload.correlationId) return 'Missing correlationId';
  return null;
}

function isPushTokenInvalidation(payload: SkripOutcomePayload): boolean {
  if ((payload.channel ?? '').toLowerCase() !== 'push') return false;
  const eventType = (payload.eventType ?? '').toLowerCase();
  if (!eventType.includes('failed')) return false;
  const reason = (payload.reason ?? '').trim().toLowerCase();
  const metadataReason = typeof payload.metadata?.failureReason === 'string'
    ? payload.metadata.failureReason.trim().toLowerCase()
    : '';
  const combined = `${reason}|${metadataReason}`;
  return combined.includes('token_invalid') || combined.includes('unregistered');
}

async function writeOutcomeToDlq(
  env: Env,
  payload: string,
  eventId: string,
  eventType: string,
  tenantId: string | null,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  const epoch = now();
  await execute(
    env.DB,
    `INSERT INTO channel_outcome_dead_letter
      (tenant_id, event_id, event_type, payload_json, error_code, error_message, retryable, first_failed_at, last_failed_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [tenantId, eventId, eventType, payload, errorCode, errorMessage, epoch, epoch],
  );
}

export async function handleSkripOutcomeWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const webhookSigningSecret = env.SKRIP_WEBHOOK_SIGNING_SECRET ?? env.WEBHOOK_SIGNING_SECRET;
  if (!webhookSigningSecret) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Skrip webhook signing is not configured' }),
      { status: 503, headers: { 'Content-Type': CONTENT_TYPE_JSON } },
    );
  }

  let rawBody = '';
  try {
    rawBody = await request.text();
  } catch {
    return badRequest('Invalid webhook payload');
  }

  const signatureCheck = await verifySkripSignature({
    method: request.method,
    path: new URL(request.url).pathname,
    timestamp: request.headers.get(SKRIP_CONFIG.HEADER_TIMESTAMP),
    nonce: request.headers.get(SKRIP_CONFIG.HEADER_NONCE),
    signature: request.headers.get(SKRIP_CONFIG.HEADER_SIGNATURE),
    rawBody,
    secret: webhookSigningSecret,
  });
  if (!signatureCheck.ok) {
    return new Response(
      JSON.stringify({ ok: false, error: signatureCheck.error }),
      { status: signatureCheck.status, headers: { 'Content-Type': CONTENT_TYPE_JSON } },
    );
  }

  const nonce = request.headers.get(SKRIP_CONFIG.HEADER_NONCE)!;
  const nonceKey = `${KV_PREFIX.AUTH_NONCE}skrip:${nonce}`;
  if (await env.KV_MARKETING.get(nonceKey)) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Skrip webhook replay detected' }),
      { status: 409, headers: { 'Content-Type': CONTENT_TYPE_JSON } },
    );
  }
  await env.KV_MARKETING.put(nonceKey, '1', { expirationTtl: SKRIP_CONFIG.NONCE_TTL_SECS });

  let payload: SkripOutcomePayload;
  try {
    payload = JSON.parse(rawBody) as SkripOutcomePayload;
  } catch {
    return badRequest('Invalid webhook JSON');
  }

  const validationError = validateOutcomePayload(payload);
  if (validationError) {
    return badRequest(validationError);
  }

  try {
    const occurredAtEpoch = Math.floor(Date.parse(payload.occurredAt) / 1000);
    const epoch = now();
    await execute(
      env.DB,
      `INSERT INTO channel_message_lineage
        (tenant_id, campaign_id, journey_id, step_id, contact_id, channel, message_id, skrip_outbound_id, provider_ref, idempotency_key, latest_status, first_sent_at, last_outcome_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         skrip_outbound_id = COALESCE(excluded.skrip_outbound_id, channel_message_lineage.skrip_outbound_id),
         provider_ref = COALESCE(excluded.provider_ref, channel_message_lineage.provider_ref),
         latest_status = excluded.latest_status,
         last_outcome_at = excluded.last_outcome_at,
         updated_at = excluded.updated_at`,
      [
        payload.tenantId,
        payload.campaignId,
        payload.journeyId ?? null,
        payload.stepId,
        payload.contactId,
        payload.channel,
        payload.messageId,
        payload.skripOutboundId ?? null,
        payload.providerRef ?? null,
        payload.messageId,
        payload.eventType,
        occurredAtEpoch,
        occurredAtEpoch,
        epoch,
        epoch,
      ],
    );

    await logEvent(env, 'skrip.outcome.processed', {
      eventId: payload.eventId,
      eventType: payload.eventType,
      tenantId: payload.tenantId,
      messageId: payload.messageId,
      channel: payload.channel,
    });

    const agentActionId = typeof payload.metadata?.agentActionId === 'string'
      ? payload.metadata.agentActionId
      : null;
    if (agentActionId) {
      await recordAgentActionOutcome(env, {
        actionId: agentActionId,
        outcomeType: payload.eventType,
        observedAt: occurredAtEpoch,
        attributionStrength: 'direct_channel_lineage',
        evidence: {
          source: 'skrip',
          messageId: payload.messageId,
          campaignId: payload.campaignId,
          channel: payload.channel,
          eventId: payload.eventId,
        },
      }).catch(() => { /* Non-critical: lineage write already succeeded. */ });
    }

    if (isPushTokenInvalidation(payload)) {
      await execute(
        env.DB,
        `UPDATE contact_channel_identities
            SET registration_state = 'invalid',
                availability_state = 'unavailable',
                updated_at = ?
          WHERE tenant_id = ?
            AND external_contact_id = ?
            AND channel = 'push'`,
        [epoch, payload.tenantId, payload.contactId],
      );
    }

    return ok({ accepted: true, eventId: payload.eventId, processedAt: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await writeOutcomeToDlq(
        env,
        rawBody,
        payload.eventId,
        payload.eventType,
        payload.tenantId,
        'lineage_upsert_failed',
        message,
      );
    } catch (dlqErr) {
      console.error('[Webhook:Skrip] DLQ write failed:', dlqErr);
    }
    console.error('[Webhook:Skrip] outcome processing error:', err);
    return serverError('Failed to process Skrip outcome');
  }
}
