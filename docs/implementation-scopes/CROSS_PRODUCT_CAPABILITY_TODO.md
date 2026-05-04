# Cross-Product Capability Todo

Date: 2026-05-02

Role: **Shared contracts, authority boundaries, and product capabilities that cut across repos**.

This file captures work that does not belong cleanly to only Visibility Marketing, Visibility Analytics, Skrip, or ai-engine. These items prevent split-brain ownership and make the agent-led growth loop durable.

Target split:

```text
Deterministic:     90-100%
Non-deterministic: 0-10%
```

## Capability 1: Federated Identity Substrate

- `[ ]` **Build**: Create identity authority matrix.
  - Product identity: Analytics/domain apps.
  - Channel identity: Skrip.
  - Growth identity: Visibility Marketing.
  - Behavior signals: Analytics/domain apps.
- `[ ]` **Build**: Define canonical subject reference format for cross-system events.
  - Suggested fields: `subjectType`, `subjectId`, `tenantId`, `domainKey`, `sourceSystem`, `externalIds`.
- `[ ]` **Build**: Define projection update rules between systems.
  - Example: Marketing may project contact email to Skrip; Skrip returns canonical channel identity.
- `[ ]` **Build**: Add identity provenance fields to all shared events.
- `[ ]` **Modify**: Make merge/link confidence explicit whenever identities are joined.
- `[ ]` **Remove**: Avoid any global identity table that every system mutates freely.

Owner: cross-product architecture.  
Determinism: 100%.

## Capability 2: Growth Event Contract

- `[ ]` **Build**: Create shared event envelope spec.
  - Required: `eventId`, `eventType`, `occurredAt`, `sourceSystem`, `sourceNode`, `tenantId`, `subject`, `correlationId`, `schemaVersion`, `data`.
- `[ ]` **Build**: Add idempotency and replay rules.
- `[ ]` **Build**: Add event freshness and clock drift rules.
- `[ ]` **Build**: Add source authentication rules for service bindings and webhook ingress.
- `[ ]` **Build**: Add shared fixture directory for cross-repo contract tests.
- `[ ]` **Modify**: Existing events should be migrated to the envelope with compatibility shims.
- `[ ]` **Remove**: Retire ad hoc event payloads once all consumers use versioned schemas.

Owner: Analytics + Marketing + domain apps.  
Determinism: 100%.

## Capability 3: Agent Action Contract

- `[ ]` **Build**: Define closed action enum.
  - Initial set: `wait`, `manual_review`, `enroll_sequence`, `pause_contact`, `pause_campaign`, `start_campaign`, `send_via_skrip`, `manufacture_preview`, `switch_channel`, `suppress_contact`.
- `[ ]` **Build**: Define action risk levels.
  - Suggested: `low`, `medium`, `high`, `restricted`.
- `[ ]` **Build**: Define action policy result schema.
- `[ ]` **Build**: Define approval requirements by risk level.
- `[ ]` **Build**: Define execution outcome schema.
- `[ ]` **Modify**: ai-engine recommendations must reference this enum only.
- `[ ]` **Remove**: Avoid arbitrary natural-language action commands as executable input.

Owner: Marketing with cross-product review.  
Determinism: 100%.

## Capability 4: Domain Packs

- `[ ]` **Build**: Define domain pack ownership model.
  - Options: live in Skrip repo, domain app repo, or shared package registry.
- `[ ]` **Extract**: Move bus-booking domain logic out of Skrip core into a domain pack.
- `[ ]` **Build**: Add generic Visibility domain pack for SEO/product-adoption triggers.
- `[ ]` **Build**: Add domain pack manifest and schema validation.
- `[ ]` **Build**: Add domain pack test harness with golden fixtures.
- `[ ]` **Build**: Add domain pack version and migration policy.
- `[ ]` **Remove**: No domain-specific trigger branches in Skrip core runtime paths.

Owner: Skrip + relevant domain app owner.  
Determinism: 90-95% with AI only inside manufacturing fields.

## Capability 5: Message Brief Contract

- `[ ]` **Build**: Define message brief schema from Marketing to Skrip.
  - Required: `tenantId`, `campaignId`, `journeyId`, `stepId`, `trigger`, `subject`, `channelCandidates`, `growthGoal`, `context`, `constraints`, `idempotencyKey`, `correlationId`.
- `[ ]` **Build**: Define context sensitivity labels.
- `[ ]` **Build**: Define allowed manufacturing modes per trigger.
- `[ ]` **Build**: Define fallback behavior when AI manufacture fails.
- `[ ]` **Modify**: Marketing should send intent and context, not provider-specific payloads.
- `[ ]` **Modify**: Skrip should return manufactured channel payloads and telemetry, not campaign decisions.

Owner: Marketing + Skrip.  
Determinism: 80-90% shell, 10-20% generation.

## Capability 6: Product Adoption Capability Catalog

- `[ ]` **Build**: Create catalog of product capabilities that Marketing can promote.
  - Examples: free audit, site connection, first analysis, AI chat, recommendations, report sharing, revenue attribution, weekly digest, competitor tracking.
- `[ ]` **Build**: For each capability, define adoption event, activation criteria, value proposition, eligible segments, and disqualifying conditions.
- `[ ]` **Modify**: Existing capability hooks should become catalog entries with stable IDs.
- `[ ]` **Build**: Add capability-to-message-brief mapping.
- `[ ]` **Build**: Add capability outcome metrics.
- `[ ]` **Remove**: Avoid hard-coded one-off copy hooks outside the catalog.

Owner: Product + Analytics + Marketing.  
Determinism: 85-95%.

## Capability 7: Conversion Truth Contract

- `[ ]` **Build**: Define conversion event taxonomy.
  - Examples: `signup`, `site_connected`, `first_analysis`, `trial_started`, `trial_converted`, `subscription_upgraded`, `booking_made`, `payment_completed`, `share_conversion`.
- `[ ]` **Build**: Define conversion authority per taxonomy item.
- `[ ]` **Build**: Define attribution windows and allowed attribution strengths.
- `[ ]` **Modify**: Marketing records attribution, not conversion truth.
- `[ ]` **Modify**: Domain apps and payment/product systems emit truth events.
- `[ ]` **Remove**: Remove any code path that treats email click/open as conversion.

Owner: Domain apps + Analytics + Marketing.  
Determinism: 100%.

## Capability 8: Agentic Governance And Safety

- `[ ]` **Build**: Define risk policy for agent actions.
- `[ ]` **Build**: Define human approval policy.
- `[ ]` **Build**: Define tenant-level kill switch.
- `[ ]` **Build**: Define global incident kill switch.
- `[ ]` **Build**: Define audit retention period.
- `[ ]` **Build**: Define model output review and escalation process.
- `[ ]` **Modify**: Every repo should log correlation ID and action ID when participating in agent-led execution.
- `[ ]` **Remove**: No agent path may bypass policy, idempotency, or audit.

Owner: platform/ops/security.  
Determinism: 100%.

## Capability 9: Shared Observability

- `[ ]` **Build**: Cross-system trace model.
  - `correlationId` must flow through Analytics event, Marketing action, ai-engine proposal, Skrip manufacture, Skrip outcome, and final attribution.
- `[ ]` **Build**: Shared event/action timeline view.
- `[ ]` **Build**: Cost and latency dashboards by capability.
- `[ ]` **Build**: Outcome dashboards by action type, channel, campaign, and domain pack.
- `[ ]` **Build**: DLQ dashboards for events, Skrip outcomes, and AI capability failures.
- `[ ]` **Build**: Alerting thresholds for failures, stale queues, high cost, schema violations, and low fallback coverage.

Owner: platform/ops with system owners.  
Determinism: 95-100%.

## Capability 10: Cross-Repo Contract Testing

- `[ ]` **Build**: Contract fixture package or mirrored fixture directory.
- `[ ]` **Build**: Marketing -> Analytics contract tests.
- `[ ]` **Build**: Analytics -> Marketing event contract tests.
- `[ ]` **Build**: Marketing -> ai-engine contract tests.
- `[ ]` **Build**: Marketing -> Skrip contract tests.
- `[ ]` **Build**: Skrip -> Marketing outcome webhook contract tests.
- `[ ]` **Build**: Domain app -> Analytics/Marketing conversion event contract tests.
- `[ ]` **Modify**: Add CI checks that fail on schema drift without fixture updates.

Owner: all system owners.  
Determinism: 100%.

## Capability 11: Design System And Operator Surfaces

- `[ ]` **Build**: Shared admin components for action ledgers, event timelines, rollout toggles, status badges, and audit drawers.
- `[ ]` **Modify**: Keep operator UI quiet, dense, and work-focused.
- `[ ]` **Build**: Add reusable components for risk level, policy result, channel status, and attribution strength.
- `[ ]` **Build**: Add charts/tables for growth signals, action outcomes, model usage, and channel delivery.
- `[ ]` **Remove**: Avoid duplicating admin UI patterns separately in Marketing and Analytics when design-system components should own them.

Owner: design-system + product surfaces.  
Determinism: 100%.

## Capability 12: Data Retention And Privacy

- `[ ]` **Build**: Retention policy for prompts, model outputs, action evidence, and event payloads.
- `[ ]` **Build**: PII classification rules for all cross-system payloads.
- `[ ]` **Build**: Redaction helpers reused by Analytics, Marketing, Skrip, and ai-engine.
- `[ ]` **Build**: GDPR/export/delete behavior for growth action records and channel identities.
- `[ ]` **Modify**: Ensure suppression and unsubscribe state survives TTL expiry.
- `[ ]` **Remove**: No unbounded raw prompt/event storage without retention policy.

Owner: security/privacy + system owners.  
Determinism: 100%.

## Capability 13: Product Capability Removal/Deprecation

- `[?]` **Remove**: Identify outdated marketing routes or public surfaces that no longer support agent-led adoption.
- `[?]` **Remove**: Identify duplicate AI calls outside ai-engine.
- `[?]` **Remove**: Identify duplicate provider registries if shared provider infrastructure is approved.
- `[?]` **Remove**: Identify domain-specific code embedded in generic runtimes.
- `[?]` **Remove**: Identify old event aliases after versioned contracts are live.
- `[?]` **Remove**: Identify UI dashboards that report vanity metrics without action/outcome linkage.

Owner: architecture review.  
Determinism: 100%.

## 2026-05-04 Ecosystem Alignment Follow-Up

- `[ ]` **Build**: Add a shared live-contract certification gate for Visibility Marketing -> Skrip -> signed outcome roundtrip.
- `[ ]` **Build**: Add a shared live-contract certification gate for Visibility Marketing -> Matrikz growth-agent capability calls.
- `[ ]` **Build**: Standardize a cross-system trace field set: `correlationId`, `agentActionId`, `growthCapability`, `promptVersion`, `responseSchemaVersion`, `deliveryMode`, `outcomeType`.
- `[ ]` **Build**: Define explicit downgrade/rejection rules for unsupported strategic channels so Marketing and Skrip cannot drift silently.
- `[ ]` **Modify**: Treat Stage 2 closed-loop optimization as a governed release state with documented semantic thresholds, not only schema-valid transport success.
- `[ ]` **Modify**: Require every repo-level scope doc to state whether it is delivering Stage 1 decision API work, Stage 2 closed-loop optimizer work, or Stage 3 autonomous operator work.

## Validation Plan

- Architecture decision records for each authority decision.
- Cross-repo schema fixtures and compatibility tests.
- Staging replay of representative events through the full loop.
- Security review of agentic action execution.
- Privacy review of AI payloads and retention.
- Operational readiness review before enabling agent execution in production.
