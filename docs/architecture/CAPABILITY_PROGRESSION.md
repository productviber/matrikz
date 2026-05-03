# Capability Progression and Expectations

Date: 2026-03-24

This document records what changed in the recent hardening pass, which prior working behavior was replaced or refactored, and what operational expectations now apply.

## Why This Exists

- Preserve context for future maintainers on security and runtime behavior progression.
- Clarify what is now mandatory in production versus optional in older docs.
- Make external setup expectations explicit (secrets, owners, and value flow).

## High-Level Progression

The platform moved from a mostly functional baseline to an explicit, fail-fast, auditable model with stronger auth boundaries.

- Before: partial/optional auth patterns, mixed route-level checks, and looser startup validation.
- After: centralized auth wrappers, signed user context for analytics APIs, structured errors, production secret validation, and shared observability hooks.

## Capability Delta by Area

### 1) Service and Admin/Auth Hardening

- Replaced/Refactored:
  - Ad-hoc token checks and duplicated auth helpers.
  - Non-constant-time token matching patterns.
- Improved To:
  - Centralized auth wrappers in `packages/marketer/src/lib/auth.ts`.
  - Timing-safe token comparison in `packages/marketer/src/lib/access.ts`.
  - Single access-decision authority for route lanes.
- Expectation:
  - All protected routes should use shared auth/access utilities, not custom inline checks.

### 2) Analytics End-User API Identity

- Replaced/Refactored:
  - Weak/implicit user identity assumptions for `/api/auth/me` and `/api/sites`.
- Improved To:
  - HMAC-signed user headers (`x-user-id`, `x-user-ts`, `x-user-sig`) verified by analytics.
  - New secret dependency: `ANALYTICS_USER_AUTH_SECRET`.
- Expectation:
  - Callers must send valid, fresh signed headers for those endpoints.
  - Unsigned or invalid signatures return unauthorized.

### 3) Error Handling and Runtime Safety

- Replaced/Refactored:
  - Inconsistent error surfaces across routes.
- Improved To:
  - Structured application error classes in `packages/marketer/src/lib/errors.ts`.
  - Centralized error-to-response mapping used by marketer runtime entry.
- Expectation:
  - New route features should throw mapped error types to keep error semantics consistent.

### 4) Observability and Incident Traceability

- Replaced/Refactored:
  - Sparse route-level logging and inconsistent event context.
- Improved To:
  - Shared observability helper in `packages/marketer/src/lib/observability.ts`.
  - Event logging in webhooks, event router, payouts, and cron paths.
- Expectation:
  - Security-sensitive or async batch routes should emit structured events.

### 5) Throughput and Concurrency Control

- Replaced/Refactored:
  - Primarily serial processing in selected email/payout flows.
- Improved To:
  - Bounded worker-pool helper in `packages/marketer/src/lib/concurrency.ts`.
  - Controlled parallelism where safe (warm sends, payout operations).
- Expectation:
  - Parallelism should always be bounded; avoid unbounded `Promise.all` fan-out on large datasets.

### 6) Route Contract Clarity

- Replaced/Refactored:
  - Missing or ambiguous behavior for some unimplemented analytics routes.
- Improved To:
  - Explicit `501 Not Implemented` for `POST /api/v1/events/click`.
- Expectation:
  - Intentionally incomplete endpoints should return explicit contract status, not accidental 404/500 behavior.

## wrangler.toml Impact (What Changed and Why)

Changes in `packages/analytics/wrangler.toml` and `packages/marketer/wrangler.toml` are primarily operational documentation and expectation-setting for secrets.

- They document required secrets for production runtime behavior.
- They do not themselves store secret values.
- Secret values are injected externally using Cloudflare Worker secrets.

For exact provisioning commands by worker/environment, see `SECRETS_RUNBOOK.md`.

## External Actions Required

Set secrets in each worker environment before production deploy.

### Analytics Worker

File: `packages/analytics/wrangler.toml`

Required secrets:

- `SYSTEM_TOKEN`
- `ADMIN_TOKEN`
- `ANALYTICS_USER_AUTH_SECRET`

### Marketer Worker

File: `packages/marketer/wrangler.toml`

Required secrets:

- `ADMIN_TOKEN`
- `ADMIN_TOKEN_ROLLOVER`
- `SYSTEM_TOKEN`
- `SYSTEM_TOKEN_ROLLOVER`
- `AGENT_TOKEN`
- `AGENT_TOKEN_ROLLOVER`
- `WEBHOOK_TOKEN`
- `WEBHOOK_TOKEN_ROLLOVER`
- `AFFILIATE_AUTH_SECRET`
- `WEBHOOK_SIGNING_SECRET`
- `EMAIL_API_KEY`
- `SLACK_WEBHOOK_URL`
- `DISCORD_WEBHOOK_URL`

Provider-specific payouts (only if selected):

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `STRIPE_SECRET_KEY`

## Where Values Come From and Where They Go

- Comes from:
  - Internal security/token generation process.
  - Third-party provider consoles (email, payout, chat/webhooks).
- Stored in:
  - Cloudflare Worker secrets per worker and environment.
- Loaded at runtime as:
  - `env.<SECRET_NAME>` in worker code.
- Used by:
  - Access control middleware/wrappers.
  - Signature verification and anti-replay logic.
  - External provider API clients.

## Production Expectations

- Production should fail fast on missing mandatory auth secrets.
- Signed user context must be present for hardened analytics user endpoints.
- Route-lane auth should remain centralized and timing-safe.
- Observability logs should be present for high-risk ingestion and batch operations.

## Verification Signals

Validation completed after this hardening pass:

- Analytics: typecheck, tests, and build passed.
- Marketer: typecheck, tests, and build passed.

## Related Files

- `packages/analytics/src/index.ts`
- `packages/analytics/tests/unit/api.test.ts`
- `packages/marketer/src/lib/access.ts`
- `packages/marketer/src/lib/auth.ts`
- `packages/marketer/src/lib/errors.ts`
- `packages/marketer/src/lib/observability.ts`
- `packages/marketer/src/lib/concurrency.ts`
- `packages/marketer/src/routes/payouts.ts`
- `packages/marketer/src/lib/email.ts`
- `packages/marketer/src/routes/webhooks.ts`
- `packages/marketer/src/events/router.ts`
- `packages/analytics/wrangler.toml`
- `packages/marketer/wrangler.toml`