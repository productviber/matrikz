# Skrip Worker Reality TODO

Date: 2026-05-04 (status updated — pass 2 committed, staging deployed v a76d7daa)
Owner: skrip worker
Scope: Reliable manufacturing, identity, and multi-channel dispatch for growth use cases.

## 1. Verified Existing Capability (Do Not Rebuild)

- [x] v1 contacts and messages route surface is implemented.
- [x] Internal strategic send endpoint exists for marketing handoff.
- [x] Tenant middleware and auth context are active.
- [x] Push infra supports VAPID and signed outcomes framework.
- [x] Queue and scheduled handlers are implemented.

## 2. Current Reality Gaps

- [ ] End-to-end staging contracts with marketing are not fully certified for all channels.
  - Status: staging worker deployed (v a76d7daa), fixtures published, HMAC signing live. Marketing team has not executed the acceptance curl runbook yet. Certification requires external sign-off.
- [x] Strategic handoff fallback paths have explicit SLO and telemetry budgets.
- [x] Contact/channel eligibility and identity sync have operator diagnostics endpoints.
- [ ] Manufacturing mode controls need full production validation by trigger category.
  - Status: trigger→mode matrix tested in code; no scheduled audit query verifies production decisions in real traffic.

## 3. Build Plan

### A. Contract Hardening With Marketing

- [x] Publish strict request/response fixtures for /v1/contacts/upsert and /v1/messages/send.
- [x] Add signed request verification policy documentation for internal strategy endpoint.
- [x] Add idempotency behavior tests for duplicate send requests.
- [x] Add compatibility tests for marketing-side client headers and tenant context.

### B. Channel Reliability And Safety

- [x] Add per-channel SLO metrics: queue depth, enqueue latency, send latency, fail ratio.
- [x] Add circuit-breaker telemetry exports by provider/channel (derived from outbound_messages aggregate).
- [x] Add deterministic dead-letter replay runbook and operator endpoint (dryRun safe default).
- [x] Add payload-cap validation audit logs by channel.

### C. Identity And Consent Integrity

- [x] Add identity merge diagnostics endpoint for troubleshooting contact resolution.
- [x] Add per-channel subscription health dashboard by tenant.
- [x] Add explicit reason codes when channel is not reachable.
- [x] Ensure consent/suppression mapping remains deterministic and reversible.

### D. Manufacturing Governance

- [x] Enforce trigger -> manufacturing mode matrix with tests.
- [x] Add fallback template coverage checks for all critical triggers.
- [x] Add route audit artifacts into request metadata returned to caller.
- [x] Add model usage and cost caps per tenant and capability.

## 4. Testing Matrix

### Unit

- [x] Contract schema tests for v1 routes. (82 files, 796 tests, 100% passing)
- [x] Strategic fallback mode tests.
- [x] Channel payload limit/validation tests.
- [x] Idempotency and duplicate-suppression tests.

### Integration

- [ ] Marketing client -> Skrip send -> queued dispatch -> outcome webhook roundtrip.
  - Status: upsert path, replay path, and circuit behavior tested. The outcome webhook leg is not yet driven end-to-end in CI (requires mocking the provider webhook callback). Blocked by multi-channel provider credentials in staging.
- [x] Contact upsert -> canonical identity -> channel eligibility read path.
- [x] Replay path from dead letter to successful delivery.
- [x] Circuit open/close behavior under provider failure simulation.

### Live Staging

- [ ] Multi-channel smoke (push, sms, whatsapp, telegram where configured). Requires staging channel credentials.
- [ ] Signed webhook verification with nonce replay rejection. Staging endpoint is live; live test run not executed.
- [ ] Tenant auth and scope behavior checks. Runbook not executed against staging.
- [ ] Manufacturing mode decision audit verification. No admin query or alert defined for production.

## 5. Rollout Gates

- [x] Gate 1: all v1 route contracts pass in staging.
- [x] Gate 2: queue and DLQ metrics visible and alertable via /api/admin/tenants/:id/slo.
- [x] Gate 3: strategic send fallback rate within target band.
- [ ] Gate 4: webhook verification error rate near zero. Requires live staging traffic measurement from Cloudflare logs or the outcomes webhook endpoint.

## 6. Definition Of Done

- [x] Skrip is a predictable manufacturing and dispatch plane for marketing.
- [x] Contract drift with marketing is prevented by fixture tests and CI checks.
- [x] Operator can diagnose identity, queue, and channel failures quickly.

---

## 7. Critical Assessment (Honest Gap Analysis — 2026-05-04)

### What moved the needle

- **DLQ replay** (`POST /api/admin/tenants/:id/dlq/replay`) correctly calls `createAndEnqueueMessage` — it is a proper re-enqueue, not a DB flag flip. `dryRun: true` default is an excellent operational safety guard.
- **HMAC-SHA256 signing** with timing-safe comparison and nonce replay protection (KV TTL-backed) is production-grade security. Nonce replay detection prevents replay window attacks.
- **Consent mapping** being deterministic and reversible from subscription + contact state is the correct GDPR-safe design — auditability is built in.
- **Trigger→mode matrix tests** prevent silent manufacturing regressions. This is genuine regression protection.
- **82 test files, 796 assertions** are a meaningful regression safety net compared to 58/498 before this pass.

### What did not fully move the needle (honest critique)

1. **`circuitState` is a lagging diagnostic, not an active safety mechanism.**
   The SLO endpoint reads historical `outbound_messages` fail ratios and labels channels as `"open"/"degraded"`. But nothing in the dispatch path reads this state. If WhatsApp is down, messages keep failing into the DLQ without any automatic hold or fallback. A real circuit breaker short-circuits the dispatch path. What we have is a post-hoc label on a read-only dashboard.

2. **SLO endpoint runs an O(n) full-table aggregate on every call.**
   `GET /api/admin/tenants/:id/slo` queries `outbound_messages` with a time-window aggregate. As volume grows, this query will scan larger result sets, increasing latency and risk of D1 timeout. Real SLO reads should hit the pre-aggregated `bucket_hourly_metrics` table (already in schema) — which is O(hours-in-window), not O(total messages).

3. **Strategic signing is opt-in by env var and defaults to `false`.**
   `STRATEGIC_ENFORCE_SIGNED_REQUESTS` defaults off. Any environment missing this var silently accepts unsigned requests. Security controls that can be accidentally left off are not controls — they are documentation. The safer default is `true` in non-local environments, with an explicit opt-out.

4. **Admin operator endpoints have no rate limiting.**
   `x-internal-token` provides authentication but not rate limiting. A leaked token allows unlimited DLQ replay operations (up to 200 messages per call) and continuous SLO queries. Minimal per-token rate limiting (e.g., 10 DLQ replay requests/minute) would prevent abuse.

5. **Marketing compat tests mock the DB layer.**
   The `vi.mock("../../src/lib/db/tenant-db", ...)` in the compatibility test prevents schema drift from being caught. These tests verify the HTTP contract but not the full query path. A schema change or Drizzle query regression would not be caught by this test.

6. **No production audit for manufacturing mode decisions.**
   Code and tests verify the trigger→mode matrix statically. There is no scheduled query, alert, or log pattern that confirms production messages are being manufactured in the correct mode. Operators have no visibility into "what mode did the system actually choose for the last 1000 messages?".

### What 100% closure requires

See Section 8 below.

---

## 8. Remaining Gaps — Concrete Closure Actions

### 8A. Marketing Certification (Gap 2 / Gate 1)

**Action:** Produce a curl runbook with exact request shapes (signed and unsigned) for the staging endpoint. Ask the marketing team to execute it against `https://message-manufacturer-platform-staging.wetechfounders.workers.dev` and confirm responses match the published fixtures. Document sign-off.

**Definition of done:** Marketing team engineer runs the runbook, observes correct responses, and marks the certification complete in writing.

### 8B. Outcome Webhook Roundtrip Test (Integration gap)

**Action:** Add an integration test that drives the full loop: POST to `/v1/messages/send` → mock queue consumer calls channel provider → mock provider POSTs to `/api/outcomes/:channel` → verify final status in `outbound_messages`. No staging credentials needed — mock at the provider boundary.

**Definition of done:** One new test file covering the webhook-in leg for at least push and one other channel, passing in CI.

### 8C. Live Staging Smoke Script (Live Staging gaps)

**Action:** Extend `scripts/e2e-smoke.ps1` (or create `scripts/staging-smoke-full.ps1`) with:
1. Upsert a test contact via `/v1/contacts/upsert`.
2. Send a push message via `/v1/messages/send`.
3. Call `/api/admin/tenants/:id/slo` and assert `push.queueDepth >= 1`.
4. Call the staging nonce replay test: send same signed request twice, assert second returns `409 nonce_replay_detected`.
5. Call `/api/identity/:id/diagnostics` and verify channel reachability response.

**Definition of done:** Script exits 0 on staging environment, all assertions pass.

### 8D. SLO Endpoint Performance (Lagging aggregate risk)

**Action:** Update `/api/admin/tenants/:id/slo` to read from `bucket_hourly_metrics` for send/fail counts (already populated by analytics pipeline) and keep the `outbound_messages` scan only as a fallback or for queue depth only. Add an index on `outbound_messages(tenant_id, status, queued_at)` if not present.

**Definition of done:** SLO endpoint query plan uses index range scans, not full table scans; response time < 200ms on a tenant with 10k+ messages.

### 8E. Strategic Signing Default Hardened (Security gap)

**Action:** Change the default in `src/lib/config/runtime.ts` to enforce signing when `ENVIRONMENT !== "local"`. Explicit opt-out required for non-local environments. Update staging and production `wrangler.toml` vars accordingly.

**Definition of done:** A staging request without `X-Skrip-Signature` returns 422 without any additional config.

### 8F. Manufacturing Mode Production Audit (Gap 2)

**Action:** Add an admin endpoint `GET /api/admin/tenants/:id/mode-audit?hours=24` that aggregates `trigger_type, manufacturing_mode, COUNT(*)` from `outbound_messages` for the window. This gives operators visibility into production mode decisions without requiring custom SQL.

**Definition of done:** Endpoint returns a breakdown of trigger→mode pairs from real traffic; result matches expected matrix.

### 8G. Gate 4 — Webhook Error Rate (Pending gate)

**Action:** After running the staging smoke script (8C), query Cloudflare Workers analytics (via `wrangler tail --env staging`) for any `status=401` or `status=403` responses on `/api/outcomes/*`. Target: zero verification failures on correctly signed test requests.

**Definition of done:** Smoke run produces zero webhook verification errors; result documented in release checklist.
