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

const OPTIONAL_INTEGRATION_BINDINGS: Array<{ keys: Array<keyof Env>; label: string }> = [
  {
    keys: ['SKRIP_BASE_URL', 'SKRIP_SERVICE_TOKEN', 'SKRIP_SIGNING_SECRET', 'SKRIP_WEBHOOK_SIGNING_SECRET'],
    label: 'Skrip integration env vars should be configured together when enabled',
  },
];

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

  for (const { keys, label } of OPTIONAL_INTEGRATION_BINDINGS) {
    const configuredCount = keys.filter((key) => Boolean(env[key])).length;
    if (configuredCount > 0 && configuredCount < keys.length) {
      missing.push(label);
    }
  }

  return missing;
}
