-- Migration 0014: Agentic growth foundation
--
-- Durable read models and ledgers for agent-led growth. AI recommendations
-- are recorded as proposals; deterministic policy and execution state remain
-- the source of truth.

CREATE TABLE IF NOT EXISTS growth_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence INTEGER NOT NULL DEFAULT 50,
  detected_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  source_event_id TEXT,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_growth_signals_active
  ON growth_signals (tenant_id, status, expires_at, severity);

CREATE INDEX IF NOT EXISTS idx_growth_signals_subject
  ON growth_signals (tenant_id, subject_type, subject_id, status);

CREATE INDEX IF NOT EXISTS idx_growth_signals_type
  ON growth_signals (tenant_id, signal_type, status, detected_at);

CREATE TABLE IF NOT EXISTS agent_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  correlation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  signal_id TEXT,
  proposed_action TEXT NOT NULL,
  proposed_action_json TEXT NOT NULL,
  status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  confidence INTEGER NOT NULL DEFAULT 50,
  evidence_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  policy_result_json TEXT NOT NULL,
  ai_metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  approved_at INTEGER,
  executed_at INTEGER,
  outcome_due_at INTEGER,
  outcome_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_actions_subject
  ON agent_actions (tenant_id, subject_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_actions_signal
  ON agent_actions (signal_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_actions_status
  ON agent_actions (tenant_id, status, outcome_due_at);

CREATE TABLE IF NOT EXISTS agent_action_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_action_events_action
  ON agent_action_events (action_id, created_at);

CREATE TABLE IF NOT EXISTS agent_action_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL,
  outcome_type TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  window_seconds INTEGER NOT NULL,
  attribution_strength TEXT NOT NULL,
  revenue_or_value INTEGER,
  evidence_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (action_id, outcome_type, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_agent_action_outcomes_action
  ON agent_action_outcomes (action_id, observed_at);