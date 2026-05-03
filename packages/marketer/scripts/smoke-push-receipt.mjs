#!/usr/bin/env node
/**
 * Smoke check for the push receipt / status pipeline.
 *
 * Verifies end-to-end:
 *   1. Mint a short-lived affiliate bearer token via the QA-only admin endpoint.
 *   2. POST a push delivery receipt  → expect { accepted: true }.
 *   3. POST a push click receipt     → expect { accepted: true }.
 *   4. GET  push status              → expect delivered + clicked timestamps.
 *   5. Verify D1 rows via `wrangler d1 execute` (requires wrangler@4 on PATH or via pnpm dlx).
 *
 * Usage:
 *   node scripts/smoke-push-receipt.mjs \
 *     --url https://visibility-marketing.wetechfounders.workers.dev \
 *     --adminToken <ADMIN_TOKEN> \
 *     --affiliateCode qa-smoke \
 *     --affiliateEmail qa-smoke@example.com \
 *     [--dbName visibility-marketing-db] \
 *     [--skipD1]
 *
 * Environment alternatives (lower precedence than flags):
 *   WORKER_URL, ADMIN_TOKEN, AFFILIATE_CODE, AFFILIATE_EMAIL, D1_DB_NAME
 *
 * Notes:
 *   • The worker must be deployed with QA_MODE_ENABLED=true for step 1.
 *   • For D1 verification, wrangler@4 must be available:
 *       pnpm dlx wrangler@4  OR  npx wrangler@4
 *     The script tries `wrangler` first, then falls back to `pnpm dlx wrangler@4`.
 */

import { parseArgs } from 'node:util';
import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    url:            { type: 'string' },
    adminToken:     { type: 'string' },
    affiliateCode:  { type: 'string', default: 'qa-smoke' },
    affiliateEmail: { type: 'string', default: 'qa-smoke@example.com' },
    dbName:         { type: 'string', default: 'visibility-marketing-db' },
    skipD1:         { type: 'boolean', default: false },
  },
  strict: true,
});

const workerUrl    = values.url            ?? process.env.WORKER_URL;
const adminToken   = values.adminToken     ?? process.env.ADMIN_TOKEN;
const affiliateCode  = values.affiliateCode  ?? process.env.AFFILIATE_CODE  ?? 'qa-smoke';
const affiliateEmail = values.affiliateEmail ?? process.env.AFFILIATE_EMAIL ?? 'qa-smoke@example.com';
const dbName       = values.dbName         ?? process.env.D1_DB_NAME        ?? 'visibility-marketing-db';
const skipD1       = values.skipD1;

assert(workerUrl,  '--url or WORKER_URL is required');
assert(adminToken, '--adminToken or ADMIN_TOKEN is required');

function abs(path) {
  return new URL(path, workerUrl).toString();
}

async function apiCall(method, path, body, token, label) {
  const init = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };

  const res = await fetch(abs(path), init);
  const text = await res.text();

  let json;
  try { json = JSON.parse(text); } catch { json = text; }

  if (!res.ok) {
    throw new Error(`[${label}] HTTP ${res.status}: ${text}`);
  }
  return json;
}

// ─── Step helpers ────────────────────────────────────────────────────────────

function step(n, label) {
  process.stdout.write(`  [${n}] ${label} … `);
}
function pass(detail = 'ok') {
  console.log(`PASS  ${detail}`);
}
function fail(err) {
  console.log('FAIL');
  console.error(`      ${err.message ?? err}`);
  process.exitCode = 1;
}

// ─── D1 query via wrangler ────────────────────────────────────────────────────

function wranglerExec(sql) {
  const wranglers = [
    `wrangler d1 execute "${dbName}" --remote --json --command`,
    `pnpm dlx wrangler@4 d1 execute "${dbName}" --remote --json --command`,
  ];

  for (const base of wranglers) {
    try {
      const out = execSync(`${base} "${sql.replace(/"/g, '\\"')}"`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      return JSON.parse(out);
    } catch {
      // try next
    }
  }
  throw new Error('wrangler not found — install wrangler@4 or run via pnpm dlx wrangler@4');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n── Push Receipt / Status Smoke Check ──────────────────────────────');
  console.log(`   Worker  : ${workerUrl}`);
  console.log(`   Affiliate: ${affiliateCode} / ${affiliateEmail}`);
  console.log('');

  // 1. Mint QA affiliate token
  let userToken;
  step(1, 'Mint QA affiliate bearer token');
  try {
    const res = await apiCall('POST', '/api/admin/qa/affiliate-token', {
      code:  affiliateCode,
      email: affiliateEmail,
      ttlSecs: 300,
    }, adminToken, 'qa-token');
    userToken = res.data?.token ?? res.token;
    assert(userToken, 'No token returned');
    pass(`expires ${res.data?.expiresAtIso ?? res.expiresAtIso}`);
  } catch (err) { fail(err); return; }

  // 2. POST delivery receipt
  const notificationId = `smoke-${Date.now().toString(36)}`;
  const tenantId   = 'smoke-tenant';
  const contactId  = `smoke-contact-${Date.now().toString(36)}`;
  const campaignId = 'smoke-campaign';

  step(2, `POST /api/push/receipt (delivered) — notificationId=${notificationId}`);
  try {
    const res = await apiCall('POST', '/api/push/receipt', {
      notificationId,
      tenantId,
      contactId,
      campaignId,
      receiptType: 'delivered',
      occurredAt:  Math.floor(Date.now() / 1000),
    }, userToken, 'receipt-delivered');
    const accepted = res.data?.accepted ?? res.accepted;
    assert(accepted === true, `Expected accepted=true, got: ${JSON.stringify(res)}`);
    pass(`type=${res.data?.type ?? res.type}`);
  } catch (err) { fail(err); return; }

  // 3. POST click receipt
  step(3, `POST /api/push/receipt (clicked)`);
  try {
    const res = await apiCall('POST', '/api/push/receipt', {
      notificationId,
      tenantId,
      contactId,
      campaignId,
      receiptType: 'clicked',
      occurredAt:  Math.floor(Date.now() / 1000),
    }, userToken, 'receipt-clicked');
    const accepted = res.data?.accepted ?? res.accepted;
    assert(accepted === true, `Expected accepted=true, got: ${JSON.stringify(res)}`);
    pass(`type=${res.data?.type ?? res.type}`);
  } catch (err) { fail(err); return; }

  // 4. GET status
  step(4, `GET /api/push/status/${notificationId}`);
  try {
    const res = await apiCall('GET', `/api/push/status/${notificationId}`, undefined, userToken, 'status');
    const status = res.data ?? res;
    assert(status.delivered === true,  `Expected delivered=true, got: ${JSON.stringify(status)}`);
    assert(status.clicked   === true,  `Expected clicked=true, got: ${JSON.stringify(status)}`);
    pass(`delivered=${status.delivered} clicked=${status.clicked}`);
  } catch (err) { fail(err); return; }

  // 5. D1 row verification
  if (skipD1) {
    console.log('  [5] D1 row check … SKIPPED (--skipD1)');
  } else {
    step(5, `D1: push_notifications row for ${notificationId}`);
    try {
      const result = wranglerExec(
        `SELECT notification_id, delivered_at, clicked_at FROM push_notifications WHERE notification_id = '${notificationId}' LIMIT 1`
      );
      const rows = result?.[0]?.results ?? result?.results ?? [];
      assert(rows.length > 0, 'No row found in push_notifications');
      const row = rows[0];
      assert(row.delivered_at, `delivered_at is null: ${JSON.stringify(row)}`);
      assert(row.clicked_at,   `clicked_at is null: ${JSON.stringify(row)}`);
      pass(`delivered_at=${row.delivered_at} clicked_at=${row.clicked_at}`);
    } catch (err) { fail(err); }

    step(5, `D1: push_notification_receipt_events rows for ${notificationId}`);
    try {
      const result = wranglerExec(
        `SELECT receipt_type FROM push_notification_receipt_events WHERE notification_id = '${notificationId}'`
      );
      const rows = result?.[0]?.results ?? result?.results ?? [];
      assert(rows.length >= 2, `Expected ≥2 receipt events, found ${rows.length}`);
      const types = rows.map((r) => r.receipt_type);
      assert(types.includes('delivered'), `Missing 'delivered' event, found: ${types}`);
      assert(types.includes('clicked'),   `Missing 'clicked' event, found: ${types}`);
      pass(`events=[${types.join(', ')}]`);
    } catch (err) { fail(err); }
  }

  console.log('');
  if (process.exitCode === 1) {
    console.log('── Result: FAILED ──────────────────────────────────────────────────');
  } else {
    console.log('── Result: ALL CHECKS PASSED ───────────────────────────────────────');
  }
  console.log('');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
