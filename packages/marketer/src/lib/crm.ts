/**
 * CRM Operations — Contact management, segmentation, and revenue tracking.
 */

import type { Env, MarketingContactRow, MrrSnapshotRow } from '../types';
import { query, queryOne, execute, now, todayKey, formatCents } from './db';

// ─── Contact Management ─────────────────────────────────────────────────────

/**
 * Upsert a marketing contact. Creates if not exists, updates if found.
 */
export async function upsertContact(
  env: Env,
  email: string,
  updates: Partial<Omit<MarketingContactRow, 'id' | 'email' | 'first_seen_at'>>
): Promise<void> {
  const existing = await queryOne<MarketingContactRow>(
    env.DB,
    `SELECT * FROM marketing_contacts WHERE email = ?`,
    [email]
  );

  if (existing) {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.status) { sets.push('status = ?'); params.push(updates.status); }
    if (updates.source) { sets.push('source = ?'); params.push(updates.source); }
    if (updates.affiliate_code) { sets.push('affiliate_code = ?'); params.push(updates.affiliate_code); }
    if (updates.converted_at) { sets.push('converted_at = ?'); params.push(updates.converted_at); }
    if (updates.plan) { sets.push('plan = ?'); params.push(updates.plan); }
    if (updates.gateway) { sets.push('gateway = ?'); params.push(updates.gateway); }
    if (updates.total_spent_cents !== undefined) {
      sets.push('total_spent_cents = total_spent_cents + ?');
      params.push(updates.total_spent_cents);
    }
    if (updates.metadata) { sets.push('metadata = ?'); params.push(updates.metadata); }

    sets.push('updated_at = ?');
    params.push(now());
    params.push(email);

    if (sets.length > 1) {
      await execute(
        env.DB,
        `UPDATE marketing_contacts SET ${sets.join(', ')} WHERE email = ?`,
        params
      );
    }
  } else {
    await execute(
      env.DB,
      `INSERT INTO marketing_contacts (email, status, source, affiliate_code, plan, gateway, total_spent_cents, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        email,
        updates.status ?? 'lead',
        updates.source ?? 'direct',
        updates.affiliate_code ?? null,
        updates.plan ?? null,
        updates.gateway ?? null,
        updates.total_spent_cents ?? 0,
        updates.metadata ?? null,
      ]
    );
  }
}

/**
 * Get a contact by email.
 */
export async function getContact(env: Env, email: string): Promise<MarketingContactRow | null> {
  return queryOne<MarketingContactRow>(
    env.DB,
    `SELECT * FROM marketing_contacts WHERE email = ?`,
    [email]
  );
}

/**
 * Move a contact to customer status after purchase.
 */
export async function markAsCustomer(
  env: Env,
  email: string,
  plan: string,
  gateway: string,
  amountCents: number,
  affiliateCode?: string
): Promise<void> {
  await upsertContact(env, email, {
    status: 'customer',
    plan,
    gateway,
    converted_at: now(),
    total_spent_cents: amountCents,
    source: affiliateCode ? 'affiliate' : undefined,
    affiliate_code: affiliateCode ?? undefined,
  });
}

/**
 * Move a contact to churned status.
 */
export async function markAsChurned(env: Env, email: string): Promise<void> {
  await upsertContact(env, email, { status: 'churned' });
}

// ─── Revenue Metrics ────────────────────────────────────────────────────────

/**
 * Update MRR snapshot for today based on a new conversion.
 * This is an incremental update — adds to today's snapshot.
 */
export async function updateMrrSnapshot(
  env: Env,
  amountCents: number,
  plan: string
): Promise<void> {
  const dateKey = todayKey();

  // Calculate monthly equivalent
  let mrrDelta = amountCents;
  if (plan === 'yearly') {
    mrrDelta = Math.round(amountCents / 12);
  }
  const arrDelta = mrrDelta * 12;

  const existing = await queryOne<MrrSnapshotRow>(
    env.DB,
    `SELECT * FROM mrr_snapshots WHERE date_key = ?`,
    [dateKey]
  );

  if (existing) {
    await execute(
      env.DB,
      `UPDATE mrr_snapshots
       SET mrr_cents = mrr_cents + ?,
           arr_cents = arr_cents + ?,
           new_customers = new_customers + 1,
           total_customers = total_customers + 1
       WHERE date_key = ?`,
      [mrrDelta, arrDelta, dateKey]
    );
  } else {
    // Get previous day's totals for carry-forward
    const prev = await queryOne<MrrSnapshotRow>(
      env.DB,
      `SELECT * FROM mrr_snapshots ORDER BY date_key DESC LIMIT 1`
    );

    await execute(
      env.DB,
      `INSERT INTO mrr_snapshots (date_key, mrr_cents, arr_cents, total_customers, new_customers, churned_customers)
       VALUES (?, ?, ?, ?, 1, 0)`,
      [
        dateKey,
        (prev?.mrr_cents ?? 0) + mrrDelta,
        (prev?.arr_cents ?? 0) + arrDelta,
        (prev?.total_customers ?? 0) + 1,
      ]
    );
  }
}

/**
 * Get the latest MRR snapshot.
 */
export async function getLatestMrrSnapshot(env: Env): Promise<MrrSnapshotRow | null> {
  return queryOne<MrrSnapshotRow>(
    env.DB,
    `SELECT * FROM mrr_snapshots ORDER BY date_key DESC LIMIT 1`
  );
}

/**
 * Get MRR snapshots for a date range.
 */
export async function getMrrHistory(
  env: Env,
  startDate: string,
  endDate: string
): Promise<MrrSnapshotRow[]> {
  return query<MrrSnapshotRow>(
    env.DB,
    `SELECT * FROM mrr_snapshots WHERE date_key >= ? AND date_key <= ? ORDER BY date_key ASC`,
    [startDate, endDate]
  );
}

// ─── Aggregate Stats ────────────────────────────────────────────────────────

export async function getContactStats(env: Env) {
  const stats = await queryOne<{
    total: number;
    leads: number;
    trials: number;
    customers: number;
    churned: number;
  }>(
    env.DB,
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status = 'lead' THEN 1 ELSE 0 END) as leads,
       SUM(CASE WHEN status = 'trial' THEN 1 ELSE 0 END) as trials,
       SUM(CASE WHEN status = 'customer' THEN 1 ELSE 0 END) as customers,
       SUM(CASE WHEN status = 'churned' THEN 1 ELSE 0 END) as churned
     FROM marketing_contacts`
  );

  return stats ?? { total: 0, leads: 0, trials: 0, customers: 0, churned: 0 };
}
