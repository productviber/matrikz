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

## 4. Testing Matrix

### Unit

- [x] Event envelope builder and validator tests.
- [x] Event schema backward compatibility tests.
- [x] DLQ replay dedupe tests.
- [x] Context API redaction tests.

### Integration

- [ ] Event bus -> marketing /events success path.
- [ ] Retry path with simulated downstream failures.
- [ ] DLQ persistence and replay path.
- [ ] Schema drift detection against marketing consumer fixtures.

### Live Staging

- [ ] Emit controlled test event set and verify marketing ingestion.
- [ ] Verify source gate acceptance by marketing.
- [ ] Verify replayed events do not double-trigger actions.
- [ ] Verify event freshness SLO dashboard visibility.

## 5. Rollout Gates

- [ ] Gate 1: zero unknown/invalid schema events in staging test suite.
- [ ] Gate 2: replay path proven idempotent.
- [ ] Gate 3: DLQ growth bounded and observable.
- [ ] Gate 4: context APIs pass redaction policy checks.

## 6. Definition Of Done

- [ ] Marketing receives stable, schema-validated, replay-safe events.
- [ ] Analytics remains product truth authority while growth orchestration stays in marketing.
- [ ] Downstream agent decisions are traceable to deterministic analytics evidence.
