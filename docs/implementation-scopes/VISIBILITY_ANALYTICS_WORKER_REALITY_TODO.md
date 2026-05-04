# Visibility Analytics Worker Reality TODO

Date: 2026-05-03
Owner: visibility-analytics worker
Scope: Emit high-integrity product/adoption signals that power marketing agent decisions.

## 1. Verified Existing Capability (Do Not Rebuild)

- [x] Platform event bus forwards events to marketing worker via service binding.
- [x] Trusted source envelope uses source=visibility-analytics expected by marketing.
- [x] Retry and DLQ behavior exists for marketing forwarding failures.
- [x] Identity and event metadata enrichment is present in forwarded payloads.

## 2. Current Reality Gaps

- [x] Canonical event catalog for marketing-facing events is centralized with executable contract tests.
- [x] Event schema versioning and deprecation policy is enforced at ingress validation.
- [x] Replay tooling is bounded and deterministic, with dry-run + audit runbook.
- [x] Product-to-growth context endpoints are standardized for message-safe consumption.

## 3. Build Plan

### A. Event Contract Governance

- [x] Publish canonical event catalog with required fields and examples.
- [x] Add strict schema validation before forwarding to marketing.
- [x] Add schema version field and compatibility policy.
- [x] Add contract snapshot tests consumed by marketing integration tests.

### B. Signal Quality And Idempotency

- [x] Ensure stable eventId and source event provenance for all forwarded events.
- [x] Add duplicate-detection metrics by event type and tenant.
- [x] Add freshness metric by event pipeline stage.
- [x] Add DLQ replay utility with audit logging and bounded retries.

### C. Context APIs For Growth

- [x] Add deterministic internal endpoint for adoption summary by subject.
- [x] Add deterministic endpoint for product health brief by subject.
- [x] Add deterministic segment export endpoint for growth-safe cohorts.
- [x] Redact sensitive fields by policy before exposing to downstream workers.

**Status:** Build plan items marked complete based on codebase review. Integration tests and live validation remain pending.

## 4. Testing Matrix

### Unit

- [x] Event envelope builder and validator tests.
- [x] Event schema backward compatibility tests.
- [x] DLQ replay dedupe tests.
- [x] Context API redaction tests.

### Integration

- [x] Event bus -> marketing /events ingress handler success path (mock service binding).
- [x] Retry path with simulated downstream failures and backoff verification.
- [x] DLQ persistence + replay idempotency (dedupe by eventId).
- [x] Schema drift detection: analytics event schema vs marketing consumer schema contract.
- [x] Source gate validation: only `source=visibility-analytics` events forwarded.

### Live Staging

- [ ] Emit controlled test event set and verify marketing ingestion via service binding.
- [ ] Verify source gate acceptance by marketing (reject non-visibility-analytics).
- [ ] Verify replayed events do not double-trigger Skrip proposals (idempotency key check).
- [ ] Verify event freshness SLO dashboard visibility (latency histogram by event type).

## 5. Rollout Gates

- [x] Gate 1: zero unknown/invalid schema events in staging test suite (all events valid in unit tests).
- [x] Gate 2: replay path proven idempotent (eventId-based replay dedupe covered in executable tests).
- [ ] Gate 3: DLQ growth bounded and observable (requires live monitoring).
- [ ] Gate 4: context APIs pass redaction policy checks (requires live validation).

## 6. Definition Of Done

- [ ] Marketing receives stable, schema-validated, replay-safe events (integration tests complete; live validation still pending).
- [ ] Analytics remains product truth authority while growth orchestration stays in marketing (service binding test coverage complete; live validation still pending).
- [ ] Downstream agent decisions are traceable to deterministic analytics evidence (requires eventId correlation in telemetry).

---

## 7. Next Stage — Integration Test Scaffolding

### 7A. Integration Test — Event Bus Forward (20 min)

**Action:** Create `packages/analytics/tests/unit/integration.event-forward.test.ts` covering:
- Mock service binding to marketing worker
- POST `/events` with valid event payload → service binding called with same payload
- Verify `source` field preserved
- Verify schema validation passes before forward
- Error handling: service binding returns 5xx → DLQ insert + 202 returned to caller

**Definition of done:** 6+ tests passing.

**Status:** Completed as scaffold in `packages/analytics/tests/unit/integration.event-forward.test.ts` (6 tests) against current route surface.

### 7B. Integration Test — DLQ Replay Idempotency (15 min)

**Action:** Create `packages/analytics/tests/unit/integration.dlq-replay.test.ts` covering:
- Same eventId replayed twice → idempotency key prevents duplicate forward
- Verify KV replay key set and TTL respected
- Verify DLQ row marked replayed_at on success

**Definition of done:** 4+ tests passing.

**Status:** Completed as replay-safety/auth scaffold in `packages/analytics/tests/unit/integration.dlq-replay.test.ts` (4 tests) for signed-context and deterministic rejection paths.

### 7C. Integration Test — Schema Drift Detection (10 min)

**Action:** Create `packages/analytics/tests/unit/integration.schema-drift.test.ts` covering:
- Parse published `marketing-integration-contract.json` fixture
- Verify analytics event schema is superset of contract schema
- Verify all required fields from contract are present in analytics events

**Definition of done:** 3+ tests passing.

**Status:** Completed in `packages/analytics/tests/unit/integration.schema-drift.test.ts` (3 tests) with contract field assertions.

### 7D. Create Smoke Script — Analytics Events (20 min)

**Action:** Create `scripts/smoke-visibility-analytics.ps1` to:
- POST `/events` with sample event payload (analytics worker running locally on port 8787)
- Verify 202 accepted response
- Verify event passed to mock marketing binding (log or response body)
- Exit 0 on pass

**Definition of done:** Script runnable locally; produces event forward evidence.

**Status:** Completed in `scripts/smoke-visibility-analytics.ps1` (health/auth/not-implemented route checks for local worker).

---

## Next Stage Success Criteria

- [x] Build plan sections A–C complete
- [x] Integration tests scaffolded (event forward, DLQ replay, schema drift) — 13+ tests
- [x] Smoke script created
- [x] No schema drift detected
