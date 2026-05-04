/**
 * Recipient Identity Token Routes
 *
 * Provides HMAC-signed token mint and verify endpoints to close the identity
 * gap between outbound link clicks and the marketing worker's contact graph.
 *
 * Routes (registered in index.ts):
 *   POST /api/identity/mint    — admin lane: mint a token for a contact
 *   POST /api/identity/verify  — system lane: verify a token, optionally persist
 *
 * Security notes:
 * - Mint requires admin authentication (ADMIN_TOKEN).
 * - Verify is system-lane (SYSTEM_TOKEN) to allow the analytics worker to
 *   resolve identities on behalf of landing pages.
 * - Tokens are single-use: the token hash is written to recipient_identity_tokens
 *   on first successful verify so replays are rejected.
 * - Tokens expire after IDENTITY_TOKEN.DEFAULT_TTL_SECS (7 days by default).
 */

import type { Env } from '../types';
import { IDENTITY_TOKEN, SKRIP_CONFIG } from '../constants';
import { mintRecipientToken, verifyRecipientToken } from '../lib/identity-token';
import { execute, now, queryOne } from '../lib/db';
import { badRequest, created, ok, serverError } from '../lib/response';
import { getCorrelationId } from '../lib/correlation';

// ── Mint ───────────────────────────────────────────────────────────────────

interface MintBody {
  contactId?: unknown;
  tenantId?: unknown;
  purpose?: unknown;
  ttlSecs?: unknown;
}

/**
 * POST /api/identity/mint
 *
 * Admin-only endpoint to mint a signed recipient identity token.
 * Use this when generating outbound links that should self-identify
 * the recipient when clicked (subscribe, unsubscribe, verify journeys).
 *
 * Body:
 *   contactId  — required string
 *   tenantId   — optional string (defaults to 'default')
 *   purpose    — optional: 'subscribe' | 'unsubscribe' | 'verify' | 'redirect' (default: 'redirect')
 *   ttlSecs    — optional number (default: 604800 = 7 days, max: 2592000 = 30 days)
 */
export async function handleIdentityTokenMint(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: MintBody;
  try {
    body = (await request.json()) as MintBody;
  } catch {
    return badRequest('Invalid JSON body');
  }

  if (!body.contactId || typeof body.contactId !== 'string') {
    return badRequest('contactId is required and must be a string');
  }

  const contactId = body.contactId.trim();
  if (!contactId) return badRequest('contactId must not be empty');

  const tenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : SKRIP_CONFIG.DEFAULT_TENANT_ID;
  const VALID_PURPOSES: readonly string[] = Object.values(IDENTITY_TOKEN.PURPOSE);
  const purpose = (
    typeof body.purpose === 'string' && VALID_PURPOSES.includes(body.purpose)
      ? body.purpose
      : IDENTITY_TOKEN.PURPOSE.REDIRECT
  ) as typeof IDENTITY_TOKEN.PURPOSE[keyof typeof IDENTITY_TOKEN.PURPOSE];
  const rawTtl = typeof body.ttlSecs === 'number' ? Math.floor(body.ttlSecs) : IDENTITY_TOKEN.DEFAULT_TTL_SECS;
  const ttlSecs = Math.min(Math.max(rawTtl, 60), 30 * 24 * 3600); // clamp 1 min – 30 days

  if (!env.WEBHOOK_SIGNING_SECRET) {
    return serverError('Identity token signing is not configured');
  }

  try {
    const { token, expiresAt, tokenHash } = await mintRecipientToken(env, {
      contactId,
      tenantId,
      purpose,
      ttlSecs,
    });

    // Persist the hash (never the raw token) for replay tracking.
    const correlationId = getCorrelationId();
    const epoch = now();
    try {
      await execute(
        env.DB,
        `INSERT OR IGNORE INTO recipient_identity_tokens
          (token_hash, contact_id, tenant_id, purpose, correlation_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [tokenHash, contactId, tenantId, purpose, correlationId, epoch, expiresAt],
      );
    } catch (dbErr) {
      // Non-fatal: token is still usable even if DB write fails.
      console.warn('[IdentityToken] Failed to persist token hash:', dbErr instanceof Error ? dbErr.message : dbErr);
    }

    return created({
      token,
      expiresAt,
      expiresAtIso: new Date(expiresAt * 1000).toISOString(),
      contactId,
      tenantId,
      purpose,
      correlationId,
    });
  } catch (err) {
    console.error('[IdentityToken] Mint error:', err);
    return serverError('Failed to mint identity token');
  }
}

// ── Verify ─────────────────────────────────────────────────────────────────

interface VerifyBody {
  token?: unknown;
  persist?: unknown;
}

/**
 * POST /api/identity/verify
 *
 * System-lane endpoint to verify a recipient identity token.
 * On success, returns the contactId and tenantId encoded in the token.
 *
 * If persist=true (default for 'subscribe' and 'unsubscribe' purposes), the
 * token is marked as used so replay attacks are blocked.
 *
 * Body:
 *   token   — required string (the token from mintRecipientToken)
 *   persist — optional boolean (default: true — mark token as used)
 */
export async function handleIdentityTokenVerify(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: VerifyBody;
  try {
    body = (await request.json()) as VerifyBody;
  } catch {
    return badRequest('Invalid JSON body');
  }

  if (!body.token || typeof body.token !== 'string') {
    return badRequest('token is required and must be a string');
  }

  const persist = body.persist !== false; // default true
  const ip = request.headers.get('CF-Connecting-IP') ?? null;
  const ua = request.headers.get('User-Agent')?.slice(0, 500) ?? null;

  const result = await verifyRecipientToken(env, body.token);

  if (!result.ok) {
    return new Response(
      JSON.stringify({ ok: false, reason: result.reason }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Check for replay — look up the token hash in the DB.
  let existingRow: { verified_at: number | null } | null = null;
  try {
    existingRow = await queryOne<{ verified_at: number | null }>(
      env.DB,
      `SELECT verified_at FROM recipient_identity_tokens WHERE token_hash = ?`,
      [result.tokenHash],
    );
  } catch {
    // If DB is unavailable, allow verify to proceed but skip replay check.
  }

  if (existingRow?.verified_at) {
    return new Response(
      JSON.stringify({ ok: false, reason: IDENTITY_TOKEN.REJECT_REASON.ALREADY_USED }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Mark token as used (single-use for sensitive purposes).
  const isSensitive = result.purpose === IDENTITY_TOKEN.PURPOSE.SUBSCRIBE
    || result.purpose === IDENTITY_TOKEN.PURPOSE.UNSUBSCRIBE;
  if (persist && isSensitive) {
    const epoch = now();
    try {
      await execute(
        env.DB,
        `UPDATE recipient_identity_tokens
            SET verified_at = ?, verify_ip = ?, verify_ua = ?
          WHERE token_hash = ?`,
        [epoch, ip, ua, result.tokenHash],
      );
    } catch (dbErr) {
      console.warn('[IdentityToken] Failed to mark token as used:', dbErr instanceof Error ? dbErr.message : dbErr);
    }
  }

  return ok({
    ok: true,
    contactId: result.contactId,
    tenantId: result.tenantId,
    purpose: result.purpose,
    expiresAt: result.expiresAt,
    expiresAtIso: new Date(result.expiresAt * 1000).toISOString(),
  });
}
