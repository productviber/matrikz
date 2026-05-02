-- 0011_email_sends_engagement.sql
--
-- P0 engagement persistence: makes it possible to answer
--   "which rendered subject / variant / capability hook earned the opens and clicks?"
--
-- Columns added to email_sends:
--   rendered_subject      — the actual subject text that shipped (after {{var}} interpolation
--                           + SUBJECT_VARIANTS selection). email_steps.subject is only the
--                           template string (e.g. "Quick SEO check for {{companyName}}") and
--                           does NOT reflect variant pools or interpolation.
--   subject_variant_idx   — index into SUBJECT_VARIANTS[templateKey] / WARM_SUBJECT_VARIANTS[…]
--   body_variant_idx      — index into BODY_VARIANTS[templateKey] / WARM_BODY_VARIANTS[…]
--   brevo_message_id      — provider message id returned from the send call; correlator for
--                           webhooks that include it in the payload.
--   opened_at / clicked_at / replied_at
--                         — first timestamp we observed each event (UNIX seconds).
--   open_count / click_count
--                         — running counters (an email can be opened many times).
--
-- Indexes:
--   idx_email_sends_brevo_msg   — webhook correlator by message-id
--   idx_email_sends_opened_at   — "recent openers" queries (retarget step-2/3)
--   idx_email_sends_clicked_at  — "recent clickers" queries (warm sequence enrollment)

ALTER TABLE email_sends ADD COLUMN rendered_subject   TEXT;
ALTER TABLE email_sends ADD COLUMN subject_variant_idx INTEGER;
ALTER TABLE email_sends ADD COLUMN body_variant_idx    INTEGER;
ALTER TABLE email_sends ADD COLUMN brevo_message_id    TEXT;
ALTER TABLE email_sends ADD COLUMN opened_at           INTEGER;
ALTER TABLE email_sends ADD COLUMN clicked_at          INTEGER;
ALTER TABLE email_sends ADD COLUMN replied_at          INTEGER;
ALTER TABLE email_sends ADD COLUMN open_count          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_sends ADD COLUMN click_count         INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_email_sends_brevo_msg  ON email_sends (brevo_message_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_opened_at  ON email_sends (opened_at);
CREATE INDEX IF NOT EXISTS idx_email_sends_clicked_at ON email_sends (clicked_at);
