-- Cold Outreach Sequence — Seeds the 3-step cold email sequence
-- for outbound prospects discovered by the analytics worker.
--
-- This sequence is triggered by 'outbound.prospect_discovered' events.
-- Templates reference BUILT_IN_TEMPLATES keys in src/lib/email.ts.
-- See: docs/OUTBOUND_SYSTEM_ARCHITECTURE.md §8.4, §10 Phase 2

-- ─── Cold Outreach Sequence ─────────────────────────────────────────────────

INSERT INTO email_sequences (name, trigger_event, description, is_active) VALUES
  ('Cold Outreach v1', 'outbound.prospect_discovered', 'Three-step cold outreach for discovered prospects: audit score reveal, insight nudge, final value drop. Max 7 days.', 1);

-- Step 1: Immediate — Value drop with audit score/grade
-- Template: cold-outreach-step1 (shows audit score, pass/issue counts, CTA to full report)
INSERT INTO email_steps (sequence_id, step_order, subject, template_key, delay_seconds) VALUES
  ((SELECT id FROM email_sequences WHERE trigger_event = 'outbound.prospect_discovered' LIMIT 1),
   1, 'Quick SEO check for {{companyName}}', 'cold-outreach-step1', 0);

-- Step 2: 3 days later — Insight nudge with one specific quick win
-- Template: cold-outreach-step2 (one actionable fix with expected impact)
INSERT INTO email_steps (sequence_id, step_order, subject, template_key, delay_seconds) VALUES
  ((SELECT id FROM email_sequences WHERE trigger_event = 'outbound.prospect_discovered' LIMIT 1),
   2, 'One quick win for {{companyName}}''s SEO', 'cold-outreach-step2', 259200);

-- Step 3: 7 days after step 1 — Final value with recap + no-more-emails promise
-- Template: cold-outreach-step3 (recap, GSC connect CTA, "no more emails" statement)
INSERT INTO email_steps (sequence_id, step_order, subject, template_key, delay_seconds) VALUES
  ((SELECT id FROM email_sequences WHERE trigger_event = 'outbound.prospect_discovered' LIMIT 1),
   3, 'Last look: {{companyName}}''s SEO potential', 'cold-outreach-step3', 604800);
