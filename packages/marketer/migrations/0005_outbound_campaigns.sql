-- Outbound Campaigns — Campaign management for cold email outreach.
--
-- Each campaign links to an email_sequence, defines filtering rules,
-- tracks warmup progress, and aggregates delivery metrics.
--
-- See: docs/OUTBOUND_SYSTEM_ARCHITECTURE.md §5.3, §10 Phase 2.1

-- ─── Outbound Campaigns ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outbound_campaigns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  sequence_id     INTEGER REFERENCES email_sequences(id),
  source_filter   TEXT,                             -- JSON: { sources: [], min_score: N }
  status          TEXT NOT NULL DEFAULT 'draft',    -- draft | active | paused | completed
  daily_limit     INTEGER NOT NULL DEFAULT 50,
  warmup_day      INTEGER NOT NULL DEFAULT 0,
  total_sent      INTEGER NOT NULL DEFAULT 0,
  total_opened    INTEGER NOT NULL DEFAULT 0,
  total_clicked   INTEGER NOT NULL DEFAULT 0,
  total_replied   INTEGER NOT NULL DEFAULT 0,
  total_bounced   INTEGER NOT NULL DEFAULT 0,
  total_unsub     INTEGER NOT NULL DEFAULT 0,
  started_at      INTEGER,
  paused_at       INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON outbound_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_slug ON outbound_campaigns(slug);

-- ─── Seed: Default Cold Outreach Campaign ───────────────────────────────────

INSERT INTO outbound_campaigns (name, slug, sequence_id, source_filter, status, daily_limit)
VALUES (
  'Cold Outreach v1',
  'cold-outreach-v1',
  (SELECT id FROM email_sequences WHERE trigger_event = 'outbound.prospect_discovered' LIMIT 1),
  '{"sources":["hackernews","producthunt","apollo"],"min_score":50}',
  'draft',
  10
);
