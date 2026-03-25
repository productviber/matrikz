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
import { verifyAffiliateCredentials } from '../lib/affiliate-auth';
import { resolveAffiliateIdentity } from '../lib/affiliate-session';
import {
  KV_PREFIX,
  PATTERNS,
  MESSAGES,
  TTL,
  KV_UNSUBSCRIBE_PREFIX,
  EVENT_SECURITY,
} from '../constants';

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
  const identity = await resolveAffiliateIdentity(request, env);
  const code = identity?.code ?? null;
  const email = identity?.email ?? null;
  if (!code || !email) return badRequest(MESSAGES.errors.missingCodeEmail);

  if (!env.AFFILIATE_AUTH_SECRET) {
    if (!(await verifyAffiliateCredentials(env, code, email))) {
      return unauthorized(MESSAGES.errors.invalidCredentials);
    }
  }

  const replayDenied = await enforceReplayProtection(request, env, 'gdpr-export', code);
  if (replayDenied) {
    return replayDenied;
  }

  try {
    const [notes, payouts, shareLeads, shareOwnerStats] = await Promise.all([
      query(env.DB, `SELECT * FROM affiliate_notes WHERE affiliate_code = ? ORDER BY created_at DESC`, [code]),
      query(env.DB, `SELECT * FROM payout_items WHERE affiliate_code = ? ORDER BY created_at DESC`, [code]),
      query(env.DB, `SELECT * FROM share_leads WHERE owner_email = ? ORDER BY updated_at DESC`, [email]),
      query(env.DB, `SELECT * FROM share_owner_stats WHERE owner_email = ?`, [email]),
    ]);

    // Application data lives in KV, not D1
    const appJson = await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_APPLICATION}${code}`);
    const application = appJson ? JSON.parse(appJson) : null;

    const statsJson = await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_STATS}${code}`);
    const stats = statsJson ? JSON.parse(statsJson) : null;

    return ok({
      affiliateCode: code,
      emailHash: await hashEmail(email),
      stats,
      notes,
      payouts,
      application,
      shareLeads,
      shareOwnerStats,
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
  const identity = await resolveAffiliateIdentity(request, env);
  const code = identity?.code ?? null;
  const email = identity?.email ?? null;
  if (!code || !email) return badRequest(MESSAGES.errors.missingCodeEmail);

  if (!env.AFFILIATE_AUTH_SECRET) {
    if (!(await verifyAffiliateCredentials(env, code, email))) {
      return unauthorized(MESSAGES.errors.invalidCredentials);
    }
  }

  const replayDenied = await enforceReplayProtection(request, env, 'gdpr-delete', code);
  if (replayDenied) {
    return replayDenied;
  }

  try {
    // Anonymise payout records (keep financial integrity)
    await execute(
      env.DB,
      `UPDATE payout_items SET affiliate_code = '[deleted]' WHERE affiliate_code = ?`,
      [code]
    );

    // Delete notes
    await execute(env.DB, `DELETE FROM affiliate_notes WHERE affiliate_code = ?`, [code]);

    // Delete share data for this user
    await execute(env.DB, `DELETE FROM share_leads WHERE owner_email = ?`, [email]);
    await execute(env.DB, `DELETE FROM share_owner_stats WHERE owner_email = ?`, [email]);

    // Wipe KV entries (affiliate + share owner)
    await Promise.all([
      env.KV_MARKETING.delete(`${KV_PREFIX.AFFILIATE_STATS}${code}`),
      env.KV_MARKETING.delete(`${KV_PREFIX.AFFILIATE_EMAIL}${code}`),
      env.KV_MARKETING.delete(`${KV_PREFIX.AFFILIATE_APPLICATION}${code}`),
      env.KV_MARKETING.delete(`${KV_PREFIX.SHARE_OWNER_STATS}${email}`),
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
      `UPDATE email_sends SET status = 'cancelled' WHERE contact_email = ? AND status = 'scheduled'`,
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

async function enforceReplayProtection(
  request: Request,
  env: Env,
  scope: string,
  code: string,
): Promise<Response | null> {
  // Backward compatible mode: only enforce nonce window when strong auth secret is configured.
  if (!env.AFFILIATE_AUTH_SECRET) return null;

  const tsRaw = request.headers.get('x-request-timestamp');
  const nonce = request.headers.get('x-request-nonce')?.trim();
  const ts = tsRaw ? parseInt(tsRaw, 10) : NaN;
  if (!Number.isFinite(ts)) {
    return badRequest('x-request-timestamp header is required');
  }
  if (!nonce || nonce.length < 8 || nonce.length > 128) {
    return badRequest('x-request-nonce header is required');
  }

  const nowSecs = Math.floor(Date.now() / 1000);
  const skew = Math.abs(nowSecs - ts);
  if (skew > EVENT_SECURITY.MAX_SKEW_SECS) {
    return unauthorized('Request timestamp outside replay window');
  }

  const dedupeKey = `${KV_PREFIX.AUTH_NONCE}${scope}:${code}:${nonce}`;
  const seen = await env.KV_MARKETING.get(dedupeKey);
  if (seen) {
    return unauthorized('Replay request detected');
  }

  await env.KV_MARKETING.put(dedupeKey, String(ts), {
    expirationTtl: EVENT_SECURITY.REPLAY_TTL_SECS,
  });
  return null;
}

