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

## Phase 0: Domain Code Extraction Inventory

- `[ ]` **Build**: Inventory all domain-specific code currently embedded in Skrip core.
  - Known example: bus-booking domain config and trigger conversion inside channel send/runtime paths.
- `[ ]` **Extract**: Move bus-booking trigger config, fallback content, and domain-specific metadata into a domain pack.
- `[ ]` **Build**: Add `domain_key` resolution path.
  - Runtime: `tenant_id -> domain_key -> domain pack -> TriggerDomainConfig -> manufacturer`.
- `[ ]` **Modify**: Make core routes and workflows depend on `TriggerDomainConfig`, not on bus-specific imports.
- `[ ]` **Build**: Add default generic domain pack for non-vertical tenants.
- `[ ]` **Remove**: Remove direct imports of bus-booking config from core routes after resolver is in place.
- `[ ]` **Build**: Add tests proving a tenant can run with generic, bus-booking, and future domain packs without core code changes.

Determinism: 100% deterministic.

## Phase 1: Domain Pack Contract

- `[ ]` **Modify**: Formalize `TriggerDomainConfig` as the only domain-specific manufacturing contract.
- `[ ]` **Build**: Add domain pack manifest.
  - Required: `domainKey`, `version`, `supportedTriggers`, `fallbackContent`, `contextSchema`, `redactionPolicy`, `allowedChannels`.
- `[ ]` **Build**: Add domain pack schema validation at startup or first use.
- `[ ]` **Build**: Add deterministic fallback requirements per trigger and channel.
- `[ ]` **Build**: Add versioned prompt/context fixtures per domain pack.
- `[ ]` **Build**: Add golden tests for each domain pack.
- `[ ]` **Remove**: No domain pack may call providers directly; all generation must go through manufacturer primitives.

Determinism: 85-95% deterministic; generation remains bounded by schemas.

## Phase 2: Agent-Callable Manufacturing Primitives

- `[ ]` **Build**: Expose manufacture preview API.
  - Candidate: `POST /v1/messages/manufacture`.
  - Returns validated payload, fallback flag, model metadata, policy result, and estimated cost.
- `[ ]` **Build**: Expose send API.
  - Candidate: `POST /v1/messages/send`.
  - Requires idempotency key, tenant ID, channel, contact identity, trigger, context, and campaign metadata.
- `[ ]` **Build**: Expose bulk send API only through queue-backed ingestion.
  - Candidate: `POST /v1/messages/bulk`.
- `[ ]` **Build**: Expose status API.
  - Candidate: `GET /v1/messages/:messageId`.
- `[ ]` **Build**: Expose channel eligibility API.
  - Candidate: `GET /v1/contacts/:externalContactId/channels`.
- `[ ]` **Build**: Expose identity lookup/upsert API with deterministic merge confidence.
  - Candidate: `POST /v1/contacts/upsert`, `GET /v1/contacts/:id`.
- `[ ]` **Modify**: Ensure all APIs return stable error envelopes with request/correlation ID.
- `[ ]` **Build**: Add contract fixtures consumed by Visibility Marketing tests.

Determinism: 80-90% deterministic, 10-20% manufacture inference.

## Phase 3: Message Manufacturing Modes

- `[ ]` **Build**: Add explicit manufacturing mode enum.
  - Required modes: `template_only`, `template_plus_ai_fields`, `full_llm_manufacture`.
- `[ ]` **Modify**: Route critical/transactional triggers to `template_only` by default.
- `[ ]` **Modify**: Route growth/persuasion triggers to `template_plus_ai_fields` or `full_llm_manufacture` only when policy allows.
- `[ ]` **Build**: Add deterministic fallback content for every trigger/channel/language tuple.
- `[ ]` **Build**: Validate generated outputs against channel hard caps.
  - Examples: title/body/action lengths, language, CTA shape, push payload validity, SMS length, WhatsApp template rules.
- `[ ]` **Build**: Add refusal/truncation/schema violation outcome codes.
- `[ ]` **Modify**: Legacy manufacturer path should converge on manufacturer v2 or be wrapped by the same policy and telemetry.
- `[ ]` **Remove**: Remove unstructured direct provider generation paths once v2 coverage is complete.

Determinism: 70-80% deterministic shell, 20-30% generation.

## Phase 4: Provider And Model Routing

- `[ ]` **Modify**: Keep deterministic pruning before any bandit/model selection.
  - Required filters: tenant policy, budget, residency, provider availability, task class, trigger criticality, channel constraints.
- `[ ]` **Build**: Add route decision audit object for every generation.
  - Required: bucket, candidates, selected arm, rejected arms, reason, fallback chain.
- `[ ]` **Modify**: Thompson sampling/bandit routing may only choose among policy-approved arms.
- `[ ]` **Build**: Add tenant-level and trigger-level model pinning controls.
- `[ ]` **Build**: Add kill switch per provider/model arm.
- `[?]` **Modify**: Decide whether Skrip should call ai-engine for provider abstraction or keep its own provider layer.
  - Prefer shared library or ai-engine only if latency, auth, cost attribution, and fallback SLOs are acceptable.
- `[ ]` **Extract**: If provider logic is duplicated between Skrip and ai-engine, extract a shared model registry or provider contract rather than creating hidden divergence.

Determinism: 75-85% deterministic, 15-25% statistical optimization/generation.

## Phase 5: Channel Identity And Conversation State

- `[ ]` **Modify**: Preserve deterministic identity resolver as channel identity authority.
- `[ ]` **Build**: Add confidence and provenance explanation for identity links and merges.
- `[ ]` **Build**: Add channel preference and fatigue projection.
  - Include last successful channel, failed channel count, recent opt-outs, response recency, preferred language.
- `[ ]` **Build**: Add conversation state API if Marketing needs context before requesting a message.
- `[ ]` **Modify**: Separate channel consent from Marketing suppression while allowing projections to sync.
- `[ ]` **Build**: Add identity reconciliation webhooks or polling contract for Marketing.
- `[ ]` **Remove**: Avoid Marketing directly mutating Skrip canonical identity; it should submit projections/upserts and consume canonical results.

Determinism: 90-100% deterministic.

## Phase 6: Workflow Engine Evolution

- `[ ]` **Modify**: Keep workflow execution as a deterministic state machine.
- `[ ]` **Build**: Externalize workflow definitions into versioned configs where possible.
- `[ ]` **Build**: Add workflow dry-run and explain endpoints.
- `[ ]` **Build**: Add workflow step outcome taxonomy.
  - Examples: `skipped_policy`, `sent`, `failed_provider`, `fallback_template`, `awaiting_engagement`, `escalated`.
- `[ ]` **Build**: Add workflow pause/resume/cancel commands with audit trail.
- `[ ]` **Modify**: Allow AI to suggest workflow improvements, but not mutate live workflow definitions without review.

Determinism: 90-95% deterministic, 5-10% AI advisory.

## Phase 7: Outcomes, Telemetry, And Attribution

- `[ ]` **Build**: Normalize provider outcomes into a stable event contract.
  - Required: `message.accepted`, `message.sent`, `message.delivered`, `message.failed`, `message.opened`, `message.clicked`, `message.replied`, `message.unsubscribed`.
- `[ ]` **Build**: Add signed webhook delivery to Marketing for every normalized outcome.
- `[ ]` **Build**: Add outcome join job that links generation request, outbound message, provider ref, and channel outcome.
- `[ ]` **Build**: Add DLQ replay and operator diagnostics.
- `[ ]` **Modify**: Ensure telemetry includes prompt hash/version, model version, budget tier, manufacturing mode, fallback flag, and channel.
- `[ ]` **Build**: Add production SLO dashboard.
  - Include p50/p95 latency, success/failure rate, fallback rate, provider rate-limit rate, queue depth, DLQ depth, cost per tenant.

Determinism: 95% deterministic, 5% AI synthesis optional.

## Phase 8: Conversation Intelligence

- `[ ]` **Build**: Add conversation summary capability for long-running threads.
- `[ ]` **Build**: Add reply classification.
  - Suggested classes: `positive_interest`, `objection`, `unsubscribe`, `support_request`, `not_now`, `wrong_person`, `auto_reply`.
- `[ ]` **Build**: Add deterministic action mapping from reply class.
  - Example: `unsubscribe` always updates consent/suppression; model cannot override.
- `[ ]` **Build**: Add suggested human response drafts for ambiguous replies.
- `[ ]` **Modify**: High-risk conversation actions require human approval.

Determinism: 65-80% deterministic, 20-35% AI classification/summarization/drafting.

## Validation Plan

- Domain pack contract tests and golden fixtures.
- Manufacturer v2 schema and fallback tests.
- Provider routing decision tests, including killed arms and budget degradation.
- Identity resolver merge/link negative tests.
- Queue idempotency and DLQ replay tests.
- Cross-worker contract tests with Visibility Marketing.
- Load tests for queue-backed bulk sends.

## Dependencies

- Marketing must define growth intent and message brief contracts.
- Cross-product domain pack ownership must be decided.
- ai-engine reuse strategy must be decided before provider abstraction duplication grows.
- Domain apps must supply conversion events if Skrip outcomes are used in vertical workflows.
