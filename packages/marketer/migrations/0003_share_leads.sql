-- Visibility Marketing Worker — Migration 0003
-- Adds the share_leads table for PLG funnel tracking and PQL scoring.
--
-- Every share link view creates an anonymous lead row, scored progressively
-- as the recipient engages (views → dwell → CTA click → signup).
-- The marketing worker uses this to drive drip sequences, Slack alerts,
-- and conversion attribution back to the share link owner.

-- ─── Share Leads (PLG Funnel Tracking) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS share_leads (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  token               TEXT NOT NULL,                          -- share link token (vs_xxx)
  owner_email         TEXT,                                   -- share link owner's email
  status              TEXT NOT NULL DEFAULT 'cold',           -- cold | warm | hot | pql | converted
  plg_stage           TEXT NOT NULL DEFAULT 'activation',     -- awareness | activation | engagement | intent | conversion | lifecycle
  pql_score           INTEGER NOT NULL DEFAULT 0,
  total_views         INTEGER NOT NULL DEFAULT 0,
  total_dwell_seconds INTEGER NOT NULL DEFAULT 0,
  scopes_viewed       TEXT,                                   -- JSON array of scopes seen
  first_seen_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  converted_user_id   TEXT,                                   -- set when share.converted fires
  converted_at        INTEGER,
  metadata            TEXT,                                   -- JSON blob for extensibility
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_share_leads_token  ON share_leads(token);
CREATE INDEX IF NOT EXISTS idx_share_leads_status ON share_leads(status);
CREATE INDEX IF NOT EXISTS idx_share_leads_owner  ON share_leads(owner_email);
CREATE INDEX IF NOT EXISTS idx_share_leads_pql    ON share_leads(pql_score);

-- ─── Share Owner Stats (aggregated per owner) ───────────────────────────────

CREATE TABLE IF NOT EXISTS share_owner_stats (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_email         TEXT NOT NULL UNIQUE,
  total_shares        INTEGER NOT NULL DEFAULT 0,
  total_views         INTEGER NOT NULL DEFAULT 0,
  total_engagements   INTEGER NOT NULL DEFAULT 0,
  total_cta_clicks    INTEGER NOT NULL DEFAULT 0,
  total_conversions   INTEGER NOT NULL DEFAULT 0,
  last_share_at       INTEGER,
  last_conversion_at  INTEGER,
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_share_owner_email ON share_owner_stats(owner_email);

-- ─── Seed Share-Specific Email Sequences ────────────────────────────────────

INSERT INTO email_sequences (name, trigger_event, description) VALUES
  ('Share Lead Warm Followup', 'share.engaged', 'Sent to share owner when a recipient stays 120s+ on their shared link'),
  ('Share CTA Dropout', 'share.cta_clicked', 'Sent to CTA clickers who do not convert within 24h'),
  ('Share Conversion Celebration', 'share.converted', 'Notifies the share owner that a recipient signed up');

-- Share Lead Warm Followup steps (notify owner)
INSERT INTO email_steps (sequence_id, step_order, subject, template_key, delay_seconds) VALUES
  ((SELECT id FROM email_sequences WHERE trigger_event = 'share.engaged'), 1,
   'Someone is exploring your shared insights', 'share-engaged-owner', 0);

-- Share CTA Dropout steps (follow up with the clicker)
INSERT INTO email_steps (sequence_id, step_order, subject, template_key, delay_seconds) VALUES
  ((SELECT id FROM email_sequences WHERE trigger_event = 'share.cta_clicked'), 1,
   'Still interested? Pick up where you left off', 'share-cta-dropout', 86400);

-- Share Conversion Celebration steps (notify owner)
INSERT INTO email_steps (sequence_id, step_order, subject, template_key, delay_seconds) VALUES
  ((SELECT id FROM email_sequences WHERE trigger_event = 'share.converted'), 1,
   'Someone you shared with just signed up!', 'share-conversion-owner', 0);
