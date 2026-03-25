import type { Env } from '../types';
import { timingSafeEqual } from './security.ts';

const TOKEN_VERSION = 1;
const DEFAULT_SESSION_TTL_SECS = 3600;

interface AffiliateSessionPayload {
  v: number;
  code: string;
  email: string;
  iat: number;
  exp: number;
}

export interface AffiliateIdentity {
  code: string;
  email: string;
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function encodeBase64Url(bytes: Uint8Array): string {
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const raw = atob(normalized + pad);
  return new Uint8Array(Array.from(raw, (c) => c.charCodeAt(0)));
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signPayload(secret: string, payloadSegment: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadSegment));
  return encodeBase64Url(new Uint8Array(sig));
}

export async function issueAffiliateSessionToken(
  env: Env,
  code: string,
  email: string,
  ttlSecs = DEFAULT_SESSION_TTL_SECS
): Promise<{ token: string; expiresAt: number }> {
  const secret = env.AFFILIATE_AUTH_SECRET;
  if (!secret) {
    throw new Error('AFFILIATE_AUTH_SECRET is not configured');
  }

  const nowSecs = Math.floor(Date.now() / 1000);
  const exp = nowSecs + Math.max(300, ttlSecs);
  const payload: AffiliateSessionPayload = {
    v: TOKEN_VERSION,
    code: code.trim(),
    email: email.trim().toLowerCase(),
    iat: nowSecs,
    exp,
  };

  const payloadSegment = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signatureSegment = await signPayload(secret, payloadSegment);
  return {
    token: `${payloadSegment}.${signatureSegment}`,
    expiresAt: exp,
  };
}

export async function verifyAffiliateSessionToken(
  env: Env,
  token: string
): Promise<AffiliateIdentity | null> {
  const secret = env.AFFILIATE_AUTH_SECRET;
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadSegment, signatureSegment] = parts;
  const expectedSig = await signPayload(secret, payloadSegment);
  if (!timingSafeEqual(signatureSegment, expectedSig)) return null;

  const payloadBytes = decodeBase64Url(payloadSegment);
  const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as AffiliateSessionPayload;
  if (payload.v !== TOKEN_VERSION) return null;

  const nowSecs = Math.floor(Date.now() / 1000);
  if (payload.exp <= nowSecs) return null;

  if (!payload.code || !payload.email) return null;
  return {
    code: payload.code,
    email: payload.email,
  };
}

export async function resolveAffiliateIdentity(
  request: Request,
  env: Env
): Promise<AffiliateIdentity | null> {
  const url = new URL(request.url);
  const bearer = extractBearerToken(request);

  if (env.AFFILIATE_AUTH_SECRET) {
    // In production we only accept bearer tokens to avoid query token leakage.
    const queryToken = env.ENVIRONMENT === 'production' ? null : url.searchParams.get('token');
    const token = bearer ?? queryToken;
    if (!token) return null;
    return verifyAffiliateSessionToken(env, token);
  }

  // Fail closed in production if signed affiliate sessions are not configured.
  if (env.ENVIRONMENT === 'production') return null;

  const code = url.searchParams.get('code');
  const email = url.searchParams.get('email');
  if (!code || !email) return null;

  return {
    code: code.trim(),
    email: email.trim().toLowerCase(),
  };
}
