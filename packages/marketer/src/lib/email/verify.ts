/**
 * Lightweight email verification for Cloudflare Workers.
 *
 * Checks MX records via Cloudflare DNS-over-HTTPS.
 * Results are cached in KV to avoid repeated lookups.
 * This is a domain-level check — it cannot verify individual mailboxes,
 * but catches typos, parked domains, and non-existent MX.
 */

import { KV_PREFIX, TTL } from '../../constants';

interface VerifyResult {
  valid: boolean;
  reason?: string;
}

const KNOWN_DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
  'yopmail.com', 'sharklasers.com', 'guerrillamailblock.com', 'grr.la',
  'dispostable.com', 'trashmail.com', 'fakeinbox.com', 'maildrop.cc',
]);

/**
 * Verify that an email domain has valid MX records.
 * Caches result in KV for 7 days (valid) or 1 day (invalid) to reduce DNS lookups.
 */
export async function verifyEmailDomain(
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> },
  email: string,
): Promise<VerifyResult> {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return { valid: false, reason: 'invalid_format' };

  if (KNOWN_DISPOSABLE_DOMAINS.has(domain)) {
    return { valid: false, reason: 'disposable_domain' };
  }

  // Check KV cache first
  const cacheKey = `${KV_PREFIX.OUTBOUND_DELIVERABILITY}mx:${domain}`;
  const cached = await kv.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as VerifyResult;
  }

  let result: VerifyResult;
  try {
    // Cloudflare DNS-over-HTTPS JSON API
    const dnsUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`;
    const resp = await fetch(dnsUrl, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      // DNS lookup failed — don't block sending, assume valid
      console.warn(`[Verify] DNS lookup failed for ${domain}: ${resp.status}`);
      return { valid: true, reason: 'dns_lookup_error' };
    }

    const data = await resp.json() as { Answer?: Array<{ type: number; data: string }> };
    const mxRecords = data.Answer?.filter((r) => r.type === 15) ?? [];

    if (mxRecords.length > 0) {
      result = { valid: true };
    } else {
      result = { valid: false, reason: 'no_mx_records' };
    }
  } catch (err) {
    // Timeout or network error — don't block sending
    console.warn(`[Verify] MX check error for ${domain}:`, err instanceof Error ? err.message : err);
    return { valid: true, reason: 'dns_timeout' };
  }

  // Cache: 7 days for valid, 1 day for invalid (domain may fix MX)
  const ttl = result.valid ? TTL.DAYS_7 : TTL.DAYS_1;
  await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: ttl }).catch(() => {});

  return result;
}
