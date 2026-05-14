import type { Env } from '../types';
import { EVENT_TYPES, SKRIP_CONFIG } from '../constants';
import { execute, now, queryOne } from '../lib/db';
import { badRequest, ok } from '../lib/response';
import { getCorrelationId } from '../lib/correlation';
import { emitChannelFallbackEvent, emitTelemetryEvent } from '../lib/telemetry';

type DirectChannel = 'push' | 'whatsapp';

type DirectMapping = {
  telemetryType: string;
  lineageStatus: string;
  shouldDeriveOpened: boolean;
  isFailed: boolean;
  engagementEvent: boolean;
};

interface DirectOutcomePayload {
  messageId?: unknown;
  notificationId?: unknown;
  eventType?: unknown;
  type?: unknown;
  tenantId?: unknown;
  contactId?: unknown;
  campaignId?: unknown;
  stepId?: unknown;
  occurredAt?: unknown;
  timestamp?: unknown;
  providerMessageId?: unknown;
  providerRef?: unknown;
  reason?: unknown;
  correlationId?: unknown;
  metadata?: unknown;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseOccurredAt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const numeric = Number.parseInt(value, 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
    const asIso = Date.parse(value);
    if (Number.isFinite(asIso)) {
      return Math.floor(asIso / 1000);
    }
  }
  return now();
}

function parsePayloadMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function mapFcmEvent(eventType: string): DirectMapping | null {
  const normalized = eventType.trim().toLowerCase();
  if (normalized === 'delivery_success' || normalized === 'delivered') {
    return {
      telemetryType: EVENT_TYPES.OUTBOUND_PUSH_DELIVERED,
      lineageStatus: 'message.delivered',
      shouldDeriveOpened: false,
      isFailed: false,
      engagementEvent: false,
    };
  }
  if (normalized === 'opened' || normalized === 'open') {
    return {
      telemetryType: EVENT_TYPES.OUTBOUND_PUSH_OPENED,
      lineageStatus: 'message.opened',
      shouldDeriveOpened: false,
      isFailed: false,
      engagementEvent: true,
    };
  }
  if (normalized === 'clicked' || normalized === 'click') {
    return {
      telemetryType: EVENT_TYPES.OUTBOUND_PUSH_CLICKED,
      lineageStatus: 'message.clicked',
      shouldDeriveOpened: true,
      isFailed: false,
      engagementEvent: true,
    };
  }
  if (normalized === 'delivery_failure' || normalized === 'failed' || normalized === 'failure') {
    return {
      telemetryType: EVENT_TYPES.OUTBOUND_PUSH_FAILED,
      lineageStatus: 'message.failed',
      shouldDeriveOpened: false,
      isFailed: true,
      engagementEvent: false,
    };
  }
  if (normalized === 'unsubscribed' || normalized === 'opt_out' || normalized === 'optout') {
    return {
      telemetryType: EVENT_TYPES.OUTBOUND_PUSH_UNSUBSCRIBED,
      lineageStatus: 'message.unsubscribed',
      shouldDeriveOpened: false,
      isFailed: false,
      engagementEvent: false,
    };
  }
  return null;
}

function mapMetaEvent(eventType: string): DirectMapping | null {
  const normalized = eventType.trim().toLowerCase();
  if (normalized === 'delivered') {
    return {
      telemetryType: EVENT_TYPES.OUTBOUND_WHATSAPP_DELIVERED,
      lineageStatus: 'message.delivered',
      shouldDeriveOpened: false,
      isFailed: false,
      engagementEvent: false,
    };
  }
  if (normalized === 'read') {
    return {
      telemetryType: EVENT_TYPES.OUTBOUND_WHATSAPP_READ,
      lineageStatus: 'message.read',
      shouldDeriveOpened: false,
      isFailed: false,
      engagementEvent: true,
    };
  }
  if (normalized === 'replied' || normalized === 'reply') {
    return {
      telemetryType: EVENT_TYPES.OUTBOUND_WHATSAPP_REPLIED,
      lineageStatus: 'message.replied',
      shouldDeriveOpened: false,
      isFailed: false,
      engagementEvent: true,
    };
  }
  if (normalized === 'failed' || normalized === 'delivery_failed') {
    return {
      telemetryType: EVENT_TYPES.OUTBOUND_WHATSAPP_FAILED,
      lineageStatus: 'message.failed',
      shouldDeriveOpened: false,
      isFailed: true,
      engagementEvent: false,
    };
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
          .filter((item) => item.length > 0),
      ),
    );
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

async function resolveNextFallbackChannel(
  env: Env,
  campaignId: string | null,
  currentChannel: string,
): Promise<string | null> {
  if (!campaignId) return null;

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
      [campaignId],
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
      `[Webhook:Direct] fallback-chain lookup failed for campaign ${campaignId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function processDirectOutcome(
  env: Env,
  input: {
    provider: 'fcm' | 'meta_whatsapp';
    channel: DirectChannel;
    messageId: string;
    eventType: string;
    mapping: DirectMapping;
    tenantId: string;
    contactId: string | null;
    campaignId: string | null;
    stepId: string | null;
    occurredAt: number;
    correlationId: string;
    reason: string | null;
    providerMessageId: string | null;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const epoch = now();
  const existingLineage = await queryOne<{ first_sent_at: number | null }>(
    env.DB,
    `SELECT first_sent_at
       FROM channel_message_lineage
      WHERE message_id = ?
      LIMIT 1`,
    [input.messageId],
  );
  const firstSentAt = existingLineage?.first_sent_at ?? null;

  await emitTelemetryEvent(env, {
    type: input.mapping.telemetryType,
    tenantId: input.tenantId,
    messageId: input.messageId,
    correlationId: input.correlationId,
    channel: input.channel,
    timestamp: input.occurredAt,
    sendTimestamp: firstSentAt,
    receiptTimestamp: input.occurredAt,
    providerMessageId: input.providerMessageId,
    campaignId: input.campaignId,
    stepId: input.stepId,
    contactId: input.contactId,
    reason: input.reason,
    metadata: {
      provider: input.provider,
      rawEventType: input.eventType,
      ...input.metadata,
    },
  });

  if (input.mapping.shouldDeriveOpened) {
    await emitTelemetryEvent(env, {
      type: EVENT_TYPES.OUTBOUND_PUSH_OPENED,
      tenantId: input.tenantId,
      messageId: input.messageId,
      correlationId: input.correlationId,
      channel: 'push',
      timestamp: input.occurredAt,
      sendTimestamp: firstSentAt,
      receiptTimestamp: input.occurredAt,
      providerMessageId: input.providerMessageId,
      campaignId: input.campaignId,
      stepId: input.stepId,
      contactId: input.contactId,
      metadata: {
        provider: input.provider,
        source: 'click-derived-open',
      },
    });
  }

  await execute(
    env.DB,
    `INSERT INTO channel_message_lineage
      (tenant_id, campaign_id, journey_id, step_id, contact_id, channel, message_id, skrip_outbound_id, provider_ref, idempotency_key, latest_status, first_sent_at, last_outcome_at, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       provider_ref = COALESCE(excluded.provider_ref, channel_message_lineage.provider_ref),
       latest_status = excluded.latest_status,
       first_sent_at = COALESCE(channel_message_lineage.first_sent_at, excluded.first_sent_at),
       last_outcome_at = excluded.last_outcome_at,
       updated_at = excluded.updated_at`,
    [
      input.tenantId,
      input.campaignId,
      input.stepId,
      input.contactId,
      input.channel,
      input.messageId,
      input.providerMessageId,
      `${input.provider}:${input.messageId}`,
      input.mapping.lineageStatus,
      firstSentAt,
      input.occurredAt,
      epoch,
      epoch,
    ],
  );

  if (input.contactId?.includes('@')) {
    if (input.channel === 'push') {
      await execute(
        env.DB,
        `UPDATE marketing_contacts
            SET push_sent_at = COALESCE(push_sent_at, ?),
                updated_at = ?
          WHERE email = ?`,
        [firstSentAt ?? input.occurredAt, epoch, input.contactId],
      );

      if (input.mapping.engagementEvent) {
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
          [input.occurredAt, input.occurredAt, input.occurredAt, epoch, input.contactId],
        );
      }

      if (input.mapping.isFailed) {
        await execute(
          env.DB,
          `UPDATE marketing_contacts
              SET push_bounce_reason = ?,
                  updated_at = ?
            WHERE email = ?`,
          [input.reason ?? 'unknown', epoch, input.contactId],
        );
      }
    }

    if (input.channel === 'whatsapp') {
      await execute(
        env.DB,
        `UPDATE marketing_contacts
            SET whatsapp_sent_at = COALESCE(whatsapp_sent_at, ?),
                updated_at = ?
          WHERE email = ?`,
        [firstSentAt ?? input.occurredAt, epoch, input.contactId],
      );

      if (input.mapping.engagementEvent) {
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
          [input.occurredAt, input.occurredAt, input.occurredAt, epoch, input.contactId],
        );
      }

      if (input.mapping.isFailed) {
        await execute(
          env.DB,
          `UPDATE marketing_contacts
              SET whatsapp_bounce_reason = ?,
                  updated_at = ?
            WHERE email = ?`,
          [input.reason ?? 'unknown', epoch, input.contactId],
        );
      }
    }
  }

  if (input.mapping.isFailed) {
    const nextChannel = await resolveNextFallbackChannel(env, input.campaignId, input.channel);
    if (nextChannel) {
      await emitChannelFallbackEvent(env, {
        tenantId: input.tenantId,
        messageId: input.messageId,
        correlationId: input.correlationId,
        fromChannel: input.channel,
        toChannel: nextChannel,
        reason: 'channel_delivery_failed_direct_provider',
        campaignId: input.campaignId,
        stepId: input.stepId,
        contactId: input.contactId,
      });
    }
  }
}

export async function handleFcmDirectWebhook(request: Request, env: Env): Promise<Response> {
  let body: DirectOutcomePayload;
  try {
    body = await request.json() as DirectOutcomePayload;
  } catch {
    return badRequest('Invalid webhook JSON');
  }

  const messageId = normalizeOptionalString(body.messageId) ?? normalizeOptionalString(body.notificationId);
  if (!messageId) return badRequest('messageId is required');

  const eventType = normalizeOptionalString(body.eventType) ?? normalizeOptionalString(body.type);
  if (!eventType) return badRequest('eventType is required');

  const mapping = mapFcmEvent(eventType);
  if (!mapping) {
    return ok({ accepted: false, messageId, reason: `Unsupported FCM eventType: ${eventType}` });
  }

  const tenantId = normalizeOptionalString(body.tenantId) ?? SKRIP_CONFIG.DEFAULT_TENANT_ID;
  const contactId = normalizeOptionalString(body.contactId);
  const campaignId = normalizeOptionalString(body.campaignId);
  const stepId = normalizeOptionalString(body.stepId);
  const occurredAt = parseOccurredAt(body.occurredAt ?? body.timestamp);
  const providerMessageId = normalizeOptionalString(body.providerMessageId) ?? normalizeOptionalString(body.providerRef);
  const reason = normalizeOptionalString(body.reason);
  const correlationId = normalizeOptionalString(body.correlationId) ?? getCorrelationId();

  await processDirectOutcome(env, {
    provider: 'fcm',
    channel: 'push',
    messageId,
    eventType,
    mapping,
    tenantId,
    contactId,
    campaignId,
    stepId,
    occurredAt,
    correlationId,
    reason,
    providerMessageId,
    metadata: parsePayloadMetadata(body.metadata),
  });

  return ok({ accepted: true, provider: 'fcm', messageId, eventType });
}

export async function handleMetaWhatsappDirectWebhook(request: Request, env: Env): Promise<Response> {
  let body: DirectOutcomePayload;
  try {
    body = await request.json() as DirectOutcomePayload;
  } catch {
    return badRequest('Invalid webhook JSON');
  }

  const messageId = normalizeOptionalString(body.messageId) ?? normalizeOptionalString(body.notificationId);
  if (!messageId) return badRequest('messageId is required');

  const eventType = normalizeOptionalString(body.eventType) ?? normalizeOptionalString(body.type);
  if (!eventType) return badRequest('eventType is required');

  const mapping = mapMetaEvent(eventType);
  if (!mapping) {
    return ok({ accepted: false, messageId, reason: `Unsupported Meta WhatsApp eventType: ${eventType}` });
  }

  const tenantId = normalizeOptionalString(body.tenantId) ?? SKRIP_CONFIG.DEFAULT_TENANT_ID;
  const contactId = normalizeOptionalString(body.contactId);
  const campaignId = normalizeOptionalString(body.campaignId);
  const stepId = normalizeOptionalString(body.stepId);
  const occurredAt = parseOccurredAt(body.occurredAt ?? body.timestamp);
  const providerMessageId = normalizeOptionalString(body.providerMessageId) ?? normalizeOptionalString(body.providerRef);
  const reason = normalizeOptionalString(body.reason);
  const correlationId = normalizeOptionalString(body.correlationId) ?? getCorrelationId();

  await processDirectOutcome(env, {
    provider: 'meta_whatsapp',
    channel: 'whatsapp',
    messageId,
    eventType,
    mapping,
    tenantId,
    contactId,
    campaignId,
    stepId,
    occurredAt,
    correlationId,
    reason,
    providerMessageId,
    metadata: parsePayloadMetadata(body.metadata),
  });

  return ok({ accepted: true, provider: 'meta_whatsapp', messageId, eventType });
}
