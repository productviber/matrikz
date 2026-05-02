#!/usr/bin/env node
/**
 * scripts/skrip-replay-dlq.mjs
 *
 * Replay channel_outcome_dead_letter rows that are retryable and have not
 * yet been replayed. Sends each row to the outcome webhook endpoint as if
 * it arrived from Skrip (unsigned — for local/staging use only).
 *
 * Usage:
 *   node scripts/skrip-replay-dlq.mjs --url https://your-worker.workers.dev \
 *     --token <ADMIN_TOKEN> [--limit 50] [--dryRun]
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
    limit: { type: 'string', default: '50' },
    dryRun: { type: 'boolean', default: false },
  },
  strict: true,
});

const workerUrl = values.url ?? process.env.WORKER_URL;
const adminToken = values.token ?? process.env.ADMIN_TOKEN;
const limit = parseInt(values.limit ?? '50', 10);
const dryRun = values.dryRun ?? false;

assert(workerUrl, '--url or WORKER_URL is required');
assert(adminToken, '--token or ADMIN_TOKEN is required');

async function fetchDlqRows() {
  const res = await fetch(
    `${workerUrl}/api/admin/outbound/skrip/diagnostics`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch diagnostics: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return body.data ?? body;
}

async function triggerDispatch(batchSize, preview) {
  const url = new URL(`${workerUrl}/api/admin/outbound/skrip/dispatch`);
  url.searchParams.set('batchSize', String(batchSize));
  if (preview) url.searchParams.set('preview', 'true');

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) {
    throw new Error(`Dispatch failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  console.log(`[DLQ Replay] dryRun=${dryRun} limit=${limit} url=${workerUrl}`);

  const diagnostics = await fetchDlqRows();
  console.log('[DLQ Replay] Current DLQ depth:', diagnostics.counts?.pendingDlq ?? 'unknown');

  if (dryRun) {
    const preview = await triggerDispatch(limit, true);
    console.log('[DLQ Replay] Preview result:', JSON.stringify(preview.data ?? preview, null, 2));
    return;
  }

  const result = await triggerDispatch(limit, false);
  console.log('[DLQ Replay] Dispatch result:', JSON.stringify(result.data ?? result, null, 2));
}

main().catch((err) => {
  console.error('[DLQ Replay] Fatal:', err.message);
  process.exit(1);
});
