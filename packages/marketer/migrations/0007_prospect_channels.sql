-- Visibility Marketing Worker — Migration 0007
--
-- Prospect outreach channels: stores every detected path to reach a prospect
-- (email, contact form, social handles, chat widgets) and tracks each
-- outreach attempt with channel, status, and timestamps.
--
-- Enables multi-channel orchestration: email → form → social → chat cascade.
-- Admin can see which channels are available and which were used per prospect.
--
-- See: docs/OUTBOUND_SYSTEM_ARCHITECTURE.md §11 Multi-channel

-- ─── Prospect Channels ──────────────────────────────────────────────────────
-- Every detected outreach channel for a prospect.
-- Populated by handleProspectEnriched() from enrichment data.

CREATE TABLE IF NOT EXISTS prospect_channels (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_domain TEXT NOT NULL,
  contact_email   TEXT,
  channel_type    TEXT NOT NULL,
  channel_value   TEXT NOT NULL,
  channel_meta    TEXT,
  priority        INTEGER NOT NULL DEFAULT 99,
  detected_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(prospect_domain, channel_type)
);

CREATE INDEX IF NOT EXISTS idx_prospect_channels_domain
  ON prospect_channels(prospect_domain);

CREATE INDEX IF NOT EXISTS idx_prospect_channels_type
  ON prospect_channels(channel_type);

-- ─── Channel Attempts ───────────────────────────────────────────────────────
-- Tracks each outreach attempt per channel per prospect.
-- One row per attempt — enables retry logic and admin visibility.

CREATE TABLE IF NOT EXISTS channel_attempts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_domain TEXT NOT NULL,
  contact_email   TEXT,
  channel_type    TEXT NOT NULL,
  channel_value   TEXT NOT NULL,
  step_key        TEXT,
  campaign_slug   TEXT,
  status          TEXT NOT NULL DEFAULT 'attempted',
  response_code   INTEGER,
  error           TEXT,
  attempted_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_channel_attempts_domain
  ON channel_attempts(prospect_domain);

CREATE INDEX IF NOT EXISTS idx_channel_attempts_status
  ON channel_attempts(status);

CREATE INDEX IF NOT EXISTS idx_channel_attempts_type
  ON channel_attempts(channel_type);
