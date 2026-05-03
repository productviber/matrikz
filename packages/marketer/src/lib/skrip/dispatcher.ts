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
import { SKRIP_CONFIG, SKRIP_OUTBOX_STATUS, TTL } from '../../constants';
import { batch, execute, now, query } from '../db';
import { createSkripClient } from './client';
import { getCorrelationId } from '../correlation';

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
  return query<ChannelExecutionOutboxRow>(
    env.DB,
    `SELECT *
       FROM channel_execution_outbox
      WHERE status IN (?, ?)
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC
      LIMIT ?`,
    [SKRIP_OUTBOX_STATUS.PENDING, SKRIP_OUTBOX_STATUS.RETRYING, now(), batchSize],
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
}

// ── Main Dispatcher ────────────────────────────────────────────────────────

export async function dispatchOutboxBatch(
  env: Env,
  batchSize = 25,
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
        correlationId: getCorrelationId(),
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
  const batchSize = options.batchSize ?? 25;

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
