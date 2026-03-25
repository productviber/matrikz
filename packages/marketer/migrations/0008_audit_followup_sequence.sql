-- Warm Audit-Followup Sequence — Seeds the 3-step warm email sequence
-- for leads captured through the free audit flow (lead.captured events).
--
-- This sequence targets high-intent contacts who ran an audit AND confirmed
-- their email. Conversion rates are 5-10x higher than cold outreach.
--
-- Timing: immediate → 2 days → 5 days (shorter than cold because intent decays)
-- Templates reference BUILT_IN_TEMPLATES keys in src/lib/email.ts.

-- ─── Warm Audit-Followup Sequence ───────────────────────────────────────────

INSERT INTO email_sequences (name, trigger_event, description, is_active) VALUES
  ('Audit Followup v1', 'lead.captured', 'Three-step warm sequence for audit leads: results delivery, quick win nudge, final recap. Max 5 days.', 1);

-- Step 1: Immediate — Deliver their audit results with score/grade breakdown
INSERT INTO email_steps (sequence_id, step_order, subject, template_key, delay_seconds) VALUES
  ((SELECT id FROM email_sequences WHERE trigger_event = 'lead.captured' LIMIT 1),
   1, 'Your {{domain}} audit results', 'audit-followup-step1', 0);

-- Step 2: 2 days later — Surface the #1 quick win from their audit
INSERT INTO email_steps (sequence_id, step_order, subject, template_key, delay_seconds) VALUES
  ((SELECT id FROM email_sequences WHERE trigger_event = 'lead.captured' LIMIT 1),
   2, 'The #1 thing I''d fix on {{domain}}', 'audit-followup-step2', 172800);

-- Step 3: 5 days after step 1 — Final recap + no-more-emails promise
INSERT INTO email_steps (sequence_id, step_order, subject, template_key, delay_seconds) VALUES
  ((SELECT id FROM email_sequences WHERE trigger_event = 'lead.captured' LIMIT 1),
   3, 'Last note on your {{domain}} audit', 'audit-followup-step3', 432000);
