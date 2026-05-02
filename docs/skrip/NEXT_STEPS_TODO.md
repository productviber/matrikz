# Skrip Integration Todo

Status model:
- `[ ]` not started
- `[-]` in progress
- `[x]` complete

## 1. Phase 0 Foundation

- `[x]` Add schema for channel authority, canonical identity, outbox, lineage, DLQ, and push opt-in events.
- `[x]` Add Skrip signing, client wrapper, feature-flag resolution, and authority resolution primitives.
- `[x]` Add signed Skrip outcomes webhook with replay protection and lineage persistence.
- `[x]` Add admin diagnostics for Skrip configuration, authority state, outbox counts, and DLQ counts.
- `[x]` Add dry-run-safe outbox staging from the existing channel orchestration boundary.
- `[x]` Add outbox dispatcher (`src/lib/skrip/dispatcher.ts`) with retry backoff and DLQ.
- `[x]` Add contact registration and reconciliation (`src/lib/skrip/registration.ts`).
- `[x]` Add browser push subscription capture (`src/routes/skrip-push.ts`).
- `[x]` Add admin endpoints: dispatch trigger, reconcile trigger, lineage viewer.
- `[x]` Wire dispatcher and reconciliation into the cron scheduled handler.
- `[x]` Add contract fixtures under `tests/fixtures/skrip/`.
- `[x]` Add operational scripts: `scripts/skrip-replay-dlq.mjs`, `scripts/skrip-reconcile.mjs`.
- `[x]` Add focused unit tests for dispatcher, registration, push routes, outbox staging, signing, diagnostics, and webhook ingress.
- `[ ]` Apply migration `0013_skrip_integration_foundation.sql` to staging and production D1 databases.

## 2. Dispatch and Routing

- `[ ]` Add dispatcher to claim `channel_execution_outbox` rows in bounded batches.
- `[ ]` Add dispatcher rule to skip `dry_run` rows and only process `pending` rows.
- `[ ]` Add deterministic retry policy for failed Skrip dispatches with bounded exponential backoff.
- `[ ]` Add message-lineage write on successful Skrip send acceptance.
- `[ ]` Add dead-letter path for repeated dispatch failures.

## 3. Identity and Registration

- `[ ]` Add contact registration helper to push `contact_channel_identities` into Skrip `/v1/contacts/upsert`.
- `[ ]` Add reconciliation job to repair missing `canonical_id` or `provider_ref` values.
- `[ ]` Add admin or internal endpoint to inspect a contact's channel identity state.

## 4. Product Surface

- `[ ]` Add browser push subscription capture endpoint and D1 logging for prompt funnel events.
- `[ ]` Add campaign editor support for channel policy selection.
- `[ ]` Add journey action type `send_via_skrip` with template intent and scheduling options.
- `[ ]` Add contact timeline rendering for normalized Skrip outcomes.

## 5. Operations and Readiness

- `[ ]` Add dashboards for outbox by status, webhook lag, duplicate prevention, and DLQ depth.
- `[ ]` Add runbook-backed replay tooling for outcome ingestion gaps.
- `[ ]` Add local and staging migration application checklist.
- `[ ]` Add release criteria for push-only pilot gate.

## 6. Immediate Next Sprint Slice

- `[x]` Wire dry-run outbox staging at the existing outbound orchestration boundary.
- `[x]` Add dispatcher implementation behind a separate feature gate.
- `[x]` Add contact registration and push subscription capture path.
- `[x]` Add contract tests for Skrip request and outcome payloads.
- `[ ]` Apply DB migration 0013 to staging — run `wrangler d1 migrations apply visibility-marketer-db`.
- `[ ]` Set `channel_authorities` rows for `push` channel to `dry_run` state for initial pilot tenant.
- `[ ]` Monitor outbox status counts via diagnostics endpoint for 48h before promoting to `enabled`.
- `[ ]` Promote pilot tenant push to `enabled` rollout state after validation.