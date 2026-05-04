# Visibility Marketing Worker Reality TODO

Date: 2026-05-03
Owner: visibility-marketing worker
Scope: Make email-first + agent-led multi-channel execution production-real.

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

- [ ] Identity token mint/verify edge cases.
- [ ] Subscribe idempotency and consent metadata validation.
- [ ] Policy rule tests for rollout combinations and kill switches.
- [ ] Dispatcher retry/backoff and dead-letter transitions.

### Integration

- [ ] Event -> signal -> action proposal -> policy -> execute path.
- [ ] Push/WhatsApp/SMS/Telegram subscribe -> identity registered -> eligible channels.
- [ ] Outbox dispatch -> signed Skrip webhook outcome -> lineage upsert.
- [ ] Attribution sweep links outcomes back to agent actions.

### Live Staging

- [ ] Smoke: diagnostics endpoint passes and reports configured true.
- [ ] Smoke: signed webhook accepted and nonce replay blocked.
- [ ] Dry-run cohort: 24h block-reason distribution captured.
- [ ] Enabled cohort (small): dispatch and failure rates within threshold.

## 5. Rollout Gates

- [ ] Gate 1: no misconfigured worker startup errors.
- [ ] Gate 2: >= 20 valid eligible identities in tenant default.
- [ ] Gate 3: policy block rate drops from no_eligible_skrip_channel baseline.
- [ ] Gate 4: signed outcome ingestion success rate stable.
- [ ] Gate 5: no compliance regression in unsubscribe/suppression handling.

## 6. Definition Of Done

- [ ] Consent capture, identity registration, and channel eligibility are consistently reproducible.
- [ ] Dry-run to enabled progression has measurable pass/fail criteria.
- [ ] Multi-channel execution complements email-first model without replacing it.
- [ ] Agentic decisions are traceable from event to outcome with auditable evidence.
