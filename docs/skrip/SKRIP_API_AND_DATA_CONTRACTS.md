# Skrip API and Data Contracts

## 1. Contract Versioning Strategy

- All contracts are versioned under `/v1`.
- Breaking changes require `/v2` routes and schema copies.
- All request and response payloads use strict schema validation.
- Unknown fields are rejected on signed system-to-system routes.

## 2. Authentication and Signing

### Headers required on Visibility-Marketing to Skrip requests

```http
Authorization: Bearer <service-token>
X-VM-Tenant-Id: tenant_acme
X-VM-Correlation-Id: corr_01JTSKRIP123
X-VM-Timestamp: 2026-05-01T12:00:00.000Z
X-VM-Nonce: nonce_01JTSKRIP123
X-VM-Signature: sha256=<hex-hmac>
Content-Type: application/json
```

Signing base string:

```text
<http-method>\n<path>\n<iso-timestamp>\n<nonce>\n<sha256-body>
```

Validation rules:

- Timestamp drift max: `5 minutes`
- Nonce uniqueness window: `15 minutes`
- Invalid signature: `401`
- Timestamp drift exceeded: `401`
- Replay nonce: `409`

## 3. Visibility-Marketing to Skrip Contracts

### 3.1 Upsert contact channel identity

Endpoint:

```http
POST /v1/contacts/upsert
```

Request:

```json
{
  "tenantId": "tenant_acme",
  "externalContactId": "contact_12345",
  "canonicalId": "skrip_can_98765",
  "profile": {
    "email": "alex@example.com",
    "phoneE164": "+14155550123",
    "firstName": "Alex",
    "lastName": "Rivera",
    "locale": "en-US",
    "timezone": "America/Los_Angeles"
  },
  "channels": {
    "push": {
      "eligible": true,
      "consentState": "opted_in",
      "subscriptions": [
        {
          "subscriptionId": "push_sub_01",
          "endpoint": "https://fcm.googleapis.com/fcm/send/abc",
          "p256dh": "base64-key",
          "auth": "base64-auth",
          "userAgent": "Chrome/135"
        }
      ]
    },
    "sms": {
      "eligible": true,
      "consentState": "unknown"
    },
    "whatsapp": {
      "eligible": false,
      "consentState": "not_provided"
    },
    "telegram": {
      "eligible": false,
      "consentState": "not_linked"
    }
  },
  "source": {
    "system": "visibility-marketing",
    "occurredAt": "2026-05-01T12:00:00.000Z"
  }
}
```

Response:

```json
{
  "ok": true,
  "version": "v1",
  "contact": {
    "tenantId": "tenant_acme",
    "externalContactId": "contact_12345",
    "canonicalId": "skrip_can_98765",
    "state": "active",
    "updatedAt": "2026-05-01T12:00:01.100Z"
  }
}
```

### 3.2 Send single channel message

Endpoint:

```http
POST /v1/messages/send
```

Request:

```json
{
  "version": "v1",
  "tenantId": "tenant_acme",
  "campaignId": "cmp_growth_q2",
  "journeyId": "journey_trial_reengage",
  "stepId": "step_push_01",
  "contact": {
    "externalContactId": "contact_12345",
    "canonicalId": "skrip_can_98765"
  },
  "channel": "push",
  "policy": "push_primary_with_email_fallback",
  "schedule": {
    "mode": "scheduled",
    "scheduledFor": "2026-05-01T12:05:00.000Z",
    "scheduleSlot": "2026-05-01T12:05Z"
  },
  "idempotencyKey": "tenant_acme:cmp_growth_q2:step_push_01:contact_12345:push:2026-05-01T12:05Z",
  "correlationId": "corr_01JTSKRIP123",
  "message": {
    "intent": "trial_recovery",
    "templateKey": "push.trial.recover.v1",
    "title": "Your site still has fixable wins",
    "body": "Open Visibility to see the latest actions.",
    "data": {
      "ctaUrl": "https://visibility.clodo.dev/action",
      "reportId": "rpt_123"
    }
  },
  "fallback": {
    "enabled": true,
    "fallbackChannel": "email",
    "fallbackAfterSeconds": 7200
  },
  "metadata": {
    "tenantTier": "growth",
    "sourceSystem": "visibility-marketing"
  }
}
```

Response:

```json
{
  "ok": true,
  "version": "v1",
  "message": {
    "messageId": "msg_01JTSKRIP123",
    "skripOutboundId": "skrip_out_01JTSKRIP123",
    "providerRef": null,
    "status": "accepted",
    "acceptedAt": "2026-05-01T12:00:01.450Z"
  }
}
```

### 3.3 Bulk or broadcast send

Endpoint:

```http
POST /v1/messages/bulk
```

Request:

```json
{
  "version": "v1",
  "tenantId": "tenant_acme",
  "campaignId": "cmp_product_launch",
  "stepId": "step_sms_announce",
  "channel": "sms",
  "schedule": {
    "mode": "immediate",
    "scheduleSlot": "2026-05-01T12:00Z"
  },
  "message": {
    "intent": "launch_announcement",
    "templateKey": "sms.launch.v1",
    "body": "Visibility has shipped multichannel journeys. Reply YES for a walkthrough."
  },
  "audience": [
    {
      "externalContactId": "contact_1",
      "canonicalId": "skrip_can_1",
      "idempotencyKey": "tenant_acme:cmp_product_launch:step_sms_announce:contact_1:sms:2026-05-01T12:00Z"
    },
    {
      "externalContactId": "contact_2",
      "canonicalId": "skrip_can_2",
      "idempotencyKey": "tenant_acme:cmp_product_launch:step_sms_announce:contact_2:sms:2026-05-01T12:00Z"
    }
  ],
  "correlationId": "corr_01JTBULK123"
}
```

Response:

```json
{
  "ok": true,
  "version": "v1",
  "batch": {
    "batchId": "batch_01JTBULK123",
    "accepted": 2,
    "rejected": 0,
    "acceptedAt": "2026-05-01T12:00:02.100Z"
  }
}
```

### 3.4 Message status lookup

Endpoint:

```http
GET /v1/messages/{messageId}
```

Response:

```json
{
  "ok": true,
  "version": "v1",
  "message": {
    "messageId": "msg_01JTSKRIP123",
    "skripOutboundId": "skrip_out_01JTSKRIP123",
    "providerRef": "provider_445566",
    "status": "delivered",
    "channel": "push",
    "lastOutcomeAt": "2026-05-01T12:00:10.000Z"
  }
}
```

## 4. Skrip to Visibility-Marketing Contracts

### 4.1 Normalized outcome callback

Endpoint:

```http
POST /webhooks/skrip/v1/outcomes
```

Request:

```json
{
  "version": "v1",
  "eventId": "evt_01JTOUTCOME123",
  "eventType": "message.tapped",
  "tenantId": "tenant_acme",
  "contactId": "contact_12345",
  "canonicalId": "skrip_can_98765",
  "campaignId": "cmp_growth_q2",
  "journeyId": "journey_trial_reengage",
  "stepId": "step_push_01",
  "channel": "push",
  "messageId": "msg_01JTSKRIP123",
  "skripOutboundId": "skrip_out_01JTSKRIP123",
  "providerRef": "provider_445566",
  "occurredAt": "2026-05-01T12:00:10.000Z",
  "sourceSystem": "skrip",
  "correlationId": "corr_01JTSKRIP123",
  "reason": null,
  "metadata": {
    "device": "web",
    "destination": "browser",
    "linkUrl": "https://visibility.clodo.dev/action"
  }
}
```

Success response:

```json
{
  "ok": true,
  "accepted": true,
  "eventId": "evt_01JTOUTCOME123",
  "processedAt": "2026-05-01T12:00:11.000Z"
}
```

### 4.2 Pull sync alternative

Endpoint:

```http
GET /v1/outcomes?cursor=cursor_123&limit=500
```

Response:

```json
{
  "ok": true,
  "version": "v1",
  "cursor": "cursor_124",
  "items": [
    {
      "eventId": "evt_01JTOUTCOME123",
      "eventType": "message.delivered",
      "tenantId": "tenant_acme",
      "contactId": "contact_12345",
      "channel": "push",
      "messageId": "msg_01JTSKRIP123",
      "occurredAt": "2026-05-01T12:00:06.000Z",
      "sourceSystem": "skrip",
      "correlationId": "corr_01JTSKRIP123"
    }
  ]
}
```

## 5. Normalized Outcome Taxonomy

Supported `eventType` values:

- `message.accepted`
- `message.sent`
- `message.delivered`
- `message.read`
- `message.tapped`
- `message.failed`
- `message.replied`
- `message.suppressed`
- `message.dropped`

Visibility-Marketing must map provider-specific statuses into this taxonomy before reporting.

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