/**
 * GDPR / Privacy Compliance Routes
 *
 * Endpoints to satisfy GDPR right-to-access, right-to-erasure, and
 * CAN-SPAM / CASL unsubscribe requirements.
 *
 *   GET  /api/affiliate/gdpr/export?code=&email=  — export all data
 *   DELETE /api/affiliate/gdpr/delete?code=&email= — erase all data
 *   POST /api/unsubscribe                         — opt-out of email
 */

import type { Env } from '../types';
import { ok, badRequest, unauthorized, serverError } from '../lib/response';
import { query, execute, hashEmail } from '../lib/db';
import { KV_PREFIX, PATTERNS, MESSAGES, TTL, KV_UNSUBSCRIBE_PREFIX } from '../constants';

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * GET /api/affiliate/gdpr/export?code=:code&email=:email
 *
 * Returns all data held for the authenticated affiliate.
 */
export async function handleGdprExport(
  request: Request,
  env: Env
): Promise<Response> {
  const { code, email } = extractParams(request);
  if (!code || !email) return badRequest(MESSAGES.errors.missingCodeEmail);

  if (!(await verifyAffiliate(env, code, email))) {
    return unauthorized(MESSAGES.errors.invalidCredentials);
  }

  try {
    const [notes, payouts, applications] = await Promise.all([
      query(env.DB, `SELECT * FROM affiliate_notes WHERE affiliate_code = ? ORDER BY created_at DESC`, [code]),
      query(env.DB, `SELECT * FROM payout_items WHERE affiliate_code = ? ORDER BY created_at DESC`, [code]),
      query(env.DB, `SELECT * FROM affiliate_applications WHERE affiliate_code = ? ORDER BY created_at DESC`, [code]),
    ]);

    const statsJson = await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_STATS}${code}`);
    const stats = statsJson ? JSON.parse(statsJson) : null;

    return ok({
      affiliateCode: code,
      emailHash: await hashEmail(email),
      stats,
      notes,
      payouts,
      applications,
      exportedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[GDPR:Export] Error:', err);
    return serverError(MESSAGES.errors.internalError);
  }
}

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * DELETE /api/affiliate/gdpr/delete?code=:code&email=:email
 *
 * Erases all personally identifiable data for the affiliate.
 * Finance records (payout_items) are anonymised rather than deleted
 * to preserve accounting integrity.
 */
export async function handleGdprDelete(
  request: Request,
  env: Env
): Promise<Response> {
  const { code, email } = extractParams(request);
  if (!code || !email) return badRequest(MESSAGES.errors.missingCodeEmail);

  if (!(await verifyAffiliate(env, code, email))) {
    return unauthorized(MESSAGES.errors.invalidCredentials);
  }

  try {
    // Anonymise payout records (keep financial integrity)
    await execute(
      env.DB,
      `UPDATE payout_items SET affiliate_code = '[deleted]' WHERE affiliate_code = ?`,
      [code]
    );

    // Delete notes and applications
    await execute(env.DB, `DELETE FROM affiliate_notes WHERE affiliate_code = ?`, [code]);
    await execute(env.DB, `DELETE FROM affiliate_applications WHERE affiliate_code = ?`, [code]);

    // Wipe KV entries
    await Promise.all([
      env.KV_MARKETING.delete(`${KV_PREFIX.AFFILIATE_STATS}${code}`),
      env.KV_MARKETING.delete(`${KV_PREFIX.AFFILIATE_EMAIL}${code}`),
      env.KV_MARKETING.delete(`${KV_PREFIX.AFFILIATE_APPLICATION}${code}`),
    ]);

    // Mark as unsubscribed to block any future emails
    await env.KV_MARKETING.put(`${KV_UNSUBSCRIBE_PREFIX}${email.toLowerCase()}`, '1', {
      expirationTtl: TTL.YEAR_1 * 10,
    });

    return ok({ deleted: true, note: MESSAGES.success.gdprDeleted });
  } catch (err) {
    console.error('[GDPR:Delete] Error:', err);
    return serverError(MESSAGES.errors.internalError);
  }
}

// ─── Unsubscribe ─────────────────────────────────────────────────────────────

/**
 * POST /api/unsubscribe
 *
 * Persists an email unsubscribe preference in KV and cancels any
 * pending email sends for this address.
 *
 * Body: { email: string }
 */
export async function handleUnsubscribe(
  request: Request,
  env: Env
): Promise<Response> {
  let body: { email?: string };
  try {
    body = await request.json() as { email?: string };
  } catch {
    return badRequest(MESSAGES.errors.invalidJson);
  }

  const email = body.email?.trim().toLowerCase();
  if (!email || !PATTERNS.EMAIL.test(email)) {
    return badRequest(MESSAGES.errors.invalidEmailFormat);
  }

  try {
    // Persist unsubscribe flag — effectively permanent (10 years TTL)
    await env.KV_MARKETING.put(`${KV_UNSUBSCRIBE_PREFIX}${email}`, '1', {
      expirationTtl: TTL.YEAR_1 * 10,
    });

    // Cancel all scheduled email sends for this address
    // We mark scheduled sends as cancelled by updating email_sends table
    await execute(
      env.DB,
      `UPDATE email_sends SET status = 'cancelled' WHERE to_email = ? AND status = 'scheduled'`,
      [email]
    );

    return ok({ unsubscribed: true, email });
  } catch (err) {
    console.error('[Unsubscribe] Error:', err);
    return serverError(MESSAGES.errors.internalError);
  }
}

/**
 * Check if an email address is unsubscribed.
 * Used by the email sending pipeline to gate outbound sends.
 */
export async function isUnsubscribed(env: Env, email: string): Promise<boolean> {
  const val = await env.KV_MARKETING.get(`${KV_UNSUBSCRIBE_PREFIX}${email.toLowerCase()}`);
  return val !== null;
}

// ─── Private helpers ─────────────────────────────────────────────────────────

function extractParams(request: Request): { code: string | null; email: string | null } {
  const url = new URL(request.url);
  return {
    code: url.searchParams.get('code'),
    email: url.searchParams.get('email'),
  };
}

async function verifyAffiliate(env: Env, code: string, email: string): Promise<boolean> {
  const cachedEmail = await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_EMAIL}${code}`);
  return !!(cachedEmail && cachedEmail.toLowerCase() === email.toLowerCase());
}
