# Skrip API and Data Contracts

## Implementation Status

✅ **Phase 2 Route Surface Complete**: All v1 routes implemented and registered in `src/index.ts`.
- Error envelope middleware: `src/lib/api/error-envelope.ts`
- Message routes: `src/routes/v1/messages.ts` (4 endpoints)
- Contact routes: `src/routes/v1/contacts.ts` (3 endpoints)
- All routes require tenant context middleware (`tenantMiddleware`)
- All routes return stable error envelopes with v1RequestId and correlation ID

✅ **VM Integration Harness Available** (Visibility-Marketing):
- Signed client wrapper: `packages/marketer/src/lib/skrip/client.ts`
- Outbox + dispatcher + webhook wiring: `packages/marketer/src/lib/skrip/outbox.ts`, `packages/marketer/src/lib/skrip/dispatcher.ts`, `packages/marketer/src/routes/webhooks-skrip.ts`
- End-to-end roundtrip test: `packages/marketer/tests/integration/skrip-phase2-roundtrip.test.ts`

## 1. Contract Versioning Strategy

- All contracts are versioned under `/v1`.
- Breaking changes require `/v2` routes and schema copies.
- All request and response payloads use strict schema validation (Zod).
- Unknown fields are rejected on signed system-to-system routes.
- Request ID tracking: `x-request-id` header (or auto-generated) sets `v1RequestId` on response.

## 2. Authentication and Signing

### Skrip-to-Visibility-Marketing Requests (Signed Webhooks)

Skrip sends outcome callbacks to Marketing with HMAC-SHA256 signatures.

- **Signature method**: `HMAC-SHA256(webhookSecret, JSON.stringify({ event, timestamp }))`
- **Verification**: `verifyWebhookSignature(payload, timestamp, signature, webhookSecret, maxAgeSeconds)`
  - Timestamp drift max: `5 minutes`
  - Available in `src/lib/outcomes/webhooks.ts`

### Visibility-Marketing-to-Skrip Requests

Skrip v1 routes require tenant context (via middleware). Visibility-Marketing now calls Skrip with a signed client wrapper (`packages/marketer/src/lib/skrip/client.ts`) that sends:

- bearer auth (`Authorization`),
- tenant header (`x-tenant-id`),
- request signature headers (`x-skrip-timestamp`, `x-skrip-nonce`, `x-skrip-signature`),
- correlation header (`x-correlation-id`),
- retry + circuit-breaker guards.

## 3. Visibility-Marketing to Skrip Contracts

### Response Envelope (All endpoints)

All responses use a stable error envelope:

```json
{
  "ok": true,
  "requestId": "req_01J...",
  "data": {}
}
```

On error:

```json
{
  "ok": false,
  "error": {
    "code": "UNPROCESSABLE",
    "message": "Identity resolution failed",
    "requestId": "req_01J...",
    "correlationId": "corr_01J..."
  }
}
```

Error codes: `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `UNPROCESSABLE`, `INTERNAL`, `SERVICE_UNAVAILABLE`.

### 3.1 Upsert contact channel identity

Endpoint:

```http
POST /v1/contacts/upsert
```

**Implementation**: `src/routes/v1/contacts.ts`

Request schema (Zod validated):

```json
{
  "tenantId": "tenant_acme",
  "identifiers": [
    {
      "type": "push_endpoint|phone|email|wa_phone|tg_chat_id|device_fingerprint|cookie_id",
      "value": "string"
    }
  ],
  "contactId": "optional_contact_id",
  "source": "api_upsert",
  "metadata": {}
}
```

Response (201 if new contact, 200 otherwise):

```json
{
  "ok": true,
  "requestId": "req_01J...",
  "data": {
    "canonicalId": "skrip_can_98765",
    "isNew": true,
    "confidence": 1.0,
    "method": "deterministic",
    "mergedFrom": [],
    "identifiersMapped": 1
  }
}
```

### 3.2 Manufacture preview

Endpoint:

```http
POST /v1/messages/manufacture
```

**Implementation**: `src/routes/v1/messages.ts`

Request schema:

```json
{
  "tenantId": "tenant_acme",
  "canonicalId": "skrip_can_98765",
  "channel": "push|whatsapp|telegram|sms",
  "trigger": {
    "type": "string",
    "id": "string",
    "data": {}
  },
  "messageType": "signal|vernacular",
  "manufacturingMode": "TEMPLATE_ONLY|TEMPLATE_PLUS_AI_FIELDS|FULL_LLM_MANUFACTURE"
}
```

Response:

```json
{
  "ok": true,
  "requestId": "req_01J...",
  "data": {
    "channel": "push",
    "manufacturingMode": "TEMPLATE_PLUS_AI_FIELDS",
    "usedFallback": false,
    "validationOutcome": "ok",
    "payload": {
      "title": "Seats filling fast",
      "body": "Book now",
      "actions": [{"action": "book", "title": "Book"}]
    },
    "modelMetadata": {
      "model": "claude-3-5-sonnet",
      "version": "2026-05-01"
    }
  }
}
```

### 3.3 Send single channel message

Endpoint:

```http
POST /v1/messages/send
```

**Implementation**: `src/routes/v1/messages.ts`

Request schema:

```json
{
  "tenantId": "tenant_acme",
  "canonicalId": "skrip_can_98765",
  "channel": "push|whatsapp|telegram|sms",
  "trigger": {
    "type": "flash_sale",
    "id": "trig_123",
    "data": {}
  },
  "messageType": "signal|vernacular",
  "manufacturingMode": "TEMPLATE_PLUS_AI_FIELDS",
  "idempotencyKey": "tenant_acme:contact_12345:2026-05-01T12:05Z",
  "campaignMetadata": {
    "campaignId": "cmp_growth_q2",
    "journeyId": "journey_trial_reengage",
    "stepId": "step_push_01"
  }
}
```

Response (idempotent, returns same messageId for duplicate requests):

```json
{
  "ok": true,
  "requestId": "req_01J...",
  "data": {
    "messageId": "msg_01J...",
    "idempotent": false,
    "status": "enqueued",
    "language": "en",
    "enqueued": true
  }
}
```

### 3.4 Bulk or broadcast send

Endpoint:

```http
POST /v1/messages/bulk
```

**Implementation**: `src/routes/v1/messages.ts`

Request schema:

```json
{
  "tenantId": "tenant_acme",
  "canonicalIds": ["skrip_can_1", "skrip_can_2"],
  "trigger": {
    "type": "flash_sale",
    "id": "trig_123",
    "data": {}
  },
  "messageType": "signal|vernacular",
  "manufacturingMode": "TEMPLATE_PLUS_AI_FIELDS",
  "workflowId": "workflow_123"
}
```

Response:

```json
{
  "ok": true,
  "requestId": "req_01J...",
  "data": {
    "total": 2,
    "enqueued": 2,
    "skipped": 0
  }
}
```

**Rate limit**: 10 requests/hour per tenant.

### 3.5 Message status lookup

Endpoint:

```http
GET /v1/messages/{messageId}
```

**Implementation**: `src/routes/v1/messages.ts`

Response:

```json
{
  "ok": true,
  "requestId": "req_01J...",
  "data": {
    "messageId": "msg_01J...",
    "status": "sent|delivered|failed",
    "sent_at": "2026-05-01T12:00:06.000Z",
    "delivered_at": null,
    "engaged_at": null,
    "failed_at": null,
    "retry_count": 0
  }
}
```

### 3.6 Contact lookup by ID

Endpoint:

```http
GET /v1/contacts/{id}
```

**Implementation**: `src/routes/v1/contacts.ts`

Response:

```json
{
  "ok": true,
  "requestId": "req_01J...",
  "data": {
    "canonicalId": "skrip_can_98765",
    "language": "en",
    "phone": "+14155550123",
    "email": "alex@example.com",
    "createdAt": "2026-05-01T12:00:01.000Z"
  }
}
```

### 3.7 Channel eligibility for contact

Endpoint:

```http
GET /v1/contacts/{externalId}/channels
```

**Implementation**: `src/routes/v1/contacts.ts`

Response:

```json
{
  "ok": true,
  "requestId": "req_01J...",
  "data": {
    "canonicalId": "skrip_can_98765",
    "channels": {
      "push": {
        "reachable": true,
        "count": 1
      },
      "sms": {
        "reachable": false,
        "count": 0
      }
    }
  }
}
```

## 4. Skrip to Visibility-Marketing Contracts

### Signed Webhook Payload

Skrip sends outcomes via signed webhooks to Marketing. Implementation in `src/lib/outcomes/webhooks.ts`.

Webhook request to Marketing:

```http
POST /webhooks/skrip/v1/outcomes
Content-Type: application/json
X-Skrip-Signature: sha256=<hex-hmac>
X-Skrip-Timestamp: 2026-05-01T12:00:10.000Z
```

Payload:

```json
{
  "event": {
    "event": "message.delivered",
    "messageId": "msg_01J...",
    "tenantId": "tenant_acme",
    "canonicalId": "skrip_can_98765",
    "channel": "push",
    "providerRef": "fcm_ref_123",
    "occurredAt": "2026-05-01T12:00:10.000Z",
    "requestId": "req_01J...",
    "campaignId": "cmp_growth_q2",
    "workflowId": "workflow_123",
    "detail": null,
    "telemetry": {
      "promptHash": "sha256_abc...",
      "promptVersion": "1.0",
      "modelVersion": "claude-3-5-sonnet-2026-05-01",
      "budgetTier": 1,
      "manufacturingMode": "FULL_LLM_MANUFACTURE",
      "usedFallback": false,
      "domainKey": "generic"
    }
  },
  "timestamp": "2026-05-01T12:00:11.000Z",
  "signature": "abc123...",
  "retryCount": 0
}
```

**Signature verification** (in Marketing):

```typescript
import { verifyWebhookSignature } from 'skrip-client';

const valid = await verifyWebhookSignature(
  JSON.stringify(payload.event),
  payload.timestamp,
  payload.signature,
  webhookSecret,
  300 // 5 minutes max drift
);
```

## 5. Normalized Outcome Event Types

Skrip normalizes provider outcomes into standardized event types. Implementation in `src/lib/outcomes/contract.ts`.

Supported `event` values (OutcomeEventType):

- `message.accepted` — Message accepted by Skrip queue
- `message.sent` — Provider accepted for delivery
- `message.delivered` — Provider confirms delivery to contact
- `message.failed` — Provider delivery failed (terminal)
- `message.opened` — Contact opened/read message (if provider supports)
- `message.clicked` — Contact tapped a link in the message
- `message.replied` — Contact replied to the message
- `message.unsubscribed` — Contact opted out via this channel

**Telemetry fields included in every event**:

- `promptHash`: SHA-256 hash of the generated prompt (for debugging)
- `promptVersion`: Version of the prompt template used
- `modelVersion`: LLM model and version (e.g., "claude-3-5-sonnet-2026-05-01")
- `budgetTier`: Tenant budget tier (1/2/3) at time of generation
- `manufacturingMode`: Mode used (TEMPLATE_ONLY, TEMPLATE_PLUS_AI_FIELDS, FULL_LLM_MANUFACTURE)
- `usedFallback`: Boolean; whether fallback content was used
- `domainKey`: Domain pack used (e.g., "bus_booking", "generic")

## 6. Data Contract Specification

### 6.1 `channel_authorities`

```sql
CREATE TABLE channel_authorities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT,
  channel TEXT NOT NULL,
  authority TEXT NOT NULL,
  rollout_state TEXT NOT NULL,
  feature_flag_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, campaign_id, channel)
);
```

Rules:

- `authority` in `visibility_marketing`, `skrip`
- `rollout_state` in `disabled`, `dry_run`, `enabled`, `rollback`

### 6.2 `contact_channel_identities`

```sql
CREATE TABLE contact_channel_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  external_contact_id TEXT NOT NULL,
  canonical_id TEXT,
  channel TEXT NOT NULL,
  consent_state TEXT NOT NULL,
  suppression_state TEXT NOT NULL,
  availability_state TEXT NOT NULL,
  identity_confidence REAL NOT NULL DEFAULT 0,
  registration_state TEXT NOT NULL,
  last_reconciled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, external_contact_id, channel)
);
```

### 6.3 `channel_execution_outbox`

```sql
CREATE TABLE channel_execution_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  journey_id TEXT,
  step_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  schedule_slot TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  correlation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (idempotency_key)
);
```

### 6.4 `channel_message_lineage`

```sql
CREATE TABLE channel_message_lineage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  journey_id TEXT,
  step_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  message_id TEXT NOT NULL,
  skrip_outbound_id TEXT,
  provider_ref TEXT,
  idempotency_key TEXT NOT NULL,
  latest_status TEXT NOT NULL,
  first_sent_at INTEGER,
  last_outcome_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (message_id),
  UNIQUE (idempotency_key)
);
```

### 6.5 `channel_outcome_dead_letter`

```sql
CREATE TABLE channel_outcome_dead_letter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  retryable INTEGER NOT NULL DEFAULT 1,
  first_failed_at INTEGER NOT NULL,
  last_failed_at INTEGER NOT NULL,
  replayed_at INTEGER
);
```

### 6.6 `push_opt_in_events`

```sql
CREATE TABLE push_opt_in_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  contact_id TEXT,
  browser_session_id TEXT,
  event_type TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  metadata_json TEXT,
  occurred_at INTEGER NOT NULL
);
```

## 7. Deterministic Deduplication Key

Canonical format:

```text
tenantId + ":" + campaignId + ":" + stepId + ":" + contactId + ":" + channel + ":" + scheduleSlot
```

Example:

```text
tenant_acme:cmp_growth_q2:step_push_01:contact_12345:push:2026-05-01T12:05Z
```

## 8. Backfill and Reconciliation Scripts

Required scripts to implement in `packages/marketer/scripts`:

1. `skrip-backfill-identities.mjs`
   Reads existing contacts, derives external contact IDs, and seeds `contact_channel_identities`.

2. `skrip-reconcile-lineage.mjs`
   Compares local lineage rows to Skrip status lookups and repairs missing provider references or statuses.

3. `skrip-replay-outcomes.mjs`
   Replays rows from `channel_outcome_dead_letter` or from a pull-sync cursor.

4. `skrip-cutover-validate.mjs`
   Verifies authority registry, outbox drain status, webhook signing health, and pilot flags before go-live.