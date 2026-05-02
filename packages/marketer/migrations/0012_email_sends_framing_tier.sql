-- Migration 0012: Framing tier (score-band) on email_sends
--
-- Adds the `framing_tier` column to persist the score-band classification
-- ('good' | 'standard' | 'compulsion') used for every outbound send.
--
-- Enables permanent tier-level engagement segmentation in the
-- `/admin/outbound/variants` dashboard (GROUP BY template_key, framing_tier,
-- subject_variant_idx) so each tier's reply-rate converges independently.
--
-- Safe & reversible: pure ADD COLUMN + CREATE INDEX. No data rewrites.

ALTER TABLE email_sends ADD COLUMN framing_tier TEXT;

CREATE INDEX IF NOT EXISTS idx_email_sends_framing_tier
  ON email_sends (framing_tier);
