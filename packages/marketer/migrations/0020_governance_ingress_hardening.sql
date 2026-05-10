-- Governance ingress hardening
-- Auditable authority decision log with replay-safe dedupe key support.

CREATE TABLE IF NOT EXISTS governance_ingress_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL,
  governance_mode TEXT NOT NULL,
  ingress_source TEXT NOT NULL,
  authority_source TEXT,
  allowed INTEGER NOT NULL,
  enforcement_outcome TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_tenant_id TEXT,
  target_tenant_id TEXT,
  tenant_scope TEXT,
  event_type TEXT NOT NULL,
  action_type TEXT,
  violation INTEGER NOT NULL DEFAULT 0,
  duplicate_suppressed INTEGER NOT NULL DEFAULT 0,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_governance_ingress_recorded_at
  ON governance_ingress_decisions (recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_governance_ingress_scope
  ON governance_ingress_decisions (tenant_scope, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_governance_ingress_source
  ON governance_ingress_decisions (authority_source, recorded_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ux_governance_ingress_dedupe
  ON governance_ingress_decisions (
    COALESCE(tenant_scope, '_none'),
    decision_id,
    event_type,
    COALESCE(action_type, '_none')
  )
  WHERE duplicate_suppressed = 0;