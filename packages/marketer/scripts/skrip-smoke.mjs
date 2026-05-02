#!/usr/bin/env node
/**
 * Staging smoke check for the Visibility-Marketing ⇄ Skrip boundary.
 *
 * Verifies:
 *   1. Marketing admin diagnostics endpoint is reachable.
 *   2. Marketing accepts a correctly signed Skrip outcome webhook.
 *
 * Usage:
 *   node scripts/skrip-smoke.mjs --url https://visibility-marketing-dev.workers.dev \
 *     --adminToken <ADMIN_TOKEN> --webhookSecret <SKRIP_WEBHOOK_SIGNING_SECRET> \
 *     [--webhookToken <WEBHOOK_TOKEN>]
 *
 * Environment alternatives:
 *   WORKER_URL, ADMIN_TOKEN, SKRIP_WEBHOOK_SIGNING_SECRET, WEBHOOK_TOKEN
 */

import { createHash, createHmac } from 'node:crypto';
import { parseArgs } from 'node:util';
import { strict as assert } from 'node:assert';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    url: { type: 'string' },
    adminToken: { type: 'string' },
    webhookSecret: { type: 'string' },
    webhookToken: { type: 'string' },
    tenantId: { type: 'string', default: 'default' },
    channel: { type: 'string', default: 'push' },
  },
  strict: true,
});

const workerUrl = values.url ?? process.env.WORKER_URL;
const adminToken = values.adminToken ?? process.env.ADMIN_TOKEN;
const webhookSecret = values.webhookSecret ?? process.env.SKRIP_WEBHOOK_SIGNING_SECRET ?? process.env.WEBHOOK_SIGNING_SECRET;
const webhookToken = values.webhookToken ?? process.env.WEBHOOK_TOKEN;
const tenantId = values.tenantId ?? 'default';
const channel = values.channel ?? 'push';

assert(workerUrl, '--url or WORKER_URL is required');
assert(adminToken, '--adminToken or ADMIN_TOKEN is required');
assert(webhookSecret, '--webhookSecret or SKRIP_WEBHOOK_SIGNING_SECRET is required');

function absolute(path) {
  return new URL(path, workerUrl).toString();
}

function sign({ method, path, timestamp, nonce, rawBody, secret }) {
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const canonical = [method.toUpperCase(), path, timestamp, nonce, bodyHash].join('\n');
  return `sha256=${createHmac('sha256', secret).update(canonical).digest('hex')}`;
}

async function expectOk(response, label) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed: HTTP ${response.status} ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  const diagnosticsUrl = new URL(absolute('/api/admin/outbound/skrip/diagnostics'));
  diagnosticsUrl.searchParams.set('tenantId', tenantId);
  diagnosticsUrl.searchParams.set('channel', channel);

  const diagnostics = await expectOk(await fetch(diagnosticsUrl, {
    headers: { Authorization: `Bearer ${adminToken}` },
  }), 'diagnostics');
  console.log('[Skrip Smoke] diagnostics ok:', JSON.stringify(diagnostics.data?.counts ?? diagnostics.counts ?? {}));

  const path = '/webhooks/skrip/v1/outcomes';
  const timestamp = new Date().toISOString();
  const nonce = `smoke-${Date.now().toString(36)}`;
  const payload = {
    version: 'v1',
    eventId: `smoke_${Date.now().toString(36)}`,
    eventType: 'message.delivered',
    tenantId,
    contactId: 'smoke@example.com',
    campaignId: 'smoke-campaign',
    journeyId: null,
    stepId: 'smoke-step',
    channel,
    messageId: `smoke_msg_${Date.now().toString(36)}`,
    occurredAt: timestamp,
    sourceSystem: 'skrip',
    correlationId: nonce,
    metadata: { smoke: true },
  };
  const rawBody = JSON.stringify(payload);
  const signature = sign({ method: 'POST', path, timestamp, nonce, rawBody, secret: webhookSecret });

  const webhook = await expectOk(await fetch(absolute(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-skrip-timestamp': timestamp,
      'x-skrip-nonce': nonce,
      'x-skrip-signature': signature,
      ...(webhookToken ? { 'x-webhook-token': webhookToken } : {}),
    },
    body: rawBody,
  }), 'signed webhook');
  console.log('[Skrip Smoke] signed webhook ok:', JSON.stringify(webhook.data ?? webhook));
}

main().catch((error) => {
  console.error('[Skrip Smoke] failed:', error.message);
  process.exit(1);
});