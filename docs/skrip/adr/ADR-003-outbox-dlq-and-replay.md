# ADR-003: Reliable Delivery Uses Outbox, DLQ, and Replay

## Status

Accepted

## Context

External send requests and webhook outcomes can fail independently of local database updates. Without a durable delivery model, the system cannot guarantee idempotent dispatch, safe retries, or auditability.

## Decision

Visibility-Marketing will persist all Skrip-bound send intents in a local outbox before dispatch. Incoming outcome events that cannot be processed safely will be stored in a DLQ with replay metadata. Replay tooling is required before channel rollout.

## Consequences

- Send intents survive worker retries and partial outages.
- Outcome ingestion failures do not silently drop attribution data.
- Rollback and reconciliation can be performed deterministically.

## Rejected alternatives

- Fire-and-forget direct calls to Skrip from journey execution: rejected because it cannot prove delivery or replay safely.
- Logging failures only in KV or console: rejected because it is not sufficient for durable operations.