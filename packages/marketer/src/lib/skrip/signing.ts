import { SKRIP_CONFIG } from '../../constants';
import { timingSafeEqual } from '../security';

const textEncoder = new TextEncoder();

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

export async function computeSkripSignature(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
  secret: string;
}): Promise<string> {
  const key = await importHmacKey(input.secret);
  const bodyHash = await sha256Hex(input.rawBody);
  const canonical = [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    bodyHash,
  ].join('\n');
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(canonical));
  return `sha256=${bytesToHex(new Uint8Array(signature))}`;
}

export function isTimestampWithinDrift(
  timestamp: string,
  maxDriftMs: number = SKRIP_CONFIG.MAX_TIMESTAMP_DRIFT_MS,
): boolean {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return false;
  return Math.abs(Date.now() - parsed) <= maxDriftMs;
}

export async function verifySkripSignature(input: {
  method: string;
  path: string;
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
  rawBody: string;
  secret: string;
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!input.timestamp || !input.nonce || !input.signature) {
    return { ok: false, status: 401, error: 'Missing Skrip signature headers' };
  }
  if (!isTimestampWithinDrift(input.timestamp)) {
    return { ok: false, status: 401, error: 'Skrip timestamp drift exceeded' };
  }

  const expected = await computeSkripSignature({
    method: input.method,
    path: input.path,
    timestamp: input.timestamp,
    nonce: input.nonce,
    rawBody: input.rawBody,
    secret: input.secret,
  });

  if (!timingSafeEqual(input.signature, expected)) {
    return { ok: false, status: 401, error: 'Invalid Skrip signature' };
  }

  return { ok: true };
}
