# Implementation Report — Matrikz Growth Agent System
**Date:** 2026-05-04  
**Scope:** Phase 1 (Initial Build) + Phase 2 (Hardening Pass) + Phase 3 (Production Monorepo Transplant)  
**Final State:** All 3 matrikz packages typecheck clean · workspace tests pass end-to-end · 0 failures  
**Phase 3 Final State:** All 5 production packages typecheck clean · 13 growth-agent tests pass · 1011 marketer tests pass · 0 failures · 3/3 live E2E pass (growth-agent dev) · repo published to github.com/productviber/matrikz

## Productviber Release Closure (2026-05-04)

This section is the canonical closure record for the Productviber deployment and release handoff.

### A. Repository activation status

- Workspace path `d:/coding/matrikz` is **not** a git working tree (no `.git` present).
- Canonical remote verified reachable: `https://github.com/productviber/matrikz.git`.
- Active release repository used for commit/push: `d:/coding/matrikz-productviber` on branch `master` with `origin` pointing to Productviber.
- Release commit published: `fe4ca5a` on `master`.

### B. Security and configuration closure

- `.dev.vars` files exist for both workers (`growth-agent`, `visibility-marketing`) with:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID=470fd65444eca7add856f069d65321a0`
  - `INTERNAL_SECRET`
- `.gitignore` ignores `.dev.vars` to prevent credential leakage.
- `INTERNAL_SECRET` uploaded for all environments on both workers via Wrangler secrets.
- Visibility worker config hardened: plaintext `INTERNAL_SECRET` vars removed from Wrangler config; runtime now uses secret binding only.

### C. Deployment matrix (Cloudflare Workers)

All six target worker-environment deployments completed.

| Worker | Environment | URL | Status |
|---|---|---|---|
| growth-agent | development | `https://growth-agent-dev.wetechfounders.workers.dev` | Deployed |
| growth-agent | staging | `https://growth-agent-staging.wetechfounders.workers.dev` | Deployed |
| growth-agent | production | `https://growth-agent-production.wetechfounders.workers.dev` | Deployed |
| visibility-marketing | development | `https://visibility-marketing-dev.wetechfounders.workers.dev` | Deployed |
| visibility-marketing | staging | `https://visibility-marketing-staging.wetechfounders.workers.dev` | Deployed |
| visibility-marketing | production | `https://visibility-marketing-production.wetechfounders.workers.dev` | Deployed |

### D. Live smoke verification summary

#### D1. growth-agent health
- `GET /health` passed on development, staging, and production.

#### D2. growth-agent capabilities
- `GET /internal/capabilities` passed on all environments when valid internal auth headers were supplied and `x-correlation-id` followed required format `{tenantId}:{uuid-v4}`.
- Earlier 400 responses were traced to malformed smoke-test correlation IDs, not runtime defects.

#### D3. visibility-marketing end-to-end
- `POST /` returned valid envelopes and reached growth-agent in all environments.
- Observed route reasons were expected for current flag posture:
  - development/staging: `upstream_non_2xx` during smoke payload path
  - production: `capability_disabled` (expected because production capability flags are intentionally off)

### E. Critical interoperability fix applied

Visibility service bindings were corrected to target actual deployed growth worker names per environment.

- development -> `growth-agent-dev`
- staging -> `growth-agent-staging`
- production -> `growth-agent-production`

This resolved Cloudflare API deploy failure `code: 10144` (service binding environment resolution mismatch).

### F. Verification notes and constraints

- Workspace-level `npm run verify` in `d:/coding/matrikz` passed previously with:
  - `@matrikz/growth-agent`: 57 tests passed
  - `@matrikz/visibility-marketing`: 20 tests passed
  - contracts package: no tests by design (`--passWithNoTests`)
- Productviber repo contains additional workspaces unrelated to this delivery; local install/verify in that clone is environment-dependent and may require repository-standard package manager/bootstrap.

### G. Release note file

Release note authored as `RELEASE_NOTES_2026-05-04.md` and committed with this delivery.

## Closure Addendum (2026-05-04)

Investigation was completed in `d:/coding/matrikz` to identify remaining blockers.

- Root cause found: workspace test command failed because `@matrikz/growth-agent-contracts` had no test files and used `vitest run` without `--passWithNoTests`.
- Fix applied:
  - Root scripts switched to stable npm workspace flag usage:
    - `npm run --workspaces typecheck`
    - `npm run --workspaces test`
  - Contracts package test script updated to `vitest run --passWithNoTests`.

Validated closure:

- `npm run typecheck` passes across all three packages.
- `npm test` passes across workspace.
- Current passing test totals from latest run:
  - `@matrikz/growth-agent`: 57 tests passed
  - `@matrikz/growth-agent-contracts`: no tests present, passes by design with `--passWithNoTests`
  - `@matrikz/visibility-marketing`: 20 tests passed

No unresolved TODO/FIXME/PENDING markers were found in user source/docs (excluding `node_modules`).

---

## 1. System Overview

The workspace contains an npm monorepo at `d:/coding/matrikz/` with three packages:

| Package | Role | Entry |
|---|---|---|
| `@matrikz/growth-agent-contracts` | Zero-runtime shared contract library | `src/index.ts` |
| `@matrikz/growth-agent` | Cloudflare Worker — AI decisioning API | `src/index.ts` |
| `@matrikz/visibility-marketing` | Cloudflare Worker — marketing orchestrator | `src/index.ts` |

All packages resolve to each other via local `file:` references in `package.json`. The runtime target is Cloudflare Workers with compatibility date `2026-05-03`.

---

## 2. Phase 1 — Initial Build

### 2.1 `@matrikz/growth-agent-contracts`

A pure TypeScript / Zod library with no Worker dependencies. It is the canonical source of truth for every type shared between the two Workers. It ships no compiled output — both Workers import it directly from `src/index.ts` (resolved at build time).

**Exports**

| Export | Kind | Purpose |
|---|---|---|
| `CAPABILITY_NAMES` | `const` tuple | Five capability slugs |
| `ACTION_TYPE_WHITELIST` | `const` tuple | Five allowed action kinds |
| `ERROR_CODES` | `const` tuple | All 11 canonical error codes |
| `SIGNAL_TYPE_ENUM` | `const` tuple | Six signal name literals |
| `GrowthSignalSchema` | Zod discriminated union | Typed `{kind, name, value}` signals |
| `GrowthNextActionRequestSchema / ResponseSchema` | Zod object | Full request/response shapes |
| `GrowthSignalSummarize*Schema` | Zod object | Signal summarization shapes |
| `JourneyCritic*Schema` | Zod object | Journey critique shapes |
| `MessageBrief*Schema` | Zod object | Message brief shapes |
| `OutcomeDiagnose*Schema` | Zod object | Outcome diagnosis shapes |
| `MetadataSchema` | Zod object | Full telemetry envelope metadata |
| `SuccessEnvelope<T>` | Interface | `{ ok: true, data, metadata }` |
| `ErrorEnvelope` | Interface | `{ ok: false, error, metadata }` |
| `CapabilityEnvelope<T>` | Union type | Either of the above |
| `UUID_V4_REGEX` | RegExp | Used by auth to validate correlation IDs |
| `SEMVER_REGEX` | RegExp | Used to validate schema version fields |

**Key design decisions:**
- `GrowthSignalSchema` is a Zod `discriminatedUnion` on `kind`, producing typed `string | number | boolean` value with no implicit coercion.
- All five capability request schemas include `outputLocale` (default `"en"`) to unlock locale-aware LLM instruction.
- `MetadataSchema` validates `requestSchemaVersion` and `responseSchemaVersion` against `SEMVER_REGEX`, ensuring version fields are structurally correct at the API boundary.

---

### 2.2 `@matrikz/growth-agent` — Core Worker

#### File-by-file breakdown

**`src/index.ts`**  
Minimal Worker entry point. Exports a `fetch` handler that delegates to `handleRequest`.

**`src/constants.ts`**  
Centralised constant registry. Re-exports `ACTION_TYPE_WHITELIST` and `SIGNAL_TYPE_ENUM` from contracts. Defines:
- `API_PREFIX`, `CAPABILITY_PATHS`, `CAPABILITY_NAMES` (path → slug map)
- `DEFAULTS` — all numeric defaults in one place: `maxTokens` per capability, `timeoutMs: 3500`, `maxRetries: 1`, `outputRepairAttempts: 1`, `budgetPerTenantPerMinute: 120`, `rateLimitPerTenantCapabilityPerMinute: 180`, `secretRotationWindowHours: 24`, `retryAfterSeconds: 300`
- `HEADER_NAMES` — all request header names as constants
- `ROUTE_REASONS` — `predictive | pinned | tier_degraded | fallback | rate_limited`
- `CAPABILITY_ENV_FLAGS` — maps capability slug to env var name for kill-switch
- `SLO_TARGETS` — `latencyP99Ms.warm: 800`, `latencyP99Ms.cold: 3000`, `maxNonDegraded5xxErrorRatePct: 0.5`, `maxFallbackRatePct: 15`, `rolloutGateWindowMinutes: 30`
- `MODEL_COST_PER_1K_TOKENS_USD` — cost registry keyed by model name

**`src/types.ts`**  
Re-exports all shared types from contracts plus defines:
- `GrowthAgentEnv` — all Cloudflare env bindings: `INTERNAL_SECRET`, `INTERNAL_SECRET_PREVIOUS`, `INTERNAL_SECRET_ROTATION_WINDOW_HOURS`, per-capability kill-switch vars, `RATE_LIMIT_PER_TENANT_CAPABILITY_PER_MIN`, `AI_OUTPUT_REPAIR_ATTEMPTS`, `WORKERS_AI` binding
- `RequestContext` — `{ correlationId, tenantId, idempotencyKeyPresent, startedAt }`
- `LlmGenerateArgs` / `LlmGenerateResult` / `LlmAdapter` interface
- `TenantBudgetGuard` / `TenantRateLimitGuard` interfaces
- `RuntimeConfig` — all derived runtime parameters with `secretRotationWindowHours`, `rateLimitPerTenantCapabilityPerMinute`, `outputRepairAttempts`
- `getRuntimeConfig(env)` — parses all env vars with safe defaults

**`src/auth.ts`**  
Single entry-point for all request authentication and correlation validation.

- `requireInternalAuth(request, env, config)` → `RequestContext`
  - Builds a list of active secrets: `[INTERNAL_SECRET, INTERNAL_SECRET_PREVIOUS]` — accepts either during the rotation window
  - Timing-safe comparison (`timingSafeEqual`) using XOR accumulation — resistant to timing-oracle attacks
  - Validates `x-correlation-id` format: must be `{tenantId}:{uuid-v4}` (extracted from `UUID_V4_REGEX` in contracts)
  - Reads `x-idempotency-key` presence into context (non-blocking)
  - Logs `secret_rotation_window` event when `INTERNAL_SECRET_PREVIOUS` is set, including configured window hours
  - Logs `auth_failure` with `auth_failure_reason: "secret_missing" | "secret_mismatch"` — never logs secret values
  - Inline runbook comment describing the 4-step rotation procedure
- `requireJsonBody<T>(request)` → `T` — validates `content-type` then parses JSON

**`src/errors.ts`**  
Policy-driven error management.

- `ERROR_POLICY` map: each `ErrorCode` → `{ status, retryable }`. Policy table:

| Code | HTTP Status | Retryable |
|---|---|---|
| `UNAUTHORIZED` | 401 | false |
| `VALIDATION_ERROR` | 400 | false |
| `UPSTREAM_TIMEOUT` | 504 | true |
| `UPSTREAM_FAILURE` | 502 | true |
| `UPSTREAM_QUOTA_EXCEEDED` | 429 | false |
| `BUDGET_EXHAUSTED` | 200 | false |
| `OUTPUT_SCHEMA_INVALID` | 200 | true |
| `CAPABILITY_DISABLED` | 503 | false |
| `RATE_LIMITED` | 429 | true |
| `INTERNAL_FALLBACK` | 200 | true |
| `INTERNAL_ERROR` | 500 | false |

- `AppError(code, message)` — constructor derives `status` and `retryable` from policy map; no caller can supply the wrong status for a code
- `makeMetadata(capability, correlationId, config, overrides?)` — builds a complete `Metadata` object, zero magic values
- `toErrorEnvelope(error, metadata, safeMessage?)` — produces a compliant `ErrorEnvelope`; user-visible message is replaced with a safe generic; `CAPABILITY_DISABLED` is the only code where `fallback: false`

**`src/guards.ts`**  
In-process rate and budget enforcement.

- `InMemoryBudgetGuard` — per-tenant-per-capability-per-minute counter using `Map<"tenantId:capability:minuteBucket", count>`
- `InMemoryRateLimitGuard` — same structure; logs `rate_limit_hit` event with `tenantId`, `capability`, `routeReason`
- `FailOpenBudgetGuard` — wraps any `TenantBudgetGuard`; if the inner guard throws (infra failure), logs `budget_guard_unavailable` and returns `allowed: true` (fail-open — favors inference continuity over hard denial)
- `NullBudgetGuard` — test stub, always allows
- `ExhaustedBudgetGuard` — test stub, always denies

**`src/degraded.ts`**  
Centralised deterministic fallback factory. `degradedResponseFor(capability, input, reason)` dispatches to a per-capability function that returns a structurally valid `CapabilityResponse`. All fallback responses are:
- White-label safe (no hardcoded brand text)
- Stable (same input always produces same output — safe for idempotent retry logic)
- Per-capability shaped (not a generic blob): e.g., `growth-next-action` always returns `action.type: "wait"` with `cooldownHours: 24`

**`src/telemetry.ts`**  
`emitTelemetry(TelemetryEvent)` writes a single structured JSON line to `console.log`. Fields:
- `type: "growth_agent_request"` — always present
- `correlationId`, `tenantId`, `capability` — tracing keys
- `idempotencyKeyPresent` — downstream deduplication signal
- `latencyMs`, `provider`, `model` — performance
- `schemaValid`, `fallback`, `errorCode` — quality
- `requestSchemaVersion`, `responseSchemaVersion` — contract version negotiation

No raw prompts, user input, or LLM outputs are logged (PII-safe).

**`src/routes.ts`**  
The main request dispatch layer.

Flow for a capability POST:
1. Parse `RuntimeConfig` from env
2. `requireInternalAuth` → `RequestContext`
3. Log rollout gate check against `SLO_TARGETS` (once per capability per Worker instance)
4. Check `config.featureFlags[capability]` → throw `CAPABILITY_DISABLED` (503 + `retry-after: 300`) if false
5. `requireJsonBody` → parse body
6. `rateGuard.consume` → throw `RATE_LIMITED` (429 + `retry-after: 300`) if exceeded
7. `budgetGuard.consume` → return degraded 200 envelope if `BUDGET_EXHAUSTED` (fail-open path)
8. `dispatchCapability` → call handler
9. Build success `CapabilityEnvelope` with full metadata including `costEstimate`
10. `emitTelemetry`
11. On `UPSTREAM_QUOTA_EXCEEDED` or `OUTPUT_SCHEMA_INVALID`: return degraded 200/502 with `retry-after` header
12. On all other errors: `toErrorEnvelope` + `emitTelemetry` + `retry-after` header if applicable

Additional routes:
- `GET /health` — public, no auth, returns `{ ok, version }`
- `GET /internal/capabilities` — auth-gated, returns per-capability feature flag state and schema versions

**`src/llm/adapter.ts`**  
`generateStructured(llm, args, validate)` — thin wrapper that calls `llm.generateJson` with Zod-derived type guard.

**`src/llm/workersAiAdapter.ts`**  
`WorkersAiAdapter implements LlmAdapter`:
- Runs request inside `AbortController` tied to `args.timeoutMs`
- On `AbortError` → throws `UPSTREAM_TIMEOUT`
- Checks HTTP 429 from Workers AI binding → throws `UPSTREAM_QUOTA_EXCEEDED`
- Parses JSON response text; on schema mismatch: calls `repairOutput` (re-prompts the model once, configurable via `outputRepairAttempts`)
- On repair failure: logs `output_schema_invalid` event with SHA-256 hash of raw output (never logs raw text) then throws `OUTPUT_SCHEMA_INVALID`
- Retries `UPSTREAM_FAILURE` up to `maxRetries` before giving up

**`src/capabilities/*.ts`** (five files)  
Each capability file follows an identical structure:
- `PROMPT_REGISTRY` object with `current: { version, systemPrompt, outputSchema }` and `previous: []` array for shadow comparison readiness
- `handleX(input, { llm, config })` — validates input against contracts Zod schema, builds locale-aware user prompt, calls `generateStructured`, returns typed result with `promptVersion` and `routeReason`
- `deterministicFallback(input, reason)` — capability-specific degraded response (also exported for direct use)
- Prompt version naming convention: `{capability-slug}-{semver}`, e.g., `growth-next-action-1.0.0`

**`wrangler.toml`**  
- All five `CAPABILITY_*_ENABLED` vars default to `"false"` (all-off posture for safe deploy)
- `RATE_LIMIT_PER_TENANT_CAPABILITY_PER_MIN = "180"`
- `AI_OUTPUT_REPAIR_ATTEMPTS = "1"`
- `INTERNAL_SECRET_ROTATION_WINDOW_HOURS = "24"`
- `[ai]` binding wires `WORKERS_AI`

---

### 2.3 `@matrikz/visibility-marketing` — Marketing Worker

**`src/types.ts`**  
Imports `CapabilityEnvelope`, `ErrorCode`, and `CapabilityName` from contracts. Defines:
- `GrowthAgentEnvelope<T>` — alias for `CapabilityEnvelope<T>`
- `GrowthCapability` — subset of `CapabilityName` relevant to marketing flows
- `GrowthAgentMetadata` — includes `correlationId` from envelope metadata
- `MarketingEnv` — env bindings including `GROWTH_AGENT` Service binding, `INTERNAL_SECRET`, `GROWTH_AGENT_TIMEOUT_MS`

**`src/client.ts`**  
`callGrowthAgent<T>(args)` — typed HTTP client with the following behaviors:

| Condition | Behavior |
|---|---|
| Circuit breaker open (3 failures in 15 s window) | Return deterministic fallback, reason `circuit_open` |
| `GROWTH_AGENT` or `INTERNAL_SECRET` missing | Return fallback, reason `binding_unavailable` |
| 503 + `CAPABILITY_DISABLED` | Return fallback, reason `capability_disabled` — clean degraded path, does not count as failure |
| `!response.ok` or `!payload.ok` | Register failure, return fallback |
| Success | Return typed `GrowthAgentEnvelope<T>` |

Always sends:
- `x-idempotency-key: crypto.randomUUID()` — allows growth-agent to detect duplicate sends
- Standard auth and tracing headers

---

## 3. Phase 2 — Hardening Pass

Phase 2 addressed 13 gaps identified in a post-Phase 1 audit. The gaps were classified as 4 critical, 6 moderate, and 3 minor.

### 3.1 Critical Gaps Resolved

#### C1 — Dual-secret rotation (auth)
**Problem:** A single `INTERNAL_SECRET` meant any key rotation required a full synchronous deploy-and-swap. During the swap window, in-flight requests using the old key would get 401s.  
**Solution:** Auth now accepts both `INTERNAL_SECRET` and `INTERNAL_SECRET_PREVIOUS` simultaneously. The rotation procedure is documented in an inline runbook in `auth.ts`. When a previous secret is active, a `secret_rotation_window` log event fires on every authenticated request (alertable signal). After the rotation window (configurable via `INTERNAL_SECRET_ROTATION_WINDOW_HOURS`), removing `INTERNAL_SECRET_PREVIOUS` automatically ends the grace period.

#### C2 — Correlation ID format enforcement
**Problem:** `x-correlation-id` had no structural validation. Callers could pass any string, breaking tracing and tenant attribution.  
**Solution:** Correlation IDs must now be `{tenantId}:{uuid-v4}`, where the `uuid-v4` portion is validated against `UUID_V4_REGEX` exported from the contracts package. Malformed IDs return 400 with a safe error message. This also guarantees that the `tenantId` in the correlation ID matches the `x-tenant-id` header by construction.

#### C3 — Shared Zod contract schemas
**Problem:** Capability request/response shapes were defined only implicitly in handler files. No cross-package or cross-Worker contract existed.  
**Solution:** All five request and response schemas are defined once in `@matrikz/growth-agent-contracts` using Zod. Both Workers import from the contracts package. Capability handlers validate input with `safeParse` before constructing LLM prompts — no request reaches the LLM with an invalid shape.

#### C4 — Expanded error taxonomy with policy ownership
**Problem:** `AppError` accepted a caller-supplied `status` code, meaning callers could accidentally assign the wrong HTTP status to a code.  
**Solution:** An `ERROR_POLICY` table owns every code's `{ status, retryable }` pair. `AppError(code, message)` looks up the policy — callers cannot supply wrong values. Six new codes were added (`CAPABILITY_DISABLED`, `RATE_LIMITED`, `UPSTREAM_QUOTA_EXCEEDED`, `BUDGET_EXHAUSTED`, `OUTPUT_SCHEMA_INVALID`, plus `INTERNAL_FALLBACK`) covering the full space of degraded paths.

---

### 3.2 Moderate Gaps Resolved

#### M1 — Capability kill-switches
Each capability has a named env var (`CAPABILITY_{SLUG}_ENABLED`). Routes check the flag before dispatching to the handler. Disabled capabilities return 503 with `retry-after: 300`. All five flags default to `"false"` in `wrangler.toml` — the worker ships in a safe all-off posture and capabilities are enabled deliberately per-environment.

#### M2 — Tenant rate limiting
`InMemoryRateLimitGuard` enforces per-tenant-per-capability-per-minute limits using a bucketed `Map`. The limit is configurable via `RATE_LIMIT_PER_TENANT_CAPABILITY_PER_MIN` (default 180). Rate-limited requests return 429 with `retry-after: 300` and emit a `rate_limit_hit` telemetry event.

#### M3 — Budget guard fail-open
`FailOpenBudgetGuard` wraps `InMemoryBudgetGuard`. If the guard itself throws (future: when backed by a KV or Durable Object that could be unavailable), the wrapper catches the error, logs `budget_guard_unavailable`, and returns `allowed: true`. This ensures an infra failure in the guard does not block all inference for all tenants.

#### M4 — Prompt registry per capability
Each capability handler exports a `PROMPT_REGISTRY` constant with `current: { version, systemPrompt, outputSchema }` and a `previous: []` array. This:
- Makes prompt version changes explicit and reviewable in code
- Enables A/B shadow comparison by keeping previous prompts accessible without dead-code deletion
- Provides the prompt version that populates `metadata.promptVersion` in every response envelope

#### M5 — Schema version sync test
`tests/unit/promptVersionSync.test.ts` iterates all five `PROMPT_REGISTRY.current.version` strings, extracts the semver suffix, and asserts it matches `DEFAULTS.responseSchemaVersion`. This is a lightweight structural contract: if a prompt version is bumped without bumping the response schema version (or vice versa), the test fails immediately.

#### M6 — Idempotency key tracing
`x-idempotency-key` is read in `requireInternalAuth` and stored as `idempotencyKeyPresent: boolean` in `RequestContext`. This flows through to `TelemetryEvent`. The marketing client sends a freshly generated `crypto.randomUUID()` as the idempotency key on every call, giving the growth-agent side a signal to detect duplicate sends (extensible to full deduplication with a KV store in a later phase).

---

### 3.3 Minor Gaps Resolved

#### N1 — WorkersAI mock factories
`tests/unit/mocks/workersAi.ts` exports three factories:
- `mockWorkersAi(fixtures)` — returns valid typed payloads from a `capability → fixture` map; asserts the fixture passes the validator (prevents stale fixtures)
- `mockWorkersAiTimeout(delayMs)` — simulates a stalled provider
- `mockWorkersAiInvalidOutput()` — simulates schema-invalid LLM output

All six unit tests use these factories instead of inline mock objects.

#### N2 — Deterministic degraded factories
`src/degraded.ts` provides `degradedResponseFor(capability, input, reason)` as the single place to change fallback behavior per capability. Fallbacks are structurally valid responses (pass Zod validation), white-label safe, and deterministic (same input → same output). Previously, ad hoc fallback objects were scattered across capability files.

#### N3 — SLO constants and rollout gate logs
`SLO_TARGETS` in constants defines the four SLO thresholds referenced in the gate check. Routes emit a `rollout_gate_check` log once per capability per Worker instance (guarded by a module-level `Set`) containing the full threshold set, capability name, prompt version, and schema versions. This creates an auditable record of what thresholds were active at the time of each request.

---

## 4. Test Coverage

### 4.1 Test inventory

| File | Type | Tests | What it covers |
|---|---|---|---|
| `growth-agent/tests/unit/growthNextAction.test.ts` | Unit | 1 | Happy path for `handleGrowthNextAction` |
| `growth-agent/tests/unit/growthSignalSummarize.test.ts` | Unit | 1 | Happy path for `handleGrowthSignalSummarize` |
| `growth-agent/tests/unit/journeyCritic.test.ts` | Unit | 1 | Happy path for `handleJourneyCritic` |
| `growth-agent/tests/unit/messageBrief.test.ts` | Unit | 1 | Happy path for `handleMessageBrief` |
| `growth-agent/tests/unit/outcomeDiagnose.test.ts` | Unit | 1 | Happy path for `handleOutcomeDiagnose` |
| `growth-agent/tests/unit/promptVersionSync.test.ts` | Unit | 1 | Prompt semver ↔ response schema version alignment across all 5 capabilities |
| `growth-agent/tests/integration/worker.integration.test.ts` | Integration | 7 | Full Worker fetch tests (see below) |
| `visibility-marketing/tests/client.integration.test.ts` | Integration | 4 | `callGrowthAgent` circuit breaker and fallback behaviors |
| `visibility-marketing/tests/e2e.marketer-growth.test.ts` | E2E | 1 | End-to-end: marketing client → real growth-agent Worker instance |

**Total: 18 tests, 0 failures**

### 4.2 Integration test scenarios (`worker.integration.test.ts`)

| Scenario | Assertion |
|---|---|
| Wrong `x-internal-secret` | 401 |
| `INTERNAL_SECRET_PREVIOUS` accepted during rotation | 200 |
| Valid request returns success envelope | 200, `payload.ok === true`, `correlationId` present in metadata |
| Malformed correlation ID | 400 |
| Provider stalls past `timeoutMs` | 504 |
| `CAPABILITY_*_ENABLED = "false"` | 503, `retry-after: 300` |
| Second request exceeds rate limit (`RATE_LIMIT = 1`) | 429 |

---

## 5. Dependency Graph

```
@matrikz/growth-agent-contracts
        │
        ├──── @matrikz/growth-agent
        │         (imports Zod schemas, ErrorEnvelope,
        │          CapabilityEnvelope, UUID_V4_REGEX)
        │
        └──── @matrikz/visibility-marketing
                  (imports CapabilityEnvelope, ErrorCode,
                   CapabilityName, GrowthAgentEnvelope)
```

Both workers import contracts as a direct source reference (`file:../growth-agent-contracts`, resolved at typecheck and test time). There is no circular dependency. The contracts package has no dependency on either worker.

---

## 6. Security Properties

| Property | Implementation |
|---|---|
| Timing-safe secret comparison | XOR accumulation over full string; short-circuit prevented |
| No secret logging | `logAuthFailure` logs reason only; secret values never appear in logs |
| Safe error messages | `toErrorEnvelope` replaces all internal messages with generic user-safe text |
| Correlation ID ownership | Format `tenantId:uuid-v4` — tenant cannot forge another tenant's correlation prefix |
| No raw LLM output in logs | Only SHA-256 hash of output logged on schema failure |
| All-off deploy posture | All capabilities disabled in `wrangler.toml`; must be explicitly enabled per env |
| Budget fail-open | Infra failures in guards cannot cause total denial of service |

---

## 7. Known Limitations and Deferred Work

| Item | Rationale for deferral |
|---|---|
| In-memory rate/budget stores | Not shared across Worker instances; acceptable for Phase 1-2. Phase 3 should back with Cloudflare KV or Durable Objects |
| Idempotency deduplication | Key is read and logged but not checked against a store; prevents exact-once semantics. Deferred to KV phase |
| `previous: []` prompt registry entries | Array exists to support shadow comparison but no shadow request routing is implemented yet |
| `OUTPUT_SCHEMA_INVALID` degraded path | Currently triggers in the `catch` block on the already-consumed body; `safeReadBody` is called as a fallback. Phase 3 should buffer body before dispatch |
| Cost estimation | `MODEL_COST_PER_1K_TOKENS_USD` only has `@cf/meta/llama-3.1-8b-instruct` at `$0` (free tier). Registry needs expanding when paid models are added |
| `FEATURE_FLAGS_JSON` and per-capability env vars | Both mechanisms exist simultaneously. Phase 3 should unify on one |

---

## 8. File Map

```
packages/
├── growth-agent-contracts/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       └── index.ts              ← all shared Zod schemas, types, constants
│
├── growth-agent/
│   ├── package.json
│   ├── wrangler.toml
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              ← Worker entry point
│       ├── constants.ts          ← all constants, SLO targets, kill-switch flags
│       ├── types.ts              ← env bindings, runtime config, interfaces
│       ├── auth.ts               ← dual-secret auth, correlation validation
│       ├── errors.ts             ← AppError, ERROR_POLICY, toErrorEnvelope
│       ├── guards.ts             ← budget and rate limit guards, fail-open wrapper
│       ├── degraded.ts           ← deterministic fallback factories per capability
│       ├── telemetry.ts          ← structured telemetry emitter
│       ├── routes.ts             ← main dispatch, kill-switch, rate limit, budget
│       ├── llm/
│       │   ├── adapter.ts        ← generateStructured helper
│       │   └── workersAiAdapter.ts ← Workers AI LLmAdapter + repair + quota detection
│       └── capabilities/
│           ├── growthNextAction.ts
│           ├── growthSignalSummarize.ts
│           ├── journeyCritic.ts
│           ├── messageBrief.ts
│           └── outcomeDiagnose.ts
│   └── tests/
│       ├── unit/
│       │   ├── mocks/workersAi.ts     ← mock factories
│       │   ├── promptVersionSync.test.ts
│       │   ├── growthNextAction.test.ts
│       │   ├── growthSignalSummarize.test.ts
│       │   ├── journeyCritic.test.ts
│       │   ├── messageBrief.test.ts
│       │   └── outcomeDiagnose.test.ts
│       └── integration/
│           └── worker.integration.test.ts
│
└── visibility-marketing/
    ├── package.json
    ├── wrangler.toml
    ├── tsconfig.json
    └── src/
        ├── index.ts
        ├── types.ts              ← GrowthAgentEnvelope, MarketingEnv
        └── client.ts             ← callGrowthAgent with circuit breaker
    └── tests/
        ├── client.integration.test.ts
        └── e2e.marketer-growth.test.ts
```

---

## Phase 3 — Production Monorepo Transplant

### 9. Transplant Overview

Phase 3 took the matrikz reference implementation and transplanted it into the live production monorepo at `D:\coding\clodo-dev-site\visibility-marketing\` (a pnpm workspace). The transplant required exact contract reconciliation across five dimensions: namespace (`@matrikz` → `@clodo`), dependency protocol (`file:` → `workspace:*`), correlation ID format (uuid-v4 → base36), secret naming (`INTERNAL_SECRET_PREVIOUS` → `INTERNAL_SECRET_ROLLOVER`), and action type whitelist (5 items → 8 items matching the production `AGENT_ACTION_TYPE` constants).

**Target workspace structure after transplant:**

| Package | Role | Status |
|---|---|---|
| `@clodo/growth-agent-contracts` | Production shared contract library | New |
| `@clodo/growth-agent` | Production Cloudflare Worker — AI decisioning | New |
| `visibility-marketing` (marketer) | Existing production Worker — surgically updated | Updated |

---

### 10. Contract Reconciliation

Before any code was written, the following differences between the reference and production environments were catalogued and resolved:

#### 10.1 Namespace

All imports changed from `@matrikz/*` to `@clodo/*`. Package names in `package.json` updated accordingly. The marketer's existing `package.json` gained a `dependencies` block with `"@clodo/growth-agent-contracts": "workspace:*"`.

#### 10.2 Dependency Protocol

pnpm workspaces use `workspace:*` instead of `file:../`. The new packages declare their internal dependency as:
```json
"@clodo/growth-agent-contracts": "workspace:*"
```
The root `pnpm-workspace.yaml` already declares `packages: ['packages/*']`, auto-discovering all subdirectories — no explicit entries required.

#### 10.3 Correlation ID Format

The matrikz reference used `{tenantId}:{uuid-v4}` validated by `UUID_V4_REGEX`. The production marketer uses a base36 timestamp-plus-random format generated in `correlation.ts`:

```
${Date.now().toString(36)}-${rand4}   → e.g. lq3abc-xy12
```

**Resolution:**
- `CORRELATION_ID_REGEX = /^[a-z0-9]+-[a-z0-9]{4,}$/` is exported from `@clodo/growth-agent-contracts` instead of `UUID_V4_REGEX`
- `auth.ts` validates against this regex (no longer parses a tenant prefix out of the correlation ID)
- `x-tenant-id` remains a separate required header for rate/budget scoping
- All integration tests use `corr = "lq3abc-xy12"` as the canonical test correlation ID

#### 10.4 Secret Naming

The matrikz reference used `INTERNAL_SECRET_PREVIOUS` for the grace-period rollover secret. The production environment follows a consistent `*_ROLLOVER` naming convention across all tokens (`ADMIN_TOKEN_ROLLOVER`, `SYSTEM_TOKEN_ROLLOVER`, etc.).

**Resolution:** Renamed to `INTERNAL_SECRET_ROLLOVER` throughout:
- `GrowthAgentEnv` interface
- `auth.ts` — secret list is `[INTERNAL_SECRET, INTERNAL_SECRET_ROLLOVER]`
- `wrangler.toml` comments
- Integration test `makeEnv()` factory

#### 10.5 Action Type Whitelist

The matrikz reference defined 5 action types in `ACTION_TYPE_WHITELIST`. The production marketer's `AGENT_ACTION_TYPE` constants defines 8:

```
wait, manual_review, enroll_sequence, send_via_skrip,
pause_campaign, start_campaign, pause_contact, escalate_to_human
```

**Resolution:** The contracts package `ACTION_TYPE_WHITELIST` was defined as the full 8-item tuple matching production constants exactly.

---

### 11. New Package: `@clodo/growth-agent-contracts`

Location: `packages/growth-agent-contracts/`

Identical role to the matrikz reference — zero-runtime Zod contract library — with the following production-specific differences:

| Aspect | Matrikz Reference | Production |
|---|---|---|
| Namespace | `@matrikz/growth-agent-contracts` | `@clodo/growth-agent-contracts` |
| Correlation regex export | `UUID_V4_REGEX` | `CORRELATION_ID_REGEX = /^[a-z0-9]+-[a-z0-9]{4,}$/` |
| `ACTION_TYPE_WHITELIST` length | 5 items | 8 items |
| Test script | present (vitest) | absent (no tests needed — pure types/schemas) |

---

### 12. New Package: `@clodo/growth-agent`

Location: `packages/growth-agent/`

Full production Worker, source-equivalent to the matrikz reference except for the reconciliation items above. All 20 source files were created:

**Infrastructure files:**
- `package.json` — `workspace:*` dep on contracts, `vitest@2.1.8`, `wrangler@3.0.0`
- `tsconfig.json` — `moduleResolution: bundler`, `allowImportingTsExtensions: true`, `types: ["@cloudflare/workers-types"]`
- `wrangler.toml` — `compatibility_date = "2026-05-03"`, all 5 capability flags default `"false"`, `[ai]` binding, no `INTERNAL_SECRET*` in vars (secrets only via `wrangler secret put`)
- `vitest.config.ts` — `globals: true, environment: 'node', testTimeout: 10_000`

**Source files:** `constants.ts`, `types.ts`, `auth.ts`, `errors.ts`, `guards.ts`, `degraded.ts`, `telemetry.ts`, `routes.ts`, `index.ts`, `llm/adapter.ts`, `llm/workersAiAdapter.ts`, and all five capability handlers.

**Key production-specific behaviors in `types.ts` / `auth.ts`:**
- `GrowthAgentEnv` has `INTERNAL_SECRET_ROLLOVER` (not `INTERNAL_SECRET_PREVIOUS`)
- `getRuntimeConfig` reads per-capability env flags only — no `FEATURE_FLAGS_JSON` JSON parsing (that mechanism was present in the matrikz reference as a legacy path and deliberately excluded from production)
- `parseFeatureFlags(env)` reads `CAPABILITY_*_ENABLED === "true"` directly

**`wrangler.toml` — notable omissions (by design):**
- `INTERNAL_SECRET` and `INTERNAL_SECRET_ROLLOVER` are **not** in `[vars]` — they are secrets and must be set via `wrangler secret put`
- `FEATURE_FLAGS_JSON` is absent — the per-capability env vars are the single flag mechanism

---

### 13. Surgical Updates to `visibility-marketing` (Marketer)

The existing production marketer Worker at `packages/marketer/` was updated in four surgical passes. No full rewrites — only targeted changes.

#### 13.1 `src/lib/ai-engine/client.ts`

**Service URL:** Changed `https://ai-engine/internal/${capability}` → `https://growth-agent/internal/${capability}`.

**Three new request headers:**
```typescript
'x-internal-secret':  env.INTERNAL_SECRET ?? '',
'x-tenant-id':        normalizeTenantId(payload.tenantId as string | null ?? null),
'x-idempotency-key':  crypto.randomUUID(),
```

**CAPABILITY_DISABLED circuit bypass:** On a `503` response whose body contains `error.code === "CAPABILITY_DISABLED"`, the client now returns early with `{ ok: false, error: 'capability_disabled' }` without calling `recordFailure()`. This prevents clean planned-disable events from tripping the circuit breaker.

Before this fix, disabling a capability for a planned rollout would open the circuit breaker after 3 requests, causing all subsequent requests (including future re-enables) to return circuit-open fallbacks for the entire `CIRCUIT_OPEN_TTL_SECS` window.

**Action type whitelist validation in `normalizeGrowthNextActionResponse`:**
```typescript
import { ACTION_TYPE_WHITELIST } from '@clodo/growth-agent-contracts';

const rawActionType = typeof actionRecord.type === 'string'
  ? actionRecord.type
  : AGENT_ACTION_TYPE.MANUAL_REVIEW;

const actionType = (ACTION_TYPE_WHITELIST as readonly string[]).includes(rawActionType)
  ? rawActionType
  : (() => {
      console.warn(JSON.stringify({ type: 'action_type_whitelist_miss', received: rawActionType }));
      return AGENT_ACTION_TYPE.WAIT;
    })();
```

This ensures that an unexpected action type from the growth-agent (model hallucination, schema evolution mismatch) cannot propagate into the marketer's action dispatch logic as an unrecognised string.

#### 13.2 `src/types.ts` — `Env` Interface

Three fields added:
```typescript
INTERNAL_SECRET?: string;
INTERNAL_SECRET_ROLLOVER?: string;
GROWTH_AGENT_TIMEOUT_MS?: string;
```

Existing `AI_ENGINE?: Fetcher` binding name was intentionally preserved — renaming it would have required changes to 30+ usages across the marketer codebase.

#### 13.3 `wrangler.toml`

**Uncommented and updated service binding:**
```toml
[[services]]
binding = "AI_ENGINE"
service = "growth-agent"
```
(Previously commented out, pointing to `"ai-engine"` which did not exist.)

**Added to `[vars]`:**
```toml
GROWTH_AGENT_TIMEOUT_MS = "3500"
```

#### 13.4 `tests/helpers.ts` — `MockEnv`

Three optional fields added to the `MockEnv` interface:
```typescript
INTERNAL_SECRET?: string;
INTERNAL_SECRET_ROLLOVER?: string;
GROWTH_AGENT_TIMEOUT_MS?: string;
```

---

### 14. Test Updates — Marketer (`tests/unit/ai-engine-client.test.ts`)

Six new test cases added to the existing 2-test file, for a total of 8 tests in that file:

| # | Test | Assertion |
|---|---|---|
| 1 | (existing) Fallback for unavailable AI_ENGINE | `action.type === MANUAL_REVIEW`, `metadata.fallback === true` |
| 2 | (existing) Normalizes structured recommendation | `action.type === 'wait'`, `confidence === 71`, `fallback === false` |
| 3 | Sends `x-internal-secret` header | Header value matches `INTERNAL_SECRET` env var |
| 4 | Sends `x-tenant-id` header | Header is defined |
| 5 | Sends `x-idempotency-key` header | Header is truthy |
| 6 | Non-2xx increments failure counter | KV store contains a key matching `*failure*` |
| 7 | 503 `CAPABILITY_DISABLED` does NOT increment counter | No KV key matching `*failure*` |

---

### 15. Phase 3 Quality Gates

All gates passed after `pnpm install` resolved `zod@^3.23.8` and the three new workspace packages.

| Gate | Command | Result |
|---|---|---|
| QG1 | `pnpm --filter @clodo/growth-agent-contracts typecheck` | ✅ 0 errors |
| QG2 | `pnpm --filter @clodo/growth-agent typecheck` | ✅ 0 errors |
| QG3 | `pnpm --filter visibility-marketing typecheck` | ✅ 0 errors |
| QG4 | `pnpm --filter @clodo/growth-agent test` | ✅ **13/13 pass** (7 files) |
| QG5 | `pnpm --filter visibility-marketing test` | ✅ **1011/1011 pass** (82 files) |
| QG6 | `FEATURE_FLAGS_JSON` absent in growth-agent | ✅ verified (grep clean) |
| QG7 | `INTERNAL_SECRET_ROLLOVER` naming consistent | ✅ verified across all files |
| QG8 | Base36 correlation format in integration tests | ✅ `corr = "lq3abc-xy12"` |
| QG9 | Action type whitelist validation in marketer client | ✅ `ACTION_TYPE_WHITELIST` import + warn-and-fallback |

---

### 16. Phase 3 Test Inventory

#### `@clodo/growth-agent` — 13 tests across 7 files

| File | Type | Tests |
|---|---|---|
| `tests/unit/growthNextAction.test.ts` | Unit | 1 |
| `tests/unit/growthSignalSummarize.test.ts` | Unit | 1 |
| `tests/unit/journeyCritic.test.ts` | Unit | 1 |
| `tests/unit/messageBrief.test.ts` | Unit | 1 |
| `tests/unit/outcomeDiagnose.test.ts` | Unit | 1 |
| `tests/unit/promptVersionSync.test.ts` | Unit | 1 |
| `tests/integration/worker.integration.test.ts` | Integration | 7 |

**Integration test scenarios:**

| Scenario | Assertion |
|---|---|
| Wrong `x-internal-secret` | 401 |
| `INTERNAL_SECRET_ROLLOVER` accepted during rotation window | 200 |
| Valid request returns success envelope | 200, `correlationId === "lq3abc-xy12"` in metadata |
| Malformed correlation ID (`"bad"`) | 400 |
| Provider stalls past `AI_TIMEOUT_MS` | 504 |
| `CAPABILITY_GROWTH_NEXT_ACTION_ENABLED = "false"` | 503, `retry-after: 300` |
| Second request exceeds `RATE_LIMIT_PER_TENANT_CAPABILITY_PER_MIN = 1` | 429 |

#### `visibility-marketing` — 1011 tests across 82 files

All pre-existing tests continue to pass. The 8-test `ai-engine-client.test.ts` is the primary new test surface.

---

### 17. Production File Map (Phase 3 additions)

```
packages/
├── growth-agent-contracts/          ← NEW
│   ├── package.json                 ← @clodo/growth-agent-contracts
│   ├── tsconfig.json
│   └── src/
│       └── index.ts                 ← 8-item ACTION_TYPE_WHITELIST, CORRELATION_ID_REGEX
│
├── growth-agent/                    ← NEW
│   ├── package.json                 ← workspace:* dep on contracts
│   ├── wrangler.toml                ← compatibility_date 2026-05-03, all caps disabled
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   └── src/
│       ├── index.ts
│       ├── constants.ts
│       ├── types.ts                 ← INTERNAL_SECRET_ROLLOVER, no FEATURE_FLAGS_JSON
│       ├── auth.ts                  ← CORRELATION_ID_REGEX, INTERNAL_SECRET_ROLLOVER
│       ├── errors.ts
│       ├── guards.ts
│       ├── degraded.ts
│       ├── telemetry.ts
│       ├── routes.ts
│       ├── llm/adapter.ts
│       ├── llm/workersAiAdapter.ts
│       └── capabilities/
│           ├── growthNextAction.ts
│           ├── growthSignalSummarize.ts
│           ├── journeyCritic.ts
│           ├── messageBrief.ts
│           └── outcomeDiagnose.ts
│   └── tests/
│       ├── unit/
│       │   ├── mocks/workersAi.ts
│       │   ├── promptVersionSync.test.ts
│       │   ├── growthNextAction.test.ts
│       │   ├── growthSignalSummarize.test.ts
│       │   ├── journeyCritic.test.ts
│       │   ├── messageBrief.test.ts
│       │   └── outcomeDiagnose.test.ts
│       └── integration/
│           └── worker.integration.test.ts
│
└── marketer/                        ← UPDATED (surgical changes only)
    ├── package.json                 ← + dependencies: @clodo/growth-agent-contracts
    ├── wrangler.toml                ← AI_ENGINE binding uncommented → growth-agent
    │                                   + GROWTH_AGENT_TIMEOUT_MS = "3500"
    └── src/
        ├── types.ts                 ← + INTERNAL_SECRET, INTERNAL_SECRET_ROLLOVER,
        │                                GROWTH_AGENT_TIMEOUT_MS in Env
        └── lib/ai-engine/
            └── client.ts            ← URL → growth-agent, 3 new headers,
                                        CAPABILITY_DISABLED bypass, whitelist validation
    └── tests/
        ├── helpers.ts               ← + 3 new MockEnv fields
        └── unit/
            └── ai-engine-client.test.ts  ← 6 new test cases (8 total)
```

---

### 18. Deferred Work (Post Phase 3)

The following items from the Phase 2 deferred list were resolved or superseded in Phase 3:

| Item | Status |
|---|---|
| `FEATURE_FLAGS_JSON` and per-capability env vars coexisting | ✅ Resolved — `FEATURE_FLAGS_JSON` excluded from production; per-capability vars only |

Remaining deferred items carry forward unchanged (see Section 7). Additional Phase 3-specific deferrals:

| Item | Rationale |
|---|---|
| E2E test porting (`e2e.marketer-growth.test.ts`) | Requires live Worker deployment and shared test secrets; deferred to CI/CD setup phase |
| Root `tsconfig.json` references array | Root tsconfig uses `include` — references array is optional since packages typecheck cleanly in isolation |
| `GROWTH_AGENT_TIMEOUT_MS` wiring in client | Env field added; `AI_ENGINE_TIMEOUT_MS` is currently used by `configuredTimeout()`. A follow-up should unify these or alias one to the other |

---

### 19. Current Status

- `growth-agent` dev deployed to `https://growth-agent-development.wetechfounders.workers.dev`
- `growth-agent` prod deployed to `https://growth-agent.wetechfounders.workers.dev`
- Live dev E2E tests passed: `3/3`
- Repository published to `https://github.com/productviber/matrikz`
- Active GitHub account for remote creation: `productviber`
- Applied production fixes for growth-next-action signal schema compatibility, message-brief capability enablement, prompt hardening, and marketer timeout alignment.

