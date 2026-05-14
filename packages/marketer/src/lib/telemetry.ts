import type { Env } from '../types';
import { EVENT_TYPES, KV_PREFIX, TELEMETRY, WORKER_NAME } from '../constants';
import { execute, now, query, queryOne } from './db';
import { getCorrelationId } from './correlation';
import { logEvent } from './observability';
import { sendDiscordNotification, sendSlackNotification } from './notifications';

type TelemetryChannel = 'email' | 'push' | 'whatsapp' | 'sms' | 'telegram' | 'system';

export interface TelemetryEvent {
  type: string;
  tenantId: string;
  messageId: string;
  correlationId?: string;
  sourceWorker?: string;
  schemaVersion?: string;
  timestamp?: number;
  sendTimestamp?: number | null;
  receiptTimestamp?: number | null;
  prospectEmail?: string | null;
  prospectId?: number | string | null;
  providerMessageId?: string | null;
  aBVariant?: string | number | null;
  channel?: string | null;
  campaignId?: string | null;
  stepId?: string | null;
  contactId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  eventPayload?: Record<string, unknown> | null;
}

interface NormalizedTelemetryEvent {
  type: string;
  tenantId: string;
  messageId: string;
  correlationId: string;
  sourceWorker: string;
  schemaVersion: string;
  schemaAlignment: SchemaAlignmentState;
  channel: TelemetryChannel;
  timestamp: number;
  sendTimestamp: number | null;
  receiptTimestamp: number | null;
  prospectEmail: string | null;
  prospectId: string | null;
  providerMessageId: string | null;
  aBVariant: string | null;
  campaignId: string | null;
  stepId: string | null;
  contactId: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  eventPayload: Record<string, unknown>;
  deliveryLatencyMs: number | null;
}

interface SchemaAlignmentState {
  requestedSchemaVersion: string | null;
  effectiveSchemaVersion: string;
  supportedSchemaVersions: string[];
  coerced: boolean;
}

export interface TelemetryEmitResult {
  accepted: boolean;
  queued: boolean;
  error?: string;
}

export interface ChannelFallbackEvent {
  tenantId: string;
  correlationId?: string;
  messageId: string;
  fromChannel: string;
  toChannel: string;
  reason: string;
  campaignId?: string | null;
  stepId?: string | null;
  contactId?: string | null;
}

type DailyCounterField =
  | 'sent_count'
  | 'delivered_count'
  | 'opened_count'
  | 'clicked_count'
  | 'replied_count'
  | 'bounced_count'
  | 'failed_count'
  | 'complained_count'
  | 'unsubscribed_count'
  | 'dismissed_count'
  | 'fallback_count';

const EVENT_COUNTER_FIELDS: Record<string, DailyCounterField | null> = {
  [EVENT_TYPES.OUTBOUND_EMAIL_SENT]: 'sent_count',
  [EVENT_TYPES.OUTBOUND_EMAIL_OPENED]: 'opened_count',
  [EVENT_TYPES.OUTBOUND_EMAIL_CLICKED]: 'clicked_count',
  [EVENT_TYPES.OUTBOUND_EMAIL_REPLIED]: 'replied_count',
  [EVENT_TYPES.OUTBOUND_EMAIL_BOUNCED]: 'bounced_count',
  [EVENT_TYPES.OUTBOUND_EMAIL_COMPLAINED]: 'complained_count',
  [EVENT_TYPES.OUTBOUND_UNSUBSCRIBED]: 'unsubscribed_count',
  [EVENT_TYPES.OUTBOUND_PUSH_SENT]: 'sent_count',
  [EVENT_TYPES.OUTBOUND_PUSH_DELIVERED]: 'delivered_count',
  [EVENT_TYPES.OUTBOUND_PUSH_OPENED]: 'opened_count',
  [EVENT_TYPES.OUTBOUND_PUSH_CLICKED]: 'clicked_count',
  [EVENT_TYPES.OUTBOUND_PUSH_DISMISSED]: 'dismissed_count',
  [EVENT_TYPES.OUTBOUND_PUSH_FAILED]: 'failed_count',
  [EVENT_TYPES.OUTBOUND_PUSH_UNSUBSCRIBED]: 'unsubscribed_count',
  [EVENT_TYPES.OUTBOUND_WHATSAPP_SENT]: 'sent_count',
  [EVENT_TYPES.OUTBOUND_WHATSAPP_DELIVERED]: 'delivered_count',
  [EVENT_TYPES.OUTBOUND_WHATSAPP_READ]: 'opened_count',
  [EVENT_TYPES.OUTBOUND_WHATSAPP_REPLIED]: 'replied_count',
  [EVENT_TYPES.OUTBOUND_WHATSAPP_FAILED]: 'failed_count',
  [EVENT_TYPES.OUTBOUND_CHANNEL_FALLBACK]: 'fallback_count',
};

function toEpochSeconds(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  // Support millisecond timestamps from legacy callers.
  if (value > 10_000_000_000) {
    return Math.floor(value / 1000);
  }
  return Math.floor(value);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveSupportedSchemaVersions(env: Env): string[] {
  const configured = (env.TELEMETRY_SCHEMA_VERSIONS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set([TELEMETRY.SCHEMA_VERSION, ...configured]));
}

function resolveSchemaAlignment(env: Env, requested: string | null): SchemaAlignmentState {
  const supportedSchemaVersions = resolveSupportedSchemaVersions(env);
  const requestedSchemaVersion = normalizeString(requested);
  if (!requestedSchemaVersion || supportedSchemaVersions.includes(requestedSchemaVersion)) {
    return {
      requestedSchemaVersion,
      effectiveSchemaVersion: requestedSchemaVersion ?? TELEMETRY.SCHEMA_VERSION,
      supportedSchemaVersions,
      coerced: false,
    };
  }

  return {
    requestedSchemaVersion,
    effectiveSchemaVersion: TELEMETRY.SCHEMA_VERSION,
    supportedSchemaVersions,
    coerced: true,
  };
}

function deriveChannel(type: string, channel?: string | null): TelemetryChannel {
  const explicit = normalizeString(channel);
  if (
    explicit === 'email' ||
    explicit === 'push' ||
    explicit === 'whatsapp' ||
    explicit === 'sms' ||
    explicit === 'telegram' ||
    explicit === 'system'
  ) {
    return explicit;
  }

  if (type.includes('.email_')) return 'email';
  if (type.includes('.push_')) return 'push';
  if (type.includes('.whatsapp_')) return 'whatsapp';
  if (type.includes('.sms_')) return 'sms';
  if (type.includes('.telegram_')) return 'telegram';
  return 'system';
}

function normalizeEvent(env: Env, event: TelemetryEvent): NormalizedTelemetryEvent {
  const epoch = now();
  const eventTs = toEpochSeconds(event.timestamp ?? null, epoch);
  const sendTs = event.sendTimestamp == null ? null : toEpochSeconds(event.sendTimestamp, eventTs);
  const receiptTs = event.receiptTimestamp == null ? null : toEpochSeconds(event.receiptTimestamp, eventTs);
  const deliveryLatencyMs = sendTs != null && receiptTs != null && receiptTs >= sendTs
    ? (receiptTs - sendTs) * 1000
    : null;
  const schemaAlignment = resolveSchemaAlignment(env, normalizeString(event.schemaVersion));

  const baseMetadata = event.metadata ?? {};
  const metadata = schemaAlignment.coerced
    ? {
        ...baseMetadata,
        schemaAlignment: {
          requested: schemaAlignment.requestedSchemaVersion,
          effective: schemaAlignment.effectiveSchemaVersion,
        },
      }
    : baseMetadata;

  const normalized: NormalizedTelemetryEvent = {
    type: event.type,
    tenantId: event.tenantId,
    messageId: event.messageId,
    correlationId: normalizeString(event.correlationId) ?? getCorrelationId(),
    sourceWorker: normalizeString(event.sourceWorker) ?? WORKER_NAME,
    schemaVersion: schemaAlignment.effectiveSchemaVersion,
    schemaAlignment,
    channel: deriveChannel(event.type, event.channel),
    timestamp: eventTs,
    sendTimestamp: sendTs,
    receiptTimestamp: receiptTs,
    prospectEmail: normalizeString(event.prospectEmail),
    prospectId: event.prospectId == null ? null : String(event.prospectId),
    providerMessageId: normalizeString(event.providerMessageId),
    aBVariant: event.aBVariant == null ? null : String(event.aBVariant),
    campaignId: normalizeString(event.campaignId),
    stepId: normalizeString(event.stepId),
    contactId: normalizeString(event.contactId),
    reason: normalizeString(event.reason),
    metadata,
    eventPayload: event.eventPayload ?? {},
    deliveryLatencyMs,
  };

  return normalized;
}

function toAnalyticsEnvelope(event: NormalizedTelemetryEvent): Record<string, unknown> {
  return {
    type: event.type,
    source: event.sourceWorker,
    schema_version: event.schemaVersion,
    data: {
      correlation_id: event.correlationId,
      tenant_id: event.tenantId,
      message_id: event.messageId,
      source_worker: event.sourceWorker,
      schema_version: event.schemaVersion,
      channel: event.channel,
      timestamp: event.timestamp,
      send_timestamp: event.sendTimestamp,
      receipt_timestamp: event.receiptTimestamp,
      delivery_latency_ms: event.deliveryLatencyMs,
      prospect_email: event.prospectEmail,
      prospect_id: event.prospectId,
      provider_message_id: event.providerMessageId,
      a_b_variant: event.aBVariant,
      campaign_id: event.campaignId,
      step_id: event.stepId,
      contact_id: event.contactId,
      reason: event.reason,
      metadata: event.metadata,
      event_payload: event.eventPayload,
    },
  };
}

function circuitKey(tenantId: string): string {
  return `${KV_PREFIX.ANALYTICS_CIRCUIT}${tenantId}`;
}

function failureKey(tenantId: string): string {
  return `${KV_PREFIX.ANALYTICS_FAILURE}${tenantId}`;
}

async function isAnalyticsCircuitOpen(env: Env, tenantId: string): Promise<boolean> {
  const value = await env.KV_MARKETING.get(circuitKey(tenantId));
  return value === '1';
}

async function clearAnalyticsFailures(env: Env, tenantId: string): Promise<void> {
  await Promise.all([
    env.KV_MARKETING.delete(failureKey(tenantId)),
    env.KV_MARKETING.delete(circuitKey(tenantId)),
  ]);
}

async function registerAnalyticsFailure(env: Env, tenantId: string): Promise<number> {
  const key = failureKey(tenantId);
  const raw = await env.KV_MARKETING.get(key);
  const current = Number.parseInt(raw ?? '0', 10);
  const next = Number.isFinite(current) ? current + 1 : 1;
  await env.KV_MARKETING.put(key, String(next), { expirationTtl: TELEMETRY.ANALYTICS_CIRCUIT_TTL_SECS });

  if (next >= TELEMETRY.ANALYTICS_CIRCUIT_FAILURE_THRESHOLD) {
    await env.KV_MARKETING.put(circuitKey(tenantId), '1', {
      expirationTtl: TELEMETRY.ANALYTICS_CIRCUIT_TTL_SECS,
    });
  }

  return next;
}

async function recordBindingMetric(
  env: Env,
  binding: string,
  tenantId: string,
  eventType: string,
  latencyMs: number,
  success: boolean,
  error: string | null,
): Promise<void> {
  try {
    const epoch = now();
    await execute(
      env.DB,
      `INSERT INTO service_binding_metrics
        (binding, tenant_id, event_type, latency_ms, success, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [binding, tenantId, eventType, latencyMs, success ? 1 : 0, error, epoch],
    );
  } catch {
    // Non-fatal; health snapshots degrade gracefully if this table is unavailable.
  }
}

async function recordSchemaAlignmentMetric(env: Env, event: NormalizedTelemetryEvent): Promise<void> {
  if (!event.schemaAlignment.coerced) return;
  await recordBindingMetric(
    env,
    'schema_alignment',
    event.tenantId,
    event.type,
    0,
    false,
    `unsupported_schema_version:${event.schemaAlignment.requestedSchemaVersion ?? 'unknown'}`,
  );
}

async function enqueueFallback(
  env: Env,
  event: NormalizedTelemetryEvent,
  error: string,
): Promise<void> {
  try {
    const epoch = now();
    await execute(
      env.DB,
      `INSERT INTO telemetry_fallback_queue
        (event_type, tenant_id, correlation_id, message_id, event_json, attempt_count, last_error, retryable, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?)`,
      [
        event.type,
        event.tenantId,
        event.correlationId,
        event.messageId,
        JSON.stringify(toAnalyticsEnvelope(event)),
        error,
        epoch,
        epoch,
        epoch,
      ],
    );
  } catch {
    // Intentionally swallow to keep primary flows non-fatal.
  }
}

async function updateDailyChannelCounters(env: Env, event: NormalizedTelemetryEvent): Promise<void> {
  const metric = EVENT_COUNTER_FIELDS[event.type] ?? null;
  if (!metric) return;

  const dateKey = new Date(event.timestamp * 1000).toISOString().slice(0, 10);
  const counters: Record<DailyCounterField, number> = {
    sent_count: 0,
    delivered_count: 0,
    opened_count: 0,
    clicked_count: 0,
    replied_count: 0,
    bounced_count: 0,
    failed_count: 0,
    complained_count: 0,
    unsubscribed_count: 0,
    dismissed_count: 0,
    fallback_count: 0,
  };
  counters[metric] = 1;

  const latencySample = event.deliveryLatencyMs ?? 0;
  const latencySampleCount = event.deliveryLatencyMs == null ? 0 : 1;

  try {
    await execute(
      env.DB,
      `INSERT INTO telemetry_channel_daily
        (date_key, channel, tenant_id,
         sent_count, delivered_count, opened_count, clicked_count, replied_count,
         bounced_count, failed_count, complained_count, unsubscribed_count, dismissed_count, fallback_count,
         avg_delivery_latency_ms, delivery_latency_samples, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date_key, channel, tenant_id) DO UPDATE SET
         sent_count = telemetry_channel_daily.sent_count + excluded.sent_count,
         delivered_count = telemetry_channel_daily.delivered_count + excluded.delivered_count,
         opened_count = telemetry_channel_daily.opened_count + excluded.opened_count,
         clicked_count = telemetry_channel_daily.clicked_count + excluded.clicked_count,
         replied_count = telemetry_channel_daily.replied_count + excluded.replied_count,
         bounced_count = telemetry_channel_daily.bounced_count + excluded.bounced_count,
         failed_count = telemetry_channel_daily.failed_count + excluded.failed_count,
         complained_count = telemetry_channel_daily.complained_count + excluded.complained_count,
         unsubscribed_count = telemetry_channel_daily.unsubscribed_count + excluded.unsubscribed_count,
         dismissed_count = telemetry_channel_daily.dismissed_count + excluded.dismissed_count,
         fallback_count = telemetry_channel_daily.fallback_count + excluded.fallback_count,
         avg_delivery_latency_ms = CASE
           WHEN excluded.delivery_latency_samples = 0 THEN telemetry_channel_daily.avg_delivery_latency_ms
           WHEN telemetry_channel_daily.delivery_latency_samples = 0 THEN excluded.avg_delivery_latency_ms
           ELSE (
             (telemetry_channel_daily.avg_delivery_latency_ms * telemetry_channel_daily.delivery_latency_samples)
             + (excluded.avg_delivery_latency_ms * excluded.delivery_latency_samples)
           ) / (telemetry_channel_daily.delivery_latency_samples + excluded.delivery_latency_samples)
         END,
         delivery_latency_samples = telemetry_channel_daily.delivery_latency_samples + excluded.delivery_latency_samples,
         updated_at = excluded.updated_at`,
      [
        dateKey,
        event.channel,
        event.tenantId,
        counters.sent_count,
        counters.delivered_count,
        counters.opened_count,
        counters.clicked_count,
        counters.replied_count,
        counters.bounced_count,
        counters.failed_count,
        counters.complained_count,
        counters.unsubscribed_count,
        counters.dismissed_count,
        counters.fallback_count,
        latencySample,
        latencySampleCount,
        now(),
      ],
    );
  } catch {
    // Non-fatal; daily rollups are advisory telemetry.
  }
}

async function sendAnalyticsEvent(
  env: Env,
  payload: Record<string, unknown>,
  schemaVersion: string,
): Promise<{ ok: boolean; status: number }> {
  const response = await env.ANALYTICS.fetch(TELEMETRY.ANALYTICS_EVENT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-schema-version': schemaVersion,
    },
    body: JSON.stringify(payload),
  });

  return { ok: response.ok, status: response.status };
}

export async function emitTelemetryEvent(env: Env, event: TelemetryEvent): Promise<TelemetryEmitResult> {
  const normalized = normalizeEvent(env, event);
  const payload = toAnalyticsEnvelope(normalized);

  await updateDailyChannelCounters(env, normalized);
  await recordSchemaAlignmentMetric(env, normalized);

  if (normalized.schemaAlignment.coerced) {
    try {
      await logEvent(env, 'telemetry.schema_alignment_coerced', {
        requestedSchemaVersion: normalized.schemaAlignment.requestedSchemaVersion,
        effectiveSchemaVersion: normalized.schemaAlignment.effectiveSchemaVersion,
        supportedSchemaVersions: normalized.schemaAlignment.supportedSchemaVersions,
        type: normalized.type,
        tenantId: normalized.tenantId,
        messageId: normalized.messageId,
      }, 'warn');
    } catch {
      // Schema-alignment telemetry should never block primary event emit.
    }
  }

  const started = Date.now();
  let queued = false;
  let accepted = false;
  let errorMessage: string | null = null;

  try {
    const circuitOpen = await isAnalyticsCircuitOpen(env, normalized.tenantId);
    if (circuitOpen) {
      errorMessage = 'analytics_circuit_open';
      queued = true;
      await enqueueFallback(env, normalized, errorMessage);
      await logEvent(env, 'telemetry.circuit_open_queued', {
        type: normalized.type,
        tenantId: normalized.tenantId,
        correlationId: normalized.correlationId,
      }, 'warn');
      return { accepted: false, queued: true, error: errorMessage };
    }

    const response = await sendAnalyticsEvent(env, payload, normalized.schemaVersion);
    accepted = response.ok;
    if (!response.ok) {
      errorMessage = `analytics_http_${response.status}`;
      queued = true;
      await registerAnalyticsFailure(env, normalized.tenantId);
      await enqueueFallback(env, normalized, errorMessage);
    } else {
      await clearAnalyticsFailures(env, normalized.tenantId);
    }

    return {
      accepted,
      queued,
      error: errorMessage ?? undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorMessage = message;
    queued = true;
    await registerAnalyticsFailure(env, normalized.tenantId);
    await enqueueFallback(env, normalized, message);
    return { accepted: false, queued: true, error: message };
  } finally {
    const latencyMs = Date.now() - started;
    await recordBindingMetric(
      env,
      'analytics_events',
      normalized.tenantId,
      normalized.type,
      latencyMs,
      accepted,
      errorMessage,
    );
  }
}

export async function emitChannelFallbackEvent(env: Env, event: ChannelFallbackEvent): Promise<TelemetryEmitResult> {
  return emitTelemetryEvent(env, {
    type: EVENT_TYPES.OUTBOUND_CHANNEL_FALLBACK,
    tenantId: event.tenantId,
    messageId: event.messageId,
    correlationId: event.correlationId,
    channel: 'system',
    reason: event.reason,
    campaignId: event.campaignId ?? null,
    stepId: event.stepId ?? null,
    contactId: event.contactId ?? null,
    metadata: {
      fromChannel: event.fromChannel,
      toChannel: event.toChannel,
    },
  });
}

export async function flushTelemetryFallbackQueue(
  env: Env,
  limit = 50,
): Promise<{ scanned: number; replayed: number; failed: number }> {
  const capped = Math.max(1, Math.min(limit, 200));
  const epoch = now();
  const rows = await query<{
    id: number;
    event_json: string;
    tenant_id: string;
    event_type: string;
    attempt_count: number;
  }>(
    env.DB,
    `SELECT id, event_json, tenant_id, event_type, attempt_count
       FROM telemetry_fallback_queue
      WHERE replayed_at IS NULL
        AND retryable = 1
        AND attempt_count < ?
        AND next_attempt_at <= ?
      ORDER BY created_at ASC
      LIMIT ?`,
    [TELEMETRY.FALLBACK_MAX_RETRIES, epoch, capped],
  );

  let replayed = 0;
  let failed = 0;

  for (const row of rows) {
    const started = Date.now();
    try {
      const payload = JSON.parse(row.event_json) as Record<string, unknown>;
      const payloadSchema = normalizeString(payload.schema_version) ?? TELEMETRY.SCHEMA_VERSION;
      const response = await sendAnalyticsEvent(env, payload, payloadSchema);
      const latencyMs = Date.now() - started;

      if (response.ok) {
        replayed++;
        await execute(
          env.DB,
          `UPDATE telemetry_fallback_queue
              SET replayed_at = ?,
                  updated_at = ?,
                  last_error = NULL
            WHERE id = ?`,
          [epoch, epoch, row.id],
        );
        await clearAnalyticsFailures(env, row.tenant_id);
        await recordBindingMetric(env, 'analytics_events_replay', row.tenant_id, row.event_type, latencyMs, true, null);
      } else {
        failed++;
        const message = `analytics_http_${response.status}`;
        const nextAttempt = epoch + Math.min(3600, 60 * (row.attempt_count + 1));
        await execute(
          env.DB,
          `UPDATE telemetry_fallback_queue
              SET attempt_count = attempt_count + 1,
                  last_error = ?,
                  next_attempt_at = ?,
                  retryable = CASE WHEN attempt_count + 1 >= ? THEN 0 ELSE 1 END,
                  updated_at = ?
            WHERE id = ?`,
          [message, nextAttempt, TELEMETRY.FALLBACK_MAX_RETRIES, epoch, row.id],
        );
        await registerAnalyticsFailure(env, row.tenant_id);
        await recordBindingMetric(env, 'analytics_events_replay', row.tenant_id, row.event_type, latencyMs, false, message);
      }
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      const nextAttempt = epoch + Math.min(3600, 60 * (row.attempt_count + 1));
      await execute(
        env.DB,
        `UPDATE telemetry_fallback_queue
            SET attempt_count = attempt_count + 1,
                last_error = ?,
                next_attempt_at = ?,
                retryable = CASE WHEN attempt_count + 1 >= ? THEN 0 ELSE 1 END,
                updated_at = ?
          WHERE id = ?`,
        [message, nextAttempt, TELEMETRY.FALLBACK_MAX_RETRIES, epoch, row.id],
      );
      await registerAnalyticsFailure(env, row.tenant_id);
      await recordBindingMetric(env, 'analytics_events_replay', row.tenant_id, row.event_type, Date.now() - started, false, message);
    }
  }

  return {
    scanned: rows.length,
    replayed,
    failed,
  };
}

export interface OutboundTelemetryHealthSnapshot {
  generatedAt: number;
  windowHours: number;
  sendSuccessRate: number;
  webhookReceiptRate: number;
  avgLatencyMs: number;
  errorCount24h: number;
  channels: Array<{
    channel: string;
    sent: number;
    delivered: number;
    receipts: number;
    failed: number;
    bounced: number;
    complained: number;
    unsubscribed: number;
    dismissed: number;
    sendSuccessRate: number;
    webhookReceiptRate: number;
    avgLatencyMs: number;
    latencySamples: number;
  }>;
  totals: {
    bindingAttempts: number;
    bindingSuccess: number;
    bindingFailures: number;
    sent: number;
    receipts: number;
  };
  fallbackQueue: {
    pending: number;
    retryable: number;
    deadLetter: number;
    oldestPendingAgeSec: number | null;
  };
  quality: {
    deadLetterCount24h: number;
    retryableDeadLetterCount24h: number;
    nonRetryableDeadLetterCount24h: number;
    unsupportedOutcomeCount24h: number;
    reverseEmitFailureCount24h: number;
  };
  schemaAlignment: {
    defaultSchemaVersion: string;
    supportedSchemaVersions: string[];
    coercedCount24h: number;
  };
  thresholds: {
    sendSuccessRateMin: number;
    webhookReceiptRateMin: number;
    avgLatencyMaxMs: number;
    errorCountMax24h: number;
    deadLetterMax24h: number;
    schemaCoercionMax24h: number;
  };
  breaches: string[];
}

function dateKeyFromEpoch(epoch: number): string {
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

export async function getOutboundTelemetryHealth(env: Env): Promise<OutboundTelemetryHealthSnapshot> {
  const generatedAt = now();
  const windowStart = generatedAt - 24 * 3600;
  const todayKey = dateKeyFromEpoch(generatedAt);
  const yesterdayKey = dateKeyFromEpoch(generatedAt - 24 * 3600);

  let bindingAttempts = 0;
  let bindingSuccess = 0;
  let bindingFailures = 0;
  let avgLatencyMs = 0;

  try {
    const bindingRow = await queryOne<{
      attempts: number;
      success: number;
      failures: number;
      avg_latency_ms: number;
    }>(
      env.DB,
      `SELECT
         COUNT(*) as attempts,
         COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as success,
         COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) as failures,
         COALESCE(AVG(latency_ms), 0) as avg_latency_ms
       FROM service_binding_metrics
       WHERE binding IN ('analytics_events', 'analytics_events_replay')
         AND created_at >= ?`,
      [windowStart],
    );

    bindingAttempts = Number(bindingRow?.attempts ?? 0);
    bindingSuccess = Number(bindingRow?.success ?? 0);
    bindingFailures = Number(bindingRow?.failures ?? 0);
    avgLatencyMs = Number(bindingRow?.avg_latency_ms ?? 0);
  } catch {
    // Table may be absent before migrations are applied; degrade gracefully.
  }

  let sent = 0;
  let receipts = 0;
  let channels: OutboundTelemetryHealthSnapshot['channels'] = [];

  try {
    const channelRow = await queryOne<{
      sent_count: number;
      delivered_count: number;
      bounced_count: number;
      failed_count: number;
      complained_count: number;
      unsubscribed_count: number;
      dismissed_count: number;
    }>(
      env.DB,
      `SELECT
         COALESCE(SUM(sent_count), 0) as sent_count,
         COALESCE(SUM(delivered_count), 0) as delivered_count,
         COALESCE(SUM(bounced_count), 0) as bounced_count,
         COALESCE(SUM(failed_count), 0) as failed_count,
         COALESCE(SUM(complained_count), 0) as complained_count,
         COALESCE(SUM(unsubscribed_count), 0) as unsubscribed_count,
         COALESCE(SUM(dismissed_count), 0) as dismissed_count
       FROM telemetry_channel_daily
       WHERE date_key IN (?, ?)`,
      [todayKey, yesterdayKey],
    );

    sent = Number(channelRow?.sent_count ?? 0);
    receipts =
      Number(channelRow?.delivered_count ?? 0)
      + Number(channelRow?.bounced_count ?? 0)
      + Number(channelRow?.failed_count ?? 0)
      + Number(channelRow?.complained_count ?? 0)
      + Number(channelRow?.unsubscribed_count ?? 0)
      + Number(channelRow?.dismissed_count ?? 0);

    const channelRows = await query<{
      channel: string;
      sent_count: number;
      delivered_count: number;
      bounced_count: number;
      failed_count: number;
      complained_count: number;
      unsubscribed_count: number;
      dismissed_count: number;
      avg_latency_ms: number;
      latency_samples: number;
    }>(
      env.DB,
      `SELECT
         channel,
         COALESCE(SUM(sent_count), 0) as sent_count,
         COALESCE(SUM(delivered_count), 0) as delivered_count,
         COALESCE(SUM(bounced_count), 0) as bounced_count,
         COALESCE(SUM(failed_count), 0) as failed_count,
         COALESCE(SUM(complained_count), 0) as complained_count,
         COALESCE(SUM(unsubscribed_count), 0) as unsubscribed_count,
         COALESCE(SUM(dismissed_count), 0) as dismissed_count,
         CASE
           WHEN COALESCE(SUM(delivery_latency_samples), 0) = 0 THEN 0
           ELSE COALESCE(SUM(avg_delivery_latency_ms * delivery_latency_samples), 0)
                / SUM(delivery_latency_samples)
         END as avg_latency_ms,
         COALESCE(SUM(delivery_latency_samples), 0) as latency_samples
       FROM telemetry_channel_daily
       WHERE date_key IN (?, ?)
       GROUP BY channel
       ORDER BY channel ASC`,
      [todayKey, yesterdayKey],
    );

    channels = channelRows.map((row) => {
      const rowSent = Number(row.sent_count ?? 0);
      const rowDelivered = Number(row.delivered_count ?? 0);
      const rowBounced = Number(row.bounced_count ?? 0);
      const rowFailed = Number(row.failed_count ?? 0);
      const rowComplained = Number(row.complained_count ?? 0);
      const rowUnsubscribed = Number(row.unsubscribed_count ?? 0);
      const rowDismissed = Number(row.dismissed_count ?? 0);
      const rowReceipts = rowDelivered + rowBounced + rowFailed + rowComplained + rowUnsubscribed + rowDismissed;

      return {
        channel: row.channel,
        sent: rowSent,
        delivered: rowDelivered,
        receipts: rowReceipts,
        failed: rowFailed,
        bounced: rowBounced,
        complained: rowComplained,
        unsubscribed: rowUnsubscribed,
        dismissed: rowDismissed,
        sendSuccessRate: rowSent > 0 ? (rowDelivered / rowSent) * 100 : 100,
        webhookReceiptRate: rowSent > 0 ? Math.min(100, (rowReceipts / rowSent) * 100) : 100,
        avgLatencyMs: Number(row.avg_latency_ms ?? 0),
        latencySamples: Number(row.latency_samples ?? 0),
      };
    });
  } catch {
    // Table may be absent before migrations are applied; degrade gracefully.
  }

  let queuePending = 0;
  let queueRetryable = 0;
  let queueDeadLetter = 0;
  let oldestPendingAgeSec: number | null = null;

  try {
    const queueRow = await queryOne<{
      pending_count: number;
      retryable_count: number;
      dead_letter_count: number;
      oldest_created_at: number | null;
    }>(
      env.DB,
      `SELECT
         COUNT(*) as pending_count,
         COALESCE(SUM(CASE WHEN retryable = 1 THEN 1 ELSE 0 END), 0) as retryable_count,
         COALESCE(SUM(CASE WHEN retryable = 0 THEN 1 ELSE 0 END), 0) as dead_letter_count,
         MIN(created_at) as oldest_created_at
       FROM telemetry_fallback_queue
       WHERE replayed_at IS NULL`,
    );

    queuePending = Number(queueRow?.pending_count ?? 0);
    queueRetryable = Number(queueRow?.retryable_count ?? 0);
    queueDeadLetter = Number(queueRow?.dead_letter_count ?? 0);
    if (queueRow?.oldest_created_at != null) {
      oldestPendingAgeSec = Math.max(0, generatedAt - Number(queueRow.oldest_created_at));
    }
  } catch {
    // Table may be absent before migrations are applied; degrade gracefully.
  }

  let qualityDeadLetterCount24h = 0;
  let qualityRetryableDeadLetterCount24h = 0;
  let qualityNonRetryableDeadLetterCount24h = 0;
  let qualityUnsupportedOutcomeCount24h = 0;
  let qualityReverseEmitFailureCount24h = 0;

  try {
    const qualityRow = await queryOne<{
      dead_letter_count: number;
      retryable_dead_letter_count: number;
      non_retryable_dead_letter_count: number;
      unsupported_outcome_count: number;
      reverse_emit_failure_count: number;
    }>(
      env.DB,
      `SELECT
         COUNT(*) AS dead_letter_count,
         COALESCE(SUM(CASE WHEN retryable = 1 THEN 1 ELSE 0 END), 0) AS retryable_dead_letter_count,
         COALESCE(SUM(CASE WHEN retryable = 0 THEN 1 ELSE 0 END), 0) AS non_retryable_dead_letter_count,
         COALESCE(SUM(CASE WHEN error_code = 'unsupported_outcome_mapping' THEN 1 ELSE 0 END), 0) AS unsupported_outcome_count,
         COALESCE(SUM(CASE WHEN error_code = 'reverse_tracking_emit_failed' THEN 1 ELSE 0 END), 0) AS reverse_emit_failure_count
       FROM channel_outcome_dead_letter
       WHERE last_failed_at >= ?
         AND replayed_at IS NULL`,
      [windowStart],
    );

    qualityDeadLetterCount24h = Number(qualityRow?.dead_letter_count ?? 0);
    qualityRetryableDeadLetterCount24h = Number(qualityRow?.retryable_dead_letter_count ?? 0);
    qualityNonRetryableDeadLetterCount24h = Number(qualityRow?.non_retryable_dead_letter_count ?? 0);
    qualityUnsupportedOutcomeCount24h = Number(qualityRow?.unsupported_outcome_count ?? 0);
    qualityReverseEmitFailureCount24h = Number(qualityRow?.reverse_emit_failure_count ?? 0);
  } catch {
    // Table may be absent before migrations are applied; degrade gracefully.
  }

  const supportedSchemaVersions = resolveSupportedSchemaVersions(env);
  let schemaCoercionCount24h = 0;

  try {
    const schemaRow = await queryOne<{ coercion_count: number }>(
      env.DB,
      `SELECT COUNT(*) AS coercion_count
         FROM service_binding_metrics
        WHERE binding = 'schema_alignment'
          AND success = 0
          AND created_at >= ?`,
      [windowStart],
    );
    schemaCoercionCount24h = Number(schemaRow?.coercion_count ?? 0);
  } catch {
    // Table may be absent before migrations are applied; degrade gracefully.
  }

  const sendSuccessRate =
    bindingAttempts > 0
      ? (bindingSuccess / bindingAttempts) * 100
      : 100;
  const webhookReceiptRate =
    sent > 0
      ? Math.min(100, (receipts / sent) * 100)
      : 100;

  const breaches: string[] = [];
  if (bindingAttempts > 0 && sendSuccessRate < TELEMETRY.ALERT_SEND_SUCCESS_RATE_MIN) {
    breaches.push('send_success_rate');
  }
  if (sent > 0 && webhookReceiptRate < TELEMETRY.ALERT_WEBHOOK_RECEIPT_RATE_MIN) {
    breaches.push('webhook_receipt_rate');
  }
  if (bindingAttempts > 0 && avgLatencyMs > TELEMETRY.ALERT_AVG_LATENCY_MAX_MS) {
    breaches.push('avg_latency_ms');
  }
  if (bindingFailures > TELEMETRY.ALERT_ERROR_COUNT_MAX_24H) {
    breaches.push('error_count_24h');
  }
  if (qualityDeadLetterCount24h > TELEMETRY.ALERT_DEAD_LETTER_MAX_24H) {
    breaches.push('dead_letter_24h');
  }
  if (schemaCoercionCount24h > TELEMETRY.ALERT_SCHEMA_COERCION_MAX_24H) {
    breaches.push('schema_alignment');
  }

  return {
    generatedAt,
    windowHours: 24,
    sendSuccessRate,
    webhookReceiptRate,
    avgLatencyMs,
    errorCount24h: bindingFailures,
    channels,
    totals: {
      bindingAttempts,
      bindingSuccess,
      bindingFailures,
      sent,
      receipts,
    },
    fallbackQueue: {
      pending: queuePending,
      retryable: queueRetryable,
      deadLetter: queueDeadLetter,
      oldestPendingAgeSec,
    },
    quality: {
      deadLetterCount24h: qualityDeadLetterCount24h,
      retryableDeadLetterCount24h: qualityRetryableDeadLetterCount24h,
      nonRetryableDeadLetterCount24h: qualityNonRetryableDeadLetterCount24h,
      unsupportedOutcomeCount24h: qualityUnsupportedOutcomeCount24h,
      reverseEmitFailureCount24h: qualityReverseEmitFailureCount24h,
    },
    schemaAlignment: {
      defaultSchemaVersion: TELEMETRY.SCHEMA_VERSION,
      supportedSchemaVersions,
      coercedCount24h: schemaCoercionCount24h,
    },
    thresholds: {
      sendSuccessRateMin: TELEMETRY.ALERT_SEND_SUCCESS_RATE_MIN,
      webhookReceiptRateMin: TELEMETRY.ALERT_WEBHOOK_RECEIPT_RATE_MIN,
      avgLatencyMaxMs: TELEMETRY.ALERT_AVG_LATENCY_MAX_MS,
      errorCountMax24h: TELEMETRY.ALERT_ERROR_COUNT_MAX_24H,
      deadLetterMax24h: TELEMETRY.ALERT_DEAD_LETTER_MAX_24H,
      schemaCoercionMax24h: TELEMETRY.ALERT_SCHEMA_COERCION_MAX_24H,
    },
    breaches,
  };
}

export async function evaluateOutboundTelemetryAlerts(
  env: Env,
): Promise<{ snapshot: OutboundTelemetryHealthSnapshot; emitted: string[] }> {
  const snapshot = await getOutboundTelemetryHealth(env);
  const emitted: string[] = [];

  for (const breach of snapshot.breaches) {
    const suppressionKey = `${KV_PREFIX.OUTBOUND_ALERT_SUPPRESS}${breach}`;
    const suppressed = await env.KV_MARKETING.get(suppressionKey);
    if (suppressed) {
      continue;
    }

    emitted.push(breach);
    await env.KV_MARKETING.put(suppressionKey, String(snapshot.generatedAt), {
      expirationTtl: TELEMETRY.ALERT_SUPPRESSION_TTL_SECS,
    });

    await logEvent(env, 'telemetry.outbound.alert', {
      breach,
      sendSuccessRate: snapshot.sendSuccessRate,
      webhookReceiptRate: snapshot.webhookReceiptRate,
      avgLatencyMs: snapshot.avgLatencyMs,
      errorCount24h: snapshot.errorCount24h,
      queuePending: snapshot.fallbackQueue.pending,
      deadLetter24h: snapshot.quality.deadLetterCount24h,
      schemaCoercions24h: snapshot.schemaAlignment.coercedCount24h,
    }, 'warn');

    const summary = [
      `[Outbound Telemetry Alert] ${breach}`,
      `send_success_rate=${snapshot.sendSuccessRate.toFixed(2)}%`,
      `webhook_receipt_rate=${snapshot.webhookReceiptRate.toFixed(2)}%`,
      `avg_latency_ms=${Math.round(snapshot.avgLatencyMs)}`,
      `error_count_24h=${snapshot.errorCount24h}`,
      `fallback_queue_pending=${snapshot.fallbackQueue.pending}`,
      `dead_letter_24h=${snapshot.quality.deadLetterCount24h}`,
      `schema_coercions_24h=${snapshot.schemaAlignment.coercedCount24h}`,
    ].join(' | ');

    await Promise.allSettled([
      sendSlackNotification(env, summary),
      sendDiscordNotification(env, summary),
    ]);
  }

  return { snapshot, emitted };
}
