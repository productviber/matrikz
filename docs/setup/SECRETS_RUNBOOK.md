# Secrets Runbook

Date: 2026-03-24

This runbook provides exact commands to provision required Cloudflare Worker secrets for both workers in `development` and `production`.

## Scope

- Worker: `visibility-analytics`
- Worker: `visibility-marketing`
- Environments: `development`, `production`

## Prerequisites

1. Wrangler is installed and authenticated.
2. You are in repo root: `d:\coding\clodo-dev-site\visibility-marketing`
3. You can access source values (internal token generator, provider consoles, vault).

## Interactive Script

Use the root orchestrator for guided setup:

```powershell
Set-Location d:\coding\clodo-dev-site\visibility-marketing

# Show planned secret names only (no writes)
.\scripts\setup-secrets.ps1 -Environment production -Worker both -ShowPlan

# Interactive provisioning
.\scripts\setup-secrets.ps1 -Environment production -Worker both
```

Legacy marketer entrypoint still works and delegates to the root script:

```powershell
Set-Location packages/marketer
.\scripts\setup-secrets.ps1 -Environment production
```

## Important Rules

- Do not place secrets in `wrangler.toml`.
- Use `wrangler secret put` for each worker and environment.
- Keep development and production values separate.
- Rollover secrets should be set before token rotation cutovers.

## Quick Reference: Where To Run Commands

- Analytics commands: run from `packages/analytics`
- Marketing commands: run from `packages/marketer`

## Analytics Worker Secrets

File context: `packages/analytics/wrangler.toml`

Required secrets:

- `SYSTEM_TOKEN`
- `ADMIN_TOKEN`
- `ANALYTICS_USER_AUTH_SECRET`

### Development

```powershell
Set-Location packages/analytics

wrangler secret put SYSTEM_TOKEN --env development
wrangler secret put ADMIN_TOKEN --env development
wrangler secret put ANALYTICS_USER_AUTH_SECRET --env development
```

### Production

```powershell
Set-Location packages/analytics

wrangler secret put SYSTEM_TOKEN --env production
wrangler secret put ADMIN_TOKEN --env production
wrangler secret put ANALYTICS_USER_AUTH_SECRET --env production
```

## Marketing Worker Secrets

File context: `packages/marketer/wrangler.toml`

Required core secrets:

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

AI Engine secrets (required when `AI_ENGINE` service binding is active):

- `INTERNAL_SECRET` — bearer token sent as `x-internal-secret` on AI Engine requests
- `INTERNAL_SECRET_ROLLOVER` — rotation support

Skrip integration secrets (required when receiving Skrip outcome webhooks or calling Skrip API):

- `SKRIP_SERVICE_TOKEN` — bearer token for outbound Skrip API calls (required when `SKRIP_BASE_URL` is set)
- `SKRIP_WEBHOOK_SIGNING_SECRET` — HMAC secret for verifying inbound Skrip outcome webhook payloads (falls back to `WEBHOOK_SIGNING_SECRET`)
- `SKRIP_SIGNING_SECRET` — optional HMAC for outbound signing to Skrip (falls back to `WEBHOOK_SIGNING_SECRET`)

Notification secrets (optional):

- `SLACK_WEBHOOK_URL`
- `DISCORD_WEBHOOK_URL`

Optional payout provider secrets (set only for selected provider):

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `STRIPE_SECRET_KEY`

### Development

```powershell
Set-Location packages/marketer

wrangler secret put ADMIN_TOKEN --env development
wrangler secret put ADMIN_TOKEN_ROLLOVER --env development
wrangler secret put SYSTEM_TOKEN --env development
wrangler secret put SYSTEM_TOKEN_ROLLOVER --env development
wrangler secret put AGENT_TOKEN --env development
wrangler secret put AGENT_TOKEN_ROLLOVER --env development
wrangler secret put WEBHOOK_TOKEN --env development
wrangler secret put WEBHOOK_TOKEN_ROLLOVER --env development
wrangler secret put AFFILIATE_AUTH_SECRET --env development
wrangler secret put WEBHOOK_SIGNING_SECRET --env development
wrangler secret put EMAIL_API_KEY --env development
wrangler secret put INTERNAL_SECRET --env development
wrangler secret put INTERNAL_SECRET_ROLLOVER --env development
wrangler secret put SKRIP_SERVICE_TOKEN --env development
wrangler secret put SKRIP_WEBHOOK_SIGNING_SECRET --env development
wrangler secret put SLACK_WEBHOOK_URL --env development
wrangler secret put DISCORD_WEBHOOK_URL --env development
```

### Production

```powershell
Set-Location packages/marketer

wrangler secret put ADMIN_TOKEN --env production
wrangler secret put ADMIN_TOKEN_ROLLOVER --env production
wrangler secret put SYSTEM_TOKEN --env production
wrangler secret put SYSTEM_TOKEN_ROLLOVER --env production
wrangler secret put AGENT_TOKEN --env production
wrangler secret put AGENT_TOKEN_ROLLOVER --env production
wrangler secret put WEBHOOK_TOKEN --env production
wrangler secret put WEBHOOK_TOKEN_ROLLOVER --env production
wrangler secret put AFFILIATE_AUTH_SECRET --env production
wrangler secret put WEBHOOK_SIGNING_SECRET --env production
wrangler secret put EMAIL_API_KEY --env production
wrangler secret put INTERNAL_SECRET --env production
wrangler secret put INTERNAL_SECRET_ROLLOVER --env production
wrangler secret put SKRIP_SERVICE_TOKEN --env production
wrangler secret put SKRIP_WEBHOOK_SIGNING_SECRET --env production
wrangler secret put SLACK_WEBHOOK_URL --env production
wrangler secret put DISCORD_WEBHOOK_URL --env production
```

### Provider-Specific Additions

If `PAYOUT_PROVIDER=razorpay`:

```powershell
Set-Location packages/marketer

wrangler secret put RAZORPAY_KEY_ID --env production
wrangler secret put RAZORPAY_KEY_SECRET --env production
```

If `PAYOUT_PROVIDER=stripe`:

```powershell
Set-Location packages/marketer

wrangler secret put STRIPE_SECRET_KEY --env production
```

## Variable vs Secret Split

These are plain vars in `packages/marketer/wrangler.toml` and are not set with `secret put`:

- `EMAIL_PROVIDER`
- `FROM_EMAIL`
- `FROM_NAME`
- `ENVIRONMENT`
- `ALLOWED_ORIGIN`
- `PAYOUT_PROVIDER`
- `RAZORPAY_ACCOUNT_NUMBER` (plain var when Razorpay is used)
- `GOVERNANCE_INGRESS_MODE` (`off` | `observe` | `enforce`)
- `GOVERNANCE_ALLOWED_AUTHORITY_SOURCES` (comma-separated forwarded authority source allowlist)
- `GOVERNANCE_ENFORCE_ACTIONS` (comma-separated high-risk action types for selective enforce)
- `GOVERNANCE_REQUIRE_TARGET_TENANT_ACTIONS` (comma-separated action types requiring `targetTenantId`)

Governance rollout helper:

```powershell
Set-Location d:\coding\clodo-dev-site\visibility-marketing
.\scripts\governance-ingress-rollout.ps1 -Environment staging -Mode observe
```

## Recommended Value Sources

- Internal tokens/secrets: generated by internal security tooling.
- Email API key: provider console (Brevo or selected provider).
- Slack/Discord webhook URLs: channel integration settings.
- Payout keys: Razorpay/Stripe dashboard.

## Post-Provision Verification

1. Deploy both workers for target environment.
2. Check health endpoints.
3. Verify authenticated routes.

Suggested smoke checks:

```powershell
curl https://visibility.clodo.dev/health
curl https://visibility.clodo.dev/api/auth/me
curl https://visibility.clodo.dev/api/sites
```

---

## Live State Audit — 2026-05-05

Audited with `wrangler secret list --name <worker>`. Legend: ✅ set · ❌ missing · ⚠ empty-in-local (needs generation).

### visibility-marketing (production)

| Secret | Status | Action |
|---|---|---|
| ADMIN_TOKEN | ❌ | Known from .dev.vars — run backfill-secrets.ps1 |
| ADMIN_TOKEN_ROLLOVER | ❌ | Known from .dev.vars — run backfill-secrets.ps1 |
| SYSTEM_TOKEN | ✅ | — |
| SYSTEM_TOKEN_ROLLOVER | ✅ | — |
| INTERNAL_SECRET | ✅ | — |
| INTERNAL_SECRET_ROLLOVER | ⚠ | Generate: `openssl rand -base64 32` |
| AGENT_TOKEN | ✅ | — |
| AGENT_TOKEN_ROLLOVER | ⚠ | Generate: `openssl rand -base64 32` |
| WEBHOOK_TOKEN | ✅ | — |
| WEBHOOK_TOKEN_ROLLOVER | ⚠ | Generate: `openssl rand -base64 32` |
| AFFILIATE_AUTH_SECRET | ✅ | — |
| WEBHOOK_SIGNING_SECRET | ✅ | — |
| EMAIL_API_KEY | ✅ | — |
| SKRIP_BASE_URL | ✅ | — |
| SKRIP_SERVICE_TOKEN | ✅ | — |
| SKRIP_WEBHOOK_SIGNING_SECRET | ❌ | Must match skrip INBOUND_WEBHOOK_SECRET; copy from dev or regenerate both sides |

### visibility-marketing-dev

| Secret | Status | Action |
|---|---|---|
| ADMIN_TOKEN | ✅ | — |
| ADMIN_TOKEN_ROLLOVER | ✅ | — |
| SYSTEM_TOKEN | ✅ | — |
| SYSTEM_TOKEN_ROLLOVER | ✅ | — |
| INTERNAL_SECRET | ✅ | — |
| INTERNAL_SECRET_ROLLOVER | ⚠ | Generate: `openssl rand -base64 32` |
| AGENT_TOKEN | ✅ | — |
| AGENT_TOKEN_ROLLOVER | ⚠ | Generate: `openssl rand -base64 32` |
| WEBHOOK_TOKEN | ✅ | — |
| WEBHOOK_TOKEN_ROLLOVER | ⚠ | Generate: `openssl rand -base64 32` |
| AFFILIATE_AUTH_SECRET | ✅ | — |
| WEBHOOK_SIGNING_SECRET | ✅ | — |
| EMAIL_API_KEY | ✅ | — |
| SKRIP_BASE_URL | ✅ | — |
| SKRIP_SERVICE_TOKEN | ❌ | Known from skrip .dev.vars — run backfill-secrets.ps1 |
| SKRIP_WEBHOOK_SIGNING_SECRET | ✅ | — |

### visibility-marketing-staging

| Secret | Status | Action |
|---|---|---|
| ADMIN_TOKEN | ✅ | — |
| ADMIN_TOKEN_ROLLOVER | ✅ | — |
| SYSTEM_TOKEN | ✅ | — |
| SYSTEM_TOKEN_ROLLOVER | ✅ | — |
| INTERNAL_SECRET | ✅ | — |
| INTERNAL_SECRET_ROLLOVER | ⚠ | Generate: `openssl rand -base64 32` |
| AGENT_TOKEN | ✅ | — |
| AGENT_TOKEN_ROLLOVER | ⚠ | Generate: `openssl rand -base64 32` |
| WEBHOOK_TOKEN | ✅ | — |
| WEBHOOK_TOKEN_ROLLOVER | ⚠ | Generate: `openssl rand -base64 32` |
| AFFILIATE_AUTH_SECRET | ✅ | — |
| WEBHOOK_SIGNING_SECRET | ✅ | — |
| EMAIL_API_KEY | ✅ | — |
| SKRIP_BASE_URL | ❌ | Known from .dev.vars — run backfill-secrets.ps1 |
| SKRIP_SERVICE_TOKEN | ❌ | Known from skrip .dev.vars — run backfill-secrets.ps1 |
| SKRIP_WEBHOOK_SIGNING_SECRET | ❌ | Must match skrip INBOUND_WEBHOOK_SECRET |

### visibility-analytics / visibility-analytics-dev / visibility-analytics-prod

| Secret | Status | Action |
|---|---|---|
| SYSTEM_TOKEN | ✅ | Set on all three |
| ADMIN_TOKEN | unknown | Verify — not audited this session |
| ANALYTICS_USER_AUTH_SECRET | ❌ | Generate: `openssl rand -base64 32`; set on all three |

### message-manufacturer-platform (skrip production)

| Secret | Status | Action |
|---|---|---|
| VAPID_PUBLIC_KEY | ✅ | — |
| VAPID_PRIVATE_KEY | ✅ | — |
| VAPID_EMAIL | ✅ | — |
| INTERNAL_API_SECRET | ✅ | — |
| ENCRYPTION_KEY_32B | ✅ | — |
| SKRIP_SERVICE_TOKEN | ✅ | — |
| BREVO_API_KEY | ❌ | Known from skrip .dev.vars — run backfill-secrets.ps1 |
| ANTHROPIC_API_KEY | ❌ | Known from skrip .dev.vars — run backfill-secrets.ps1 |
| WHATSAPP_ACCESS_TOKEN | ❌ | Requires Meta Business Account |
| WHATSAPP_PHONE_NUMBER_ID | ❌ | Requires Meta Business Account |
| WHATSAPP_APP_SECRET | ❌ | Requires Meta Business Account |
| WHATSAPP_VERIFY_TOKEN | ❌ | Generate or choose a static verify token |
| TELEGRAM_BOT_TOKEN | ❌ | Create bot via @BotFather |
| TELEGRAM_WEBHOOK_SECRET | ❌ | Generate: `openssl rand -base64 32` |
| OPENAI_API_KEY | ❌ | Optional — only needed if OpenAI arm is active |

### message-manufacturer-platform (skrip staging)

All secrets are missing — no secrets set in staging environment. Clone from production or generate fresh before any staging deployment.

### Automated Backfill (known values only)

Run from workspace root after setting `$env:CLOUDFLARE_API_TOKEN`:

```powershell
$env:CLOUDFLARE_API_TOKEN = "<token>"
.\scripts\backfill-secrets.ps1
```

Handles: `visibility-marketing` ADMIN_TOKEN + ADMIN_TOKEN_ROLLOVER, `visibility-marketing-dev` SKRIP_SERVICE_TOKEN, `visibility-marketing-staging` SKRIP_BASE_URL + SKRIP_SERVICE_TOKEN, `message-manufacturer-platform` BREVO_API_KEY + ANTHROPIC_API_KEY.

Expected behavior notes:

- Analytics `/api/auth/me` and `/api/sites` now require valid signed user headers.
- Missing/invalid secrets in production should fail fast during startup/validation paths.

## Rotation Checklist

1. Set `*_ROLLOVER` secrets first.
2. Update callers/issuers to accept old + new during overlap.
3. Promote new primary secret values.
4. Remove old values after validation window.

## Related Docs

- `CAPABILITY_PROGRESSION.md`
- `DEPLOYMENT.md`
- `packages/analytics/wrangler.toml`
- `packages/marketer/wrangler.toml`