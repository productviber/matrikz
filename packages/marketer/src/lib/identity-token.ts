/**
 * Recipient Identity Token — HMAC-signed tokens for outbound link tracking.
 *
 * Tokens allow recipients of outbound emails/messages to self-identify when
 * clicking a tracked link (subscribe, unsubscribe, verify, redirect) without
 * requiring explicit login. The token is signed with WEBHOOK_SIGNING_SECRET
 * so it cannot be forged.
 *
 * Token format (URL-safe base64 of the concatenated payload):
 *   base64url("<contactId>|<tenantId>|<purpose>|<expiresAt>|<hmacHex>")
 *
 * The token is single-use when purpose is 'subscribe' or 'unsubscribe':
 * verification persists a row in recipient_identity_tokens so replays are
 * detected and rejected.
 */

import type { Env } from '../types';
import { IDENTITY_TOKEN } from '../constants';

const enc = new TextEncoder();

// ── Internal helpers ────────────────────────────────────────────────────────

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function bytesToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return bytesToHex(digest);
}

function encodeBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(str: string): string {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (padded.length % 4)) % 4;
  return atob(padded + '='.repeat(padding));
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface MintTokenInput {
  contactId: string;
  tenantId: string;
  purpose: string;
  ttlSecs?: number;
}

export interface MintTokenResult {
  token: string;
  expiresAt: number;
  tokenHash: string;
}

export interface VerifyTokenSuccess {
  ok: true;
  contactId: string;
  tenantId: string;
  purpose: string;
  expiresAt: number;
  tokenHash: string;
}

export interface VerifyTokenFailure {
  ok: false;
  reason: string;
}

export type VerifyTokenResult = VerifyTokenSuccess | VerifyTokenFailure;

/**
 * Mint a HMAC-signed recipient identity token.
 *
 * Returns the URL-safe base64 token and its expiry epoch (unix seconds).
 * The tokenHash (SHA-256 of the raw token) is returned so callers can
 * persist it to recipient_identity_tokens without storing the token itself.
 */
export async function mintRecipientToken(
  env: Env,
  input: MintTokenInput,
): Promise<MintTokenResult> {
  const secret = env.WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    throw new Error(IDENTITY_TOKEN.REJECT_REASON.MISSING_SECRET);
  }

  const ttlSecs = input.ttlSecs ?? IDENTITY_TOKEN.DEFAULT_TTL_SECS;
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSecs;
  const sep = IDENTITY_TOKEN.SEPARATOR;
  const payload = `${input.contactId}${sep}${input.tenantId}${sep}${input.purpose}${sep}${expiresAt}`;

  const key = await importHmacKey(secret);
  const rawSig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const sigHex = bytesToHex(rawSig);

  const raw = `${payload}${sep}${sigHex}`;
  const token = encodeBase64Url(raw);
  const tokenHash = await sha256Hex(token);

  return { token, expiresAt, tokenHash };
}

/**
 * Verify a recipient identity token.
 *
 * Returns a structured result with reason codes for any failure.
 * Does NOT check for single-use replay — that must be done by the caller
 * using the returned tokenHash against recipient_identity_tokens.
 */
export async function verifyRecipientToken(
  env: Env,
  token: string,
): Promise<VerifyTokenResult> {
  const secret = env.WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    return { ok: false, reason: IDENTITY_TOKEN.REJECT_REASON.MISSING_SECRET };
  }

  let raw: string;
  try {
    raw = decodeBase64Url(token);
  } catch {
    return { ok: false, reason: IDENTITY_TOKEN.REJECT_REASON.MALFORMED };
  }

  const sep = IDENTITY_TOKEN.SEPARATOR;
  const parts = raw.split(sep);
  // Expect: contactId | tenantId | purpose | expiresAt | sigHex
  if (parts.length < 5) {
    return { ok: false, reason: IDENTITY_TOKEN.REJECT_REASON.MALFORMED };
  }

  // The sigHex is the last segment; everything else is the payload.
  const sigHex = parts[parts.length - 1];
  const payload = parts.slice(0, -1).join(sep);
  const payloadParts = payload.split(sep);
  if (payloadParts.length < 4) {
    return { ok: false, reason: IDENTITY_TOKEN.REJECT_REASON.MALFORMED };
  }

  const expiresAtStr = payloadParts[payloadParts.length - 1];
  const purpose = payloadParts[payloadParts.length - 2];
  const tenantId = payloadParts[payloadParts.length - 3];
  // contactId may itself contain the separator in edge-cases: join all remaining
  const contactId = payloadParts.slice(0, -3).join(sep);

  if (!contactId || !tenantId || !purpose || !expiresAtStr) {
    return { ok: false, reason: IDENTITY_TOKEN.REJECT_REASON.MALFORMED };
  }

  // Verify HMAC before anything else (constant-time)
  const key = await importHmacKey(secret);
  let sigValid = false;
  try {
    const expectedSigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
    const expectedHex = bytesToHex(expectedSigBuf);
    // Constant-time comparison via a timing-safe algorithm
    sigValid = expectedHex.length === sigHex.length &&
      (await timingSafeEqualHex(sigHex, expectedHex));
  } catch {
    return { ok: false, reason: IDENTITY_TOKEN.REJECT_REASON.TAMPERED };
  }

  if (!sigValid) {
    return { ok: false, reason: IDENTITY_TOKEN.REJECT_REASON.TAMPERED };
  }

  const expiresAt = parseInt(expiresAtStr, 10);
  if (!Number.isFinite(expiresAt) || Math.floor(Date.now() / 1000) > expiresAt) {
    return { ok: false, reason: IDENTITY_TOKEN.REJECT_REASON.EXPIRED };
  }

  const tokenHash = await sha256Hex(token);

  return { ok: true, contactId, tenantId, purpose, expiresAt, tokenHash };
}

// ── Timing-safe hex comparison ──────────────────────────────────────────────

async function timingSafeEqualHex(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) return false;
  // Encode both as UTF-8 bytes and use subtle.verify for constant-time compare
  const [aKey, bKey] = await Promise.all([
    crypto.subtle.importKey('raw', enc.encode(a), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    crypto.subtle.importKey('raw', enc.encode(b), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  ]);
  const probe = enc.encode('__probe__');
  const [aSig, bSig] = await Promise.all([
    crypto.subtle.sign('HMAC', aKey, probe),
    crypto.subtle.sign('HMAC', bKey, probe),
  ]);
  const aArr = new Uint8Array(aSig);
  const bArr = new Uint8Array(bSig);
  let diff = 0;
  for (let i = 0; i < aArr.length; i++) diff |= aArr[i] ^ bArr[i];
  return diff === 0;
}
