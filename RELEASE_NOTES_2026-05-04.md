# Release Notes - 2026-05-04

## Release Scope

Hardening, environment parity, deployment closure, and Productviber repository activation for the Matrikz growth-agent system.

## Included Changes

- Completed growth-agent hardening updates across auth, guards, telemetry, errors, routes, and Workers AI adapter.
- Added and stabilized unit/integration test coverage for degraded paths, guards, metadata, and worker behavior.
- Added visibility-marketing worker package and integration/e2e coverage in this workspace.
- Updated Cloudflare Wrangler environment topology for development, staging, and production in both workers.
- Added explicit environment-level AI binding declarations for growth-agent environments.
- Removed plaintext INTERNAL_SECRET from visibility-marketing Wrangler vars and enforced secret-only runtime handling.
- Corrected visibility service bindings to explicit environment worker names:
  - development -> growth-agent-dev
  - staging -> growth-agent-staging
  - production -> growth-agent-production

## Deployment Outcomes

All six target deployments are active:

- https://growth-agent-dev.wetechfounders.workers.dev
- https://growth-agent-staging.wetechfounders.workers.dev
- https://growth-agent-production.wetechfounders.workers.dev
- https://visibility-marketing-dev.wetechfounders.workers.dev
- https://visibility-marketing-staging.wetechfounders.workers.dev
- https://visibility-marketing-production.wetechfounders.workers.dev

## Runtime Verification

- growth-agent /health passed on dev, staging, production.
- growth-agent /internal/capabilities passed on dev, staging, production with valid auth and correlation headers.
- visibility-marketing POST smoke reached growth-agent in all environments and returned controlled envelope fallbacks consistent with current feature-flag posture.

## Security and Ops Notes

- INTERNAL_SECRET uploaded to all envs for both workers via Wrangler secrets.
- .dev.vars protected through .gitignore.
- Correlation ID format for internal capability calls is enforced as {tenantId}:{uuid-v4}.

## Repository Activation

- Working delivery source path is d:/coding/matrikz (non-git workspace).
- Canonical release repository path is d:/coding/matrikz-productviber.
- Remote: https://github.com/productviber/matrikz.git

## Known Follow-ups

- Standardize bootstrap/install flow for the full Productviber monorepo workspace package set if local verification is required in a fresh clone.
- Keep production capability flags disabled until go-live approval.

## Post-Release Revalidation

An additional end-to-end revalidation pass was completed after release publication.

- Test gate rerun in source workspace:
  - `npm run verify` passed
  - growth-agent: 57 tests passed
  - visibility-marketing: 20 tests passed
- Deploy gate rerun:
  - growth-agent dev/staging/production deployed
  - visibility-marketing dev/staging/production deployed
- Runtime smoke gate rerun:
  - growth-agent `/health` passed in all environments
  - growth-agent `/internal/capabilities` passed in all environments
  - visibility-marketing `POST /` returned valid envelopes in all environments
