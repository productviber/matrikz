-- 0017: Agent-action linkage columns + recipient identity token table
--
-- A. Add agent_action_id to channel_execution_outbox and channel_message_lineage
--    so send_via_skrip executions can be traced back to the originating action.
--
-- B. Create recipient_identity_tokens for HMAC-signed outbound link tracking:
--    clicking a tracked link resolves the contact without requiring login.

ALTER TABLE channel_execution_outbox ADD COLUMN agent_action_id TEXT;
ALTER TABLE channel_message_lineage  ADD COLUMN agent_action_id TEXT;

CREATE INDEX IF NOT EXISTS idx_outbox_agent_action
  ON channel_execution_outbox (agent_action_id)
  WHERE agent_action_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lineage_agent_action
  ON channel_message_lineage (agent_action_id)
  WHERE agent_action_id IS NOT NULL;

-- ── Recipient identity tokens ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS recipient_identity_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT NOT NULL UNIQUE,           -- SHA-256 hex of the raw token (never store raw)
  contact_id   TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  purpose      TEXT NOT NULL,                  -- e.g. 'subscribe', 'unsubscribe', 'verify'
  correlation_id TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  verified_at  INTEGER,                        -- NULL = not yet used
  verify_ip    TEXT,
  verify_ua    TEXT
);

CREATE INDEX IF NOT EXISTS idx_recipient_tokens_contact
  ON recipient_identity_tokens (contact_id, tenant_id, purpose);

CREATE INDEX IF NOT EXISTS idx_recipient_tokens_expiry
  ON recipient_identity_tokens (expires_at)
  WHERE verified_at IS NULL;
