#!/usr/bin/env node
/**
 * scripts/skrip-reconcile.mjs
 *
 * Trigger the contact identity reconciliation endpoint to re-register any
 * contact_channel_identities rows stuck in registration_state='pending'.
 *
 * Usage:
 *   node scripts/skrip-reconcile.mjs --url https://your-worker.workers.dev \
 *     --token <ADMIN_TOKEN> [--batchSize 50]
 *
 * Environment (alternative to flags):
 *   WORKER_URL   — base URL of the marketer worker
 *   ADMIN_TOKEN  — admin bearer token
 */

import { parseArgs } from 'node:util';
import { strict as assert } from 'node:assert';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    url: { type: 'string' },
    token: { type: 'string' },
    batchSize: { type: 'string', default: '50' },
  },
  strict: true,
});

const workerUrl = values.url ?? process.env.WORKER_URL;
const adminToken = values.token ?? process.env.ADMIN_TOKEN;
const batchSize = parseInt(values.batchSize ?? '50', 10);

assert(workerUrl, '--url or WORKER_URL is required');
assert(adminToken, '--token or ADMIN_TOKEN is required');

async function main() {
  console.log(`[Reconcile] batchSize=${batchSize} url=${workerUrl}`);

  const url = new URL(`${workerUrl}/api/admin/outbound/skrip/reconcile`);
  url.searchParams.set('batchSize', String(batchSize));

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[Reconcile] HTTP ${res.status}: ${text}`);
    process.exit(1);
  }

  const body = await res.json();
  const data = body.data ?? body;
  console.log(`[Reconcile] Scanned=${data.scanned} Registered=${data.registered} Failed=${data.failed}`);

  if (data.failed > 0) {
    console.warn(`[Reconcile] ${data.failed} rows failed — check Skrip connectivity and retry.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[Reconcile] Fatal:', err.message);
  process.exit(1);
});
