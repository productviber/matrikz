# Visibility Marketing Worker Reality TODO

Date: 2026-05-03
Owner: visibility-marketing worker
Scope: Make email-first + agent-led multi-channel execution production-real.

Staging endpoint: https://visibility-marketing-staging.wetechfounders.workers.dev
Staging version: 28810905-587d-425d-87e5-44f9a52f8736

## 1. Verified Existing Capability (Do Not Rebuild)

- [x] Event ingress from analytics service binding and trusted source checks.
- [x] Growth signal materialization + agent proposal path wired on event flow.
- [x] Policy engine gates action execution.
- [x] Skrip integration rails exist: registration, outbox, dispatcher, signed outcomes.
- [x] User-facing subscribe endpoints exist for push, WhatsApp, SMS, Telegram.
- [x] Cron already runs email processing, Skrip dispatch, reconciliation, and attribution sweeps.
- [x] Admin diagnostics and quality endpoints exist for Skrip and agentic telemetry.

## 2. Current Reality Gaps

- [ ] Frontend-driven consent journeys are not consistently connected to subscribe endpoints with stable contact identity.
- [ ] Most send_via_skrip proposals are blocked by no_eligible_skrip_channel.
- [ ] Dry-run and effective flag states are not yet aligned to produce controlled enabled traffic.
- [ ] Outcome-attribution quality gates are not codified into operator rollout runbooks.

## 3. Build Plan

### A. Identity Bridge From Outreach To Consent

- [x] Add signed recipient identity token generation for outbound links.
- [x] Add token verification endpoint in marketing lane.
- [x] Resolve token to contactId + tenantId and persist correlation IDs.
- [x] Reject expired/tampered tokens with auditable reason codes.

### B. Consent Intake Hardening

- [x] Require consent metadata on subscribe requests (source, campaign, step, landing route).
- [x] Enforce idempotent subscribe writes by contactId + channel + address hash.
- [x] Add unsubscribe parity checks across all channel endpoints.
- [x] Add abuse/rate controls for public user lane routes.

### C. Policy And Rollout Readiness

- [x] Add operator API for setting Skrip flags by tenant/campaign/channel.
- [x] Add read endpoint returning combined authority + flag + policy effective state.
- [x] Add explicit reason telemetry for blocked proposals by policy rule.
- [x] Add kill-switch drill command and response playbook validation.

### D. Execution Reliability

- [x] Add deduplicated replay for failed channel_outcome_dead_letter rows.
- [x] Add structured dispatcher retry telemetry (first fail, retry, terminal fail).
- [x] Add action-level linkage from send_via_skrip to lineage/outcomes.
- [x] Add cron execution summary snapshot in KV for last 24h trend checks.

## 4. Testing Matrix

### Unit

- [ ] Identity token mint/verify edge cases (expiry, tamper, replay, REJECT_REASON auditing).
- [ ] Subscribe idempotency and consent metadata validation (contact+channel+address hash, INSERT OR IGNORE).
- [ ] Policy rule tests for rollout combinations and kill switches (flags, authority, decision).
- [ ] Dispatcher retry/backoff and dead-letter transitions (telemetry events, replayDeadLetterBatch).

### Integration

- [ ] Event -> signal -> action proposal -> policy -> execute path.
- [ ] Push/WhatsApp/SMS/Telegram subscribe -> identity registered -> eligible channels.
- [ ] Outbox dispatch -> signed Skrip webhook outcome -> lineage upsert with agentActionId.
- [ ] Attribution sweep links outcomes back to agent actions via agent_action_id column.
- [ ] `/api/admin/skrip/flags` → KV write → `/api/admin/skrip/policy-state` read consistency.

### Live Staging

- [x] Smoke: `/api/identity/mint` and `/api/identity/verify` success paths.
- [x] Smoke: `/api/admin/skrip/flags`, `/api/admin/skrip/policy-state`, `/api/admin/skrip/killswitch/drill`, `/api/admin/skrip/dlq/replay` all return 200.
- [ ] Dry-run cohort: 24h block-reason distribution captured by policy rule.
- [ ] Enabled cohort (small): dispatch and failure rates within threshold.

## 5. Rollout Gates

- [x] Gate 1: no misconfigured worker startup errors — 1019/1019 tests passing; deployed v0fcd0eee.
- [ ] Gate 2: >= 20 valid eligible identities in tenant default (requires live data).
- [ ] Gate 3: policy block rate drops from no_eligible_skrip_channel baseline (requires observability).
- [ ] Gate 4: signed outcome ingestion success rate stable (requires Skrip integration).
- [ ] Gate 5: no compliance regression in unsubscribe/suppression handling (requires live validation).

## 6. Definition Of Done

- [x] Consent capture, identity registration, and channel eligibility are consistently reproducible (code: mint/verify routes, consentMeta, idempotency).
- [ ] Dry-run to enabled progression has measurable pass/fail criteria (requires policy telemetry dashboards).
- [ ] Multi-channel execution complements email-first model without replacing it (requires load testing).
- [ ] Agentic decisions are traceable from event to outcome with auditable evidence (requires agent_action_id linking verified end-to-end).

---

## 7. Next Stage — Test Execution & Smoke Validation

### 7A. Unit Tests — Identity Token (15 min)

**Action:** Create `packages/marketer/tests/unit/identity-token.test.ts` covering:
- `mintRecipientToken`: valid mint, token format validation, expiresAt >= now, tokenHash is SHA-256
- `verifyRecipientToken`: success path, expired token rejection, tampered token detection, replay detection, purpose validation
- All 4 `REJECT_REASON` codes exercised

**Definition of done:** 12+ tests, all passing, coverage >= 90%.

### 7B. Unit Tests — Policy & Flags (20 min)

**Action:** Create `packages/marketer/tests/unit/skrip-policy.test.ts` covering:
- `handleSkripFlagSet`: valid key format regex, KV write, ttl handling
- `handleSkripPolicyState`: authority + flags combination, kill-switch resolution, effective state logic
- `handleKillSwitchDrill`: reads all 4 KV keys, returns drill report
- Auth: admin lane enforced for flag-set and kill-switch-drill

**Definition of done:** 16+ tests, all passing, coverage >= 85%.

### 7C. Integration Tests — Admin Skrip Routes (20 min)

**Action:** Create `packages/marketer/tests/unit/admin-skrip.integration.test.ts` covering:
- Flag set → policy-state read consistency
- Kill-switch drill with various flag states
- DLQ replay with empty and populated dead-letter table

**Definition of done:** 8+ tests, all passing.

### 7D. Smoke Test Script — Marketing Routes (30 min)

**Action:** Create `scripts/smoke-visibility-marketing.ps1` executing against deployed URL:
- `/api/identity/mint` with sample body, verify token returned
- `/api/identity/verify` with returned token, verify contact ID resolved
- `/api/admin/skrip/flags`, `/api/admin/skrip/policy-state`, `/api/admin/skrip/killswitch/drill`, `/api/admin/skrip/dlq/replay` all return 200
- Exit 0 on all pass, 1 on any failure

**Definition of done:** Script runs without errors; smoke report printed to stdout.

### 7E. Verify Live Deployment (10 min)

**Action:** Run the smoke script against `https://visibility-marketing-dev.wetechfounders.workers.dev`.

**Definition of done:** All endpoints return 200; script exit code 0.

---

## Next Stage Success Criteria

- [x] Code implementation complete for sections A–D
- [x] Deployed to dev environment
- [ ] Unit tests added for identity token, policy, flags
- [ ] Integration tests added for admin routes
- [x] Smoke script created and passing
- [ ] All 1019+ tests passing after additions

---

## 8. Next Activities (Remaining)

1. Add and stabilize unit tests:
	- `packages/marketer/tests/unit/identity-token.test.ts`
	- `packages/marketer/tests/unit/skrip-policy.test.ts`
2. Add integration test for admin Skrip route consistency:
	- `packages/marketer/tests/unit/admin-skrip.integration.test.ts`
3. Run full marketer test suite and keep baseline green:
	- Target: 1019+ tests passing with new additions
4. Collect rollout evidence on staging:
	- 24h policy block-reason distribution
	- small enabled cohort dispatch/failure thresholds
5. Close rollout gates with evidence:
	- Gate 2 (eligible identities), Gate 3 (block-rate drop), Gate 4 (signed outcomes), Gate 5 (compliance regression)
