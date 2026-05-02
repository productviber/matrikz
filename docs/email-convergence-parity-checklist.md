# Email Convergence Parity Checklist

**Date:** 2026-05-02
**Related decision:** `docs/email-convergence-decision.md`
**Status:** Pending — awaiting Skrip shadow-mode evidence

All items below must be checked `[x]` before activating `SKRIP_EMAIL_AUTHORITY_ENABLED` for any production tenant.

---

## 1. Deliverability

- [ ] Skrip email path achieves ≥ 95% inbox placement rate across major providers (Gmail, Outlook, Yahoo).
- [ ] SPF, DKIM, and DMARC are correctly configured for Skrip's sending domain(s).
- [ ] DKIM selector and signing key are verified in staging and production.
- [ ] Reputation warm-up schedule completed for new sending IP/domain (see `fix-warmup.sql`).
- [ ] Spam score < 2.0 on MailTester or equivalent for representative templates.
- [ ] Deliverability delta vs existing engine ≤ 0.5% across ≥ 10,000 shadow sends.

## 2. Bounce and Complaint Handling

- [ ] Hard bounce webhook received and forwarded to `email_sends` / `suppression_list` within 60 seconds.
- [ ] Soft bounce retry strategy matches existing engine behavior (≥ 3 retries over 24h).
- [ ] Complaint (spam report) webhook received and contact added to suppression list within 60 seconds.
- [ ] `email_sends.status` updated correctly for every bounce/complaint event via Skrip outcome webhook.
- [ ] Bounce rate parity vs existing engine ≤ 0.1% over ≥ 10,000 shadow sends.

## 3. Open and Click Tracking

- [ ] Open tracking pixel served by Skrip, events forwarded as outcome webhooks to Visibility Marketing.
- [ ] Click tracking redirect served by Skrip, outcome webhooks include original URL and clicked link.
- [ ] `email_sends_engagement` table populated correctly from Skrip outcome events.
- [ ] Open rate parity vs existing engine ≤ 2% over ≥ 10,000 shadow sends.
- [ ] Click-through rate parity vs existing engine ≤ 1% over ≥ 10,000 shadow sends.

## 4. Reply Handling

- [ ] Reply detection (if applicable) forwarded as outcome event.
- [ ] Reply events trigger suppression or stage update in the same way as existing engine reply webhooks.

## 5. Template Rendering

- [ ] All active Visibility Marketing email templates rendered by Skrip's engine and diffed against golden screenshots.
- [ ] Zero rendering regressions on the template golden set (text + HTML).
- [ ] Personalization token substitution (`{{first_name}}`, `{{company_name}}`, etc.) verified in all templates.
- [ ] UTM parameters appended correctly to all links in rendered templates.
- [ ] Plain-text fallback generated and correct for all templates.
- [ ] Character encoding (UTF-8) preserved for international content.

## 6. Unsubscribe Safety

- [ ] List-Unsubscribe header (`RFC 2369`) present in every email sent via Skrip.
- [ ] One-click unsubscribe (`RFC 8058`) implemented and verified.
- [ ] Unsubscribe via header or link correctly suppresses the contact within 10 seconds.
- [ ] `KV_MARKETING:unsubscribe:{email}` key set and `suppression_list` updated from Skrip outcome webhooks.
- [ ] Resubscribe path works correctly (unsubscribe then re-opt-in clears suppression).
- [ ] 100% unsubscribe pass rate on test suite of ≥ 100 synthetic unsubscribe events.

## 7. Sequence Enrollment Parity

- [ ] `enrollInSequences` routing to Skrip email produces same step cadence as existing engine.
- [ ] Multi-step drip sequences advance correctly when Skrip delivers step N and Marketing receives the outcome.
- [ ] Step-level idempotency keys prevent duplicate sends when outcome webhook is retried.
- [ ] Paused contacts are not re-enrolled via Skrip path.
- [ ] Suppressed contacts blocked at Skrip channel authority layer as well as application layer.

## 8. Provider Fallback

- [ ] Skrip email can fall back to a secondary provider (e.g. SendGrid if Brevo is down) in staging.
- [ ] Fallback triggered correctly when primary provider returns 5xx or times out.
- [ ] Fallback behavior documented in SECRETS_RUNBOOK.md.
- [ ] Fallback round-trip tested in staging: delivery confirmed, outcome webhook received.

## 9. Cost Comparison

- [ ] Per-send cost via Skrip ≤ existing engine cost per send (or cost delta justified by operational savings).
- [ ] Volume tier pricing confirmed with Skrip vendor.
- [ ] Cost monitoring in place (alert if per-send cost exceeds threshold).

## 10. Attribution Continuity

- [ ] `agent_action_id` propagated through Skrip send → outcome webhook → `agent_action_outcomes`.
- [ ] `email_sends` attribution fields (`campaign_id`, `sequence_id`, `contact_id`) populated from Skrip outcome data.
- [ ] Attribution join queries return same results with Skrip-sourced sends as with existing engine sends.
- [ ] Agent performance dashboard shows Skrip-sourced outcomes correctly.

## 11. Migration Safety

- [ ] Rollback plan documented: can revert to existing email engine within 15 minutes by setting `rollout_state = 'rollback'` in `channel_authorities`.
- [ ] Rollback tested in staging: revert sets `channel_authorities.rollout_state = 'rollback'`, policy immediately routes to legacy engine.
- [ ] Zero send duplication confirmed during rollback (idempotency keys prevent double-send).
- [ ] Dual-write period (both engines active) limited to shadow-mode window only; no tenant in dual-live state.
- [ ] Data migration plan for `email_sends` history if Skrip keeps its own send log.

## 12. Shadow-Mode Evidence Gate

- [ ] Shadow-mode active for ≥ 30 calendar days.
- [ ] Shadow-mode covered ≥ 10,000 email sends.
- [ ] All gate criteria in sections 1–11 met with documented evidence.
- [ ] Sign-off from: Growth Platform lead, Deliverability owner, Security review.
- [ ] `SKRIP_EMAIL_AUTHORITY_ENABLED` flag activation PR reviewed and merged.

---

## Activation Sequence (after all items checked)

1. Insert/update `channel_authorities` for target tenant with `rollout_state = 'dry_run'` and `channel = 'email'`.
2. Set `SKRIP_EMAIL_AUTHORITY_ENABLED = 'true'` in wrangler secrets for the target environment.
3. Monitor for 48 hours: check `agent_action_outcomes`, `email_sends`, and Skrip outcome webhooks.
4. Update `rollout_state = 'enabled'` for the tenant after dry-run validation.
5. Progressively roll out to remaining tenants.
6. After all tenants migrated and 60 days of clean production evidence: decommission legacy email engine.
