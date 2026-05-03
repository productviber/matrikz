-- Migration 0016: Push notification receipt tracking + status projection
--
-- Adds durable notification status tracking so the browser SW can report
-- delivered/clicked/dismissed events and the backend can expose
-- GET /api/push/status/:notificationId for end-to-end verification.

CREATE TABLE IF NOT EXISTS push_notifications (
  notification_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  contact_id TEXT,
  campaign_id TEXT,
  step_id TEXT,
  channel TEXT NOT NULL DEFAULT 'push',
  sent_at INTEGER,
  delivered_at INTEGER,
  clicked_at INTEGER,
  dismissed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_notifications_tenant_created
  ON push_notifications (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS push_notification_receipt_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id TEXT NOT NULL,
  receipt_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  correlation_id TEXT,
  receipt_id TEXT UNIQUE,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(notification_id) REFERENCES push_notifications(notification_id)
);

CREATE INDEX IF NOT EXISTS idx_push_receipts_notification
  ON push_notification_receipt_events (notification_id, occurred_at DESC);
