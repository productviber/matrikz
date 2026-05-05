-- Migration 0018: Campaign objectives
--
-- Strategic campaign intent records for downstream execution planning.

CREATE TABLE IF NOT EXISTS campaign_objectives (
  id TEXT PRIMARY KEY,
  objective_type TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  business_goal_statement TEXT NOT NULL,
  urgency TEXT NOT NULL,
  success_metric_primary TEXT NOT NULL,
  success_metric_secondary TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  CHECK (objective_type IN ('activation', 'retention', 'reactivation', 'conversion', 'expansion')),
  CHECK (urgency IN ('low', 'medium', 'high')),
  CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  CHECK (length(campaign_name) <= 80),
  CHECK (length(business_goal_statement) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_campaign_objectives_status_updated
  ON campaign_objectives (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_campaign_objectives_type_updated
  ON campaign_objectives (objective_type, updated_at DESC);

INSERT INTO campaign_objectives (
  id,
  objective_type,
  campaign_name,
  business_goal_statement,
  urgency,
  success_metric_primary,
  success_metric_secondary,
  start_at,
  end_at,
  timezone,
  dry_run,
  created_by,
  created_at,
  updated_at,
  status
)
SELECT
  'obj_demo_retention_local',
  'retention',
  'Demo Retention Sprint',
  'Recover recently dormant product users before they churn out of the lifecycle entirely.',
  'medium',
  'Reactivated users within 14 days',
  'Follow-up reply rate',
  '2026-05-05T09:00:00.000Z',
  '2026-05-19T17:00:00.000Z',
  'UTC',
  1,
  'seed:local-demo',
  1777856400,
  1777856400,
  'draft'
WHERE NOT EXISTS (
  SELECT 1 FROM campaign_objectives WHERE id = 'obj_demo_retention_local'
);