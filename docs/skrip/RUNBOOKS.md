# Skrip Integration Runbooks

## 1. Incident Runbook

### Trigger conditions

- Send success rate drops below `99.9%`
- Outcome lag p95 exceeds `60s`
- Duplicate send rate exceeds `0.1%`
- Webhook signature validation failures spike
- DLQ depth grows continuously for 15 minutes

### Triage sequence

1. Check channel authority and rollout flags for impacted tenant or campaign.
2. Check outbox queue depth and retry exhaustion counts.
3. Check circuit breaker state for Skrip client.
4. Check signed webhook acceptance rate and DLQ entries.
5. Check whether impact is channel-specific or tenant-wide.

### Immediate mitigations

1. Disable affected channel authority for the impacted cohort.
2. Pause outbox dispatcher if duplicate sends or severe failures are observed.
3. Preserve webhook ingestion to close lineage on already-sent messages.
4. Snapshot current outbox and DLQ state before manual replay.

## 2. Replay Runbook

### Replay from DLQ

1. Query `channel_outcome_dead_letter` for retryable events.
2. Replay oldest-first with fixed concurrency and audit logging.
3. Re-validate signature semantics only when replaying original payloads externally.
4. Mark `replayed_at` and persist the result.

### Replay from pull sync

1. Start from last successful cursor.
2. Pull outcomes in pages of 500.
3. Upsert by `eventId` to guarantee idempotency.
4. Stop only after lag is back within SLO.

## 3. Rollback Runbook

### Preconditions

- Incident commander assigned.
- Tenant or campaign scope identified.
- Email fallback posture confirmed.

### Steps

1. Set rollout state to `rollback` for the affected tenant and channel.
2. Disable Skrip dispatcher for the affected channel.
3. Reject creation of new Skrip-bound outbox rows for that scope.
4. Preserve already-created rows for audit unless explicit purge is approved.
5. Continue processing inbound outcomes for already-sent messages.
6. Confirm no new outbound requests hit Skrip.

### Verification

- Outbox rows stop advancing to `dispatched`.
- No new Skrip message IDs are created after cutoff.
- Existing email journeys keep operating.

## 4. Credential Rotation Runbook

1. Generate new service auth secret and webhook signing secret.
2. Add rollover values to Visibility-Marketing and Skrip.
3. Deploy both systems with dual-secret validation.
4. Shift outbound signing to the new primary secret.
5. Verify request and webhook validation success.
6. Remove old secret after overlap window expires.

## 5. Release Checklist

- ADRs approved.
- Contract schemas frozen for the target release.
- D1 migrations applied and verified.
- Feature flags default to disabled.
- Dashboards and alerts live.
- Rollback drill completed.
- Staging pilot roundtrip passed.
- Email regression suite passed.

## 6. Production Validation Checklist

- Pilot tenant authority points to Skrip only for intended channels.
- Push subscription registration succeeds end-to-end.
- Signed webhook events are accepted and stored.
- Outcome lag dashboard reports healthy values.
- DLQ remains empty or within expected baseline.
- Duplicate send rate remains below threshold.
- Admin dashboard reflects the same counts as lineage tables.