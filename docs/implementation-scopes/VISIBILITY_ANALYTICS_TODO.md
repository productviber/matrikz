# Visibility Analytics Implementation Todo

Date: 2026-05-02

Role: **Product And Adoption Signal Authority**.

Visibility Analytics should own product behavior, site health, usage metrics, adoption milestones, and product intelligence. It should emit clean signals to Visibility Marketing and provide user/product context to ai-engine, but it should not execute campaigns or decide channel delivery.

Target split:

```text
Deterministic:     85-95%
Non-deterministic: 5-15%
```

## Authority Boundary

Visibility Analytics owns:

- user and site product state,
- GSC/Bing/Cloudflare-derived product metrics,
- authenticated product dashboard context,
- adoption and activation milestones,
- product health signals,
- internal report data and product event emission.

Visibility Analytics consumes:

- ai-engine insights for SEO/product analysis,
- Marketing attribution projections where user-facing context needs them,
- domain app conversion events when the product surface needs to display them.

Visibility Analytics must not own:

- campaign execution,
- growth action authorization,
- Skrip channel identity,
- LLM provider orchestration outside ai-engine.

## Phase 0: Current Signal Inventory

- `[ ]` **Build**: Create an event catalog for all analytics-originated events consumed by Marketing.
  - Include name, payload schema, source route/job, destination, idempotency key, timestamp semantics, and replay policy.
- `[ ]` **Modify**: Ensure every emitted event has `eventId`, `occurredAt`, `sourceSystem`, `sourceNode`, `subject`, and `correlationId`.
- `[ ]` **Build**: Add schema fixtures for Marketing contract tests.
- `[ ]` **Modify**: Mark which events are product truth vs derived signal.
  - Product truth: signup, app install, site connected, first analysis, plan change.
  - Derived signal: anomaly, opportunity, recommendation, content gap.
- `[ ]` **Remove**: Retire any event aliases that duplicate meaning without a migration path.

Determinism: 100% deterministic.

## Phase 1: Product Adoption Event Model

- `[ ]` **Build**: Standardize activation events.
  - Required: `user.signed_up`, `site.connected`, `analysis.started`, `analysis.completed`, `user.first_analysis`, `ai.chat_used`, `report.viewed`, `recommendation.applied`.
- `[ ]` **Build**: Standardize retention and expansion events.
  - Required: `user.returned`, `weekly_report_opened`, `recommendation_completed`, `plan.upgraded`, `plan.downgraded`, `subscription.cancelled`.
- `[ ]` **Build**: Standardize failure/friction events.
  - Required: `gsc.connection_failed`, `analysis.failed`, `report.export_failed`, `checkout.abandoned`, `trial.expiring`, `trial.expired`.
- `[ ]` **Modify**: Emit events from the exact product authority point, not from secondary UI assumptions.
- `[ ]` **Build**: Add event replay endpoint/job for a bounded time window.
- `[ ]` **Build**: Add event freshness and duplicate metrics.

Determinism: 95-100% deterministic.

## Phase 2: Growth Signal Inputs For Marketing

- `[ ]` **Build**: Add internal endpoint for Marketing to fetch adoption summaries.
  - Candidate: `GET /internal/adoption-summary/:subjectId`.
- `[ ]` **Build**: Add deterministic adoption stage calculation.
  - Suggested stages: `anonymous`, `lead`, `signup`, `connected_site`, `activated`, `retained`, `expanded`, `at_risk`, `churned`.
- `[ ]` **Build**: Add product health snapshot per user/site.
  - Include site score, last analysis, issue count, recommendation count, connected data sources, report freshness, and recent activity.
- `[ ]` **Build**: Add opportunity summary payload for Marketing.
  - Include top deterministic opportunities and evidence; do not include model-generated persuasion copy.
- `[ ]` **Modify**: Existing internal report-data APIs should return stable machine fields plus display fields.
- `[ ]` **Build**: Add contract tests for Analytics -> Marketing event and internal API payloads.

Determinism: 90-95% deterministic, 5-10% AI summary optional.

## Phase 3: ai-engine Integration Discipline

- `[ ]` **Modify**: Keep ai-engine calls in Analytics focused on product intelligence.
  - Examples: anomaly diagnosis, recommendation refinement, content gaps, chat with analytics context.
- `[ ]` **Build**: Add typed ai-engine client response schemas for every capability currently used by Analytics.
- `[ ]` **Modify**: Persist ai-engine capability metadata beside generated insights.
  - Required: capability, model/provider, prompt version, response schema version, cost estimate, created_at.
- `[ ]` **Build**: Add deterministic fallback for each AI-assisted product insight.
  - If ai-engine fails, product dashboards must still render useful deterministic metrics.
- `[ ]` **Remove**: Any direct provider calls from Analytics if ai-engine has an equivalent capability.
- `[ ]` **Build**: Add privacy redaction before product/user context is sent to ai-engine.

Determinism: 70-85% deterministic shell, 15-30% model inference inside product insight paths.

## Phase 4: Conversion Truth And Domain App Boundaries

- `[?]` **Modify**: Decide which conversions Analytics is authoritative for and which belong to domain apps or payment systems.
- `[ ]` **Build**: Define conversion event contract.
  - Required fields: `conversionId`, `subjectId`, `tenantId`, `conversionType`, `value`, `currency`, `occurredAt`, `sourceSystem`, `domainKey`, `metadata`.
- `[ ]` **Build**: Add conversion projection endpoint for Marketing attribution.
  - Candidate: `GET /internal/conversions?subjectId=&since=`.
- `[ ]` **Modify**: Ensure Marketing cannot create conversion truth directly; it can only record attribution against observed conversion events.
- `[ ]` **Build**: Add provenance fields to distinguish product conversion, payment conversion, affiliate conversion, and domain-app conversion.
- `[ ]` **Remove**: Any analytics report wording that implies attribution equals conversion truth.

Determinism: 100% deterministic.

## Phase 5: Product Usage Cohorts And Segments

- `[ ]` **Build**: Deterministic cohort generator for activation and retention.
  - Examples: `no_site_connected_24h`, `connected_no_analysis`, `analysis_no_action`, `high_score_no_upgrade`, `low_score_high_intent`.
- `[ ]` **Build**: Segment export endpoint for Marketing.
  - Must support pagination, filters, and stable snapshot IDs.
- `[ ]` **Modify**: Segment definitions should be versioned and stored as config, not scattered conditionals.
- `[ ]` **Build**: Segment drift metrics.
  - Track size, entry rate, exit rate, conversion rate, and last computed time.
- `[ ]` **Build**: Optional ai-engine segment narrative.
  - Model may explain a segment; deterministic code defines membership.

Determinism: 90-95% deterministic, 5-10% AI explanation.

## Phase 6: Product Health To Message Briefs

- `[ ]` **Build**: Add internal endpoint that returns a message-safe product context brief.
  - Candidate: `GET /internal/message-context/:subjectId`.
- `[ ]` **Modify**: Ensure message context excludes sensitive raw query data unless explicitly allowed.
- `[ ]` **Build**: Add field-level sensitivity labels.
  - Examples: `public`, `tenant_private`, `pii`, `provider_secret`, `never_send_to_ai`.
- `[ ]` **Build**: Add deterministic top issue and top opportunity selection.
- `[ ]` **Modify**: Allow ai-engine to summarize the deterministic brief, but not invent product facts.

Determinism: 90% deterministic, 10% AI summarization.

## Phase 7: Analytics Admin And Observability

- `[ ]` **Build**: Event emission dashboard.
  - Shows emitted count, failed deliveries, replay count, duplicate count, and downstream acknowledgment if available.
- `[ ]` **Build**: Internal API contract dashboard for Marketing consumers.
- `[ ]` **Build**: ai-engine usage dashboard scoped to Analytics capabilities.
- `[ ]` **Build**: Data freshness indicators for GSC, Bing, Cloudflare, analysis jobs, and product events.
- `[ ]` **Build**: Dead-letter or retry queue for failed internal event emission.

## Validation Plan

- Unit tests for event schema builders and adoption stage calculator.
- Contract tests for Analytics -> Marketing events and internal APIs.
- Negative tests for stale, duplicated, malformed, or spoofed event delivery.
- Snapshot tests for product context redaction before ai-engine calls.
- Integration tests for product event -> Marketing growth signal creation.

## Dependencies

- Marketing must define required growth signal input fields.
- ai-engine must provide typed product insight capabilities and response schemas.
- Domain apps/payment systems must define conversion event contracts.
- Cross-product identity authority must define subject ID mapping rules.
