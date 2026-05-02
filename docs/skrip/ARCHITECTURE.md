# Skrip Integration — Architecture Reference

## Module Map

All Skrip-specific code lives under `packages/marketer/src/lib/skrip/` and adjacent route files.

```
src/
  lib/
    skrip/
      signing.ts       — HMAC-SHA256 request signing and webhook verification
      flags.ts         — Progressive enablement flags (KV-backed per tenant/campaign/channel)
      router.ts        — Send authority resolution + idempotency key construction
      client.ts        — Signed HTTP client for Skrip API with circuit breaker + retries
      outbox.ts        — Outbox staging helpers (enqueue eligible channel identities)
      dispatcher.ts    — Outbox dispatcher: claim → send → lineage → DLQ
      registration.ts  — Contact channel registration + reconciliation
  routes/
    skrip-push.ts      — POST /api/push/subscribe, DELETE /api/push/unsubscribe
    webhooks-skrip.ts  — POST /webhooks/skrip/v1/outcomes
    admin/
      skrip.ts         — GET /api/admin/outbound/skrip/diagnostics
                         POST /api/admin/outbound/skrip/dispatch
                         POST /api/admin/outbound/skrip/reconcile
                         GET  /api/admin/outbound/skrip/lineage
scripts/
  skrip-replay-dlq.mjs — Operational: trigger DLQ replay via admin API
  skrip-reconcile.mjs  — Operational: trigger identity reconciliation via admin API
tests/
  unit/
    skrip-signing.test.ts
    skrip-outbox.test.ts
    skrip-dispatcher.test.ts
    skrip-registration.test.ts
    skrip-diagnostics.test.ts
    skrip-webhook.test.ts
    skrip-push.test.ts
  fixtures/
    skrip/
      contact-upsert-request.json
      contact-upsert-response.json
      message-send-request.json
      message-send-response.json
      outcome-webhook-payload.json
      push-subscribe-request.json
migrations/
  0013_skrip_integration_foundation.sql
docs/
  skrip/
    ARCHITECTURE.md              ← this file
    SKRIP_INTEGRATION_BLUEPRINT.md
    SKRIP_API_AND_DATA_CONTRACTS.md
    RUNBOOKS.md
    NEXT_STEPS_TODO.md
    adr/
      ADR-001-skrip-send-authority.md
      ADR-002-canonical-identity-and-event-envelope.md
      ADR-003-outbox-dlq-and-replay.md
```

---

## Data Flow

### Outbound (marketing → Skrip)

```
Event arrives (prospect enriched / campaign step due)
  ↓
channel-orchestrator.ts
  └─ enqueueEligibleSkripChannels()         [outbox.ts]
       ↓ contact_channel_identities (consent check)
       ↓ resolveSkripExecutionDecision()     [router.ts]
           ↓ channel_authorities (authority + rollout_state)
           ↓ getSkripFlagSnapshot()          [flags.ts]
       ↓ INSERT channel_execution_outbox    status = dry_run | pending
                                            idempotency_key = deterministic

Cron (every minute via wrangler.toml) OR POST /api/admin/outbound/skrip/dispatch
  └─ dispatchOutboxBatch()                  [dispatcher.ts]
       ↓ SELECT pending rows (skip dry_run)
       ↓ client.sendMessage()               [client.ts → Skrip /v1/messages/send]
       ↓ UPDATE outbox → dispatched
       ↓ INSERT channel_message_lineage    latest_status = accepted
       └─ on failure:
            attempt_count < MAX_RETRIES → UPDATE outbox → retrying (backoff)
            attempt_count ≥ MAX_RETRIES → UPDATE outbox → failed
                                         INSERT channel_outcome_dead_letter
```

### Inbound (Skrip → marketing)

```
Skrip POSTs to /webhooks/skrip/v1/outcomes
  └─ handleSkripOutcomeWebhook()            [webhooks-skrip.ts]
       ↓ verifySkripSignature()             HMAC check
       ↓ nonce replay check                 (KV)
       ↓ UPSERT channel_message_lineage    latest_status = delivered | failed | …
       └─ on validation failure:
            INSERT channel_outcome_dead_letter
```

### Push Subscription

```
Browser calls POST /api/push/subscribe
  └─ handlePushSubscribe()                  [skrip-push.ts]
       ↓ INSERT push_opt_in_events          event_type = subscribed
       ↓ registerContactChannel()           [registration.ts]
           ↓ INSERT contact_channel_identities  registration_state = pending
           ↓ client.registerContact()       [client.ts → Skrip /v1/contacts/upsert]
           ↓ UPDATE contact_channel_identities  canonical_id, registration_state = registered
           └─ if Skrip down: row stays pending, reconciled by cron
```

---

## Rollout State Machine

Authority rows in `channel_authorities` control which engine sends:

| rollout_state | Behaviour |
|---|---|
| `disabled` | Nothing staged or sent |
| `dry_run` | Outbox rows written with status `dry_run`, never dispatched |
| `enabled` | Rows written as `pending`, dispatched by cron |
| `rollback` | New rows not staged; existing pending rows cancelled |

Transitions should go:  
`disabled → dry_run (48h+) → enabled`  
with rollback available at any step.

---

## Feature Flags (KV)

KV keys (prefix `skrip_flag:`):

| Key | Meaning |
|---|---|
| `skrip_flag:tenant:{id}` | Per-tenant master switch |
| `skrip_flag:tenant:{id}:campaign:{slug}` | Per-campaign override |
| `skrip_flag:tenant:{id}:channel:{channel}` | Per-channel override |

Values: `true` / `false` / `enabled` / `disabled`. Absent key = falls back to `SKRIP_DEFAULT_ENABLEMENT` env var.

---

## Circuit Breaker (KV)

The client maintains a per-tenant circuit breaker in KV:

- `skrip_failure:{tenant}` — failure counter (expires in 24h)
- `skrip_circuit:{tenant}` — open-until epoch (expires after `CIRCUIT_OPEN_TTL_SECS`)

When `failure_count ≥ CIRCUIT_FAILURE_THRESHOLD` the circuit opens and all sends are blocked for `CIRCUIT_OPEN_TTL_SECS` seconds. The counter resets on a successful send.

---

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `SKRIP_BASE_URL` | Yes (for live sends) | Base URL of Skrip API |
| `SKRIP_SERVICE_TOKEN` | Yes | Bearer token for API calls |
| `SKRIP_SIGNING_SECRET` | Yes | HMAC secret for outgoing request signatures |
| `SKRIP_WEBHOOK_SIGNING_SECRET` | Yes | HMAC secret for incoming webhook verification |
| `SKRIP_DEFAULT_ENABLEMENT` | No | Global flag default (`true`/`false`), defaults `false` |
| `SKRIP_TIMEOUT_MS` | No | HTTP timeout override, defaults `10000` |

---

## Admin API Reference

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/outbound/skrip/diagnostics` | Configuration, flag snapshot, outbox by status, recent rows, DLQ count |
| POST | `/api/admin/outbound/skrip/dispatch` | Trigger outbox dispatch sweep (`?batchSize=25&preview=true`) |
| POST | `/api/admin/outbound/skrip/reconcile` | Register pending channel identities (`?batchSize=50`) |
| GET | `/api/admin/outbound/skrip/lineage` | Message lineage (`?tenantId=&campaignId=&channel=&limit=50`) |

---

## Operational Scripts

```
# Replay DLQ rows (staging / prod catch-up)
node packages/marketer/scripts/skrip-replay-dlq.mjs \
  --url https://marketer.example.workers.dev \
  --token $ADMIN_TOKEN

# Dry-run preview before actual replay
node packages/marketer/scripts/skrip-replay-dlq.mjs \
  --url https://marketer.example.workers.dev \
  --token $ADMIN_TOKEN --dryRun

# Reconcile pending contact identities
node packages/marketer/scripts/skrip-reconcile.mjs \
  --url https://marketer.example.workers.dev \
  --token $ADMIN_TOKEN --batchSize 100
```

---

## Testing

```
# All Skrip unit tests
npm exec vitest run \
  tests/unit/skrip-signing.test.ts \
  tests/unit/skrip-outbox.test.ts \
  tests/unit/skrip-dispatcher.test.ts \
  tests/unit/skrip-registration.test.ts \
  tests/unit/skrip-diagnostics.test.ts \
  tests/unit/skrip-webhook.test.ts \
  tests/unit/skrip-push.test.ts \
  tests/unit/channel-orchestrator.test.ts
```

---

## Migration

Apply to D1 before any live traffic reaches the new routes:

```
wrangler d1 migrations apply visibility-marketer-db --env production
```

Migration file: `packages/marketer/migrations/0013_skrip_integration_foundation.sql`
