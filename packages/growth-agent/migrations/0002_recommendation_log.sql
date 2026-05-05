CREATE TABLE IF NOT EXISTS recommendation_log (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  action_type TEXT NOT NULL,
  confidence REAL NOT NULL,
  risk_level TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  dispatched_at TEXT,
  expires_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('reactive', 'proactive'))
);

CREATE INDEX IF NOT EXISTS idx_recommendation_log_correlation
  ON recommendation_log(correlation_id);

CREATE INDEX IF NOT EXISTS idx_recommendation_log_tenant_subject
  ON recommendation_log(tenant_id, subject_id);
