CREATE TABLE IF NOT EXISTS outcome_records (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  action_type TEXT NOT NULL,
  outcome_metric TEXT NOT NULL,
  delta REAL NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outcome_records_correlation
  ON outcome_records(correlation_id);

CREATE INDEX IF NOT EXISTS idx_outcome_records_tenant_created
  ON outcome_records(tenant_id, created_at DESC);
