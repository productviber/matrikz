import type { Env } from '../types';
import { CONTENT_TYPE_JSON, EVENT_TYPES, KV_PREFIX, SKRIP_CONFIG } from '../constants';
import { execute, now, queryOne } from '../lib/db';
import { ok, badRequest, serverError } from '../lib/response';
import { verifySkripSignature } from '../lib/skrip/signing';
import { logEvent } from '../lib/observability';
import { emitChannelFallbackEvent, emitTelemetryEvent } from '../lib/telemetry';
import { recordAgentActionOutcome } from '../lib/growth/actions';
import { getDispatchCorrelation, normalizeOutcomeMetric } from '../lib/growth/closedLoop';
import { sendOutcomeFeedback } from '../lib/growth/feedbackClient';

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

const SUPPORTED_CAMPAIGN_CHANNELS = ['email', 'push', 'whatsapp', 'sms', 'telegram', 'contact_form'] as const;

function mapSkripOutcomeToTelemetryType(payload: SkripOutcomePayload): string | null {
  const event = payload.eventType.toLowerCase();
  const channel = payload.channel.toLowerCase();

  if (channel === 'push') {
    if (event.includes('delivered')) return EVENT_TYPES.OUTBOUND_PUSH_DELIVERED;
    if (event.includes('clicked')) return EVENT_TYPES.OUTBOUND_PUSH_CLICKED;
    if (event.includes('opened')) return EVENT_TYPES.OUTBOUND_PUSH_OPENED;
    if (event.includes('dismissed')) return EVENT_TYPES.OUTBOUND_PUSH_DISMISSED;
    if (event.includes('failed')) return EVENT_TYPES.OUTBOUND_PUSH_FAILED;
    if (event.includes('unsubscribed') || event.includes('optout')) return EVENT_TYPES.OUTBOUND_PUSH_UNSUBSCRIBED;
    return null;
  }

  if (channel === 'whatsapp') {
    if (event.includes('delivered')) return EVENT_TYPES.OUTBOUND_WHATSAPP_DELIVERED;
    if (event.includes('read')) return EVENT_TYPES.OUTBOUND_WHATSAPP_READ;
    if (event.includes('replied') || event.includes('reply')) return EVENT_TYPES.OUTBOUND_WHATSAPP_REPLIED;
    if (event.includes('failed')) return EVENT_TYPES.OUTBOUND_WHATSAPP_FAILED;
    return null;
  }

  return null;
}

function parseCampaignChannels(value: string | null | undefined): string[] | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const normalized = Array.from(
      new Set(
        parsed
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim().toLowerCase())
          .filter((item) => (SUPPORTED_CAMPAIGN_CHANNELS as readonly string[]).includes(item)),
      ),
    );
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

function shouldEmitFallbackFromOutcome(payload: SkripOutcomePayload): boolean {
  const eventType = payload.eventType.toLowerCase();
  return eventType.includes('failed') || eventType.includes('bounce');
}

async function resolveNextFallbackChannel(env: Env, payload: SkripOutcomePayload): Promise<string | null> {
  const currentChannel = payload.channel.trim().toLowerCase();
  if (!currentChannel || !payload.campaignId) return null;

  try {
    const campaign = await queryOne<{
      fallback_chain_json: string | null;
      channels_json: string | null;
    }>(
      env.DB,
      `SELECT fallback_chain_json, channels_json
         FROM outbound_campaigns
        WHERE slug = ?
        ORDER BY started_at DESC
        LIMIT 1`,
      [payload.campaignId],
    );

    const fallbackChain = parseCampaignChannels(campaign?.fallback_chain_json)
      ?? parseCampaignChannels(campaign?.channels_json)
      ?? null;
    if (!fallbackChain || fallbackChain.length === 0) {
      return null;
    }

    const currentIndex = fallbackChain.indexOf(currentChannel);
    if (currentIndex < 0 || currentIndex >= fallbackChain.length - 1) {
      return null;
    }

    for (let index = currentIndex + 1; index < fallbackChain.length; index += 1) {
      const candidate = fallbackChain[index];
      if (candidate !== currentChannel) {
        return candidate;
      }
    }

    return null;
  } catch (err) {
    console.log(
      `[Webhook:Skrip] fallback-chain lookup failed for campaign ${payload.campaignId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function resolveFallbackActionTaken(payload: SkripOutcomePayload): string {
  const raw = payload.metadata?.actionType;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  // Default action keeps closed-loop non-fatal when correlation map is unavailable.
  return 'send_via_skrip';
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
  retryable = 1,
): Promise<void> {
  const epoch = now();
  await execute(
    env.DB,
    `INSERT INTO channel_outcome_dead_letter
      (tenant_id, event_id, event_type, payload_json, error_code, error_message, retryable, first_failed_at, last_failed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, eventId, eventType, payload, errorCode, errorMessage, retryable, epoch, epoch],
  );
}

export async function handleSkripOutcomeWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
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
    const existingLineage = await queryOne<{
      first_sent_at: number | null;
    }>(
      env.DB,
      `SELECT first_sent_at
         FROM channel_message_lineage
        WHERE message_id = ?
        LIMIT 1`,
      [payload.messageId],
    );
    const firstSentAt = existingLineage?.first_sent_at ?? null;

    await execute(
      env.DB,
      `INSERT INTO channel_message_lineage
        (tenant_id, campaign_id, journey_id, step_id, contact_id, channel, message_id, skrip_outbound_id, provider_ref, idempotency_key, latest_status, first_sent_at, last_outcome_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         skrip_outbound_id = COALESCE(excluded.skrip_outbound_id, channel_message_lineage.skrip_outbound_id),
         provider_ref = COALESCE(excluded.provider_ref, channel_message_lineage.provider_ref),
         latest_status = excluded.latest_status,
         first_sent_at = COALESCE(channel_message_lineage.first_sent_at, excluded.first_sent_at),
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
        firstSentAt,
        occurredAtEpoch,
        epoch,
        epoch,
      ],
    );

    const telemetryType = mapSkripOutcomeToTelemetryType(payload);
    if (telemetryType) {
      await emitTelemetryEvent(env, {
        type: telemetryType,
        tenantId: payload.tenantId,
        messageId: payload.messageId,
        correlationId: payload.correlationId,
        channel: payload.channel,
        timestamp: occurredAtEpoch,
        sendTimestamp: firstSentAt,
        receiptTimestamp: occurredAtEpoch,
        providerMessageId: payload.providerRef ?? payload.skripOutboundId ?? null,
        campaignId: payload.campaignId,
        stepId: payload.stepId,
        contactId: payload.contactId,
        reason: payload.reason ?? null,
        metadata: {
          eventId: payload.eventId,
          sourceSystem: payload.sourceSystem,
          rawEventType: payload.eventType,
        },
        eventPayload: payload.metadata ?? {},
      });
    } else {
      const unsupportedReason = `Unsupported telemetry mapping for channel=${payload.channel} eventType=${payload.eventType}`;
      await logEvent(env, 'skrip.outcome.unmapped', {
        eventId: payload.eventId,
        eventType: payload.eventType,
        tenantId: payload.tenantId,
        channel: payload.channel,
      }, 'warn');

      try {
        await writeOutcomeToDlq(
          env,
          rawBody,
          payload.eventId,
          payload.eventType,
          payload.tenantId,
          'unsupported_outcome_mapping',
          unsupportedReason,
          0,
        );
      } catch (dlqErr) {
        console.error('[Webhook:Skrip] unsupported mapping DLQ write failed:', dlqErr);
      }
    }

    await logEvent(env, 'skrip.outcome.processed', {
      eventId: payload.eventId,
      eventType: payload.eventType,
      tenantId: payload.tenantId,
      messageId: payload.messageId,
      channel: payload.channel,
    });

    const correlation = await getDispatchCorrelation(env, payload.correlationId);
    if (!correlation) {
      console.log(JSON.stringify({
        type: 'outcome_feedback_fallback_missing_correlation',
        correlationId: payload.correlationId,
        tenantId: payload.tenantId,
        eventType: payload.eventType,
      }));
    }

    const feedbackTask = sendOutcomeFeedback(env, {
      correlationId: payload.correlationId,
      tenantId: correlation?.tenantId ?? payload.tenantId,
      subjectId: correlation?.subjectId ?? payload.contactId,
      actionTaken: correlation?.actionType ?? resolveFallbackActionTaken(payload),
      outcomeMetric: normalizeOutcomeMetric(payload.eventType),
      observedAt: payload.occurredAt,
      sourceEventType: payload.eventType,
    });
    if (ctx) {
      ctx.waitUntil(feedbackTask);
    } else {
      void feedbackTask;
    }

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

    if (payload.contactId.includes('@')) {
      const channel = payload.channel.toLowerCase();
      const event = payload.eventType.toLowerCase();
      if (channel === 'push') {
        await execute(
          env.DB,
          `UPDATE marketing_contacts
              SET push_sent_at = COALESCE(push_sent_at, ?),
                  updated_at = ?
            WHERE email = ?`,
          [firstSentAt ?? occurredAtEpoch, epoch, payload.contactId],
        );

        if (event.includes('clicked') || event.includes('opened')) {
          await execute(
            env.DB,
            `UPDATE marketing_contacts
                SET push_last_opened_at = COALESCE(push_last_opened_at, ?),
                    last_engaged_at = CASE
                      WHEN last_engaged_at IS NULL THEN ?
                      ELSE MAX(last_engaged_at, ?)
                    END,
                    status = CASE WHEN status = 'prospect' THEN 'engaged' ELSE status END,
                    updated_at = ?
              WHERE email = ?`,
            [occurredAtEpoch, occurredAtEpoch, occurredAtEpoch, epoch, payload.contactId],
          );
        }

        if (event.includes('failed')) {
          await execute(
            env.DB,
            `UPDATE marketing_contacts
                SET push_bounce_reason = ?,
                    updated_at = ?
              WHERE email = ?`,
            [payload.reason ?? 'unknown', epoch, payload.contactId],
          );
        }
      }

      if (channel === 'whatsapp') {
        await execute(
          env.DB,
          `UPDATE marketing_contacts
              SET whatsapp_sent_at = COALESCE(whatsapp_sent_at, ?),
                  updated_at = ?
            WHERE email = ?`,
          [firstSentAt ?? occurredAtEpoch, epoch, payload.contactId],
        );

        if (event.includes('read') || event.includes('replied') || event.includes('reply')) {
          await execute(
            env.DB,
            `UPDATE marketing_contacts
                SET whatsapp_last_read_at = COALESCE(whatsapp_last_read_at, ?),
                    last_engaged_at = CASE
                      WHEN last_engaged_at IS NULL THEN ?
                      ELSE MAX(last_engaged_at, ?)
                    END,
                    status = CASE WHEN status = 'prospect' THEN 'engaged' ELSE status END,
                    updated_at = ?
              WHERE email = ?`,
            [occurredAtEpoch, occurredAtEpoch, occurredAtEpoch, epoch, payload.contactId],
          );
        }

        if (event.includes('failed')) {
          await execute(
            env.DB,
            `UPDATE marketing_contacts
                SET whatsapp_bounce_reason = ?,
                    updated_at = ?
              WHERE email = ?`,
            [payload.reason ?? 'unknown', epoch, payload.contactId],
          );
        }
      }
    }

    if (shouldEmitFallbackFromOutcome(payload)) {
      const nextChannel = await resolveNextFallbackChannel(env, payload);
      if (nextChannel) {
        await emitChannelFallbackEvent(env, {
          tenantId: payload.tenantId,
          messageId: payload.messageId,
          correlationId: payload.correlationId,
          fromChannel: payload.channel.toLowerCase(),
          toChannel: nextChannel,
          reason: 'channel_delivery_failed',
          campaignId: payload.campaignId,
          stepId: payload.stepId,
          contactId: payload.contactId,
        });
      }
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
