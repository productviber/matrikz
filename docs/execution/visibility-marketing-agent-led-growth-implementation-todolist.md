# Visibility Marketing Agent-Led Growth Implementation Todolist

Date: 2026-05-09
Status model: `[ ]` not started · `[-]` in progress · `[x]` complete · `[!]` blocked or needs operator action

## Current Progress Snapshot

- [x] Investigation completed against current docs and code.
- [x] Existing agent-led growth foundations verified: signals, actions, policy, AI advisory client, outcome attribution, governance, Skrip handoff.
- [x] Local marketer test suite observed passing after latest changes: 1196 tests, 101 files.
- [x] D1 migration list for `visibility-marketing-db` reports no pending migrations from current config.
- [x] Remote D1 migration apply completed successfully from package-local Wrangler config.
- [x] Improvement implementation started with operator-grade quality metrics.
- [x] First implementation slice validated locally: focused tests, full marketer tests, marketer type check, growth-agent tests, growth-agent type check.
- [x] Staging deployment completed successfully using Wrangler v4 with token auth.
- [x] Semantic evaluation harness implemented and validated for `growth-next-action`, `message-brief`, and `outcome-diagnose`.
- [x] Growth-agent holdout/uplift reporting implemented over `recommendation_log` and `outcome_records`.
- [x] Recommendation diversity hints implemented for repeated action/no-outcome fatigue in marketer proposal context.
- [x] Cost per executed action added to marketer admin quality reporting.
- [x] Reasoning trace completeness rollup added to marketer admin quality reporting.
- [x] Provider/model/prompt/schema/capability cost dimensions added to marketer admin quality reporting.
- [x] Repeated same-category intervention quality metric added to marketer admin quality reporting.
- [x] Quarterly review, trace review, and cost telemetry operator docs added.

## Phase 1 — Documentation And Tracking

- [x] Create comprehensive improvement plan.
- [x] Create implementation tracking todolist.
- [x] Add review template for quarterly agent performance review.
- [x] Update existing implementation backlog to reference this execution plan.

## Phase 2 — Operator-Grade Quality Metrics

- [x] Expand `GET /api/admin/agentic/quality` beyond basic proposal counts.
- [x] Add metadata completeness rollup.
- [x] Add token and cost totals/averages from `ai_metadata_json`.
- [x] Add average latency by AI metadata.
- [x] Add fallback counts and fallback rate from structured JSON metadata.
- [x] Add no-outcome rate by action type.
- [x] Add high-confidence no-outcome false-positive proxy.
- [x] Add wait/manual-review/escalation positive-outcome false-negative proxy.
- [x] Add recent quality-risk samples for operator review.
- [x] Add focused unit tests.
- [x] Run focused tests.
- [x] Run full marketer tests.

Validation evidence:
- `corepack pnpm exec vitest run tests/unit/agentic-admin.test.ts` — 8 passed.
- `corepack pnpm exec vitest run tests/unit/agentic-admin.test.ts tests/unit/growth-actions.test.ts tests/unit/growth-event-actions.test.ts` — 24 passed.
- `corepack pnpm exec vitest run --reporter=basic` from `packages/marketer` — 101 files passed, 1195 tests passed.
- Latest `corepack pnpm exec vitest run --reporter=basic` from `packages/marketer` — 101 files passed, 1196 tests passed.
- `corepack pnpm exec tsc --noEmit -p tsconfig.json` from `packages/marketer` — passed with no output.
- `corepack pnpm exec vitest run --reporter=basic` from `packages/growth-agent` — 14 files passed, 1 skipped; 65 passed, 4 skipped.
- `corepack pnpm exec tsc --noEmit -p tsconfig.json` from `packages/growth-agent` — passed with no output.
- VS Code diagnostics on touched files — no errors found.

## Phase 3 — Semantic Evaluation Harness

- [x] Define eval score schema for `growth-next-action`.
- [x] Add labeled fixture set for recommended action, risk, confidence, trust safety, and specificity.
- [x] Add adversarial fixture set: suppressed contact and repeated no-response/fatigue cases.
- [x] Add eval runner command.
- [x] Add pass/fail thresholds to rollout docs.
- [x] Extend harness to `message-brief`.
- [x] Extend harness to `outcome-diagnose`.

Validation evidence:
- `corepack pnpm run eval:semantic` from `packages/growth-agent` — 1 eval file passed, 2 tests passed.
- `corepack pnpm exec tsc --noEmit -p tsconfig.json` from `packages/growth-agent` — passed with no output.
- `corepack pnpm exec vitest run --reporter=basic` from `packages/growth-agent` — 14 files passed, 1 skipped; 65 passed, 4 skipped.

## Phase 4 — Cost Accounting And Reporting

- [x] Persist or expose provider/model/prompt/cost/token dimensions consistently for every AI-assisted proposal.
- [x] Add cost per proposal.
- [x] Add cost per executed action.
- [x] Add cost per positive outcome.
- [x] Add missing-cost metadata count to quality endpoint.
- [x] Document null cost handling for free/local Workers AI models vs missing telemetry.

Implementation notes:
- `GET /api/admin/agentic/quality` now returns `executedActionCount`, `executedCostEstimateTotal`, `costPerExecutedAction`, and `executedMissingCostEstimateCount`.
- `GET /api/admin/agentic/quality` now returns `aiMetadataByDimension` grouped by provider, model, prompt version, response schema version, capability, and fallback state.
- `docs/operations/AGENTIC-COST-TELEMETRY.md` defines null cost handling for explicit fallback, explicit zero-cost model paths, and missing telemetry.

Validation evidence:
- `corepack pnpm exec vitest run tests/unit/agentic-admin.test.ts tests/unit/growth-event-actions.test.ts --reporter=basic` from `packages/marketer` — 2 files passed, 23 tests passed.
- `corepack pnpm exec tsc --noEmit -p tsconfig.json` from `packages/marketer` — passed with no output.
- VS Code diagnostics on touched admin files — no errors found.

## Phase 5 — Causal And Holdout Reporting

- [x] Verify treatment/control arm fields are populated across recommendation and outcome paths.
- [x] Add experiment/holdout reporting endpoint or admin quality section.
- [x] Add uplift estimate by experiment ID and action type.
- [x] Add confidence interval when sample size is sufficient.
- [x] Separate attribution metrics from causal impact metrics in documentation.

Implementation notes:
- Growth-agent exposes `GET /internal/experiments/holdout-report?windowDays=30&minArmSample=50` with internal auth.
- Report source is `recommendation_log` joined to `outcome_records` by `correlation_id`.
- Output separates treatment/control attribution rates from causal uplift estimates.

Validation evidence:
- `corepack pnpm exec vitest run tests/unit/holdoutReport.test.ts tests/integration/worker.integration.test.ts --reporter=basic` from `packages/growth-agent` — 2 files passed, 20 tests passed.
- `corepack pnpm exec tsc --noEmit -p tsconfig.json` from `packages/growth-agent` — passed with no output.
- `corepack pnpm exec vitest run --reporter=basic` from `packages/growth-agent` — 14 files passed, 1 skipped; 65 passed, 4 skipped.

## Phase 6 — Recommendation Diversity Controls

- [x] Add recent action category distribution to subject context.
- [x] Add repeated-action/no-outcome warning in policy hints.
- [x] Add diversity budget for repeated outreach categories.
- [x] Add quality metric for repeated same-category interventions.
- [x] Add tests for repeated no-response avoiding same action category.

Implementation notes:
- Marketer subject context now includes `actionTypeDistribution`, `repeatedActionWarnings`, and `diversityRisk` from the recent action/outcome lookback.
- `growth-next-action` requests now include diversity policy hints: repeated warnings, avoid-action types, and the active diversity budget.
- Optional AI request fields are omitted when absent so service-binding payloads do not serialize `undefined` into invalid JSON.
- `GET /api/admin/agentic/quality` now returns `repeatedSameCategoryInterventions` plus per-action repeated-category rates.

Validation evidence:
- `corepack pnpm exec vitest run tests/unit/growth-event-actions.test.ts --reporter=basic` from `packages/marketer` — 15 tests passed.
- `corepack pnpm exec vitest run tests/unit/agentic-admin.test.ts tests/unit/growth-event-actions.test.ts --reporter=basic` from `packages/marketer` — 2 files passed, 23 tests passed.
- `corepack pnpm exec tsc --noEmit -p tsconfig.json` from `packages/marketer` — passed with no output.
- VS Code diagnostics on touched marketer files — no errors found.

## Phase 7 — Reasoning Trace Completeness

- [x] Define required trace fields: prompt version, schema version, model/provider or explicit fallback, route reason, fallback reason, policy result, signal summary, subject context, outcome summary.
- [x] Add completeness checks to quality endpoint.
- [x] Add tests for quality endpoint trace completeness rollup.
- [x] Add operator documentation for trace review.

Implementation notes:
- `GET /api/admin/agentic/quality` now returns `traceCompleteness` with complete row count/rate plus present/missing counts for each trace field.
- Fallback rows are treated as complete for provider/model only when fallback is explicit and a fallback reason path is present.
- Trace completeness is derived from `ai_metadata_json`, `policy_result_json`, `proposed_action_json`, and `evidence_json` without adding a migration.
- `docs/operations/AGENTIC-TRACE-REVIEW-GUIDE.md` defines the operator procedure and escalation rules for missing trace fields.

Validation evidence:
- `corepack pnpm exec vitest run tests/unit/agentic-admin.test.ts --reporter=basic` from `packages/marketer` — 8 tests passed.
- `corepack pnpm exec tsc --noEmit -p tsconfig.json` from `packages/marketer` — passed with no output.
- VS Code diagnostics on touched admin files — no errors found.

## Phase 8 — Deployment And Verification

- [x] Run full marketer suite.
- [x] Run growth-agent suite.
- [x] Run TypeScript checks for marketer and growth-agent.
- [x] Verify D1 migrations list before deploy.
- [x] Deploy improved visibility-marketing component to staging.
- [x] Run staging smoke checks.
- [!] Run 24h quality observation window. Requires a successful staging deploy and elapsed live traffic/soak time.
- [!] Promote to production only after quality and governance gates pass. Requires staging deploy, smoke pass, and observation window completion.

Deployment attempt evidence:
- `npx wrangler deploy --config wrangler.toml --env staging` from `packages/marketer` ran `npx vite build` successfully.
- Build output included `dist/index.js 655.62 kB | gzip: 154.62 kB` and completed in about 1.15s.
- Wrangler stopped before publish with: `In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable for wrangler to work.`
- Latest local deploy-build validation: `corepack pnpm run build` from `packages/marketer` — passed; `dist/index.js 668.42 kB | gzip: 156.79 kB`.
- Latest remote migration apply validation: `npx wrangler d1 migrations apply visibility-marketing-db --config wrangler.toml --remote` from `packages/marketer` — exit code 0.
- Latest full local marketer validation rerun: `corepack pnpm exec vitest run --reporter=basic` from `packages/marketer` — exit code 0; 101 files passed, 1196 tests passed.
- Latest staging deploy retry: `npx wrangler deploy --config wrangler.toml --env staging` from `packages/marketer` rebuilt successfully, then failed at Cloudflare auth with `Timed out waiting for authorization code, please try again.` and exited with code 1.
- Successful publish via updated client: `npx wrangler@4 deploy --config wrangler.toml --env staging` from `packages/marketer` — deployed `visibility-marketing-staging` to `https://visibility-marketing-staging.wetechfounders.workers.dev` with version `ab5b5116-dba9-4e94-a950-3f366c0cf698`.
- Staging smoke verification: `scripts/smoke-visibility-marketing.ps1 -Url https://visibility-marketing-staging.wetechfounders.workers.dev -Token <admin> -SystemToken <system>` — Results: 7 pass, 0 fail.

## Phase 9 — Production Operations

- [x] Add quarterly agent performance review template.
- [x] Document first-review scheduling inputs using `GET /api/admin/agentic/quality`, governance SLO endpoints, outcome export, and holdout report.
- [!] Record baseline metrics for fallback, no-outcome, cost, policy blocks, and governance violations. Requires deployed environment URL, admin token, and live data capture.
- [x] Create remediation ticket template for thresholds outside target.

Implementation notes:
- `docs/operations/AGENTIC-GROWTH-QUARTERLY-REVIEW-TEMPLATE.md` contains the review agenda, baseline capture commands, thresholds, trace sampling table, holdout/uplift review, and remediation ticket template.
- Actual baseline values must be captured from staging or production after deployment because local tests use mocked quality rows.

## Deployment Commands To Use Later

```powershell
Set-Location 'd:\coding\clodo-dev-site\visibility-marketing\packages\growth-agent'
corepack pnpm run eval:semantic
corepack pnpm exec tsc --noEmit -p tsconfig.json

Set-Location 'd:\coding\clodo-dev-site\visibility-marketing\packages\marketer'
corepack pnpm exec vitest run
corepack pnpm exec tsc --noEmit -p tsconfig.json
npx wrangler d1 migrations list visibility-marketing-db --config wrangler.toml
npx wrangler deploy --config wrangler.toml --env staging
```

## Known Operator Notes

- Earlier terminal runs showed non-zero exits for a piped `vitest` command and a non-package-root migration command; later direct reruns from `packages/marketer` succeeded.
- The latest direct migration list command returned `No migrations to apply` for `visibility-marketing-db` using the package-local Wrangler config.
- Wrangler v3 deploy remained unstable in this shell (`fetch failed`), while Wrangler v4 completed publish successfully with the same token.
- Remaining rollout work is now the 24h staging quality observation window and production promotion gates.
