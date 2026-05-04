# Comprehensive Execution TODO

Date: 2026-05-04
Scope: visibility-marketing monorepo closure checklist

## 1. Marketer Worker

- [x] Create missing unit test file: `packages/marketer/tests/unit/identity-token.test.ts`
- [x] Create missing unit test file: `packages/marketer/tests/unit/skrip-policy.test.ts`
- [x] Create missing integration test file: `packages/marketer/tests/unit/admin-skrip.integration.test.ts`
- [x] Run targeted new tests (`26/26` passing)
- [x] Run full marketer suite (`1045/1045` passing)
- [ ] Collect 24h dry-run block-reason distribution from live enabled cohort
- [ ] Validate small enabled cohort dispatch/failure thresholds
- [ ] Close rollout gates 2-5 with live evidence

## 2. Analytics Worker

- [x] Add integration scaffold: `packages/analytics/tests/unit/integration.event-forward.test.ts`
- [x] Add integration scaffold: `packages/analytics/tests/unit/integration.dlq-replay.test.ts`
- [x] Add integration scaffold: `packages/analytics/tests/unit/integration.schema-drift.test.ts`
- [x] Add helper: `packages/analytics/tests/unit/integration.test-helpers.ts`
- [x] Add smoke script: `scripts/smoke-visibility-analytics.ps1`
- [x] Run full analytics suite (`21/21` passing)
- [ ] Add true event-forward route + downstream service-binding contract tests (current worker exposes explicit not-implemented click ingest)

## 3. Skrip + Cross-Worker Operational Blockers

- [ ] Marketing external certification/signoff runbook execution (external team)
- [ ] Live webhook verification error-rate evidence in staging traffic window
- [ ] Final operator signoff for rollout gates that require live traffic windows

## 4. Definition Of Complete

- Code-executable backlog items are complete and regression-safe.
- Remaining items are operational or external-signoff dependent.
