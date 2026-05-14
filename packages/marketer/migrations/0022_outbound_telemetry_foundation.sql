-- Migration 0022: Outbound telemetry foundation
--
-- Adds the schema needed for contract-correct, multi-tenant telemetry:
--   - message_id lock on email sends
--   - channel lifecycle fields on contacts
--   - analytics binding metrics + fallback queue
--   - daily channel SLI rollups
--   - campaign multi-channel config fields

ALTER TABLE email_sends ADD COLUMN message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sends_message_id
  ON email_sends (message_id)
  WHERE message_id IS NOT NULL;

ALTER TABLE marketing_contacts ADD COLUMN email_opened_at INTEGER;
ALTER TABLE marketing_contacts ADD COLUMN last_engaged_at INTEGER;
ALTER TABLE marketing_contacts ADD COLUMN push_sent_at INTEGER;
ALTER TABLE marketing_contacts ADD COLUMN push_last_opened_at INTEGER;
ALTER TABLE marketing_contacts ADD COLUMN whatsapp_sent_at INTEGER;
ALTER TABLE marketing_contacts ADD COLUMN whatsapp_last_read_at INTEGER;
ALTER TABLE marketing_contacts ADD COLUMN email_bounce_type TEXT;
ALTER TABLE marketing_contacts ADD COLUMN push_bounce_reason TEXT;
ALTER TABLE marketing_contacts ADD COLUMN whatsapp_bounce_reason TEXT;

ALTER TABLE outbound_campaigns ADD COLUMN channels_json TEXT;
ALTER TABLE outbound_campaigns ADD COLUMN fallback_chain_json TEXT;

CREATE TABLE IF NOT EXISTS service_binding_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  binding TEXT NOT NULL,
  tenant_id TEXT,
  event_type TEXT,
  latency_ms INTEGER NOT NULL,
  success INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_service_binding_metrics_lookup
  ON service_binding_metrics (binding, created_at DESC, tenant_id);

CREATE TABLE IF NOT EXISTS telemetry_fallback_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  correlation_id TEXT,
  message_id TEXT,
  event_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  retryable INTEGER NOT NULL DEFAULT 1,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  replayed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_telemetry_fallback_pending
  ON telemetry_fallback_queue (replayed_at, retryable, next_attempt_at, tenant_id);

CREATE TABLE IF NOT EXISTS telemetry_channel_daily (
  date_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  opened_count INTEGER NOT NULL DEFAULT 0,
  clicked_count INTEGER NOT NULL DEFAULT 0,
  replied_count INTEGER NOT NULL DEFAULT 0,
  bounced_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  complained_count INTEGER NOT NULL DEFAULT 0,
  unsubscribed_count INTEGER NOT NULL DEFAULT 0,
  dismissed_count INTEGER NOT NULL DEFAULT 0,
  fallback_count INTEGER NOT NULL DEFAULT 0,
  avg_delivery_latency_ms REAL NOT NULL DEFAULT 0,
  delivery_latency_samples INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (date_key, channel, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_channel_daily_tenant
  ON telemetry_channel_daily (tenant_id, date_key DESC, channel);
