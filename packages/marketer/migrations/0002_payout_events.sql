-- Visibility Marketing Worker — Migration 0002
-- Adds the payout_events audit log table for admin observability.
--
-- All payout provider interactions (Razorpay X2B, Stripe Transfers, Stub)
-- write a structured event row here, giving admins full visibility into:
--   - Which affiliates were paid / skipped / failed
--   - Which provider handled each payout
--   - Intermediate steps (contact_created, fund_account_created, transfer_sent)
--   - Error messages for failed payouts

CREATE TABLE IF NOT EXISTS payout_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        INTEGER NOT NULL REFERENCES payout_batches(id) ON DELETE CASCADE,
  affiliate_code  TEXT NOT NULL,
  event_type      TEXT NOT NULL,   -- initiated | contact_created | fund_account_created | transfer_sent | succeeded | failed | skipped
  provider        TEXT NOT NULL,   -- razorpay | stripe | stub
  reference       TEXT,            -- provider-assigned ID at each step
  amount_cents    INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,   -- success | failure
  error           TEXT,            -- present on failure events
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_payout_events_batch    ON payout_events(batch_id);
CREATE INDEX IF NOT EXISTS idx_payout_events_affiliate ON payout_events(affiliate_code);
CREATE INDEX IF NOT EXISTS idx_payout_events_type      ON payout_events(event_type);
CREATE INDEX IF NOT EXISTS idx_payout_events_status    ON payout_events(status);
