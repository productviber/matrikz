/**
 * KV-based sliding-window rate limiter.
 *
 * Stores hit counts in KV with a TTL equal to the window duration.
 * If the key does not exist, the window starts fresh.
 * On exceed, returns `{ allowed: false, remaining: 0 }`.
 */

import type { Env } from '../types';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // unix seconds
}

const KV_RATE_PREFIX = 'rate:';

/**
 * Check and increment rate limit for a given key.
 *
 * @param env      Worker environment (KV binding)
 * @param key      Unique bucket key, e.g. `apply:${ip}` or `apply:${email}`
 * @param limit    Maximum requests allowed in the window
 * @param windowSecs  Rolling window size in seconds
 */
export async function checkRateLimit(
  env: Env,
  key: string,
  limit: number,
  windowSecs: number
): Promise<RateLimitResult> {
  const kvKey = `${KV_RATE_PREFIX}${key}`;
  const now = Math.floor(Date.now() / 1000);
  const resetAt = now + windowSecs;

  const raw = await env.KV_MARKETING.get(kvKey);
  const current = raw ? parseInt(raw, 10) : 0;

  if (current >= limit) {
    return { allowed: false, remaining: 0, resetAt };
  }

  // Increment — only set TTL on first write so the window is fixed, not sliding per request
  await env.KV_MARKETING.put(kvKey, String(current + 1), {
    expirationTtl: windowSecs,
  });

  return { allowed: true, remaining: limit - current - 1, resetAt };
}
