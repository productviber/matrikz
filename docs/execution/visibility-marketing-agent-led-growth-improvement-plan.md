# Visibility Marketing Agent-Led Growth Improvement Plan

Date: 2026-05-09
Owner: Visibility Marketing / distributed growth-agent component
Scope: visibility-marketing, growth-agent advisory binding, dispatcher, Skrip handoff, outcome feedback, governance rollout

## Executive Assessment

Visibility Marketing is the right home for the agent-led growth controller. The current system already has the critical production foundations: deterministic signal materialization, agent action ledger, policy gates, AI advisory integration, Skrip handoff, outcome attribution, governance controls, and operator endpoints.

The next improvement phase should not rebuild the system. It should make the distributed agent growth loop measurable, reviewable, deployable, and quality-gated. The most valuable improvements are the ones that convert existing telemetry and ledger data into operator-grade evidence: recommendation quality, fallback maturity, cost per recommendation, false-positive/false-negative proxies, semantic evals, and controlled rollout gates.

## Current Strengths To Preserve

- Visibility Marketing owns growth orchestration, policy, audit, attribution, and execution rails.
- growth-agent owns structured advisory capabilities and returns metadata with prompt version, schema version, fallback state, latency, token estimate, and cost estimate.
- Agent actions are persisted in `agent_actions` with evidence, policy result, AI metadata, and idempotency keys.
- Outcomes are projected into `agent_action_outcomes`, and stale actions can be marked `no_outcome_observed`.
- Skrip handoff is routed through structured execution intent and outbox/strategic send paths.
- Governance ingress and execution are already in observe mode with runbooks and rollback controls.
- Tests are broad and currently passing in the local marketer suite.

## Priority Improvement Areas

### P0 — Operator-Grade Decision Quality Metrics

Why this matters: The system has decision and outcome data, but operators need a single quality view that answers whether the agent is improving or merely operating.

Improve:
- Fallback rate by window, capability, prompt version, model, and action type.
- Cost and token estimates per recommendation and per successful outcome.
- High-confidence recommendation quality.
- No-outcome rate by action type.
- False-positive proxy: high-confidence interventions that ended in no outcome.
- False-negative proxy: wait/manual-review/escalation decisions followed by positive self-resolution or conversion.
- Recent quality risk samples for review.

Acceptance:
- `GET /api/admin/agentic/quality` returns quality, cost, fallback, and FP/FN proxy metrics.
- Endpoint remains bounded by `windowDays` and uses existing D1 tables.
- Focused unit coverage verifies the new rollups.

Implemented:
- `GET /api/admin/agentic/quality` returns aggregate proposal quality, cost, fallback, metadata completeness, trace completeness, repeated-category quality, FP/FN proxy metrics, and recent quality-risk samples.
- `aiMetadataByDimension` groups provider, model, prompt version, response schema version, capability, fallback state, token totals, cost totals, latency, and missing telemetry counts.

### P0 — Semantic Evaluation Harness

Why this matters: Schema validity proves the model responds in the correct shape; it does not prove the recommendation is good.

Improve:
- Add labeled fixtures for `growth-next-action`, `message-brief`, and `outcome-diagnose`.
- Score recommendations against expected action family, allowed risk, policy alignment, specificity, and trust safety.
- Add adversarial cases: missing consent, suppressed contact, contradictory signals, stale signals, repeated no-response, high-risk proposal.
- Make eval results part of deploy gates for prompt/model/schema changes.

Acceptance:
- Offline eval command exists and is documented.
- Prompt changes require passing schema tests plus semantic eval thresholds.
- Eval report includes pass rate, schema validity, fallback rate, latency, and cost.

Initial command:

```powershell
Set-Location 'd:\coding\clodo-dev-site\visibility-marketing\packages\growth-agent'
corepack pnpm run eval:semantic
```

Initial gate thresholds:
- Case score must be `>= 0.8`.
- Suite pass rate must be `100%`.
- Schema validity rate must be `100%`.
- Fallback rate must be `0%` for deterministic eval fixtures.

### P0 — Cost Per Recommendation Accounting

Why this matters: Metadata contains token and cost estimates, but operators need accountable reporting at recommendation and outcome level.

Improve:
- Persist and aggregate `tokenEstimate`, `costEstimate`, provider, model, prompt version, and capability from `ai_metadata_json`.
- Report cost per proposal, cost per executed action, cost per positive outcome, and fallback-cost floor.
- Track unknown/null metadata separately to expose instrumentation gaps.

Acceptance:
- Admin quality endpoint exposes cost/token totals and averages.
- Admin quality endpoint exposes executed-action cost totals and `costPerExecutedAction`.
- Documentation defines how to interpret null cost for free/local models vs missing provider metadata.

Implemented:
- `docs/operations/AGENTIC-COST-TELEMETRY.md` defines the cost fields, null-cost semantics, and review thresholds.

### P1 — Causal Measurement And Holdout Reporting

Why this matters: A subject converting after a recommendation is not proof the recommendation caused the conversion.

Improve:
- Preserve treatment/control arm in recommendation logs and outcome records.
- Build holdout reporting by experiment ID, action type, subject stage, and attribution window.
- Separate direct outcome attribution from uplift estimates.
- Add confidence intervals before claiming revenue impact.

Acceptance:
- Control-arm metrics are queryable from operator routes or reports.
- Promotion gates use holdout/uplift where available, not only period-over-period conversion.

Initial internal report:

```powershell
Set-Location 'd:\coding\clodo-dev-site\visibility-marketing\packages\growth-agent'
# Requires x-internal-secret and x-tenant-id headers when called remotely.
# Path: GET /internal/experiments/holdout-report?windowDays=30&minArmSample=50
```

The report reads `recommendation_log` and `outcome_records`, groups by `experiment_id`, `arm`, capability, and action type, then returns treatment/control rates plus uplift estimates. Attribution answers "what happened after a recommendation"; uplift compares treatment against control and is the metric to use before claiming causal impact.

### P1 — Recommendation Diversity And Habituation Controls

Why this matters: Repeating the same category of intervention burns attention even when each single recommendation is plausible.

Improve:
- Track action-type repetition per subject over recent windows.
- Add diversity budget and suppression logic for repeated action categories.
- Surface repeated-action risk in policy warnings and quality metrics.
- Add tests for no-response followed by repeated proposals.

Acceptance:
- Subject context includes recent action type distribution.
- Policy or decision hints penalize repeated no-outcome action categories.
- Quality reporting exposes repeated same-category intervention rates.

Initial implementation:
- Marketer subject context adds recent action type distribution, repeated-action warnings, and a `diversityRisk` summary.
- `growth-next-action` policy hints include repeated warnings, avoid-action types for repeated no-outcome categories, and the active diversity budget.
- The proposal materializer persists diversity context in action evidence for later trace review.
- `GET /api/admin/agentic/quality` exposes `repeatedSameCategoryInterventions` plus repeated-category rates per action type.
- Focused validation: `corepack pnpm exec vitest run tests/unit/growth-event-actions.test.ts --reporter=basic` from `packages/marketer` passed with 15 tests.

### P1 — Reasoning Trace Completeness

Why this matters: The right to explanation and debugging need more than final action output.

Improve:
- Ensure each proposal persists prompt version, schema version, model, provider, fallback reason, policy hints summary, active signal count, and outcome history summary.
- Keep raw PII out of logs while retaining enough structured evidence to reconstruct decision cause.
- Add a trace completeness metric for action rows missing critical metadata.

Acceptance:
- Decision trace endpoint can explain why the action was proposed, why it was allowed/blocked, and what happened afterward.
- Quality endpoint reports metadata completeness.

Initial implementation:
- Admin quality reporting now includes `traceCompleteness` with complete row count/rate and present/missing counts for prompt version, response schema version, provider/model or explicit fallback, route reason, fallback reason, policy result, signal summary, subject context, and outcome summary.
- The rollup uses existing action JSON columns, so no migration is required for the first trace-completeness gate.
- `docs/operations/AGENTIC-TRACE-REVIEW-GUIDE.md` defines required trace fields, sampling procedure, reviewer checklist, and escalation rules.

### P2 — Formal Agent Performance Review Cadence

Why this matters: Agent-led growth needs an accountable human operating rhythm.

Improve:
- Add a quarterly review template covering fallback rate, cost, no-outcome rate, conversion/uplift, policy blocks, complaint/unsubscribe signals, and sampled qualitative reviews.
- Define owners for product, marketing, data, engineering, and legal/governance signoff.
- Require remediation issues for metrics outside thresholds.

Acceptance:
- Review template exists in docs.
- Quality endpoint provides the data needed for the template.

Implemented:
- `docs/operations/AGENTIC-GROWTH-QUARTERLY-REVIEW-TEMPLATE.md` includes baseline capture commands, quality/cost/governance/holdout tables, trace sampling, and a remediation ticket template.

## Recommended 90-Day Implementation Sequence

### Days 0-15: Measurement Foundation

1. Upgrade `GET /api/admin/agentic/quality` with cost, token, fallback, metadata completeness, no-outcome, and FP/FN proxy rollups.
2. Add focused tests for quality rollup calculations.
3. Document interpretation of each metric and threshold.
4. Verify local tests and D1 migration state.

### Days 16-35: Eval Gate

1. Add semantic eval fixtures for `growth-next-action`.
2. Add eval runner and report output.
3. Add prompt/model/schema promotion gate in docs and CI-ready command.
4. Extend evals to `message-brief`.

### Days 36-55: Causal Reporting

1. Add holdout/control-arm reporting for recommendation outcomes.
2. Add uplift and confidence-interval fields where sample size permits.
3. Separate attribution reporting from causal impact reporting.

### Days 56-75: Diversity And Suppression Quality

1. Add recent action category distribution to subject context.
2. Penalize repeated no-outcome categories in policy hints or prompt context.
3. Add repeated-action quality metric.
4. Add tests for habituation prevention.

### Days 76-90: Deployment And Review Cadence

1. Deploy to staging.
2. Run 7-day observe-mode quality soak.
3. Produce first agent performance review using the new metrics.
4. Promote improved component if gates pass.

## Deployment Readiness Gates

- Full marketer test suite passes.
- Growth-agent tests pass.
- D1 migrations show no pending migration for the target database.
- Semantic evals pass threshold with `corepack pnpm run eval:semantic` from `packages/growth-agent`.
- Fallback rate is within target or explained by provider/capability state.
- No-outcome rate by action type is within threshold or actions are restricted to supervised mode.
- Governance ingress/execution are at least in observe mode with SLO endpoint healthy.
- Rollback path is tested: governance override, agent kill switch, Skrip rollout state, and deployment rollback.

## Initial Thresholds

These are starting thresholds for operator review. They should be tuned after baseline data is collected.

| Metric | Initial Target | Blocker Threshold |
|---|---:|---:|
| Schema validity | >= 99% | < 98% |
| Fallback rate | <= 15% | > 30% |
| Metadata completeness | >= 95% | < 90% |
| High-confidence no-outcome proxy | <= 20% | > 35% |
| Policy block rate | explainable | unexplained spike > 15% |
| Cost per positive outcome | decreasing | rising 2 review periods in a row |
| Governance violation rate in observe | <= 2% | > 5% |

## Notes On Applicability

The 100-point agent-led growth framework is applicable here because this repository is already past the static automation stage. The system makes capability-level decisions, routes work through policy and queue/outbox paths, and records outcomes. The main risk is not lack of architecture; it is insufficient quality measurement before broader autonomy.
