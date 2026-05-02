# Skrip Integration Blueprint

## 1. Executive Summary

Visibility-Marketing already acts as the campaign and growth orchestration layer for outbound email and analytics-driven lifecycle events. The target state is to preserve that role while delegating non-email channel execution to Skrip through an integration boundary that is tenant-safe, idempotent, observable, and rollback-ready.

Phase 1 keeps the existing email orchestration path intact. Visibility-Marketing remains the source of truth for campaigns, journey steps, eligibility, attribution, reporting, and optimization. Skrip becomes the execution authority for push first, then WhatsApp, SMS, and Telegram, while sending normalized outcomes back into Visibility-Marketing for attribution and learning loops.

The integration is intentionally additive. No existing email API or workflow is removed in phase 1. Instead, a Skrip Integration Service, canonical identity mapping, channel policy layer, reliable outbox delivery path, and signed outcome ingestion surface are introduced behind feature flags.

## 2. Current State Analysis

### Existing strengths

- Visibility-Marketing already has email orchestration in [packages/marketer/src/lib/email.ts](../../packages/marketer/src/lib/email.ts).
- Email provider transport is abstracted in [packages/marketer/src/lib/email/provider.ts](../../packages/marketer/src/lib/email/provider.ts).
- Email outcomes already flow in through [packages/marketer/src/routes/webhooks.ts](../../packages/marketer/src/routes/webhooks.ts).
- Admin outbound reporting and campaign operations exist in [packages/marketer/src/routes/admin/outbound.ts](../../packages/marketer/src/routes/admin/outbound.ts).
- Cross-worker eventing from analytics into marketer is already modeled in [packages/marketer/IO_CONTRACTS.md](../../packages/marketer/IO_CONTRACTS.md) and [packages/marketer/src/types.ts](../../packages/marketer/src/types.ts).

### Gaps versus target

1. The delivery stack is email-centric. There is no general multichannel execution boundary or send-authority registry.
2. Contact identity is implicit and mostly email-based. There is no canonical mapping between `tenantId`, `externalContactId`, and a Skrip `canonicalId`.
3. No outbox pattern exists for external channel execution requests or safe replay after partial failures.
4. Existing webhook handling is provider-specific. There is no normalized multichannel outcome ingestion contract.
5. Current observability is lightweight KV-backed event logging. There is no DLQ, outcome lag tracking, retry taxonomy, or end-to-end correlation model.
6. No channel policy model exists to express `email_only`, `push_assist`, `push_primary_with_email_fallback`, or `multi_channel_progressive`.
7. No feature-flag surface exists to enable Skrip by tenant, campaign, or channel.
8. No browser push subscription capture flow exists in marketer today.

### Architectural assumptions

- Visibility-Marketing remains the product surface for campaign setup, journey editing, reporting, and attribution.
- Skrip exposes authenticated APIs for contact channel registration, message sends, bulk sends, and status lookup.
- Skrip can emit signed outcome callbacks or support cursor-based pull sync.
- The integration is implemented in the marketer worker and uses the existing D1 and KV footprint unless queue infrastructure is later added.
- Tenancy must be explicit even if some current marketer flows are single-tenant or implicit today.

## 3. Future State Architecture

### Target topology

```text
Visibility-Marketing
  campaign intelligence + journey orchestration + eligibility + attribution
        |
        v
Skrip Integration Service
  routing + mapping + idempotency + retries + feature flags + outbox
        |
        v
Skrip
  push / WhatsApp / Telegram / SMS execution + AI message manufacturing
        |
        v
Visibility-Marketing
  normalized outcomes + contact timeline + reporting + optimization loops
```

### Core modules to add

1. `src/lib/skrip/client.ts`
   Purpose: signed HTTP wrapper, retries, bounded backoff, circuit breaker, status normalization.

2. `src/lib/skrip/adapter.ts`
   Purpose: map campaign or journey step payloads into Skrip contract payloads.

3. `src/lib/skrip/router.ts`
   Purpose: evaluate feature flags, channel policy, consent, suppression, and one-send-authority rules.

4. `src/lib/skrip/outbox.ts`
   Purpose: persist outbound execution intents, claim work, mark sent, replay safely.

5. `src/routes/webhooks-skrip.ts`
   Purpose: signed ingestion endpoint for normalized multichannel outcomes.

6. `src/lib/skrip/reconciliation.ts`
   Purpose: identity reconciliation, missed outcome replay, lineage repair.

7. `src/lib/feature-flags.ts`
   Purpose: progressive enablement by tenant, campaign, channel, and cohort.

### Proposed data model additions

1. `channel_authorities`
   Declares which system has execution authority per tenant, campaign, and channel.

2. `contact_channel_identities`
   Maps `tenant_id`, `external_contact_id`, `channel`, `canonical_id`, confidence, and registration state.

3. `journey_channel_policies`
   Stores campaign or journey-level routing policy, fallback rules, and allowlists.

4. `channel_execution_outbox`
   Reliable send queue with deterministic idempotency key and delivery state.

5. `channel_message_lineage`
   Tracks `campaign_id`, `journey_id`, `step_id`, `contact_id`, `skrip_outbound_id`, `provider_ref`, and status transitions.

6. `channel_outcome_dead_letter`
   Retains webhook processing failures for replay and forensics.

7. `push_opt_in_events`
   Captures `prompt_shown`, `permission_granted`, `subscription_registered`, `first_delivery`, and `first_tap`.

### One-send-authority rule

- Email authority remains Visibility-Marketing in phases 0-2.
- Push authority moves to Skrip during phase 1 pilot when feature flags enable it.
- WhatsApp, SMS, and Telegram authority move independently in phase 2 cohorts.
- Channel authority is resolved before any send is queued.
- If no authority is configured, the send is rejected with a typed routing error instead of falling through implicitly.

## 4. Detailed Implementation Plan By Phase

### Phase 0: Contract and schema alignment

Goal: create the integration boundary with no customer-facing routing change.

Owners:
- Platform architect: integration shape, ADRs, rollout gates
- Growth backend: marketer service changes
- Data engineering: schema and lineage model
- Security: auth and signing model
- SRE: observability and SLO dashboard design

Tasks:
- Add canonical event envelope and contract validation library.
- Add feature-flag model for tenant, campaign, and channel progressive rollout.
- Create D1 migrations for identity mapping, authority registry, outbox, lineage, and DLQ tables.
- Implement Skrip client wrapper with request signing, timestamp drift validation, retries, and circuit breaker.
- Implement no-op routing layer behind flags while email remains unchanged.
- Add admin diagnostics endpoint for channel authority and pending outbox health.
- Define contract tests against mocked Skrip API.

PR slices:
- PR-01: schema migrations and types
- PR-02: config, flags, signing, client wrapper
- PR-03: outbox primitives and observability scaffolding
- PR-04: contract docs and tests

Go or no-go:
- All schemas are deployed.
- Contract tests pass.
- No regression in email processing or existing webhook ingestion.
- Replay safety proven in staging.

### Phase 1: Push-only pilot

Goal: add first-class web push via Skrip for selected tenants and campaigns.

Owners:
- Frontend: browser push consent and subscription capture UI
- Growth backend: push registration and send action execution
- Data engineering: opt-in funnel metrics and attribution wiring
- QA: end-to-end pilot coverage

Tasks:
- Add browser push subscription capture flow in marketer UI.
- Register push subscriptions in Skrip with tenant and contact binding.
- Add campaign-level channel policy and `send_via_skrip` journey step.
- Implement immediate and scheduled push sends via outbox dispatcher.
- Add signed Skrip outcomes webhook and normalized mapping into analytics and contact timeline.
- Add pilot dashboards for push opt-in funnel and outcome lag.
- Add kill switch by tenant and by channel.

PR slices:
- PR-05: push subscription UI and API
- PR-06: contact registration + identity reconciliation
- PR-07: outbox dispatcher + push send path
- PR-08: outcome webhook + metrics + dashboards
- PR-09: pilot cohort config + operational runbooks

Go or no-go:
- Pilot tenants stay below `0.1%` duplicate sends.
- Outcome lag p95 stays below `60s` for 7 consecutive days.
- No regression in email throughput or bounce handling.
- Rollback dry run succeeds.

### Phase 2: WhatsApp, SMS, Telegram cohorts

Goal: add controlled multichannel rollout while keeping email authority unchanged.

Owners:
- Growth backend: channel adapters and routing rules
- Legal and compliance: consent and suppression enforcement
- SRE: channel-specific dashboards and alerts

Tasks:
- Extend eligibility model to channel availability, consent state, and suppression state.
- Add routing support for `push_assist`, `push_primary_with_email_fallback`, and `multi_channel_progressive`.
- Add channel-specific fallback rules and quiet-hour policies.
- Add attribution and incremental uplift dashboards versus email-only baseline.
- Add replay tooling for missed or delayed outcomes.

PR slices:
- PR-10: channel eligibility engine
- PR-11: WhatsApp adapter
- PR-12: SMS adapter
- PR-13: Telegram adapter
- PR-14: multichannel analytics and ROI dashboard

Go or no-go:
- Contract validation passes for every channel.
- Consent enforcement is verified in staging.
- Failure taxonomy coverage is complete.
- SLO alerts are live.

### Phase 3: Optional email convergence decision gate

Goal: decide whether email should remain local or converge into Skrip.

Decision inputs:
- Relative deliverability and revenue uplift.
- Operational complexity of dual execution paths.
- Feature parity for email templates, A/B logic, warmup, and compliance.
- Incident profile and rollback posture.

Decision outcomes:
- Keep email in Visibility-Marketing indefinitely.
- Move specific email cohorts into Skrip behind a separate authority flag.
- Converge fully only after parity and backout proof exist.

## 5. UI and UX Change List

1. Campaign editor: add `Channel policy` selector with the four supported policies.
2. Journey builder: add action type `send_via_skrip` with channel, intent, template key, schedule mode, and fallback settings.
3. Contact profile: add channel eligibility card showing consent, availability, suppression, and canonical identity state.
4. Admin outbound dashboard: add channel authority view, outbox health, DLQ count, and outcome lag widgets.
5. Reporting: preserve current campaign semantics while adding channel split and normalized outcome funnel.
6. Push onboarding UI: add browser permission prompt education, subscription status, and recovery messaging.
7. Contact timeline: add normalized multichannel events with correlation ID and provider references.

## 6. Observability and SLOs

### Standard event envelope

Every internal lifecycle event must carry:

```json
{
  "eventId": "evt_01J...",
  "eventType": "message.delivered",
  "tenantId": "tenant_acme",
  "contactId": "contact_123",
  "campaignId": "cmp_launch_q3",
  "stepId": "step_push_1",
  "channel": "push",
  "messageId": "msg_01J...",
  "occurredAt": "2026-05-01T12:00:00.000Z",
  "sourceSystem": "skrip",
  "correlationId": "corr_01J..."
}
```

### SLOs

- Send API success rate: `>= 99.9%`
- Outcome ingestion lag p95: `<= 60s`
- Duplicate send rate: `<= 0.1%`
- DLQ drain time p95: `<= 15m`

### Required dashboards

1. Channel delivery funnel by tenant, campaign, and channel.
2. Outcome lag p50, p95, p99.
3. Failure taxonomy by provider and normalized reason.
4. Retry volume, retry exhaustion, and DLQ depth.
5. Incremental uplift versus email-only baseline.
6. Push opt-in funnel.

### Alerts

- Circuit breaker open for Skrip client.
- Outcome lag above threshold for 10 minutes.
- Duplicate send rate above `0.1%` for any tenant.
- Signature validation failure spike.
- DLQ growth above tenant-specific threshold.

## 7. Security and Compliance Checklist

- Least-privilege service credentials per environment.
- HMAC request signing with nonce and timestamp drift checks.
- Secrets stored encrypted and rotated with overlap windows.
- Strict schema validation on inbound and outbound contracts.
- Tenant ID validated on every query, payload, and lineage row.
- Channel consent and suppression enforced before queuing sends.
- Replay protection on webhook callbacks.
- Audit trail retained for every send request and outcome transition.
- PII minimization in logs and dashboards.
- Documented deletion and suppression propagation path.

## 8. Risk Register With Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Dual-send during migration | High | Enforce one-send-authority registry and deterministic idempotency key |
| Identity mismatch between systems | High | Add canonical mapping table, confidence states, and reconciliation jobs |
| Outcome loss from webhook failures | High | Signed webhook ingestion, DLQ, replay tooling, lag alerts |
| Email regression from shared changes | High | Keep email path isolated, add explicit guardrails and regression suite |
| Channel consent drift | High | Centralize eligibility checks and store decision snapshots per send |
| Skrip outage | High | Circuit breaker, bounded retries, graceful degradation, kill switch |
| Analytics/reporting inconsistency | Medium | Normalized event schema and lineage table |
| UI complexity for marketers | Medium | Preserve existing semantics and add progressive disclosure |

## 9. Test Plan With Acceptance Criteria

### Unit

- Adapter mapping from campaign step to Skrip payload.
- Deterministic idempotency key generation.
- Signature generation and validation.
- Routing and fallback decisions.
- Channel eligibility decisions.

Acceptance criteria:
- All supported policies map to deterministic routing decisions.
- Duplicate inputs generate the same idempotency key.

### Integration

- Contact registration with Skrip.
- Single send and bulk send happy paths.
- Retries and circuit breaker activation.
- Outcome webhook processing and lineage persistence.
- Replay and reconciliation jobs.

Acceptance criteria:
- All `v1` contracts validate strictly.
- Failure modes persist enough state for replay.

### End-to-end

- Push subscription capture to first tap.
- Journey step `send_via_skrip` roundtrip.
- Campaign analytics reflect Skrip-delivered outcomes.
- Tenant-specific kill switch rollback.

Acceptance criteria:
- Contact timeline and campaign dashboard show the same normalized outcomes.
- Pilot rollback restores channel routing without manual data repair.

### Chaos and fault injection

- Skrip timeout or `5xx` burst.
- Delayed outcome callbacks.
- Duplicate callbacks.
- Partial D1 write failures during outcome processing.

Acceptance criteria:
- No duplicate sends beyond SLO.
- DLQ receives unrecoverable items.
- Replays are idempotent.

### Load

- Burst campaign enqueue.
- Webhook ingestion spikes.
- Reconciliation replay batches.

Acceptance criteria:
- p95 outcome lag remains within target under projected burst load.

## 10. Cutover and Rollback Playbook

### Cutover

1. Deploy schemas, client, flags, and observability with all Skrip routing disabled.
2. Validate contract tests and signed webhook verification in staging.
3. Enable push registration only for internal test tenant.
4. Enable `send_via_skrip` for pilot campaign and push channel only.
5. Confirm outcome roundtrip, lag, dashboards, and kill switch.
6. Expand to selected tenants with explicit owner approval.

### Immediate rollback

1. Disable channel authority flag for affected tenant or channel.
2. Stop outbox dispatchers for Skrip-bound messages.
3. Continue accepting delayed outcomes for lineage closure.
4. Drain or quarantine in-flight outbox rows.
5. Route future sends back to the prior authority only if explicitly configured.

Rollback success criteria:
- No further sends are dispatched to Skrip after cutoff.
- Existing email campaigns continue without config changes.
- Reporting remains internally consistent for already-sent messages.

## 11. Post-launch Optimization Roadmap

1. Add channel-specific send-time optimization using observed reply and tap curves.
2. Add message intent feedback loops from outcomes back into journey selection.
3. Add multichannel attribution models that distinguish assist versus primary conversion.
4. Evaluate optional email convergence only after parity and operational evidence exist.
5. Add per-tenant experimentation support for channel mix and fallback order.

## 12. Implementation PR Plan

| PR | Scope | Owner |
|---|---|---|
| PR-01 | Migrations for authority, identity, outbox, lineage, DLQ | Data engineering |
| PR-02 | Env vars, feature flags, request signing, Skrip client wrapper | Growth backend |
| PR-03 | Channel router and eligibility engine | Growth backend |
| PR-04 | Outbox dispatcher, retry policy, circuit breaker | Platform |
| PR-05 | Push subscription capture UI and APIs | Frontend |
| PR-06 | Skrip contact registration and reconciliation | Growth backend |
| PR-07 | `send_via_skrip` journey action and campaign policy plumbing | Growth backend |
| PR-08 | Signed outcomes webhook, DLQ, replay tooling | Platform |
| PR-09 | Dashboards, alerts, SLO instrumentation | SRE |
| PR-10 | Pilot rollout configs and cutover runbook drill | Platform + QA |

## 13. First 2-Week Sprint Plan

### Sprint objective

Land the non-invasive foundation for push-only pilot enablement without changing live email routing.

### Sprint backlog

Day 1-2:
- Finalize ADRs and `v1` contract schemas.
- Add environment variables for Skrip base URL, service auth secret, webhook signing secret, and feature flags.

Day 3-4:
- Add D1 migrations for `channel_authorities`, `contact_channel_identities`, `channel_execution_outbox`, `channel_message_lineage`, and `channel_outcome_dead_letter`.
- Add TypeScript row types and constants.

Day 5-6:
- Implement `src/lib/skrip/client.ts` with signing, retry, and circuit-breaker skeleton.
- Implement strict schema validation helpers for outbound and inbound contracts.

Day 7-8:
- Implement channel authority resolver and routing policy evaluator in dry-run mode.
- Add admin diagnostics endpoint for authority state, pending outbox rows, and DLQ depth.

Day 9-10:
- Add unit tests for idempotency key generation, routing policy evaluation, and signature validation.
- Add integration tests with mocked Skrip endpoints for contact upsert and send submit.

### Owners

- Platform architect: contract approval, rollout gates
- Growth backend: migrations, client wrapper, routing, tests
- SRE: dashboards and alert definitions
- QA: integration harness and pilot acceptance criteria

### Sprint exit criteria

- No changes to current email dispatch behavior.
- Contract docs merged and reviewed.
- Foundation schemas and client wrapper merged behind flags.
- Test suite green for the new integration slice.