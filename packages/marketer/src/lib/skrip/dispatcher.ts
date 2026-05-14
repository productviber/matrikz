/**
 * Skrip Outbox Dispatcher
 *
 * Claims eligible rows from channel_execution_outbox and delivers them via
 * the Skrip API. Writes message lineage on acceptance and pushes rows to the
 * dead-letter queue after max-retries are exhausted.
 *
 * Safety rules:
 *   - dry_run rows are never dispatched; their status is left unchanged.
 *   - Dispatches are idempotent: the idempotency_key is forwarded to Skrip.
 *   - The circuit breaker inside SkripClient prevents cascading failures.
 *   - Failed rows receive exponential backoff via next_attempt_at.
 */

import type { ChannelExecutionOutboxRow, ChannelMessageLineageRow, Env } from '../../types';
import { EVENT_TYPES, SKRIP_CONFIG, SKRIP_OUTBOX_STATUS, TTL } from '../../constants';
import { batch, execute, now, query } from '../db';
import { createSkripClient } from './client';
import { getCorrelationId } from '../correlation';
import { emitTelemetryEvent } from '../telemetry';

// ── Internal types for Skrip send/response shapes ─────────────────────────

interface SkripSendRequest {
  idempotencyKey: string;
  tenantId: string;
  campaignId: string;
  journeyId: string | null;
  stepId: string;
  contact: {
    externalContactId: string;
    canonicalId: string | null;
  };
  channel: string;
  schedule: {
    mode: string;
    scheduledFor: string;
    scheduleSlot: string;
  };
  metadata: Record<string, unknown>;
  context: Record<string, unknown>;
}

interface SkripSendResponse {
  messageId: string;
  outboundId?: string | null;
}

export interface DispatchResult {
  total: number;
  dispatched: number;
  skipped: number;
  failed: number;
  errors: string[];
}

// ── Backoff policy ─────────────────────────────────────────────────────────

const BACKOFF_SECONDS = [60, 300, 900, 3_600, 14_400] as const;

function nextRetryAt(attemptCount: number): number {
  const delay = BACKOFF_SECONDS[Math.min(attemptCount, BACKOFF_SECONDS.length - 1)];
  return now() + delay;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function claimPendingBatch(
  env: Env,
  batchSize: number,
): Promise<ChannelExecutionOutboxRow[]> {
  const epoch = now();
  const perTenantLimit = SKRIP_CONFIG.DISPATCH_PER_TENANT_LIMIT;
  // Subquery ranks rows per tenant so each tenant gets at most perTenantLimit slots.
  // This prevents a single high-volume tenant from consuming the whole batch window.
  return query<ChannelExecutionOutboxRow>(
    env.DB,
    `SELECT *
       FROM channel_execution_outbox
      WHERE status IN (?, ?)
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND id IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY tenant_id
                     ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC
                   ) AS rn
              FROM channel_execution_outbox
             WHERE status IN (?, ?)
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ) WHERE rn <= ?
        )
      ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC
      LIMIT ?`,
    [
      SKRIP_OUTBOX_STATUS.PENDING, SKRIP_OUTBOX_STATUS.RETRYING, epoch,
      SKRIP_OUTBOX_STATUS.PENDING, SKRIP_OUTBOX_STATUS.RETRYING, epoch,
      perTenantLimit,
      batchSize,
    ],
  );
}

async function markDispatched(
  env: Env,
  outboxId: number,
  messageId: string,
  skripOutboundId: string | null,
): Promise<void> {
  const epoch = now();
  await execute(
    env.DB,
    `UPDATE channel_execution_outbox
        SET status = ?, updated_at = ?
      WHERE id = ?`,
    [SKRIP_OUTBOX_STATUS.DISPATCHED, epoch, outboxId],
  );

  const row = await query<ChannelExecutionOutboxRow>(
    env.DB,
    `SELECT * FROM channel_execution_outbox WHERE id = ?`,
    [outboxId],
  );
  if (!row[0]) return;
  const r = row[0];

  await execute(
    env.DB,
    `INSERT INTO channel_message_lineage
      (tenant_id, campaign_id, journey_id, step_id, contact_id, channel, message_id, skrip_outbound_id, provider_ref, idempotency_key, latest_status, first_sent_at, last_outcome_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'accepted', ?, NULL, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       skrip_outbound_id = COALESCE(excluded.skrip_outbound_id, channel_message_lineage.skrip_outbound_id),
       latest_status = 'accepted',
       updated_at = excluded.updated_at`,
    [
      r.tenant_id,
      r.campaign_id,
      r.journey_id,
      r.step_id,
      r.contact_id,
      r.channel,
      messageId,
      skripOutboundId ?? null,
      r.idempotency_key,
      epoch,
      epoch,
      epoch,
    ],
  );

  if (r.channel === 'push') {
    await execute(
      env.DB,
      `INSERT INTO push_notifications
        (notification_id, tenant_id, contact_id, campaign_id, step_id, channel, sent_at, delivered_at, clicked_at, dismissed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'push', ?, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(notification_id) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         contact_id = excluded.contact_id,
         campaign_id = excluded.campaign_id,
         step_id = excluded.step_id,
         sent_at = COALESCE(push_notifications.sent_at, excluded.sent_at),
         updated_at = excluded.updated_at`,
      [
        messageId,
        r.tenant_id,
        r.contact_id,
        r.campaign_id,
        r.step_id,
        epoch,
        epoch,
        epoch,
      ],
    );
  }

  const sentEventType = r.channel === 'push'
    ? EVENT_TYPES.OUTBOUND_PUSH_SENT
    : r.channel === 'whatsapp'
      ? EVENT_TYPES.OUTBOUND_WHATSAPP_SENT
      : null;

  if (sentEventType) {
    await emitTelemetryEvent(env, {
      type: sentEventType,
      tenantId: r.tenant_id,
      messageId,
      correlationId: r.correlation_id,
      channel: r.channel,
      timestamp: epoch,
      sendTimestamp: epoch,
      campaignId: r.campaign_id,
      stepId: r.step_id,
      contactId: r.contact_id,
      providerMessageId: skripOutboundId,
      metadata: {
        idempotencyKey: r.idempotency_key,
        outboxId,
      },
    });

    if (r.contact_id.includes('@')) {
      if (r.channel === 'push') {
        await execute(
          env.DB,
          `UPDATE marketing_contacts
              SET push_sent_at = COALESCE(push_sent_at, ?),
                  updated_at = ?
            WHERE email = ?`,
          [epoch, epoch, r.contact_id],
        );
      } else if (r.channel === 'whatsapp') {
        await execute(
          env.DB,
          `UPDATE marketing_contacts
              SET whatsapp_sent_at = COALESCE(whatsapp_sent_at, ?),
                  updated_at = ?
            WHERE email = ?`,
          [epoch, epoch, r.contact_id],
        );
      }
    }
  }
}

async function markRetrying(env: Env, outboxId: number, attemptCount: number, errorMessage: string): Promise<void> {
  const epoch = now();
  const nextAttempt = nextRetryAt(attemptCount);
  await execute(
    env.DB,
    `UPDATE channel_execution_outbox
        SET status = ?,
            attempt_count = ?,
            next_attempt_at = ?,
            last_error_code = 'dispatch_failed',
            last_error_message = ?,
            updated_at = ?
      WHERE id = ?`,
    [SKRIP_OUTBOX_STATUS.RETRYING, attemptCount + 1, nextAttempt, errorMessage.slice(0, 500), epoch, outboxId],
  );
  // Structured retry telemetry for observability dashboards.
  const event = attemptCount === 0 ? 'dispatcher.first_failure' : 'dispatcher.retry_attempt';
  console.log(JSON.stringify({
    event,
    outbox_id: outboxId,
    attempt: attemptCount + 1,
    next_attempt_at: nextAttempt,
    error: errorMessage.slice(0, 200),
    ts: epoch,
  }));
}

async function sendToDeadLetter(env: Env, row: ChannelExecutionOutboxRow, errorMessage: string): Promise<void> {
  const epoch = now();
  await execute(
    env.DB,
    `UPDATE channel_execution_outbox
        SET status = ?, last_error_message = ?, updated_at = ?
      WHERE id = ?`,
    [SKRIP_OUTBOX_STATUS.FAILED, errorMessage.slice(0, 500), epoch, row.id],
  );
  // Emit a lineage DLQ row for operational replay visibility
  await execute(
    env.DB,
    `INSERT INTO channel_outcome_dead_letter
      (tenant_id, event_id, event_type, payload_json, error_code, error_message, retryable, first_failed_at, last_failed_at)
     VALUES (?, ?, 'dispatch.failed', ?, 'max_retries_exceeded', ?, 0, ?, ?)`,
    [
      row.tenant_id,
      row.idempotency_key,
      row.payload_json,
      errorMessage.slice(0, 500),
      epoch,
      epoch,
    ],
  );
  // Structured terminal-failure telemetry.
  console.log(JSON.stringify({
    event: 'dispatcher.terminal_failure',
    outbox_id: row.id,
    tenant_id: row.tenant_id,
    channel: row.channel,
    idempotency_key: row.idempotency_key,
    attempt_count: row.attempt_count,
    error: errorMessage.slice(0, 200),
    ts: epoch,
  }));
}

// ── Main Dispatcher ────────────────────────────────────────────────────────

export async function dispatchOutboxBatch(
  env: Env,
  batchSize: number = SKRIP_CONFIG.DISPATCH_BATCH_SIZE,
): Promise<DispatchResult> {
  const result: DispatchResult = { total: 0, dispatched: 0, skipped: 0, failed: 0, errors: [] };
  const rows = await claimPendingBatch(env, batchSize);
  result.total = rows.length;

  if (rows.length === 0) return result;

  const client = createSkripClient(env);
  if (!client.configured) {
    result.skipped = rows.length;
    console.log('[Dispatcher] Skrip client not configured — skipping dispatch');
    return result;
  }

  for (const row of rows) {
    // Never dispatch dry-run rows
    if (row.status === SKRIP_OUTBOX_STATUS.DRY_RUN) {
      result.skipped++;
      continue;
    }

    let payload: SkripSendRequest;
    try {
      payload = JSON.parse(row.payload_json) as SkripSendRequest;
    } catch {
      result.failed++;
      result.errors.push(`Row ${row.id}: invalid payload JSON`);
      await sendToDeadLetter(env, row, 'invalid payload JSON');
      continue;
    }

    try {
      const response = await client.sendMessage<SkripSendResponse>(row.tenant_id, {
        ...payload,
        idempotencyKey: row.idempotency_key,
        correlationId: row.correlation_id || getCorrelationId(),
      });

      await markDispatched(env, row.id, response.messageId, response.outboundId ?? null);
      result.dispatched++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failed++;
      result.errors.push(`Row ${row.id}: ${msg}`);

      const maxRetries = SKRIP_CONFIG.MAX_RETRIES;
      if (row.attempt_count >= maxRetries) {
        await sendToDeadLetter(env, row, msg);
      } else {
        await markRetrying(env, row.id, row.attempt_count, msg);
      }
    }
  }

  return result;
}

// ── Admin / Manual Trigger ─────────────────────────────────────────────────

export interface DispatchTriggerOptions {
  batchSize?: number;
  dryRunOnly?: boolean;
}

/**
 * Run a manual dispatcher sweep — used from the admin API trigger endpoint.
 * When dryRunOnly=true it reports what would be dispatched without sending.
 */
export async function runDispatcherSweep(
  env: Env,
  options: DispatchTriggerOptions = {},
): Promise<DispatchResult> {
  const batchSize = options.batchSize ?? SKRIP_CONFIG.DISPATCH_BATCH_SIZE;

  if (options.dryRunOnly) {
    const rows = await claimPendingBatch(env, batchSize);
    return {
      total: rows.length,
      dispatched: 0,
      skipped: rows.length,
      failed: 0,
      errors: [],
    };
  }

  return dispatchOutboxBatch(env, batchSize);
}

// ── Dead-Letter Replay ─────────────────────────────────────────────────────

export interface DlqReplayResult {
  scanned: number;
  replayed: number;
  skipped: number;
  errors: string[];
}

/**
 * Replay retryable rows from channel_outcome_dead_letter back into
 * channel_execution_outbox as 'pending' so the next dispatcher sweep picks
 * them up. Non-retryable rows (retryable=0) are never touched.
 *
 * Idempotent: rows already replayed (replayed_at IS NOT NULL) are skipped.
 */
export async function replayDeadLetterBatch(
  env: Env,
  options: { limit?: number; tenantId?: string | null } = {},
): Promise<DlqReplayResult> {
  const limit = Math.min(options.limit ?? 25, 100);
  const result: DlqReplayResult = { scanned: 0, replayed: 0, skipped: 0, errors: [] };

  const rows = await query<{
    id: number;
    tenant_id: string | null;
    event_id: string;
    event_type: string;
    payload_json: string;
  }>(
    env.DB,
    `SELECT id, tenant_id, event_id, event_type, payload_json
       FROM channel_outcome_dead_letter
      WHERE retryable = 1
        AND replayed_at IS NULL
        ${options.tenantId ? 'AND tenant_id = ?' : ''}
      ORDER BY first_failed_at ASC
      LIMIT ?`,
    options.tenantId ? [options.tenantId, limit] : [limit],
  );

  result.scanned = rows.length;
  const epoch = now();

  for (const dlq of rows) {
    // Only replay dispatch.failed rows — they have a valid outbox payload
    if (dlq.event_type !== 'dispatch.failed') {
      result.skipped++;
      continue;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(dlq.payload_json) as Record<string, unknown>;
    } catch {
      result.skipped++;
      result.errors.push(`DLQ row ${dlq.id}: malformed payload`);
      continue;
    }

    // Re-insert into outbox with a fresh idempotency key suffix to allow replay
    const replayKey = `${dlq.event_id}:replay:${epoch}`;
    try {
      await execute(
        env.DB,
        `INSERT OR IGNORE INTO channel_execution_outbox
          (tenant_id, campaign_id, journey_id, step_id, contact_id, channel, schedule_slot,
           idempotency_key, payload_json, status, attempt_count, next_attempt_at,
           last_error_code, last_error_message, correlation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?, ?)`,
        [
          dlq.tenant_id ?? SKRIP_CONFIG.DEFAULT_TENANT_ID,
          (payload.campaignId as string) ?? 'replay',
          (payload.journeyId as string | null) ?? null,
          (payload.stepId as string) ?? 'replay',
          ((payload.contact as Record<string, unknown>)?.externalContactId as string) ?? 'unknown',
          (payload.channel as string) ?? 'push',
          (payload.schedule as Record<string, string>)?.scheduleSlot ?? new Date(epoch * 1000).toISOString().slice(0, 16) + 'Z',
          replayKey,
          dlq.payload_json,
          epoch,
          getCorrelationId(),
          epoch,
          epoch,
        ],
      );
      // Mark the DLQ row as replayed
      await execute(
        env.DB,
        `UPDATE channel_outcome_dead_letter SET replayed_at = ? WHERE id = ?`,
        [epoch, dlq.id],
      );
      result.replayed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`DLQ row ${dlq.id}: ${msg}`);
    }
  }

  return result;
}
