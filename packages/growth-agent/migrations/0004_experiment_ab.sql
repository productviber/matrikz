-- Risk 8: A/B experiment primitive
-- Adds experiment tracking columns to both recommendation_log and outcome_records.
-- SQLite supports adding nullable columns without data migration.

ALTER TABLE recommendation_log ADD COLUMN experiment_id TEXT;
ALTER TABLE recommendation_log ADD COLUMN arm TEXT;

ALTER TABLE outcome_records ADD COLUMN experiment_id TEXT;
ALTER TABLE outcome_records ADD COLUMN arm TEXT;

CREATE INDEX IF NOT EXISTS idx_recommendation_log_experiment
  ON recommendation_log(experiment_id) WHERE experiment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outcome_records_experiment
  ON outcome_records(experiment_id) WHERE experiment_id IS NOT NULL;
