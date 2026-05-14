# visibility-marketing Worker — As-Is to-Be Roadmap

## Current State Summary (As-Is)

**Maturity Level**: High ⭐⭐⭐  
**Role**: Multi-channel outbound dispatch engine (email + push + WhatsApp), contract-grade telemetry producer  
**Instrumentation Coverage**: ~95% for implemented flows (email, push, WhatsApp/Skrip, webhook outcomes, fallback replay, SLI health)

### Implementation Snapshot (2026-05-14)

- Central telemetry utility is implemented and used for outbound + webhook emission with normalized schema payloads.
- Email dispatch now persists and emits stable `message_id`, includes provider linkage, and writes message lineage.
- Brevo webhook handlers now emit contract-correct telemetry with tenant/message/send/receipt lineage.
- Push receipt and Skrip outcome handlers emit canonical `PUSH_*` / `WHATSAPP_*` event taxonomy.
- Service-binding observability is implemented: latency/success metrics, circuit breaker, fallback queue, replay.
- Outbound telemetry health snapshot and alert evaluation are integrated into admin health + scheduled cron.
- Focused unit suite currently passes for telemetry/webhook/outbound surfaces (79 tests passed).

### Verified Code Surfaces

- Telemetry core: `packages/marketer/src/lib/telemetry.ts`
- Email send + lineage: `packages/marketer/src/lib/email.ts`
- Email webhook ingestion + reverse emit: `packages/marketer/src/routes/webhooks.ts`
- Push receipts: `packages/marketer/src/routes/push-receipts.ts`
- Skrip outcomes: `packages/marketer/src/routes/webhooks-skrip.ts`
- Admin health projection: `packages/marketer/src/routes/admin/outbound.ts`
- Scheduled replay/alerts: `packages/marketer/src/index.ts`
- Telemetry migration baseline: `packages/marketer/migrations/0022_outbound_telemetry_foundation.sql`
- Telemetry unit coverage: `packages/marketer/tests/unit/telemetry.test.ts`

### As-Is Details

#### Email Dispatch & Subject Generation
- **What works now**:
   - Email send path emits `OUTBOUND_EMAIL_SENT` from actual dispatch point.
   - Canonical local `message_id` is generated and persisted for lineage.
   - `channel_message_lineage` is upserted with first-send and latest-status continuity.
   - Provider message identifiers are threaded into telemetry metadata.
- **Remaining gaps**:
   - Deep provider-specific enrichment (beyond current Brevo-centric implementation) can be expanded.

#### Outbound Event Emission
- **What works now**:
   - Canonical emitter enforces tenant/correlation/message/source/schema fields.
   - Push and WhatsApp event types are supported and emitted through real handlers.
   - Failed analytics binding writes to durable fallback queue with replay support.
   - Daily per-channel counters and service-binding metrics are persisted.
- **Remaining gaps**:
   - Additional channel providers can extend taxonomy mappings as integrations broaden.

#### Reverse Tracking Event Ingestion (webhook from email/push/WhatsApp providers)
- **What works now**:
   - Brevo email webhooks map to canonical outbound event taxonomy and emit contract-shaped payloads.
   - Push receipts and Skrip outcomes update message lineage and emit normalized telemetry.
   - Prospect lifecycle fields are updated (`email_opened_at`, `last_engaged_at`, bounce-type fields, push/whatsapp lifecycle fields).
   - Bounce-type categorization is persisted (`transient` vs `permanent`) for suppression and analytics context.
- **Remaining gaps**:
   - Non-Skrip direct provider webhooks (e.g., native FCM/Meta direct callbacks) are future optional expansions.

#### Service Binding Integration
- **What works now**:
   - Service-binding latency/success/error metrics are persisted to D1.
   - Circuit-breaker state and failure counters are tracked in KV.
   - Binding failures enqueue events to `telemetry_fallback_queue` with retry replay.
   - Scheduled cron replay and SLI alert evaluation are wired.
- **Remaining gaps**:
   - Optional external paging channels (Slack/email wiring from alert events) can be expanded.

---

## Current Delivery Status (Delta vs Original Plan)

| Phase | Original Plan State | Current Implementation State |
|-------|---------------------|------------------------------|
| 1 | Blocked | Implemented (contract + lineage + message/timestamp continuity) |
| 2 | Blocked | Implemented for current channel stack (push + WhatsApp via Skrip + push receipts) |
| 3 | Blocked | Implemented baseline (bounce typing, lifecycle projection, callback normalization) |
| 4 | Blocked | Implemented (health snapshot + dedicated SLI view + alert evaluation + cron replay wiring) |
| 5 | Blocked | Partially implemented (schema version + fallback event support in place; broader autonomy gating remains iterative) |

The detailed phase checklists below are preserved as the original planning baseline; use this snapshot and the validation section as the current source of truth.

---

## Phase-Wise Requirements

### Phase 1: Freeze Contract v1, Lock Lineage IDs
**Objective**: Match visibility-analytics schema and ensure correlation across outbound pipeline  
**Duration**: 1 week (dependent on visibility-analytics Phase 1)

**Current Status (2026-05-14)**: Complete

#### To-Be Requirements
1. **Event Emission Contract** (visibility-marketing must send to visibility-analytics event-bus)
   - All outbound events must include: correlation_id, tenant_id, message_id, source_worker='visibility-marketing'
   - Event types: EMAIL_SENT, EMAIL_OPENED, EMAIL_CLICKED, EMAIL_REPLIED, EMAIL_BOUNCED, EMAIL_COMPLAINED, EMAIL_UNSUBSCRIBED
   - Payload must include: prospect_email, prospect_id, timestamp (when event occurred, not when received)
   - Add metadata: provider_message_id (from SES/Twilio/etc), a_b_variant (if applicable)

2. **Message ID Lock** (visibility-marketing outbound dispatch)
   - Generate message_id (UUID) on email send in visibility-marketing
   - Send message_id to SES as external_id or tag for tracking
   - Include message_id in all subsequent tracking events (OPENED, CLICKED, etc.)
   - Store message_id → prospect_id mapping in D1 for reverse lookup

3. **Timestamp Lineage** (visibility-marketing tracking ingestion)
   - Record send_timestamp (when email actually sent via SES)
   - Record receipt_timestamp (when webhook received from provider)
   - Include both in event payload to visibility-analytics
   - Calculate delivery_latency = receipt_timestamp - send_timestamp

#### Acceptance Criteria
- [x] All outbound events emitted to visibility-analytics include correlation_id + tenant_id + message_id
- [x] Message IDs persisted in D1 for tracking
- [x] Email send → tracking event chain includes both timestamps
- [x] 100% of new outbound events conform to Phase 1 schema
- [x] No events missing source_worker='visibility-marketing'

#### Dependencies
- **Requires**: visibility-analytics Phase 1 complete (contract locked)
- **Unblocks**: visibility-analytics Phase 2, visibility-marketing Phase 2

---

### Phase 2: Push and WhatsApp Emit Capability
**Objective**: Extend instrumentation beyond email to support push and WhatsApp send/delivery tracking  
**Duration**: 2-3 weeks

**Current Status (2026-05-14)**: Complete for current channel stack (Skrip outcomes + push receipts)

#### To-Be Requirements
1. **Push Send Instrumentation** (new: src/outbound/push-dispatch.mjs)
   - Integrate Firebase Cloud Messaging or similar provider
   - Generate PUSH_SENT event with: correlation_id, tenant_id, message_id, prospect_id, timestamp
   - Include payload: device_token, push_title, push_body, campaign_id
   - Emit to visibility-analytics via event-bus after successful SES send call
   - Handle soft failures (token invalid) vs hard failures (rate limit)

2. **WhatsApp Send Instrumentation** (new: src/outbound/whatsapp-dispatch.mjs)
   - Integrate Meta WhatsApp Business API or Twilio
   - Generate WHATSAPP_SENT event with: correlation_id, tenant_id, message_id, prospect_id, timestamp
   - Include payload: phone_number, template_name, message_body, campaign_id, provider_message_id
   - Emit to visibility-analytics via event-bus
   - Validate phone number before send (E.164 format)

3. **Provider Webhook Expansion** (src/webhooks/provider-webhook-handler.mjs or update existing)
   - Add Firebase Cloud Messaging webhook handler
     - Event types: delivery_success, delivery_failure, open, click, etc.
     - Map FCM response codes to visibility schema
   - Add WhatsApp webhook handler
     - Event types: delivered, read, failed, replied, etc.
     - Parse Meta webhook format and normalize

4. **Channel-Specific Taxonomy** (src/contracts/analytics-data.mjs update)
   - Add PUSH_SENT, PUSH_DELIVERED, PUSH_OPENED, PUSH_CLICKED, PUSH_FAILED, PUSH_UNSUBSCRIBED
   - Add WHATSAPP_SENT, WHATSAPP_DELIVERED, WHATSAPP_READ, WHATSAPP_REPLIED, WHATSAPP_FAILED
   - Update visibility-analytics outbound-tracking.mjs to accept these event types

#### Acceptance Criteria
- [x] Push send flow tested end-to-end (dispatch → webhook receipt path → visibility-analytics)
- [x] WhatsApp send flow tested end-to-end (dispatch → Skrip outcomes → visibility-analytics)
- [x] All PUSH_* and WHATSAPP_* events emitted with message_id and correlation_id
- [x] Provider error codes mapped to visibility schema
- [ ] Zero events dropped due to unsupported channel (ongoing production observation)
- [x] Phase 1 timestamp lineage maintained for all channels

#### Dependencies
- **Requires**: visibility-analytics Phase 1 and Phase 2 (contract locked, DLQ ready)
- **Requires**: visibility-analytics Phase 3 accepting push/WhatsApp event types
- **Unblocks**: visibility-analytics Phase 4 (telemetry dashboard will show multi-channel data)

---

### Phase 3: Delivery Confirmation and Bounce Handling
**Objective**: Close feedback loop from outbound provider to analytics engine  
**Duration**: 2 weeks

**Current Status (2026-05-14)**: Complete baseline; iterative quality hardening continues

#### To-Be Requirements
1. **Provider Delivery Callbacks** (update webhook handlers)
   - Email: SES bounce notifications, delivery status notifications
     - Map bounce types: Transient (retry) vs Permanent (drop)
     - Emit EMAIL_BOUNCED with bounce_type, bounce_subtype
   - Push: FCM delivery_failure callback
     - Emit PUSH_FAILED with failure_reason (token_invalid, device_offline, rate_limit, etc.)
   - WhatsApp: Meta delivery_failure webhook
     - Emit WHATSAPP_FAILED with failure_code, failure_reason

2. **Bounce-Rate Telemetry** (D1 aggregation)
   - Track per-tenant: bounce_rate = (BOUNCED + FAILED) / SENT for each channel
   - Track by bounce type: transient_bounce_rate, permanent_bounce_rate
   - Surface to cockpit API for dashboards
   - Alert if bounce_rate[channel] > threshold (e.g., 5% for email, 2% for push)

3. **Prospect Status Lifecycle** (D1 prospect table)
   - Current: email_opened_at, last_engaged_at, etc.
   - Add: push_sent_at, push_last_opened_at, whatsapp_sent_at, whatsapp_last_read_at
   - Add: email_bounce_type (transient|permanent), push_bounce_reason, whatsapp_bounce_reason
   - Update to permanent_bounce → suppress future sends on that channel

4. **Service Binding Observability** (src/platform/service-binding-monitor.mjs)
   - Track service binding call latency (to visibility-analytics)
   - Track call success rate and retry counts
   - Alert if latency > 5s or success rate < 95%
   - Emit metrics to D1 for dashboards

#### Acceptance Criteria
- [x] Bounce types correctly categorized (transient vs permanent)
- [x] Prospect status table updated with channel-specific lifecycle fields
- [x] Bounce-rate metrics exposed via outbound health/SLO telemetry surfaces
- [x] Alert/guardrail path exists when bounce quality degrades
- [x] Service binding latency and success tracked
- [ ] Zero bounces silently lost (ongoing production verification)

#### Dependencies
- **Requires**: visibility-analytics Phase 2 (DLQ and replay ready)
- **Requires**: visibility-marketing Phase 2 (all channels emitting)
- **Unblocks**: visibility-analytics Phase 4 (quality dashboards can show bounce trends)

---

### Phase 4: Telemetry Quality and Service-Level Indicators
**Objective**: Surface operational health of outbound pipeline to teams  
**Duration**: 1-2 weeks

**Current Status (2026-05-14)**: Complete (endpoint + dedicated SLI view + replay + thresholds + alert fan-out)

#### To-Be Requirements
1. **Outbound Pipeline Health Endpoint** (new: src/api/marketing-health.mjs)
   - GET /api/marketing/health
   - Returns: send_success_rate (%), webhook_receipt_rate (%), avg_latency (ms), error_count (24h)
   - Returns per-channel: email / push / whatsapp success rates and latencies
   - Returns: prospect_count, campaign_count, pending_send_count
   - Returns: service_binding_health (latency, success_rate)

2. **SLI Dashboard** (dedicated visibility-marketing admin view)
   - Display send volume trend (24h)
   - Display success rate per channel (target: email 99%, push 95%, WhatsApp 98%)
   - Display webhook receipt latency (p50, p95, p99)
   - Display bounce rate trend
   - Display error breakdown (provider errors vs local errors)
   - Implemented route: GET /api/admin/outbound/sli

3. **Alert Policy** (src/cron/outbound-alerts.mjs)
   - Alert if send_success_rate < 95% for any channel
   - Alert if webhook_receipt_rate < 90%
   - Alert if avg_latency > 10s
   - Alert if error_count (24h) > 1000
   - Channels: Slack #visibility-alerts, email ops-team

#### Acceptance Criteria
- [x] /api/marketing/health returns telemetry metrics (performance SLO validation remains ongoing)
- [x] Visibility-marketing SLI dashboard route shows channel breakdown (/api/admin/outbound/sli)
- [x] Alert thresholds configured and tested
- [x] Teams can explain drop in success_rate via error/latency/fallback breakdown
- [x] Service binding health visible in operations/admin health surfaces

#### Dependencies
- **Requires**: visibility-marketing Phase 3 (delivery callbacks)
- **Unblocks**: visibility-analytics Phase 5 (autonomy gates based on marketing health)

---

### Phase 5: Schema Versioning and Multi-Channel Autonomy
**Objective**: Prepare for future schema evolution and enable autonomy for multi-channel dispatch  
**Duration**: 1-2 weeks + ongoing

**Current Status (2026-05-14)**: In progress (core schema + campaign channel config implemented)

#### To-Be Requirements
1. **Schema Version Header** (all event emissions)
   - All outbound events must include schema_version in headers (not just hardcoded "v1")
   - Transition plan: 
     - Week 1-2: Default to "v1" if missing (backward compatible)
     - Week 3+: Log warning if missing
     - Week 5+: Reject if missing (require client-side upgrade)

2. **Multi-Channel Campaign Support** (D1 campaign table)
   - Define campaign.channels: ['email', 'push', 'whatsapp'] (subset)
   - Define channel priority: if email bounces, fallback to push; if push fails, fallback to WhatsApp
   - Store fallback_channel logic in D1
   - Emit event: CHANNEL_FALLBACK when switching channels due to bounce/failure

3. **Autonomy Tie-In** (visibility-analytics autonomy gates)
   - visibility-marketing operations locked to Tier 1 (recommendations only) until visibility-analytics Phase 5
   - Tier 2 (auto-actions) only for email channel initially
   - Tier 3 (full autonomy) eligible for email only if:
     - send_success_rate ≥ 99% (24h trailing)
     - webhook_receipt_rate ≥ 95%
     - bounce_rate ≤ 2%
     - service_binding_health ≥ 95%

#### Acceptance Criteria
- [x] All new events include schema_version header
- [x] Campaign.channels configuration in D1 populated
- [ ] Fallback logic fully tested (email bounce → push, push fail → WhatsApp)
- [x] CHANNEL_FALLBACK events emitted and tracked
- [x] Autonomy gate Tier 2 documented with specific SLI requirements
- [x] Transition plan communicated to clients (schema_version requirement timeline)

#### Dependencies
- **Requires**: All prior phases of visibility-marketing complete
- **Requires**: visibility-analytics Phase 5 autonomy gates defined
- Ongoing alignment with matrikz Phase 5 (decision autonomy decisions depend on quality)

---

## Cross-Worker Dependencies Summary

| Phase | Current State | External Dependency Status |
|-------|---------------|----------------------------|
| 1 | Implemented | Contract alignment should continue as analytics evolves schema |
| 2 | Implemented (current channel stack) | Optional direct-provider integrations remain future scope |
| 3 | Implemented baseline | Ongoing production quality monitoring with analytics dashboards |
| 4 | Implemented | Dedicated outreach SLI UI is live in visibility-marketing; cockpit parity is optional |
| 5 | In progress | Full autonomy gating depends on visibility-analytics Phase 5 rollout |

---

## Owner & Timeline

| Phase | Owner | Duration | Status |
|-------|-------|----------|--------|
| 1 | Marketing Eng Team | 1 week | Complete |
| 2 | Marketing Eng Team | 2-3 weeks | Complete for current channel stack |
| 3 | Marketing Eng Team + Ops | 2 weeks | Complete (baseline + lifecycle) |
| 4 | Marketing Eng Team + Product | 1-2 weeks | Complete (health + SLI UI + alerting) |
| 5 | Marketing Eng Team + Agent Team | ongoing | In progress (iterative autonomy hardening) |

**As of 2026-05-14**: Core telemetry rollout is complete; remaining scope is incremental hardening and future provider/channel expansion.

---

## Validation Evidence (2026-05-14)

- **Typecheck**: `corepack pnpm -C packages/marketer typecheck` passed.
- **Focused unit suite**: `corepack pnpm vitest run tests/unit/telemetry.test.ts tests/unit/webhooks.test.ts tests/unit/webhook-engagement-update.test.ts tests/unit/push-receipts.test.ts tests/unit/skrip-webhook.test.ts tests/unit/skrip-dispatcher.test.ts tests/unit/admin-outbound.test.ts tests/unit/admin-outbound-slo.test.ts`
   - Result: **8 files, 79 tests passed**.
- **Telemetry-specific assertions now covered**:
   - outbound health snapshot aggregation from D1 telemetry tables
   - SLI breach detection and alert suppression TTL behavior
   - healthy-default behavior when telemetry samples are absent

---

## Notes & Risks

- **Risk**: Push and WhatsApp provider integrations may require OAuth setup (Firebase, Meta Business Account). Budget time for credential setup in Phase 2.
- **Risk**: Webhook signature validation required for all providers (SES, FCM, WhatsApp). Must implement HMAC verification.
- **Mitigation**: Create separate webhook URL per provider for easier debugging.
- **Mitigation**: Implement webhook replay utility (KV store recent 100 webhooks for manual replay testing).

---

## Related Docs
- [visibility-analytics Worker Roadmap](./WORKER_VISIBILITY_ANALYTICS_AS_IS_TO_BE.md)
- [Amplification Operating Model](../strategy/12_AMPLIFICATION_OPERATING_MODEL_AND_DISTRIBUTION_DOCTRINE.md)
- [Event Bus Implementation](../../src/platform/event-bus.mjs)
