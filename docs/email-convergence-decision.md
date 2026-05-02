# Email Convergence Decision

**Date:** 2026-05-02
**Status:** Decided — Defer until Skrip shadow-mode evidence collected
**Owner:** Growth Platform Team

---

## Decision

> **Email delivery authority stays with Visibility Marketing's existing engine (Brevo/SendGrid) until Skrip email path has production shadow-mode evidence meeting all parity gate criteria.**

The isolated `SKRIP_EMAIL_AUTHORITY_ENABLED` feature flag scaffold has been built and is ready to activate once the parity gate is cleared. No rollover until the checklist in `docs/email-convergence-parity-checklist.md` is signed off.

---

## Background

Visibility Marketing currently owns email manufacturing and delivery through Brevo/SendGrid:

- `email_sends` table tracks all outbound email state.
- `enrollInSequences` routes cold/lifecycle sequences through the existing email engine.
- Open/click/bounce/complaint webhooks from Brevo feed back as Skrip-style outcome events.
- Suppression, unsubscribe, and frequency-cap guardrails are enforced before every send.

Skrip was introduced as a multi-channel delivery authority for push, SMS, WhatsApp, and Telegram. The question is whether Skrip should also absorb email manufacturing and delivery.

---

## Options Evaluated

### Option A — Keep email in Visibility Marketing (selected for now)

**Pros:**
- No migration risk to a live, revenue-critical channel.
- Existing SLOs, bounce handling, and suppression are proven.
- Zero cross-service blast radius for email delivery failures.

**Cons:**
- Two delivery systems to maintain long-term.
- Skrip's multi-channel orchestration doesn't see the full picture for email.
- Reporting joins are more complex.

### Option B — Migrate email to Skrip

**Pros:**
- Single channel authority for all channels — simpler routing in policy engine.
- Skrip owns message manufacturing, template rendering, and delivery for all channels.
- Unified outcome webhook and attribution across email + push + SMS.

**Cons:**
- High migration risk. Email is the primary revenue-critical growth channel.
- Skrip email must reach parity on deliverability, bounce/reply handling, template rendering, unsubscribe safety, and provider fallback before cutover.
- Rollback path must be proven in staging before prod.

### Option C — Hybrid: Skrip owns new email sends, VM engine handles legacy

**Cons:**
- Increased complexity with two concurrent email send paths.
- Attribution and suppression must be synchronized across both.
- Higher bug surface than a clean migration.

---

## Decision Rationale

The risk of migrating a live, revenue-critical email channel before parity is proven outweighs the architectural benefit of unifying delivery in Skrip. The correct sequencing is:

1. Skrip runs in **shadow mode** alongside the existing email engine.
2. Shadow mode compares: deliverability, open rates, bounce rates, template render fidelity, unsubscribe handling, and provider fallback behavior.
3. When shadow-mode data covers ≥ 30 days and ≥ 10,000 sends with parity on all gate criteria, the `SKRIP_EMAIL_AUTHORITY_ENABLED` flag can be activated.
4. Activate for a single tenant first (dry_run rollout state), then progressively expand.
5. Legacy email engine is decommissioned only after all tenants have migrated and 60 days of clean production evidence.

---

## Gate Criteria (must ALL be met before activating flag)

| Gate | Threshold | Source |
|------|-----------|--------|
| Shadow-mode coverage | ≥ 30 days, ≥ 10,000 sends | Skrip shadow send logs |
| Deliverability parity | ≤ 0.5% gap vs existing engine | Email provider stats |
| Bounce rate parity | ≤ 0.1% gap | Bounce webhook comparison |
| Open rate parity | ≤ 2% gap | Engagement tracking |
| Unsubscribe handling | 100% pass rate | Suppression cross-check |
| Template render fidelity | Zero regressions vs golden set | Render diff test suite |
| Provider fallback tested | Confirmed in staging | Smoke test pass |
| Rollback plan documented | Yes | SECRETS_RUNBOOK.md + migration note |

Full parity checklist: see `docs/email-convergence-parity-checklist.md`.

---

## Implementation Scaffold

The isolated feature flag has been built in the policy engine:

- **Env var:** `SKRIP_EMAIL_AUTHORITY_ENABLED` (string `'true'` to activate)
- **Behaviour:** When enabled, `enroll_sequence` actions run through `resolveSkripExecutionDecision` for the `email` channel, respecting `channel_authorities` rollout state.
- **Dry-run safe:** When `channel_authorities.rollout_state = 'dry_run'`, policy emits a warning but does not block.
- **Kill switch:** `agent:growth:kill:channel:{tenantId}:email` KV key acts as emergency off.

To activate for a tenant in dry-run:
```sql
INSERT INTO channel_authorities (tenant_id, campaign_id, channel, authority, rollout_state)
VALUES ('your-tenant', NULL, 'email', 'skrip', 'dry_run')
ON CONFLICT DO UPDATE SET rollout_state = 'dry_run', authority = 'skrip';
```

To enable live:
```sql
UPDATE channel_authorities SET rollout_state = 'enabled' WHERE tenant_id = 'your-tenant' AND channel = 'email';
```

---

## Next Review

This decision should be revisited once Skrip email shadow-mode evidence is available. Track progress in the parity checklist.
