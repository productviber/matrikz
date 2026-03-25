# Visibility Platform Implementation Backlog

Status model:
- `[ ]` not started
- `[-]` in progress
- `[x]` complete

Access lanes (earmarked):
- **Admin access**: privileged operational and financial actions.
- **User access**: end-user and affiliate self-service actions.
- **System access**: trusted worker-to-worker and webhook ingestion paths.
- **Agentic access**: machine/automation actions used by internal agents and scripted operations.

## 1) Security & Access Control (Risk-first)

### Admin access lane
- `[x]` Replace scattered token checks with centralized guard in all admin handlers.
- `[x]` Add token rotation procedure and dual-token rollover support.
- `[x]` Add audit logs for denied admin attempts with request fingerprint.

### User access lane
- `[x]` Replace query-param identity on affiliate endpoints with signed token/session.
- `[x]` Unify `verifyAffiliate` logic across portal and GDPR routes.
- `[x]` Add replay/nonce window for user-sensitive actions (GDPR export/delete).

### System access lane
- `[x]` Add explicit system access guard for event ingestion (`/events`).
- `[x]` Add explicit webhook ingress guard with optional strict secret enforcement.
- `[x]` Add request timestamp and anti-replay verification for events.

### Agentic access lane
- `[x]` Add agentic token lane (disabled unless configured).
- `[ ]` Define which endpoints are agent-eligible and explicitly deny all others.
- `[ ]` Add narrow-scoped agent permissions and operation-level audit metadata.

## 2) Critical Fixes

- `[x]` Fix unsubscribe SQL column mismatch (`to_email` -> `contact_email`).
- `[x]` Restrict campaign detail endpoint (`GET /api/campaigns/:slug`) to intended lane.
- `[x]` Add webhook signature verification for Brevo payloads.
- `[x]` Ensure analytics internal endpoints require system or admin access.

## 3) Performance & Scalability

- `[x]` Refactor payout batch generation to avoid per-affiliate sequential KV/DB fan-out (single grouped DB read + parallel KV fetches).
- `[x]` Optimize A/B stats endpoint KV fanout (batched parallel KV reads + defensive payload parsing).
- `[ ]` Split cron email processing into bounded concurrency worker units.
- `[ ]` Add queue/backpressure strategy for burst webhook traffic.

## 4) Maintainability

- `[x]` Split `routes/admin.ts` into domain modules (dashboard, outbound, campaigns, contacts).
- `[x]` Split `lib/email.ts` into renderer, scheduler, provider, and orchestration modules.
	- Completed slices: extracted A/B helpers to `src/lib/email/ab.ts`, template-context prep to `src/lib/email/context.ts`, provider transport to `src/lib/email/provider.ts`, and renderer/templates to `src/lib/email/renderer.ts`; `lib/email.ts` now remains orchestration-only.
- `[ ]` Consolidate auth/access helpers into one library and remove duplicate checks.
- `[ ]` Standardize error envelope with code, message, and correlation ID.

## 5) Analytics Package Hardening

- `[x]` Replace hardcoded analytics/user/site payloads with DB-backed logic.
- `[x]` Add auth checks for analytics API routes and internal routes.
- `[x]` Add analytics test suite and CI workflow coverage (unit tests + package workflow).
- `[x]` Add analytics package CI workflow parity with marketer.

## 6) Testing & CI

- `[x]` Add tests for access-lane guard behavior (admin/user/system/agentic).
- `[ ]` Add negative tests for webhook and system endpoint spoofing.
- `[ ]` Add migration/schema consistency test for SQL column references.
- `[ ]` Add cross-worker contract tests for marketer <-> analytics APIs.

## Route Ownership Matrix (initial)

Admin access:
- `/api/admin/*`
- `/api/payouts/*`
- `/api/affiliate/:code/payout-details`
- `/api/campaigns` (create/list/update)

User access:
- `/api/affiliate/portal`
- `/api/affiliate/stats`
- `/api/affiliate/gdpr/export`
- `/api/affiliate/gdpr/delete`
- `/api/unsubscribe`

System access:
- `/events`
- `/webhooks/brevo`
- `/webhooks/brevo/inbound`

Agentic access (proposed, gated by token):
- `/api/admin/emails/process`
- `/api/admin/campaigns/outbound/:id/start`
- `/api/admin/campaigns/outbound/:id/pause`

## Immediate Next Slice

- `[x]` Introduce shared access library and wire to `/events` and webhook ingress.
- `[x]` Add tests for the new access layer.
- `[x]` Enforce campaign detail endpoint ownership decision.