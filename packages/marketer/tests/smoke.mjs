/**
 * Smoke test for the visibility-marketing worker.
 *
 * Usage:
 *   node tests/smoke.mjs [base_url]
 *
 * Defaults to http://localhost:8787 if no base URL is provided.
 */

const BASE = process.env.BASE_URL || process.argv[2] || 'http://localhost:8787';

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  console.log(`\n🧪 Smoke Tests — ${BASE}\n`);

  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ✅ ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`  ❌ ${t.name}: ${err.message}`);
    }
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed, ${tests.length} total\n`);
  process.exit(failed > 0 ? 1 : 0);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('GET / returns worker info', async () => {
  const res = await fetch(`${BASE}/`);
  assert(res.ok, `Expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body.worker === 'visibility-marketing', 'Worker name mismatch');
});

test('GET /health returns ok', async () => {
  const res = await fetch(`${BASE}/health`);
  assert(res.ok, `Expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body.ok === true, 'Expected ok: true');
  assert(body.data.status === 'ok', 'Status should be ok');
});

test('GET /api/health returns detailed health', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert(res.ok, `Expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body.ok === true, 'Expected ok: true');
  assert(body.data.checks, 'Should have checks object');
});

test('POST /events with valid envelope returns ok', async () => {
  const res = await fetch(`${BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'user.converted',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        userId: 'test@example.com',
        purchaseType: 'pro',
        plan: 'yearly',
        amountCents: 29900,
        gateway: 'stripe',
      },
    }),
  });
  assert(res.ok, `Expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body.ok === true, 'Expected ok: true');
});

test('POST /events with affiliate.conversion returns ok', async () => {
  const res = await fetch(`${BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'affiliate.conversion',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        affiliateCode: 'test-partner',
        userId: 'buyer@example.com',
        eventType: 'subscription.created',
        amountCents: 2900,
        commissionCents: 580,
        plan: 'pro',
      },
    }),
  });
  assert(res.ok, `Expected 200, got ${res.status}`);
});

test('POST /events with unknown source returns 400', async () => {
  const res = await fetch(`${BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'test.event',
      source: 'unknown-source',
      timestamp: new Date().toISOString(),
      data: {},
    }),
  });
  assert(res.status === 400, `Expected 400, got ${res.status}`);
});

test('POST /events with unknown event type returns 200 (forward compatible)', async () => {
  const res = await fetch(`${BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'future.unknown.event',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: { foo: 'bar' },
    }),
  });
  assert(res.ok, `Expected 200, got ${res.status}`);
});

test('GET /api/affiliate/stats without code returns 400', async () => {
  const res = await fetch(`${BASE}/api/affiliate/stats`);
  assert(res.status === 400, `Expected 400, got ${res.status}`);
});

test('GET /api/affiliate/stats with code returns data', async () => {
  const res = await fetch(`${BASE}/api/affiliate/stats?code=test-partner`);
  assert(res.ok, `Expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body.ok === true, 'Expected ok: true');
  assert(body.data.code === 'test-partner', 'Code mismatch');
});

test('GET /api/campaigns returns list', async () => {
  const res = await fetch(`${BASE}/api/campaigns`);
  assert(res.ok, `Expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body.ok === true, 'Expected ok: true');
  assert(Array.isArray(body.data.campaigns), 'Should return campaigns array');
});

test('POST /api/affiliate/apply creates application', async () => {
  const res = await fetch(`${BASE}/api/affiliate/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `smoke-test-${Date.now()}@example.com`,
      name: `Smoke Test ${Date.now()}`,
      website: 'https://example.com',
    }),
  });
  assert(res.status === 201, `Expected 201, got ${res.status}`);
  const body = await res.json();
  assert(body.ok === true, 'Expected ok: true');
  assert(body.data.status === 'pending', 'Should be pending');
});

test('GET /r/nonexistent redirects with fallback', async () => {
  const res = await fetch(`${BASE}/r/nonexistent-slug`, { redirect: 'manual' });
  assert(res.status === 302, `Expected 302, got ${res.status}`);
});

test('GET /nonexistent returns 404', async () => {
  const res = await fetch(`${BASE}/this-does-not-exist`);
  assert(res.status === 404, `Expected 404, got ${res.status}`);
});

test('OPTIONS / returns CORS headers', async () => {
  const res = await fetch(`${BASE}/`, { method: 'OPTIONS' });
  assert(res.status === 204, `Expected 204, got ${res.status}`);
  assert(res.headers.get('Access-Control-Allow-Origin') === '*', 'Missing CORS header');
});

// Run
run();
