# Visibility Marketing Implementation Todo

Date: 2026-05-02

Role: **Agentic Growth Controller**.

Visibility Marketing should own growth orchestration: lifecycle state, campaign state, sequence enrollment, channel handoff, attribution, agent action audit, and execution rails. It should not become the LLM provider, product analytics authority, channel identity authority, or domain conversion ledger.

Target split:

```text
Deterministic:     80-90%
Non-deterministic: 10-20%
```

## Authority Boundary

Visibility Marketing owns:

- growth contact state and lifecycle stage,
- campaign and sequence orchestration,
- agentic action eligibility and execution,
- suppression, unsubscribe, and frequency gates for growth actions,
- handoff to Skrip for non-email channel delivery,
- marketing attribution and uplift reporting,
- action audit trail and replay/debug surfaces.

Visibility Marketing consumes:

- product/adoption events from Visibility Analytics and domain apps,
- channel identity and message outcomes from Skrip,
- structured AI recommendations from ai-engine.

Visibility Marketing must not own:

- product conversion truth,
- channel canonical identity truth,
- model/provider routing,
- arbitrary free-form agent execution.

## Phase 0: Finish Current Integration Hardening

- `[x]` **Modify**: Confirm current Skrip multichannel integration backlog state against the working tree and deployed environments.
  - Acceptance: backlog, migrations, tests, and routes agree on what is complete vs pending.
- `[x]` **Modify**: Apply migration `0013_skrip_integration_foundation.sql` to staging D1, then production D1 after dry-run checks.
  - Runbook: `DEPLOYMENT.md` → _Marketer D1 Migration Runbook_ section. Commands: `wrangler d1 migrations apply visibility-marketing --env staging --dry-run` then apply.
- `[x]` **Modify**: Verify channel authority rows for `push`, `sms`, `whatsapp`, and `telegram` in `dry_run` before enabling live sends.
  - Runbook: `DEPLOYMENT.md` → _Verify Channel Authority Rows_ section. SQL inserts and verification query documented.
- `[x]` **Build**: Add an operator-safe push/channel opt-in funnel dashboard over `push_opt_in_events`.
  - Must show subscribe, unsubscribe, registration pending, registration failed, and eligible-for-send counts.
- `[x]` **Build**: Add admin rollout controls for `channel_authorities.rollout_state`.
  - Required states: `disabled`, `dry_run`, `enabled`, `rollback`.
- `[x]` **Modify**: Add cross-worker smoke check that Marketing can call Skrip diagnostics and receive signed webhook outcomes in staging.
- `[x]` **Modify**: Keep existing email path independent until Skrip has parity, SLO, and rollback proof.

## Phase 1: Deterministic Growth Signal Read Model

- `[x]` **Build**: Add `growth_signals` table or materialized KV/D1 projection.
  - Suggested fields: `signal_id`, `subject_type`, `subject_id`, `tenant_id`, `signal_type`, `severity`, `detected_at`, `expires_at`, `source_event_id`, `evidence_json`, `status`.
- `[x]` **Build**: Add deterministic signal detectors for product adoption gaps.
  - Examples: `installed_no_first_analysis`, `audit_completed_no_signup`, `signup_no_site_connected`, `first_analysis_no_return`, `trial_expiring_high_intent`, `uninstall_with_recent_engagement`.
- `[x]` **Build**: Add deterministic signal detectors for outbound and campaign intent.
  - Examples: `cold_clicked_no_reply`, `audit_grade_low_high_fit`, `pricing_visit_no_signup`, `share_created_no_conversion`, `affiliate_click_no_signup`.
- `[x]` **Modify**: Extend existing event handlers to write signal candidates after CRM/contact updates.
  - Source examples: audit funnel, outbound enrichment, Shopify lifecycle, share/affiliate events, Brevo engagement events, Skrip outcomes.
- `[x]` **Build**: Add signal expiration and deduplication rules.
  - Required: one active signal per `(subject_id, signal_type, outcome_window)` unless explicitly reopened.
- `[x]` **Build**: Add deterministic confidence bands derived from evidence, not LLM guesswork.
  - Example: high intent = clicked + audit completed + no signup within 24h.
- `[x]` **Modify**: Add internal read endpoint for signal listings.
  - Implemented route: `GET /api/agentic/growth-signals`.
- `[x]` **Build**: Add admin/operator view to inspect signal evidence and lifecycle.

Determinism: 95% deterministic, 5% AI summary optional.

## Phase 2: Agent Action Ledger

- `[x]` **Build**: Add `agent_actions` table.
  - Suggested fields: `action_id`, `agent_id`, `tenant_id`, `subject_id`, `signal_id`, `proposed_action`, `status`, `risk_level`, `confidence`, `evidence_json`, `input_hash`, `output_hash`, `policy_result_json`, `created_at`, `approved_at`, `executed_at`, `outcome_due_at`, `outcome_json`.
- `[x]` **Build**: Add `agent_action_events` table for append-only status transitions.
  - Events: `proposed`, `policy_checked`, `approved`, `executed`, `rejected`, `failed`, `rolled_back`, `outcome_observed`.
- `[x]` **Build**: Add deterministic idempotency key for agent actions.
  - Suggested key: `(tenant_id, subject_id, signal_id, proposed_action, action_window)`.
- `[x]` **Modify**: Attach correlation IDs to every agent action proposal and execution.
- `[x]` **Build**: Persist ai-engine request and response snapshots with PII-minimized payloads.
  - Store hashes and structured summaries; do not store raw sensitive prompts unless policy allows.
- `[x]` **Build**: Add replay/debug endpoint for an action.
  - Implemented route: `GET /api/agentic/actions/:id/audit`.

Determinism: 100% deterministic.

## Phase 3: Agentic API Namespace

- `[x]` **Build**: Add `/api/agentic/*` namespace instead of expanding arbitrary admin endpoints.
  - This keeps agent operations separate from human admin operations.
- `[x]` **Build**: `GET /api/agentic/growth-signals`.
  - Returns only eligible, deduped, non-expired signals.
- `[x]` **Build**: `GET /api/agentic/subjects/:id/context`.
  - Returns lifecycle, recent events, channel reachability projection, suppression state, and attribution history.
- `[x]` **Build**: `POST /api/agentic/actions/propose`.
  - Calls ai-engine only after deterministic candidates are built.
- `[x]` **Build**: `POST /api/agentic/actions/dry-run`.
  - Runs policy, eligibility, suppression, budget, and channel checks without execution.
- `[x]` **Build**: `POST /api/agentic/actions/execute`.
  - Executes only an existing ledgered proposal that passed policy checks.
- `[x]` **Build**: `GET /api/agentic/actions/:id`.
  - Shows state, evidence, policy result, execution result, and outcome window.
- `[x]` **Modify**: Expand `AGENTIC_ALLOWED_OPERATIONS` only to the new namespace and explicitly needed legacy admin routes.
- `[x]` **Modify**: Add operation-level permission scopes for agent tokens.
  - Examples: `signals:read`, `actions:propose`, `actions:execute_low_risk`, `campaigns:pause`, `messages:send_preview`.
- `[x]` **Remove**: Avoid agent access to broad `/api/admin/*` routes.
  - Admin remains human/operator lane.

Determinism: 85-90% deterministic, 10-15% non-deterministic.

## Phase 4: Policy And Guardrail Engine

- `[x]` **Build**: Central `growth-policy` module for all action eligibility.
- `[x]` **Build**: Policy checks for consent, suppression, unsubscribe, personal email, channel availability, domain gap, frequency cap, campaign state, tenant rollout, budget, risk level, and human approval threshold.
- `[x]` **Build**: Policy result schema.
  - Required: `allowed`, `blockedReasons`, `warnings`, `requiredApproval`, `effectiveChannels`, `cooldownUntil`, `evidence`.
- `[x]` **Modify**: Route all agent execution through the policy engine, even if the agent proposal came from a trusted token.
- `[x]` **Build**: Human approval gate for high-risk actions.
  - High-risk examples: large segment enrollment, campaign start, win-back after churn, multi-channel send, custom model-generated copy.
- `[x]` **Build**: Emergency global kill switch for agent execution.
- `[x]` **Build**: Tenant/campaign/channel kill switches that reuse the existing Skrip rollout pattern.

Determinism: 100% deterministic.

## Phase 5: ai-engine Client Integration

- `[x]` **Build**: Add `ai-engine` service binding and typed client.
  - Candidate env binding: `AI_ENGINE`.
- `[x]` **Build**: Add internal client methods for growth-specific capabilities.
  - `growthNextAction`, `growthSignalSummarize`, `journeyCritic`, `messageBrief`, `outcomeDiagnose`.
- `[x]` **Modify**: Use ai-engine only for proposal/ranking/explanation, never direct execution.
- `[x]` **Build**: Request timeout, retry, circuit breaker, and fail-closed behavior.
  - If ai-engine is unavailable, deterministic candidate ranking should still allow safe fallback actions like `wait` or `manual_review`.
- `[x]` **Build**: Store ai-engine model metadata in the action ledger.
  - Required: provider, model, capability, prompt version, response schema version, latency, token estimate, cost estimate.
- `[x]` **Build**: Add contract tests for Marketing -> ai-engine request/response shapes.

Determinism: 70-80% deterministic shell, 20-30% non-deterministic recommendation.

## Phase 6: Growth Execution Primitives

- `[x]` **Build**: Execute `enroll_sequence` through existing `enrollInSequences` with idempotency and policy checks.
- `[x]` **Build**: Execute `send_via_skrip` through the Skrip outbox, not direct provider calls.
- `[x]` **Build**: Execute `pause_campaign`, `start_campaign`, and `pause_contact` as explicit action types with audit trail.
- `[x]` **Build**: Execute `wait` as a ledgered no-op with next review time.
- `[x]` **Build**: Execute `escalate_to_human` by creating an operator task or notification.
- `[x]` **Modify**: Existing outbound, audit, and lifecycle event handlers should create eligible actions instead of immediately expanding every automation path.
- `[x]` **Remove**: Any future route that lets an agent submit arbitrary SQL, arbitrary template text, or arbitrary provider payload.

Determinism: 90% deterministic, 10% AI-generated briefing optional.

## Phase 7: Attribution And Learning Loop

- `[x]` **Build**: Join `agent_actions` to `email_sends`, `channel_execution_outbox`, `channel_message_lineage`, and analytics/domain conversion events.
- `[x]` **Build**: Add `agent_action_outcomes` projection.
  - Suggested fields: `action_id`, `outcome_type`, `observed_at`, `window_seconds`, `attribution_strength`, `revenue_or_value`, `evidence_json`.
- `[x]` **Build**: Agent performance dashboard.
  - Must show proposals, approvals, executions, blocks, conversion outcomes, channel outcomes, cost, and rollback events.
- `[x]` **Build**: Outcome export to ai-engine for prompt/capability evaluation.
- `[x]` **Modify**: Existing campaign metrics should include agent action IDs where applicable.
- `[x]` **Build**: Add weekly review job to mark stale actions as `no_outcome_observed`.

Determinism: 90-95% deterministic, 5-10% AI explanation.

## Phase 8: Email Convergence Decision Gate

- `[x]` **Modify**: Decide whether Skrip should eventually own email manufacturing and/or email delivery.
  - Decision: **Defer until shadow-mode evidence.** See `docs/email-convergence-decision.md`.
- `[x]` **Build**: Parity checklist before moving any email authority.
  - Checklist: `docs/email-convergence-parity-checklist.md` — 12 sections covering deliverability, bounce/reply/open/click, template rendering, unsubscribe safety, provider fallback, cost, attribution continuity, and migration safety.
- `[x]` **Build**: Isolated `email` channel authority flag if convergence is approved.
  - Implemented: `SKRIP_EMAIL_AUTHORITY_ENABLED` env var. When set to `'true'`, `enroll_sequence` evaluates `channel_authorities` for `email` via `resolveSkripExecutionDecision`. Emits `email_skrip_authority_dry_run` warning in dry_run state; `email_channel_authority_kill_switch` block when KV kill switch active. Tests in `tests/unit/growth-policy.test.ts`.
- `[x]` **Remove**: Do not remove current email engine until Skrip email path has production shadow-mode evidence.
  - Gate documented in `docs/email-convergence-decision.md` and `docs/email-convergence-parity-checklist.md` section 12. Flag scaffold is inert until parity gate is cleared.

## Validation Plan

- Unit tests for growth policy checks and agent action state transitions.
- Contract tests for Marketing -> ai-engine and Marketing -> Skrip.
- Negative tests for agent token misuse outside `/api/agentic/*`.
- Migration tests for new D1 tables and indexes.
- Integration tests for proposal -> policy -> execution -> outcome attribution.
- Staging dry-run for every action type before production enablement.

## Dependencies

- Visibility Analytics must emit product/adoption events with stable IDs.
- ai-engine must expose growth-specific structured capabilities.
- Skrip must expose stable manufacture/send/status/outcome contracts.
- Cross-product identity authority and event contracts must be documented and tested.

## 2026-05-04 Ecosystem Review Follow-Up

Cross-repo review confirms Visibility Marketing is the correct home for the growth controller. The main follow-up work is now contract clarity and operational simplification, not a change of ownership.

- `[x]` **Modify**: Normalize and filter unsupported channels before building Skrip strategic requests so `email` is not passed where the strategic contract is non-email only.
  - Implemented: `SKRIP_STRATEGIC_DISPATCHABLE_CHANNELS` constant + pre-filter in `buildSkripStrategicRequest` (`execution-intent.ts`).
- `[ ]` **Modify**: Choose and document one canonical `send_via_skrip` execution lane for operator reasoning, incident response, and release certification.
- `[ ]` **Build**: Promote the live Marketing -> Skrip -> normalized outcome roundtrip to a hard release gate rather than an evidence-only signoff path.
- `[ ]` **Build**: Expand direct consumption of non-next-action advisory capabilities, starting with `message-brief` and `outcome-diagnose` in production flows.
- `[ ]` **Modify**: Keep Marketing focused on decision, policy, audit, and attribution; do not let provider- or payload-specific manufacturing logic leak back in.

## Maturity Stage Index

Maturity stages follow the cross-repo model: **Stage 1** = infrastructure complete / tested locally; **Stage 2** = integration live, roundtrip exercised; **Stage 3** = production certified, SLOs observed.

| Phase | Title | Stage |
|-------|-------|-------|
| 0 | Finish Current Integration Hardening | Stage 3 — deployed to staging + production |
| 1 | Deterministic Growth Signal Read Model | Stage 3 — all signal detectors live |
| 2 | Agent Action Ledger | Stage 3 — tables live, audit trail active |
| 3 | Non-Deterministic AI Advisory Layer | Stage 2 — ai-engine integration live; semantic eval pending |
| 4 | Agentic Policy And Execution Rails | Stage 2 — policy gates + execution path live; roundtrip certified |
| 5 | Skrip Multichannel Execution | Stage 2 — strategic path + outbox path live; roundtrip harness done; staging hard gate pending |
| 6 | Admin And Operator Controls | Stage 2 — rollout controls and operator tasks live; SLO dashboard pending |
| 7 | Attribution And Learning Loop | Stage 2 — joins + projections live; learning loop and exports pending |
| 8 | Email Convergence Decision Gate | Stage 1 — scaffold inert; shadow-mode gate pending |
