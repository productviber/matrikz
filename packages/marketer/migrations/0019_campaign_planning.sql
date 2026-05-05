-- Prompt 2-4 foundation: deterministic segment previews, channel intent, and strategic brief logs.

CREATE TABLE IF NOT EXISTS segment_previews (
  segment_hash TEXT PRIMARY KEY,
  canonical_json TEXT NOT NULL,
  estimate INTEGER NOT NULL,
  confidence_band TEXT,
  last_computed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_segments (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  segment_hash TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  include_json TEXT NOT NULL,
  exclude_json TEXT NOT NULL,
  estimate INTEGER NOT NULL,
  contradiction_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaign_objectives(id) ON DELETE CASCADE,
  UNIQUE (campaign_id, segment_hash)
);

CREATE INDEX IF NOT EXISTS idx_campaign_segments_campaign_id
  ON campaign_segments(campaign_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS channel_intents (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('campaign', 'segment')),
  scope_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  segment_id TEXT,
  hard_block_json TEXT NOT NULL DEFAULT '[]',
  preferred_json TEXT NOT NULL DEFAULT '[]',
  fallback_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_type, scope_id),
  FOREIGN KEY (campaign_id) REFERENCES campaign_objectives(id) ON DELETE CASCADE,
  FOREIGN KEY (segment_id) REFERENCES campaign_segments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_channel_intents_campaign_id
  ON channel_intents(campaign_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS strategic_brief_logs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  strategy_signature TEXT NOT NULL,
  strategy_timestamp TEXT NOT NULL,
  strategy_nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaign_objectives(id) ON DELETE CASCADE,
  UNIQUE (strategy_nonce)
);

CREATE INDEX IF NOT EXISTS idx_strategic_brief_logs_campaign_id
  ON strategic_brief_logs(campaign_id, created_at DESC);
