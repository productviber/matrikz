# Visibility Platform Implementation Backlog

Status model:
- `[ ]` not started
- `[-]` in progress
- `[x]` complete

Access lanes (earmarked):
- **Admin access**: privileged operational and financial actions.
- **User access**: end-user and affiliate self-service actions.
- **System access**: trusted worker-to-worker and webhook ingestion paths.
- **Agentic access**: machine/automation actions used by internal agents and scripted operations.

## 1) Security & Access Control (Risk-first)

### Admin access lane
- `[x]` Replace scattered token checks with centralized guard in all admin handlers.
- `[x]` Add token rotation procedure and dual-token rollover support.
- `[x]` Add audit logs for denied admin attempts with request fingerprint.

### User access lane
- `[x]` Replace query-param identity on affiliate endpoints with signed token/session.
- `[x]` Unify `verifyAffiliate` logic across portal and GDPR routes.
- `[x]` Add replay/nonce window for user-sensitive actions (GDPR export/delete).

### System access lane
- `[x]` Add explicit system access guard for event ingestion (`/events`).
- `[x]` Add explicit webhook ingress guard with optional strict secret enforcement.
- `[x]` Add request timestamp and anti-replay verification for events.

### Agentic access lane
- `[x]` Add agentic token lane (disabled unless configured).
- `[x]` Define which endpoints are agent-eligible and explicitly deny all others (`AGENTIC_ALLOWED_OPERATIONS` constant in `route-lanes.ts`; `detectAgenticTokenMisuse` guard in `access.ts` + main router returns 403 when agent token hits non-agentic lane).
- `[x]` Add narrow-scoped agent permissions and operation-level audit metadata (`auditAgenticAccess` emits a KV record with operation + request fingerprint on every successful agentic request).
- `[x]` Add operation scopes for `/api/agentic/*` (`signals:read`, `subjects:read`, `actions:read`, `actions:propose`, `actions:dry_run`, `actions:execute_low_risk`).

## 2) Critical Fixes

- `[x]` Fix unsubscribe SQL column mismatch (`to_email` -> `contact_email`).
- `[x]` Restrict campaign detail endpoint (`GET /api/campaigns/:slug`) to intended lane.
- `[x]` Add webhook signature verification for Brevo payloads.
- `[x]` Ensure analytics internal endpoints require system or admin access.

## 3) Performance & Scalability

- `[x]` Refactor payout batch generation to avoid per-affiliate sequential KV/DB fan-out (single grouped DB read + parallel KV fetches).
- `[x]` Optimize A/B stats endpoint KV fanout (batched parallel KV reads + defensive payload parsing).
- `[x]` Split cron email processing into bounded concurrency worker units (`CRON_EMAIL_TIME_BUDGET_MS = 25 s` guard added to cold-sends loop in `email.ts`; warm sends already use `runWithConcurrency`; cold sends have intentional inter-send delays and cannot be parallelised without breaking warmup compliance).
- `[-]` Add queue/backpressure strategy for burst webhook traffic (KV-backed rate limiter exists at `lib/rate-limit.ts`; Cloudflare Queue binding optional upgrade deferred to future slice).

## 4) Maintainability

- `[x]` Split `routes/admin.ts` into domain modules (dashboard, outbound, campaigns, contacts).
- `[x]` Split `lib/email.ts` into renderer, scheduler, provider, and orchestration modules.
	- Completed slices: extracted A/B helpers to `src/lib/email/ab.ts`, template-context prep to `src/lib/email/context.ts`, provider transport to `src/lib/email/provider.ts`, and renderer/templates to `src/lib/email/renderer.ts`; `lib/email.ts` now remains orchestration-only.
- `[x]` Consolidate auth/access helpers into one library and remove duplicate checks (all access logic centralised in `lib/access.ts`; `lib/auth.ts` is a thin delegation shim; `detectAgenticTokenMisuse` added for cross-lane detection).
- `[x]` Standardize error envelope with code, message, and correlation ID (`badRequest`, `unauthorized`, `forbidden`, `notFound`, `serverError`, `tooManyRequests` in `lib/response.ts` now include `code` and `correlationId`; `ApiResponse` type updated; new `forbidden()` helper added).

## 5) Analytics Package Hardening

- `[x]` Replace hardcoded analytics/user/site payloads with DB-backed logic.
- `[x]` Add auth checks for analytics API routes and internal routes.
- `[x]` Add analytics test suite and CI workflow coverage (unit tests + package workflow).
- `[x]` Add analytics package CI workflow parity with marketer.

## 6) Testing & CI

- `[x]` Add tests for access-lane guard behavior (admin/user/system/agentic).
- `[x]` Add negative tests for webhook and system endpoint spoofing (`tests/unit/security-spoofing.test.ts` — covers admin/system/agentic/webhook wrong-token, missing-token, replay-source, agentic-misuse, error-envelope shape).
- `[-]` Add migration/schema consistency test for SQL column references (deferred — comprehensive schema linting requires a separate tooling spike).
- `[x]` Add cross-worker contract tests for marketer <-> analytics APIs (`tests/unit/analytics-client-contract.test.ts` — validates path, method, auth header, correlationId forwarding, and error-envelope parsing).

## 7) Skrip Multichannel Integration Program

### Phase 0: Contracts and foundation
- `[x]` Add D1 schema for channel authority, canonical identity mapping, outbox, lineage, DLQ, and push opt-in events (`migrations/0013`).
- `[x]` Add Skrip client wrapper with HMAC-SHA256 signing, retries, timeout policy, and KV-backed circuit breaker.
- `[x]` Add feature flags for tenant, campaign, and channel progressive enablement (KV-backed).
- `[x]` Add strict contract fixtures for Skrip `v1` requests and outcomes (`tests/fixtures/skrip/`).
- `[x]` Add admin diagnostics for authority state, outbox health by status, and DLQ depth.
- `[x]` Add outbox dispatcher with exponential backoff, DLQ promotion, and dry-run-safe execution.
- `[x]` Add contact channel registration with reconciliation sweep for pending identities.
- `[x]` Add admin trigger endpoints: dispatch sweep, reconcile sweep, message lineage viewer.
- `[x]` Add operational scripts: `skrip-replay-dlq.mjs`, `skrip-reconcile.mjs`.
- `[ ]` Apply migration `0013` to staging and production D1 databases.

### Phase 1: Push-only pilot
- `[x]` Add browser push subscription capture (`POST /api/push/subscribe`, `DELETE /api/push/unsubscribe`).
- `[x]` Add Skrip contact registration for push subscriptions with tenant-safe identity binding.
- `[x]` Add `send_via_skrip` path — outbox staging in channel orchestrator (B2B outbound steps) + direct admin trigger `POST /api/admin/push/send` for product lifecycle events.
- `[x]` Add signed Skrip outcomes webhook and normalized lineage ingestion (`POST /webhooks/skrip/v1/outcomes`).
- `[-]` Add push opt-in funnel dashboard — backend diagnostics complete; frontend UI pending.
- `[-]` Pilot rollback switch — `channel_authorities.rollout_state` supports `dry_run → enabled → rollback`; admin UI toggle pending.

### Phase 2: Messaging channel rollout
- `[x]` Per-contact channel eligibility engine — consent/suppression/availability checks in `outbox.ts`; all four channels (push/SMS/WhatsApp/Telegram) eligible via `SKRIP_CHANNELS` list.
- `[x]` Add WhatsApp channel capture route + tests (`POST /api/channels/whatsapp/subscribe`, `DELETE /api/channels/whatsapp/unsubscribe`; E.164 validation; `tests/unit/skrip-channels.test.ts`).
- `[x]` Add SMS channel capture route + tests (`POST /api/channels/sms/subscribe`, `DELETE /api/channels/sms/unsubscribe`; E.164 validation).
- `[x]` Add Telegram channel capture route + tests (`POST /api/channels/telegram/subscribe`, `DELETE /api/channels/telegram/unsubscribe`; numeric chat_id validation).
- `[x]` Add multichannel attribution and ROI dashboard (`GET /api/admin/outbound/skrip/attribution` — `channel_message_lineage` breakdown by channel + status vs email_sends baseline; summary delivery/failure rates per channel).

### Phase 3: Optional email convergence
- `[ ]` Establish decision gate for email convergence based on parity, SLOs, and rollback proof.
- `[ ]` If approved, add isolated email authority flag and parity checklist.

## 8) Agent-Led Growth Controller Foundation

### Phase 1: deterministic growth signals
- `[x]` Add D1 growth signal projection (`migrations/0014_agentic_growth_foundation.sql`).
- `[x]` Materialize signal candidates from trusted event ingestion (`audit.completed`, `lead.captured`, Shopify lifecycle, trial expiry, outbound enrichment, share creation, affiliate click).
- `[x]` Add signal dedupe, expiration, severity, confidence, source event, and evidence JSON.
- `[-]` Extend signal coverage to Brevo engagement/Skrip outcomes and deeper product adoption gaps.

### Phase 2: agent action ledger
- `[x]` Add `agent_actions`, `agent_action_events`, and `agent_action_outcomes` D1 tables.
- `[x]` Add deterministic action idempotency, input/output hashes, correlation IDs, policy snapshots, and ai-engine metadata snapshots.
- `[x]` Add action audit endpoint (`GET /api/agentic/actions/:id/audit`).

### Phase 3: agentic API namespace
- `[x]` Add dedicated `/api/agentic/*` namespace for signal reads, subject context, proposal, dry-run, execution, action reads, and audit reads.
- `[x]` Keep broad `/api/admin/*` outside the agentic lane while preserving the explicit legacy allowlist for email processing and outbound campaign start/pause.

### Phase 4: policy and execution rails
- `[x]` Add central growth policy engine for suppression, unsubscribe, personal email, channel availability, frequency cap, campaign state, daily budget, risk, approval threshold, and kill switches.
- `[-]` Expand policy to domain-gap and campaign/channel rollout checks as rollout data matures.
- `[x]` Execute `wait`, `manual_review`, `escalate_to_human`, `enroll_sequence`, `send_via_skrip`, `pause_contact`, `pause_campaign`, and `start_campaign` only through ledger + policy.

### Phase 5: ai-engine advisory client
- `[x]` Add optional `AI_ENGINE` service binding and typed client methods for `growthNextAction`, `growthSignalSummarize`, `journeyCritic`, `messageBrief`, and `outcomeDiagnose`.
- `[x]` Add timeout, retry, KV-backed circuit breaker, and deterministic fallback to `wait`/`manual_review` when ai-engine is unavailable.
- `[x]` Ensure ai-engine can advise/rank/explain but cannot execute actions.

### Remaining productization
- `[x]` Add operator APIs for growth signals, agent action review/approval, Skrip opt-in funnel, rollout controls, and performance outcomes.
- `[x]` Add scheduled stale-outcome job and richer attribution joins to email/Skrip execution surfaces.
- `[x]` Add deterministic event-to-action proposal materialization for eligible growth signals.
- `[x]` Add staging smoke script for Skrip diagnostics + signed outcome webhook verification (`pnpm run test:smoke:skrip`).
- `[ ]` Apply migration `0014` to staging and production D1 databases after local dry-run checks.

## Route Ownership Matrix (initial)

Admin access:
- `/api/admin/*`
- `/api/payouts/*`
- `/api/affiliate/:code/payout-details`
- `/api/campaigns` (create/list/update)

User access:
- `/api/affiliate/portal`
- `/api/affiliate/stats`
- `/api/affiliate/gdpr/export`
- `/api/affiliate/gdpr/delete`
- `/api/unsubscribe`

System access:
- `/events`
- `/webhooks/brevo`
- `/webhooks/brevo/inbound`

Agentic access (proposed, gated by token):
- `/api/agentic/growth-signals`
- `/api/agentic/subjects/:id/context`
- `/api/agentic/actions/propose`
- `/api/agentic/actions/dry-run`
- `/api/agentic/actions/execute`
- `/api/agentic/actions/:id`
- `/api/agentic/actions/:id/audit`
- `/api/admin/emails/process`
- `/api/admin/campaigns/outbound/:id/start`
- `/api/admin/campaigns/outbound/:id/pause`

## Immediate Next Slice

- `[x]` Introduce shared access library and wire to `/events` and webhook ingress.
- `[x]` Add tests for the new access layer.
- `[x]` Enforce campaign detail endpoint ownership decision.

## Agent-Led Growth Improvement Execution

- `[x]` Dedicated execution plan: `docs/execution/visibility-marketing-agent-led-growth-improvement-plan.md`.
- `[x]` Dedicated implementation tracker: `docs/execution/visibility-marketing-agent-led-growth-implementation-todolist.md`.
- `[x]` Operator review template: `docs/operations/AGENTIC-GROWTH-QUARTERLY-REVIEW-TEMPLATE.md`.
- `[x]` Trace review guide: `docs/operations/AGENTIC-TRACE-REVIEW-GUIDE.md`.
- `[x]` Cost telemetry guide: `docs/operations/AGENTIC-COST-TELEMETRY.md`.

---

## 9) Governance Ingress Hardening

Date completed: 2026-05-06

Authority contract validation at marketing event ingress with progressive enforcement modes
and full decision observability.

### Core implementation
- `[x]` Add `ForwardedAuthorityContext` type and `authorityContext` field on `EventEnvelope`.
- `[x]` Add `governance-ingress.ts` module with policy engine, validation, and decision types.
  - `GovernanceIngressMode`: `off | observe | enforce`.
  - `GovernancePolicy`: `allowedAuthoritySources`, `enforceActionTypes`, `requireTargetTenantActionTypes`.
  - `GovernanceReason` taxonomy (12 named reasons covering all valid/invalid paths).
  - `evaluateGovernanceIngress()` — pure policy evaluation, accepts optional mode override.
  - `evaluateAndGuardGovernanceIngress()` — async, resolves KV mode override, deduplicates via KV.
  - `resolveGovernanceMode()` — KV-first, env var fallback; enables no-redeploy mode changes.
  - `buildGovernancePolicyInfo()` — serializable policy snapshot for admin introspection.
- `[x]` Place governance gate in `events/router.ts` before freshness/replay checks.
  - Legacy context-absent events: allowed and logged as governance gap (non-blocking).
  - Duplicate decision suppression: single KV write, 200 early return.
  - Tenant mismatch: blocked in enforce mode.
- `[x]` Add `GOVERNANCE_INGRESS_MODE`, `GOVERNANCE_ENFORCE_ACTIONS`, `GOVERNANCE_ALLOWED_AUTHORITY_SOURCES`, `GOVERNANCE_REQUIRE_TARGET_TENANT_ACTIONS` env vars to `Env` type and `wrangler.toml` (all three envs, default `off`).
- `[x]` Add `GOVERNANCE_INGRESS_MODE` and `GOVERNANCE_MODE_OVERRIDE` constants.
- `[x]` Add D1 migration `0020_governance_ingress_hardening.sql` — `governance_ingress_decisions` table with dedup unique index.

### Admin endpoints
- `[x]` `GET /api/admin/governance/ingress-slo` — SLO summary with pass/violation/block rates, source/reason/outcome distributions, filterable by hours/tenant/source/reason/mode/actionType.
- `[x]` `GET /api/admin/governance/enforcement-status` — active mode (KV + env), policy config, `overrideActive` flag.
- `[x]` `POST /api/admin/governance/mode-override` — set KV override (7-day TTL, no redeploy required).
- `[x]` `DELETE /api/admin/governance/mode-override` — clear KV override, restore env var control.

### Testing
- `[x]` Unit: `tests/unit/governance-ingress.test.ts` — 10 tests covering all mode/reason/source/tenant combinations.
- `[x]` Unit: `tests/unit/admin-governance-ingress.test.ts` — 2 tests for SLO endpoint.
- `[x]` Unit: `tests/unit/admin-governance-override.test.ts` — 11 tests for mode override and enforcement status endpoints.
- `[x]` Integration: `tests/integration/event-router.test.ts` — 28 tests including enforce/observe/absent/tenant-mismatch/source-allowlist/selective-enforce/duplicate-suppression paths.
- `[x]` Integration: `tests/integration/api-routes.test.ts` — governance SLO auth + success + webhook compat regression.
- `[x]` Regression: skrip/webhook tests (24 tests) — zero regression on webhook delivery/reconcile paths.
- Total: 84 governance-related tests pass.

### Operational docs and automation
- `[x]` `scripts/governance-ingress-rollout.ps1` — automates migration application and mode setting per environment.
- `[x]` `docs/operations/GOVERNANCE-SLO-RUNBOOK.md` — SLO definitions, alert criteria, D1 queries, staging gate script, incident checklist, emergency controls.
- `[x]` `docs/operations/GOVERNANCE-ROLLOUT-GUIDE.md` — per-environment command sequences for all 5 stages (off → observe dev → observe staging → observe prod → selective enforce → full enforce) with gate criteria and rollback at each step.

### Pending (operational, requires human action)
- `[x]` Set `GOVERNANCE_INGRESS_MODE=observe` in `wrangler.toml` for all three environments (dev, staging, production). Takes effect on next `wrangler deploy`.
- `[ ]` Apply migration `0020_governance_ingress_hardening.sql` to D1.
  - All three environments share `database_id = "00bb447b-f813-4f00-929b-b709f64f8872"` — run once.
  - **Requires Cloudflare auth**: `wrangler login` or set `CLOUDFLARE_API_TOKEN` env var, then:
    ```
    cd packages/marketer
    npx wrangler d1 migrations apply visibility-marketing-db --config wrangler.toml
    ```
- `[ ]` Deploy after migration: `npx wrangler deploy --config packages/marketer/wrangler.toml` — activates observe mode from wrangler.toml.
- `[ ]` Staging 7-day soak in observe mode — monitor via `GET /api/admin/governance/ingress-slo?hours=168`. Required before production enforce.
- `[ ]` Run staging gate script (`GOVERNANCE-ROLLOUT-GUIDE.md` Stage 2c) after 7-day soak.
- `[ ]` Production 7-day soak after deploying observe mode.
- `[ ]` Run production gate script (Stage 4c/5b) before enabling selective enforce.
- `[ ]` Set `GOVERNANCE_ENFORCE_ACTIONS` scope with product team sign-off before enabling enforce.
- `[ ]` Enable enforce mode on staging → 24h soak → production (after all gate criteria pass).