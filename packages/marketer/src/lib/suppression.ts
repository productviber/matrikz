/**
 * Suppression List — Permanent D1-backed email suppression for CAN-SPAM compliance.
 *
 * KV-based unsubscribe flags expire with TTL. This module provides a permanent
 * suppression record that survives KV expirations, preventing re-enrollment of
 * prospects who bounced, complained, or unsubscribed.
 *
 * @module lib/suppression
 */

import type { Env } from '../types';
import { queryOne, execute } from './db';

export type SuppressionReason = 'hard_bounce' | 'spam_complaint' | 'unsubscribed' | 'manual';
export type SuppressionSource = 'brevo_webhook' | 'admin' | 'user_request';

/**
 * Check if an email is permanently suppressed.
 */
export async function isSuppressed(db: Env['DB'], email: string): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    db,
    `SELECT id FROM suppression_list WHERE email = ? LIMIT 1`,
    [email.trim().toLowerCase()],
  );
  return !!row;
}

/**
 * Add an email to the permanent suppression list.
 * Idempotent — silently ignores duplicates via INSERT OR IGNORE.
 */
export async function addSuppression(
  db: Env['DB'],
  email: string,
  reason: SuppressionReason,
  source: SuppressionSource,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await execute(
      db,
      `INSERT OR IGNORE INTO suppression_list (email, reason, source, metadata)
       VALUES (?, ?, ?, ?)`,
      [
        email.trim().toLowerCase(),
        reason,
        source,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  } catch (err) {
    console.warn(`[Suppression] Failed to add ${email}: ${err instanceof Error ? err.message : err}`);
  }
}
