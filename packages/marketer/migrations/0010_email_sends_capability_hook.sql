-- email_sends: capability hook attribution
--
-- Adds a column that records which capability hook (from the analytics
-- CAPABILITY_CATALOG) was attached to each scheduled/sent email. This is
-- what lets the admin metrics dashboard group opens/clicks/replies by hook
-- so we can see which capability surface is driving response.
--
-- Also adds `variant` for A/B subject/body attribution so reporting can
-- roll up across variant × capability hook.
--
-- Indexes: both are low-cardinality but frequently filtered in dashboards.
--
-- Safe to re-apply: uses IF NOT EXISTS guards via PRAGMA check.
-- (SQLite ALTER TABLE ADD COLUMN is idempotent only via check-then-add.)

-- D1/SQLite lacks "ADD COLUMN IF NOT EXISTS", but re-applying a migration
-- that adds an existing column errors the batch. Re-applies should be done
-- by checking d1_migrations first (standard wrangler workflow).

ALTER TABLE email_sends ADD COLUMN capability_hook_id TEXT;
ALTER TABLE email_sends ADD COLUMN variant TEXT;

CREATE INDEX IF NOT EXISTS idx_email_sends_capability_hook
  ON email_sends(capability_hook_id);

CREATE INDEX IF NOT EXISTS idx_email_sends_variant
  ON email_sends(variant);
