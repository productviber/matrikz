/**
 * Payout Processing Routes
 *
 * Monthly batch payout workflow:
 * 1. Query unpaid conversions per affiliate
 * 2. Calculate totals
 * 3. Create payout batch
 * 4. Process payouts (PayPal / bank transfer)
 * 5. Record payout in DB
 */

import type { Env, PayoutBatchRow, PayoutItemRow } from '../types';
import { ok, badRequest, notFound, serverError } from '../lib/response';
import { query, queryOne, execute, now, formatCents } from '../lib/db';
import { notifyPayoutCompleted } from '../lib/notifications';
import { processPayoutItem } from '../lib/payout-provider';
import { runWithConcurrency } from '../lib/concurrency';
import { logEvent } from '../lib/observability';
import {
  KV_PREFIX,
  PAYOUT_STATUS,
  PAGINATION,
  DEFAULTS,
  NOTE_TYPE,
  MESSAGES,
} from '../constants';

const PAYOUT_INSERT_CONCURRENCY = 6;
const PAYOUT_PROCESS_CONCURRENCY = 4;

/**
 * POST /api/payouts/batch (Admin only)
 *
 * Create a new payout batch — calculates unpaid earnings for all affiliates.
 */
export async function handleCreatePayoutBatch(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // Get all affiliates with stats from KV
    // We'll list affiliate codes from notes table
    const affiliates = await query<{ affiliate_code: string }>(
      env.DB,
      `SELECT DISTINCT affiliate_code FROM affiliate_notes WHERE note_type = '${NOTE_TYPE.CONVERSION}'`
    );

    if (affiliates.length === 0) {
      return ok({ message: MESSAGES.errors.noAffiliatesFound, batch: null });
    }

    const affiliateCodes = affiliates
      .map((a) => a.affiliate_code)
      .filter((code) => Boolean(code));

    // Load already-paid totals for all affiliates in one query.
    const paidByAffiliate = new Map<string, number>();
    if (affiliateCodes.length > 0) {
      const placeholders = affiliateCodes.map(() => '?').join(',');
      const paidRows = await query<{ affiliate_code: string; total_paid: number }>(
        env.DB,
        `SELECT affiliate_code, COALESCE(SUM(amount_cents), 0) as total_paid
         FROM payout_items
         WHERE status = '${PAYOUT_STATUS.SENT}' AND affiliate_code IN (${placeholders})
         GROUP BY affiliate_code`,
        affiliateCodes
      );
      for (const row of paidRows) {
        const code = row.affiliate_code ?? (affiliateCodes.length === 1 ? affiliateCodes[0] : undefined);
        if (code) {
          paidByAffiliate.set(code, row.total_paid ?? 0);
        }
      }
    }

    // Fetch KV-backed earnings/email metadata concurrently.
    const affiliateSnapshots = await Promise.all(
      affiliateCodes.map(async (code) => {
        const [statsJson, email] = await Promise.all([
          env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_STATS}${code}`),
          env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_EMAIL}${code}`),
        ]);

        let totalEarnedCents = 0;
        if (statsJson) {
          try {
            const stats = JSON.parse(statsJson) as { totalEarnedCents?: number };
            totalEarnedCents = stats.totalEarnedCents ?? 0;
          } catch {
            totalEarnedCents = 0;
          }
        }

        return {
          code,
          email,
          totalEarnedCents,
          totalPaid: paidByAffiliate.get(code) ?? 0,
        };
      })
    );

    const items = affiliateSnapshots
      .map((snapshot) => ({
        code: snapshot.code,
        email: snapshot.email,
        amountCents: snapshot.totalEarnedCents - snapshot.totalPaid,
      }))
      .filter((item): item is { code: string; email: string; amountCents: number } =>
        Boolean(item.email) && item.amountCents > 0
      );

    if (items.length === 0) {
      return ok({ message: MESSAGES.errors.noUnpaidEarnings, batch: null });
    }

    const totalAmount = items.reduce((sum, i) => sum + i.amountCents, 0);
    await logEvent(env, 'payout.batch.create.started', {
      affiliateCount: items.length,
      totalAmount,
    });

    // Create batch
    await execute(
      env.DB,
      `INSERT INTO payout_batches (status, total_amount_cents, affiliate_count)
       VALUES ('${PAYOUT_STATUS.PENDING}', ?, ?)`,
      [totalAmount, items.length]
    );

    const batch = await queryOne<PayoutBatchRow>(
      env.DB,
      `SELECT * FROM payout_batches ORDER BY id DESC LIMIT 1`
    );

    if (!batch) {
      return serverError(MESSAGES.errors.failedCreateBatch);
    }

    // Create payout items with bounded fan-out to avoid serial N+1 writes.
    await runWithConcurrency(items, PAYOUT_INSERT_CONCURRENCY, async (item) => {
      await execute(
        env.DB,
        `INSERT INTO payout_items (batch_id, affiliate_code, affiliate_email, amount_cents)
         VALUES (?, ?, ?, ?)`,
        [batch.id, item.code, item.email, item.amountCents]
      );
    });

    return ok({
      batch: {
        id: batch.id,
        status: PAYOUT_STATUS.PENDING,
        totalAmountCents: totalAmount,
        totalFormatted: formatCents(totalAmount),
        affiliateCount: items.length,
        items: items.map((i) => ({
          code: i.code,
          email: i.email,
          amountCents: i.amountCents,
          formatted: formatCents(i.amountCents),
        })),
      },
    });
  } catch (err) {
    console.error('[Payouts:Create] Error:', err);
    await logEvent(env, 'payout.batch.create.failed', {
      error: err instanceof Error ? err.message : String(err),
    }, 'error');
    return serverError(MESSAGES.errors.failedCreateBatch);
  }
}

/**
 * POST /api/payouts/batch/:id/process (Admin only)
 *
 * Process a pending payout batch — mark items as sent and record references.
 * In a real system, this would integrate with PayPal/Stripe Connect/bank APIs.
 */
export async function handleProcessPayoutBatch(
  request: Request,
  env: Env,
  batchId: number
): Promise<Response> {
  const batch = await queryOne<PayoutBatchRow>(
    env.DB,
    `SELECT * FROM payout_batches WHERE id = ?`,
    [batchId]
  );

  if (!batch) return notFound(MESSAGES.errors.batchNotFound);
  if (batch.status !== PAYOUT_STATUS.PENDING) {
    return badRequest(MESSAGES.errors.batchAlreadyProcessed(batch.status));
  }

  try {
    await logEvent(env, 'payout.batch.process.started', { batchId });
    // Mark batch as processing
    await execute(
      env.DB,
      `UPDATE payout_batches SET status = '${PAYOUT_STATUS.PROCESSING}' WHERE id = ?`,
      [batchId]
    );

    // Get items
    const items = await query<PayoutItemRow>(
      env.DB,
      `SELECT * FROM payout_items WHERE batch_id = ? AND status = '${PAYOUT_STATUS.PENDING}'`,
      [batchId]
    );

    // Process body may contain method and reference overrides
    let bodyData: { method?: string; references?: Record<string, string> } = {};
    try {
      bodyData = await request.json();
    } catch {
      // Empty body is fine
    }

    const defaultMethod = bodyData.method ?? DEFAULTS.PAYOUT_METHOD;

    let successCount = 0;
    await runWithConcurrency(items, PAYOUT_PROCESS_CONCURRENCY, async (item) => {
      try {
        // Resolve affiliate email from item record or KV cache
        const affiliateEmail =
          item.affiliate_email ??
          (await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_EMAIL}${item.affiliate_code}`)) ??
          item.affiliate_code;

        // Call the pluggable payout provider (stub by default)
        const result = await processPayoutItem(env, {
          affiliateCode: item.affiliate_code,
          email: affiliateEmail,
          amountCents: item.amount_cents,
          batchId: batch.id,
        });

        const reference =
          result.reference ||
          bodyData.references?.[item.affiliate_code] ||
          `payout-${batch.id}-${item.affiliate_code}-${Date.now()}`;

        if (result.success) {
          await execute(
            env.DB,
            `UPDATE payout_items SET status = '${PAYOUT_STATUS.SENT}', method = ?, reference = ? WHERE id = ?`,
            [defaultMethod, reference, item.id]
          );

          // Log to affiliate notes
          await execute(
            env.DB,
            `INSERT INTO affiliate_notes (affiliate_code, note_type, content)
             VALUES (?, '${NOTE_TYPE.PAYOUT}', ?)`,
            [
              item.affiliate_code,
              MESSAGES.notes.payoutProcessed(formatCents(item.amount_cents), defaultMethod, reference),
            ]
          );

          successCount++;
        } else {
          console.error(`[Payouts] Provider rejected item ${item.id}: ${result.errorMessage}`);
          await execute(
            env.DB,
            `UPDATE payout_items SET status = '${PAYOUT_STATUS.FAILED}' WHERE id = ?`,
            [item.id]
          );
        }
      } catch (err) {
        console.error(`[Payouts] Failed to process item ${item.id}:`, err);
        await execute(
          env.DB,
          `UPDATE payout_items SET status = '${PAYOUT_STATUS.FAILED}' WHERE id = ?`,
          [item.id]
        );
      }
    });

    // Update batch status
    const finalStatus = successCount === items.length ? PAYOUT_STATUS.COMPLETED : PAYOUT_STATUS.FAILED;
    await execute(
      env.DB,
      `UPDATE payout_batches SET status = ?, completed_at = ? WHERE id = ?`,
      [finalStatus, now(), batchId]
    );

    // Send notifications
    if (finalStatus === PAYOUT_STATUS.COMPLETED) {
      await notifyPayoutCompleted(env, batchId, batch.total_amount_cents, batch.affiliate_count);
    }

    return ok({
      batchId,
      status: finalStatus,
      processed: successCount,
      total: items.length,
      failed: items.length - successCount,
    });
  } catch (err) {
    console.error('[Payouts:Process] Error:', err);
    await logEvent(env, 'payout.batch.process.failed', {
      batchId,
      error: err instanceof Error ? err.message : String(err),
    }, 'error');
    await execute(
      env.DB,
      `UPDATE payout_batches SET status = '${PAYOUT_STATUS.FAILED}' WHERE id = ?`,
      [batchId]
    );
    return serverError(MESSAGES.errors.failedProcessBatch);
  }
}

/**
 * GET /api/payouts (Admin only)
 *
 * List payout batches.
 */
export async function handleListPayoutBatches(
  request: Request,
  env: Env
): Promise<Response> {
  const batches = await query<PayoutBatchRow>(
    env.DB,
    `SELECT * FROM payout_batches ORDER BY initiated_at DESC LIMIT ${PAGINATION.DEFAULT_PAGE_SIZE}`
  );

  return ok({
    batches: batches.map((b) => ({
      ...b,
      totalFormatted: formatCents(b.total_amount_cents),
    })),
  });
}

/**
 * GET /api/payouts/:id (Admin only)
 *
 * Get payout batch details with items.
 */
export async function handleGetPayoutBatch(
  request: Request,
  env: Env,
  batchId: number
): Promise<Response> {
  const batch = await queryOne<PayoutBatchRow>(
    env.DB,
    `SELECT * FROM payout_batches WHERE id = ?`,
    [batchId]
  );

  if (!batch) return notFound(MESSAGES.errors.batchNotFound);

  const items = await query<PayoutItemRow>(
    env.DB,
    `SELECT * FROM payout_items WHERE batch_id = ? ORDER BY affiliate_code`,
    [batchId]
  );

  return ok({
    batch: {
      ...batch,
      totalFormatted: formatCents(batch.total_amount_cents),
    },
    items: items.map((i) => ({
      ...i,
      amountFormatted: formatCents(i.amount_cents),
    })),
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

