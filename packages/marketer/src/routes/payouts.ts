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
import { ok, badRequest, notFound, serverError, unauthorized } from '../lib/response';
import { query, queryOne, execute, now, formatCents } from '../lib/db';
import { notifyPayoutCompleted } from '../lib/notifications';

/**
 * POST /api/payouts/batch (Admin only)
 *
 * Create a new payout batch — calculates unpaid earnings for all affiliates.
 */
export async function handleCreatePayoutBatch(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return unauthorized();

  try {
    // Get all affiliates with stats from KV
    // We'll list affiliate codes from notes table
    const affiliates = await query<{ affiliate_code: string }>(
      env.DB,
      `SELECT DISTINCT affiliate_code FROM affiliate_notes WHERE note_type = 'conversion'`
    );

    if (affiliates.length === 0) {
      return ok({ message: 'No affiliates with conversions found', batch: null });
    }

    const items: { code: string; email: string; amountCents: number }[] = [];

    for (const aff of affiliates) {
      const code = aff.affiliate_code;

      // Get total earned from KV
      const statsJson = await env.KV_MARKETING.get(`affiliate-stats:${code}`);
      if (!statsJson) continue;
      const stats = JSON.parse(statsJson);

      // Get total already paid
      const paidResult = await queryOne<{ total_paid: number }>(
        env.DB,
        `SELECT COALESCE(SUM(amount_cents), 0) as total_paid
         FROM payout_items
         WHERE affiliate_code = ? AND status = 'sent'`,
        [code]
      );
      const totalPaid = paidResult?.total_paid ?? 0;

      const unpaid = stats.totalEarnedCents - totalPaid;
      if (unpaid <= 0) continue;

      // Get affiliate email
      const email = await env.KV_MARKETING.get(`affiliate-email:${code}`);
      if (!email) continue;

      items.push({ code, email, amountCents: unpaid });
    }

    if (items.length === 0) {
      return ok({ message: 'No unpaid earnings to process', batch: null });
    }

    const totalAmount = items.reduce((sum, i) => sum + i.amountCents, 0);

    // Create batch
    await execute(
      env.DB,
      `INSERT INTO payout_batches (status, total_amount_cents, affiliate_count)
       VALUES ('pending', ?, ?)`,
      [totalAmount, items.length]
    );

    const batch = await queryOne<PayoutBatchRow>(
      env.DB,
      `SELECT * FROM payout_batches ORDER BY id DESC LIMIT 1`
    );

    if (!batch) {
      return serverError('Failed to create payout batch');
    }

    // Create payout items
    for (const item of items) {
      await execute(
        env.DB,
        `INSERT INTO payout_items (batch_id, affiliate_code, affiliate_email, amount_cents)
         VALUES (?, ?, ?, ?)`,
        [batch.id, item.code, item.email, item.amountCents]
      );
    }

    return ok({
      batch: {
        id: batch.id,
        status: 'pending',
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
    return serverError('Failed to create payout batch');
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
  if (!isAdmin(request, env)) return unauthorized();

  const batch = await queryOne<PayoutBatchRow>(
    env.DB,
    `SELECT * FROM payout_batches WHERE id = ?`,
    [batchId]
  );

  if (!batch) return notFound('Batch not found');
  if (batch.status !== 'pending') {
    return badRequest(`Batch is already ${batch.status}`);
  }

  try {
    // Mark batch as processing
    await execute(
      env.DB,
      `UPDATE payout_batches SET status = 'processing' WHERE id = ?`,
      [batchId]
    );

    // Get items
    const items = await query<PayoutItemRow>(
      env.DB,
      `SELECT * FROM payout_items WHERE batch_id = ? AND status = 'pending'`,
      [batchId]
    );

    // Process body may contain method and reference overrides
    let bodyData: { method?: string; references?: Record<string, string> } = {};
    try {
      bodyData = await request.json();
    } catch {
      // Empty body is fine
    }

    const defaultMethod = bodyData.method ?? 'manual';

    let successCount = 0;
    for (const item of items) {
      const reference = bodyData.references?.[item.affiliate_code]
        ?? `payout-${batch.id}-${item.affiliate_code}-${Date.now()}`;

      try {
        // In production, this is where you'd call PayPal/bank API
        // For now, we mark as sent with a reference

        await execute(
          env.DB,
          `UPDATE payout_items SET status = 'sent', method = ?, reference = ? WHERE id = ?`,
          [defaultMethod, reference, item.id]
        );

        // Log to affiliate notes
        await execute(
          env.DB,
          `INSERT INTO affiliate_notes (affiliate_code, note_type, content)
           VALUES (?, 'payout', ?)`,
          [
            item.affiliate_code,
            `Payout of ${formatCents(item.amount_cents)} via ${defaultMethod} (ref: ${reference})`,
          ]
        );

        successCount++;
      } catch (err) {
        console.error(`[Payouts] Failed to process item ${item.id}:`, err);
        await execute(
          env.DB,
          `UPDATE payout_items SET status = 'failed' WHERE id = ?`,
          [item.id]
        );
      }
    }

    // Update batch status
    const finalStatus = successCount === items.length ? 'completed' : 'failed';
    await execute(
      env.DB,
      `UPDATE payout_batches SET status = ?, completed_at = ? WHERE id = ?`,
      [finalStatus, now(), batchId]
    );

    // Send notifications
    if (finalStatus === 'completed') {
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
    await execute(
      env.DB,
      `UPDATE payout_batches SET status = 'failed' WHERE id = ?`,
      [batchId]
    );
    return serverError('Failed to process payout batch');
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
  if (!isAdmin(request, env)) return unauthorized();

  const batches = await query<PayoutBatchRow>(
    env.DB,
    `SELECT * FROM payout_batches ORDER BY initiated_at DESC LIMIT 50`
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
  if (!isAdmin(request, env)) return unauthorized();

  const batch = await queryOne<PayoutBatchRow>(
    env.DB,
    `SELECT * FROM payout_batches WHERE id = ?`,
    [batchId]
  );

  if (!batch) return notFound('Batch not found');

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

function isAdmin(request: Request, env: Env): boolean {
  const authHeader = request.headers.get('Authorization');
  return authHeader === `Bearer ${env.ADMIN_TOKEN}`;
}
