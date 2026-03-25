-- Add per-campaign warmup schedule.
--
-- Moves the warmup schedule from a hardcoded constant in code to a
-- per-campaign setting stored in D1. Each campaign can now have its own
-- ramp (e.g. aggressive 7-day test vs conservative 30-day build).
--
-- warmup_schedule is a JSON array: [{ "day": 1, "dailyLimit": 20 }, ...]
-- NULL means "use the default 30-day schedule from code".

ALTER TABLE outbound_campaigns
  ADD COLUMN warmup_schedule TEXT;  -- JSON array or NULL (= use default)

-- Update the existing seed campaign with the default 30-day schedule
UPDATE outbound_campaigns
SET warmup_schedule = '[{"day":1,"dailyLimit":10},{"day":3,"dailyLimit":20},{"day":7,"dailyLimit":35},{"day":14,"dailyLimit":50},{"day":21,"dailyLimit":75},{"day":30,"dailyLimit":150}]'
WHERE slug = 'cold-outreach-v1';
