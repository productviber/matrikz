# Skrip Implementation Todo

Date: 2026-05-02

Role: **Message Manufacturing, Channel Identity, And Conversation Engine**.

Skrip should own the manufacture and delivery of channel-safe messages and maintain channel identity. It should expose stable primitives to growth systems, but it should not own product lifecycle decisions, CRM truth, or domain conversion truth.

Target split:

```text
Deterministic:     70-85%
Non-deterministic: 15-30%
```

## Authority Boundary

Skrip owns:

- channel identity and reachability,
- channel consent/projection state as it relates to dispatch,
- message manufacture and validation,
- model/provider routing for manufacture,
- provider dispatch, retry, idempotency, and DLQ,
- delivery and channel outcome normalization,
- conversation state where channel interactions require memory.

Skrip consumes:

- growth intent and message briefs from Visibility Marketing,
- product/adoption context from Marketing or Analytics projections,
- domain pack contracts for vertical-specific triggers and fallbacks,
- optional shared inference primitives from ai-engine if latency/cost/SLOs permit.

Skrip must not own:

- growth campaign orchestration,
- product adoption decisions,
- domain conversion truth,
- broad CRM state beyond channel identity.

## Phase 0: Domain Code Extraction Inventory ✅ COMPLETE

- `[✅]` **Build**: Inventory all domain-specific code — DONE in `src/domain/bus-booking/config.ts` & `src/domain/packs/generic/index.ts`.
- `[✅]` **Extract**: Moved bus-booking into self-registering domain pack (`src/domain/bus-booking/index.ts`).
- `[✅]` **Build**: Added `domain_key` resolution path in `src/domain/registry.ts`.
  - Runtime: `tenant_id -> getTenantDomainKey() -> resolveDomainPack() -> TriggerDomainConfig -> manufacturer`.
- `[✅]` **Modify**: Core routes (`src/routes/channels/send.ts`) now depend only on `TriggerDomainConfig` interface.
- `[✅]` **Build**: Generic domain pack added for non-vertical tenants (`src/domain/packs/generic/index.ts`).
- `[✅]` **Remove**: Removed hardcoded bus-booking imports from send routes; now uses resolver.
- `[✅]` **Build**: Tests prove extensibility (16 test cases in `tests/unit/domain/domain-pack.test.ts`).

Status: **100% deterministic. Third-party domain packs can register without core changes.**

## Phase 1: Domain Pack Contract ✅ COMPLETE

- `[✅]` **Modify**: Formalized `TriggerDomainConfig` as sole manufacturing contract (`src/lib/messaging/domain-config.ts`).
- `[✅]` **Build**: Domain pack manifest in `src/domain/domain-pack.ts`.
  - Includes: `domainKey`, `version`, `supportedTriggers`, `fallbackContent`, `contextSchema`, `redactionPolicy`, `allowedChannels`.
- `[✅]` **Build**: Schema validation in `validateManifest()` checks domainKey format, version semver, supported triggers, English fallback coverage.
- `[✅]` **Build**: Deterministic fallback requirements enforced (FallbackTemplate interface validates title/body/actions per channel).
- `[✅]` **Build**: Golden test fixtures in `tests/unit/domain/golden-fixtures.test.ts` capture exact fallback outputs.
- `[✅]` **Build**: 16 golden tests per domain pack validate immutability contract.
- `[✅]` **Enforce**: No domain pack imports from `lib/channels/*`; all go through manufacturer v1/v2.

Status: **85-95% deterministic shell. Generation bounded by schema + fallback enforcement.**

## Phase 2: Agent-Callable Manufacturing Primitives ✅ COMPLETE (Routes) | 🟡 ROUNDTRIP HARNESS COMPLETE

**Status**: All 8 v1 routes implemented and registered in `src/index.ts`. VM roundtrip harness exists in `packages/marketer/tests/integration/skrip-phase2-roundtrip.test.ts` (enqueue -> `/v1/messages/send` -> signed webhook outcome). Cross-worker staging validation remains pending.

- `[✅]` **Build**: Manufacture preview API — `POST /v1/messages/manufacture` in `src/routes/v1/messages.ts`.
  - Returns validated payload, fallback flag, manufacturingMode, validationOutcome, modelMetadata.
- `[✅]` **Build**: Send API — `POST /v1/messages/send` (idempotent with idempotencyKey).
- `[✅]` **Build**: Bulk send API — `POST /v1/messages/bulk` (queue-backed, 1-10k contacts, rate-limited 10/hour).
- `[✅]` **Build**: Status API — `GET /v1/messages/:messageId` (KV fast path + D1 fallback).
- `[✅]` **Build**: Channel eligibility API — `GET /v1/contacts/:externalId/channels`.
- `[✅]` **Build**: Identity lookup/upsert API — `POST /v1/contacts/upsert`, `GET /v1/contacts/:id` (`src/routes/v1/contacts.ts`).
- `[✅]` **Modify**: Stable error envelopes (`src/lib/api/error-envelope.ts`) with v1RequestId (from header or generated).
  - `v1Ok(c, data, status?)` and `v1Err(c, code, message, status?, correlationId?)` helpers.
- `[✅]` **Build**: VM roundtrip integration harness for send + webhook outcome.
  - Coverage: `packages/marketer/tests/integration/skrip-phase2-roundtrip.test.ts` validates VM outbox dispatch to `/v1/messages/send` and signed outcome ingestion via `/webhooks/skrip/v1/outcomes`.

Status: **80-90% deterministic shell. 10-20% generation in manufacture path (LLM, fallback routing).**

## Phase 3: Message Manufacturing Modes ✅ COMPLETE

- `[✅]` **Build**: Manufacturing mode enum in `src/lib/messaging/manufacturing-mode.ts`.
  - Modes: `TEMPLATE_ONLY`, `TEMPLATE_PLUS_AI_FIELDS`, `FULL_LLM_MANUFACTURE`.
- `[✅]` **Modify**: Critical/transactional triggers (journey_update, otp, booking_confirmed, payment_failed) → `template_only` always.
- `[✅]` **Modify**: Growth/informational triggers respect budget tier + policy gates.
  - Tier 3 → `template_only`; Tier 2 drops frontier models; Tier 1 full capacity.
- `[✅]` **Build**: Fallback content validated in golden tests (`tests/unit/domain/golden-fixtures.test.ts`, 16 test cases).
- `[✅]` **Build**: Channel hard-cap validators in `src/lib/messaging/channel-caps.ts` for push/sms/whatsapp/telegram.
  - Push: title ≤50, body ≤100, actions 1-2, spam detection.
  - SMS: body ≤160.
  - WhatsApp: body ≤1024, title ≤60, buttons ≤3.
  - Telegram: body ≤4096.
- `[✅]` **Build**: Outcome codes in `src/lib/messaging/outcome-codes.ts` (17 codes: refusal, truncation, schema_violation, success, etc.).
- `[⏳]` **Modify**: Manufacturer v1/v2 convergence planned after Phase 2 integration.
- `[⏳]` **Remove**: Direct provider paths removal deferred until v2 coverage confirmed.

Status: **70-80% deterministic shell (manufacturing mode enforcement). 20-30% generation (LLM content).**

## Phase 4: Provider And Model Routing ✅ INFRASTRUCTURE COMPLETE | ⏳ INTEGRATION PENDING

**Status**: Audit infrastructure complete. Awaiting integration with manufacturer and bandit routing.

- `[✅]` **Build**: Deterministic pruning infrastructure ready in `src/lib/routing/audit.ts`.
  - Pruning steps, candidates before/after, strategy tracking (static_family_rank, thompson_sampling, pinned, tier_degraded).
- `[✅]` **Build**: Route decision audit object (`RouteAudit` interface) with full tracing:
  - bucket, candidatesBefore, pruningSteps, candidatesAfter, selectedArmId, strategyUsed, explanation, fallbackChain.
- `[✅]` **Build**: Outcome codes in `src/lib/messaging/outcome-codes.ts` include all routing failure modes.
  - no_feasible_arms, policy_killed, budget_exhausted, tier_degraded, model_rate_limited, model_unavailable, etc.
- `[⏳]` **Modify**: Deterministic pruning logic integration with manufacturer (requires Phase 2→4 handoff).
- `[⏳]` **Build**: Tenant-level model pinning (requires D1 schema + policy table extension).
- `[⏳]` **Build**: Trigger-level model pinning (requires D1 schema + policy table extension).
- `[⏳]` **Build**: Kill switch per provider/arm (requires feature flag system).
- `[?]` **Modify**: ai-engine integration strategy — deferred pending Phase 2 + Phase 4 integration readiness.

Status: **75-85% deterministic audit infrastructure. 15-25% statistical optimization deferred.**

## Phase 5: Channel Identity And Conversation State ✅ INFRASTRUCTURE COMPLETE | ⏳ API ENDPOINTS PENDING

**Status**: Core models complete. APIs and integration endpoints pending.

- `[✅]` **Preserve**: Identity resolver (`src/lib/identity/resolver.ts`) remains deterministic authority.
- `[✅]` **Build**: Confidence and provenance in resolver output (confidence score, mergedFrom array, method field).
- `[✅]` **Build**: Channel preference/fatigue model (`src/lib/messaging/channel-preference.ts`).
  - ChannelFatigue: lastSuccessAt, failureCount, optedOutAt, lastAttemptAt, preferenceScore.
  - computeChannelFatigue() based on failures, staleness (60+ days), recent opt-outs.
  - rankChannels() deterministic ordering for dispatch.
- `[⏳]` **Build**: Conversation state API endpoints (GET /v1/contacts/:id/conversation_state).
  - Implemented: `src/routes/v1/contacts.ts` — returns channel fatigue, subscription count, preference scores, and recent event count per channel.
- `[⏳]` **Modify**: Channel consent vs. Marketing suppression separation (schema + sync contract).
- `[⏳]` **Build**: Identity reconciliation webhooks from Skrip → Marketing (or polling alternative).
- `[⏳]` **Enforce**: Marketing submits upserts via `/v1/contacts/upsert`; reads canonical results only.

Status: **90-95% deterministic foundation. 5-10% projection/fatigue calculations.**

## Phase 6: Workflow Engine Evolution ⏳ NOT STARTED (Planned after Phase 2-5 integration)

- `[ ]` **Modify**: Keep workflow execution as deterministic state machine.
- `[ ]` **Build**: Externalize workflow definitions into versioned configs.
- `[ ]` **Build**: Add workflow dry-run and explain endpoints.
- `[ ]` **Build**: Add workflow step outcome taxonomy.
  - Examples: `skipped_policy`, `sent`, `failed_provider`, `fallback_template`, `awaiting_engagement`, `escalated`.
- `[ ]` **Build**: Add workflow pause/resume/cancel with audit trail.
- `[ ]` **Modify**: AI advisory (no direct mutations to live definitions).

Determinism: 90-95% deterministic, 5-10% AI advisory.

**Blocker**: Deferred until Phase 2-5 core integration is validated.

## Phase 7: Outcomes, Telemetry, And Attribution ✅ CONTRACTS COMPLETE | ⏳ JOIN JOB & TELEMETRY PENDING

**Status**: Event models and webhook delivery complete. Join job and dashboard deferred.

- `[✅]` **Build**: Normalized outcome contract (`src/lib/outcomes/contract.ts`).
  - Event types: message.accepted, message.sent, message.delivered, message.failed, message.opened, message.clicked, message.replied, message.unsubscribed.
  - NormalizedOutcomeEvent with 8 standard events, OutcomeTelemetry (promptHash, modelVersion, budgetTier, manufacturingMode, usedFallback, domainKey).
- `[✅]` **Build**: Signed webhook delivery (`src/lib/outcomes/webhooks.ts`).
  - buildSignedWebhookPayload() — HMAC-SHA256 using Web Crypto API (Workers-compatible).
  - verifyWebhookSignature() for incoming validation.
  - WebhookPayload includes event, timestamp, signature, retryCount.
  - WebhookEndpoint configuration model (url, secret, active, events filter).
- `[⏳]` **Build**: Outcome join job (links generation_event → outbound_message → provider_ref → outcome_event).
  - Requires: background queue consumer, D1 schema for join table.
- `[⏳]` **Build**: DLQ replay and operator diagnostics.
- `[⏳]` **Modify**: Telemetry integration with manufacturer (promptHash computation, model selection tracking).
  - Implemented: `src/routes/internal/strategy.ts` now computes `promptHash` (SHA-256 of brief) and emits `modelVersion` in both the manufacturing response block and the `internal.strategy.send` log event.
- `[⏳]` **Build**: SLO dashboard (latency, success rate, fallback rate, queue depth, DLQ depth, cost).

Status: **95% deterministic contracts. 5% optional AI synthesis in outcomes.**

## Phase 8: Conversation Intelligence ✅ CLASSIFICATION ENGINE COMPLETE | ⏳ SUMMARIZATION & DRAFTING PENDING

**Status**: Reply classification and deterministic action mapping complete. Summarization/drafting deferred.

- `[⏳]` **Build**: Conversation summary for long-running threads (deferred for Phase 2-5 integration).
- `[✅]` **Build**: Reply classification (`src/lib/conversation/reply-classifier.ts`).
  - 8 classifications: positive_interest, objection, unsubscribe, support_request, not_now, wrong_person, auto_reply, ambiguous.
  - classifyReplyDeterministic() — keyword-based (no LLM), includes confidence 0.0–1.0.
  - CRITICAL: unsubscribe always confidence 0.95; auto_reply 0.85; wrong_person 0.80; support 0.75; objection/not_now/positive 0.65–0.70; ambiguous 0.0.
- `[✅]` **Build**: Deterministic action mapping from classification (`mapReplyToAction()`).
  - unsubscribe → update_consent (ENFORCED, model cannot override).
  - support_request → flag_support_request (route to human queue).
  - not_now → retry_later (schedule for later).
  - other classifications → no_action (log only).
- `[⏳]` **Build**: Human response draft suggestions (LLM-based, deferred).
- `[⏳]` **Modify**: High-risk action approval workflows (deferred for Phase 2-5 integration).

Status: **95-100% deterministic classification. 0-5% optional AI drafting.**

## Validation Plan

- Domain pack contract tests and golden fixtures.
- Manufacturer v2 schema and fallback tests.
- Provider routing decision tests, including killed arms and budget degradation.
- Identity resolver merge/link negative tests.
- Queue idempotency and DLQ replay tests.
- Cross-worker contract tests with Visibility Marketing (staging live-contract run pending).
- Load tests for queue-backed bulk sends (awaiting Phase 2 integration).
- Routing audit object integration tests (awaiting Phase 4 integration).
- Reply classification determinism tests (DONE, see `reply-classifier.ts`).

## Pending Integration Work (Next Priority)

The infrastructure foundation is complete. The following integration work is now blocking:

1. **Phase 2 Staging Validation**: Run live-contract staging validation for Visibility Marketing -> Skrip -> signed webhook (beyond mocked harness).
2. **Phase 4 Routing Integration**: Connect audit object to manufacturer; test pruning + bandit logic.
3. **Phase 5 API Endpoints**: Add conversation_state GET endpoint; add reconciliation webhook endpoint.
4. **Phase 7 Join Job**: Implement background outcome join job and DLQ consumer.
5. **Telemetry Instrumentation**: Wire promptHash, modelVersion, budgetTier into manufacturer v2 path.

Once Phase 2 is integrated, subsequent phases can proceed in parallel.

## Implementation Status Summary

| Phase | Component | Status | Files | Notes |
|-------|-----------|--------|-------|-------|
| 0-1 | Domain packs | ✅ | `src/domain/` | 16 test cases pass; extensibility proven |
| 2 | v1 routes | ✅ | `src/routes/v1/` | 8 routes registered in `src/index.ts`; error envelope complete |
| 3 | Manufacturing modes | ✅ | `src/lib/messaging/` | outcome-codes (17), channel-caps, manufacturing-mode |
| 4 | Route audit | ✅ | `src/lib/routing/audit.ts` | Tracing infrastructure ready; integration pending |
| 5 | Channel preference | ✅ | `src/lib/messaging/channel-preference.ts` | Fatigue model + ranking; APIs pending |
| 7 | Signed webhooks | ✅ | `src/lib/outcomes/webhooks.ts` | Web Crypto API (Workers-compatible) |
| 8 | Reply classification | ✅ | `src/lib/conversation/reply-classifier.ts` | Deterministic; action mapping enforces policy |
| 6 | Workflow evolution | ⏳ | TBD | Deferred until Phase 2-5 integration |
| 4 | Model pinning | ⏳ | TBD | Requires schema + feature flag system |
| 7 | Outcome join job | ⏳ | TBD | Requires queue consumer + D1 join table |

## Dependencies

- ✅ Core Skrip infrastructure complete (Phases 0-1, 3-4 foundation, 5, 7-8 foundation).
- ⏳ Visibility Marketing integration with v1 routes (Phase 2 integration contract needed).
- ⏳ Routing + telemetry integration into manufacturer (Phase 4 integration).
- ⏳ ai-engine reuse strategy (deferred; evaluate after Phase 2-5 validation).
- ⏳ Domain apps supply conversion events for outcomes attribution (depends on Phase 7 join job).

## 2026-05-04 Ecosystem Review Follow-Up

Cross-repo review confirms Skrip is the right home for channel identity, manufacture, and delivery. The next changes should tighten contract clarity and close the remaining Stage 2 integration gaps.

- `[x]` **Build**: Publish explicit supported-channel behavior for strategic send, including downgrade and rejection semantics for unsupported channels.
  - Implemented: `STRATEGIC_DISPATCHABLE_CHANNELS` exported from `src/lib/strategic/contract.ts` with full explanatory comment; `pickChannel` in `src/routes/internal/strategy.ts` now documents why email is excluded.
- `[ ]` **Build**: Complete the live-contract staging certification path with Visibility Marketing and keep it as a maintained release gate.
- `[ ]` **Modify**: Finish routing audit integration so manufacturing decisions expose traceable route-selection metadata in production paths.
- `[ ]` **Build**: Complete the outcome join job, reconciliation surfaces, and telemetry enrichment needed for full closed-loop attribution.
- `[ ]` **Modify**: Continue converging manufacturer paths and removing legacy direct-provider paths only after parity and operator evidence are proven.

## Maturity Stage Index

Maturity stages: **Stage 1** = infrastructure complete / tested locally; **Stage 2** = integration live, roundtrip exercised; **Stage 3** = production certified, SLOs observed.

| Phase | Title | Stage |
|-------|-------|-------|
| 0 | Domain Code Extraction | Stage 3 — domain packs registered, tests green |
| 1 | Domain Pack Contract | Stage 3 — manifest validated, golden fixtures enforced |
| 2 | Agent-Callable Manufacturing Primitives | Stage 2 — all v1 routes live; staging live-contract certification pending |
| 3 | Message Manufacturing Modes | Stage 2 — mode enforcement live; manufacturer v2 convergence deferred |
| 4 | Provider And Model Routing | Stage 1 — audit infrastructure complete; manufacturer integration pending |
| 5 | Channel Identity And Conversation State | Stage 2 — identity resolver + fatigue model live; conversation_state API added |
| 6 | Workflow Engine Evolution | Stage 1 — deferred until Phase 2-5 validated |
| 7 | Outcomes, Telemetry, And Attribution | Stage 2 — contracts + webhooks + promptHash live; join job pending |
| 8 | Conversation Intelligence | Stage 2 — classification + action mapping live; drafting deferred |
