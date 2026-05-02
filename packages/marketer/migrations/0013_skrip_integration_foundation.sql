-- Migration 0013: Skrip multichannel integration foundation
--
-- Adds the minimum durable primitives required to integrate Visibility-Marketing
-- with Skrip without disturbing the existing email execution path:
--   - authority registry per tenant/campaign/channel
--   - canonical channel identity mapping
--   - external execution outbox
--   - message lineage for normalized outcomes
--   - DLQ for failed outcome ingestion
--   - push opt-in funnel event log

CREATE TABLE IF NOT EXISTS channel_authorities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT,
  channel TEXT NOT NULL,
  authority TEXT NOT NULL,
  rollout_state TEXT NOT NULL,
  feature_flag_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, campaign_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_channel_authorities_lookup
  ON channel_authorities (tenant_id, channel, campaign_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_authorities_unique_scope
  ON channel_authorities (tenant_id, channel, COALESCE(campaign_id, '__tenant__'));

CREATE TABLE IF NOT EXISTS contact_channel_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  external_contact_id TEXT NOT NULL,
  canonical_id TEXT,
  channel TEXT NOT NULL,
  consent_state TEXT NOT NULL,
  suppression_state TEXT NOT NULL,
  availability_state TEXT NOT NULL,
  identity_confidence REAL NOT NULL DEFAULT 0,
  registration_state TEXT NOT NULL,
  last_reconciled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, external_contact_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_contact_channel_identities_lookup
  ON contact_channel_identities (tenant_id, channel, canonical_id);

CREATE TABLE IF NOT EXISTS channel_execution_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  journey_id TEXT,
  step_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  schedule_slot TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  correlation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_channel_execution_outbox_dispatch
  ON channel_execution_outbox (status, next_attempt_at, channel);

CREATE TABLE IF NOT EXISTS channel_message_lineage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  journey_id TEXT,
  step_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  message_id TEXT NOT NULL,
  skrip_outbound_id TEXT,
  provider_ref TEXT,
  idempotency_key TEXT NOT NULL,
  latest_status TEXT NOT NULL,
  first_sent_at INTEGER,
  last_outcome_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (message_id),
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_channel_message_lineage_lookup
  ON channel_message_lineage (tenant_id, campaign_id, channel, latest_status);

CREATE TABLE IF NOT EXISTS channel_outcome_dead_letter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  retryable INTEGER NOT NULL DEFAULT 1,
  first_failed_at INTEGER NOT NULL,
  last_failed_at INTEGER NOT NULL,
  replayed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_channel_outcome_dead_letter_pending
  ON channel_outcome_dead_letter (replayed_at, retryable, tenant_id);

CREATE TABLE IF NOT EXISTS push_opt_in_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  contact_id TEXT,
  browser_session_id TEXT,
  event_type TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  metadata_json TEXT,
  occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_opt_in_events_funnel
  ON push_opt_in_events (tenant_id, event_type, occurred_at);