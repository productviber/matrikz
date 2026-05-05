# visibility-marketing

**Growth orchestration, policy enforcement, and agentic growth API** for the Visibility platform.

This is the **Manifesting layer** in the Four-M model: it orchestrates subject journeys, executes multi-channel growth actions, enforces suppression and send policies, and exposes the agentic API that the `growth-agent` worker calls to drive agent-led product adoption.

## Architecture

```
growth-agent (Matrikz)
        │  agentic API (/api/agentic/*)
        ▼
visibility-marketing  ←── Analytics (upstream signals)
        │
        ├── Policy engine (suppression, frequency, risk-gating)
        ├── Multi-channel execution (email + Skrip SMS/push/WhatsApp)
        ├── Attribution & outcome loop (D1 agent_action_outcomes)
        └── Cron pipeline (due emails, reputation, outbox, identity reconciliation)
        │
        ▼
Skrip (message-manufacturer-platform)  — Manufacturing / delivery
```

## Route Lanes

Access is enforced by `src/lib/route-lanes.ts` across five lanes:

| Lane      | Auth               | Namespace                  |
|-----------|--------------------|----------------------------|
| admin     | `ADMIN_TOKEN`      | `/api/admin/*`             |
| user      | signed user header | `/api/user/*`              |
| system    | `SYSTEM_TOKEN`     | `/api/system/*`            |
| webhook   | HMAC signature     | `/webhooks/*`              |
| agentic   | `AGENT_TOKEN` + scopes | `/api/agentic/*`       |

## Agentic API (`/api/agentic/*`)

All endpoints require `Authorization: Bearer <AGENT_TOKEN>` and appropriate scope.

| Method | Path                              | Scope(s)                          |
|--------|-----------------------------------|-----------------------------------|
| GET    | `/api/agentic/growth-signals`     | `signals:read`                    |
| GET    | `/api/agentic/subjects/:id/context` | `subjects:read`                 |
| POST   | `/api/agentic/actions/propose`    | `actions:propose`                 |
| POST   | `/api/agentic/actions/dry-run`    | `actions:dry_run`                 |
| POST   | `/api/agentic/actions/execute`    | `actions:execute_low_risk` / `actions:execute_high_risk` |
| GET    | `/api/agentic/actions/:id`        | `actions:read`                    |
| GET    | `/api/agentic/actions/:id/audit`  | `actions:read`                    |
| GET    | `/api/agentic/actions/:id/trace`  | `actions:read`                    |

## Cron Pipeline (`*/5 * * * *`)

Each tick (unconditionally, via `ctx.waitUntil`):

1. `processDueEmails` — flush warm + campaign queues
2. `captureReputationSnapshot` — email domain health into KV
3. `dispatchOutboxBatch` — fan-out pending Skrip channel messages
4. `reconcilePendingIdentities` — resolve unresolved subject tokens
5. `markStaleAgentActions` → re-evaluate low-risk stuck actions
6. `attributeAgentActionOutcomes` — write conversion/engagement into `agent_action_outcomes`
7. KV cron snapshot — `cron:snapshot:latest` + dated key (always runs, independent of #6)

## Service Bindings

| Binding         | Target worker                     | Required |
|-----------------|-----------------------------------|----------|
| `DB`            | D1 database                       | always   |
| `KV_MARKETING`  | KV namespace                      | always   |
| `ANALYTICS`     | `visibility-analytics`            | always   |
| `AI_ENGINE`     | `growth-agent`                    | optional |
| `SKRIP_SERVICE` | `message-manufacturer-platform`   | optional |

## Required Secrets (Production)

Core auth: `ADMIN_TOKEN`, `ADMIN_TOKEN_ROLLOVER`, `SYSTEM_TOKEN`, `SYSTEM_TOKEN_ROLLOVER`,
`AGENT_TOKEN`, `AGENT_TOKEN_ROLLOVER`, `WEBHOOK_TOKEN`, `WEBHOOK_TOKEN_ROLLOVER`,
`AFFILIATE_AUTH_SECRET`, `WEBHOOK_SIGNING_SECRET`, `EMAIL_API_KEY`

AI Engine: `INTERNAL_SECRET`, `INTERNAL_SECRET_ROLLOVER`

Skrip: `SKRIP_SERVICE_TOKEN`, `SKRIP_WEBHOOK_SIGNING_SECRET`
(optional overrides: `SKRIP_BASE_URL`, `SKRIP_SIGNING_SECRET`)

See `docs/setup/SECRETS_RUNBOOK.md` for provisioning commands.

## Running Locally

```bash
pnpm install
pnpm dev          # starts wrangler dev
pnpm typecheck    # TypeScript validation
pnpm test         # vitest unit suite
```

## Deployment

```bash
pnpm deploy --env staging
pnpm deploy --env production
```

Or use the activation checklist script to verify secrets and migrations first:

```bash
node scripts/activate.mjs
```
