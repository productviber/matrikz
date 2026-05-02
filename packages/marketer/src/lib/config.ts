/**
 * Startup config validation — fail fast if required bindings are missing.
 */

import type { Env } from '../types';

/** Required bindings that must be present for the worker to operate. */
const REQUIRED_BINDINGS: Array<{ key: keyof Env; label: string }> = [
  { key: 'DB', label: 'D1 database binding (DB)' },
  { key: 'KV_MARKETING', label: 'KV namespace binding (KV_MARKETING)' },
  { key: 'ANALYTICS', label: 'Analytics service binding (ANALYTICS)' },
  { key: 'ADMIN_TOKEN', label: 'ADMIN_TOKEN secret' },
  { key: 'FROM_EMAIL', label: 'FROM_EMAIL variable' },
  { key: 'FROM_NAME', label: 'FROM_NAME variable' },
];

const REQUIRED_PROD_BINDINGS: Array<{ key: keyof Env; label: string }> = [
  { key: 'WEBHOOK_SIGNING_SECRET', label: 'WEBHOOK_SIGNING_SECRET secret' },
  { key: 'AFFILIATE_AUTH_SECRET', label: 'AFFILIATE_AUTH_SECRET secret' },
];

// No static optional-integration bindings — Skrip uses fallbacks, checked below.

/**
 * Validate that all required env bindings are present.
 * Returns an array of missing binding descriptions (empty = valid).
 */
export function validateConfig(env: Env): string[] {
  const missing: string[] = [];

  for (const { key, label } of REQUIRED_BINDINGS) {
    if (!env[key]) {
      missing.push(label);
    }
  }

  if (env.ENVIRONMENT === 'production') {
    for (const { key, label } of REQUIRED_PROD_BINDINGS) {
      if (!env[key]) {
        missing.push(label);
      }
    }
  }

  // Skrip integration: only validate when SKRIP_BASE_URL is explicitly set.
  // The other three keys fall back to SYSTEM_TOKEN / WEBHOOK_SIGNING_SECRET (required above),
  // so we only need to check the effective service-token and signing-secret exist.
  if (env.SKRIP_BASE_URL) {
    const effectiveServiceToken = env.SKRIP_SERVICE_TOKEN ?? env.SYSTEM_TOKEN;
    const effectiveSigningSecret = env.SKRIP_SIGNING_SECRET ?? env.WEBHOOK_SIGNING_SECRET;
    const effectiveWebhookSecret = env.SKRIP_WEBHOOK_SIGNING_SECRET ?? env.WEBHOOK_SIGNING_SECRET;
    if (!effectiveServiceToken) missing.push('SKRIP_SERVICE_TOKEN (or SYSTEM_TOKEN fallback) required when SKRIP_BASE_URL is set');
    if (!effectiveSigningSecret) missing.push('SKRIP_SIGNING_SECRET (or WEBHOOK_SIGNING_SECRET fallback) required when SKRIP_BASE_URL is set');
    if (!effectiveWebhookSecret) missing.push('SKRIP_WEBHOOK_SIGNING_SECRET (or WEBHOOK_SIGNING_SECRET fallback) required when SKRIP_BASE_URL is set');
  }

  return missing;
}
