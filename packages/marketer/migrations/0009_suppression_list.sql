-- Persistent Suppression List — CAN-SPAM compliance.
--
-- KV-based unsubscribe flags expire with TTL. If a suppressed prospect
-- re-appears via a new discovery cycle after TTL expiry, they could be
-- re-enrolled in sequences. This table provides a permanent, D1-backed
-- suppression record that survives KV expirations.
--
-- Checked on every enrollment attempt in outbound-events.ts.

CREATE TABLE IF NOT EXISTS suppression_list (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  reason      TEXT NOT NULL,      -- 'hard_bounce' | 'spam_complaint' | 'unsubscribed' | 'manual'
  source      TEXT,               -- 'brevo_webhook' | 'admin' | 'user_request'
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata    TEXT                -- Optional JSON context
);

CREATE INDEX IF NOT EXISTS idx_suppression_email ON suppression_list(email);
