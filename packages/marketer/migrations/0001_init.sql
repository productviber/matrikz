-- Visibility Marketing Worker — D1 Schema
-- This migration creates all tables for the marketing-specific database.

-- ─── Marketing Contacts (CRM) ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketing_contacts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'lead',  -- lead | trial | customer | churned
  source          TEXT,                           -- organic | affiliate | direct | campaign
  affiliate_code  TEXT,
  first_seen_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  converted_at    INTEGER,
  plan            TEXT,
  gateway         TEXT,
  total_spent_cents INTEGER NOT NULL DEFAULT 0,
  metadata        TEXT,                           -- JSON blob for extensibility
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_contacts_status ON marketing_contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_affiliate ON marketing_contacts(affiliate_code);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON marketing_contacts(email);

-- ─── Email Sequences ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_sequences (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  trigger_event   TEXT NOT NULL,
  description     TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS email_steps (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_id     INTEGER NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  step_order      INTEGER NOT NULL,
  subject         TEXT NOT NULL,
  template_key    TEXT NOT NULL,
  delay_seconds   INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(sequence_id, step_order)
);

CREATE TABLE IF NOT EXISTS email_sends (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_email   TEXT NOT NULL,
  sequence_id     INTEGER NOT NULL REFERENCES email_sequences(id),
  step_id         INTEGER NOT NULL REFERENCES email_steps(id),
  status          TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | sent | failed | cancelled
  scheduled_at    INTEGER NOT NULL,
  sent_at         INTEGER,
  error           TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_sends_status ON email_sends(status);
CREATE INDEX IF NOT EXISTS idx_sends_scheduled ON email_sends(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_sends_contact ON email_sends(contact_email);

-- ─── Affiliate Notes / Activity Log ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS affiliate_notes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  affiliate_code  TEXT NOT NULL,
  note_type       TEXT NOT NULL DEFAULT 'general', -- conversion | tier_upgrade | payout | general
  content         TEXT NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_notes_affiliate ON affiliate_notes(affiliate_code);

-- ─── Campaigns / Referral Links ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS campaigns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  affiliate_code  TEXT,
  utm_source      TEXT NOT NULL DEFAULT 'affiliate',
  utm_medium      TEXT NOT NULL DEFAULT 'referral',
  utm_campaign    TEXT NOT NULL,
  utm_content     TEXT,
  utm_term        TEXT,
  destination_url TEXT NOT NULL DEFAULT 'https://visibility.clodo.dev',
  clicks          INTEGER NOT NULL DEFAULT 0,
  conversions     INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_campaigns_slug ON campaigns(slug);
CREATE INDEX IF NOT EXISTS idx_campaigns_affiliate ON campaigns(affiliate_code);

-- ─── Payout Batches ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payout_batches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | processing | completed | failed
  total_amount_cents INTEGER NOT NULL DEFAULT 0,
  affiliate_count INTEGER NOT NULL DEFAULT 0,
  initiated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at    INTEGER,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS payout_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        INTEGER NOT NULL REFERENCES payout_batches(id) ON DELETE CASCADE,
  affiliate_code  TEXT NOT NULL,
  affiliate_email TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  method          TEXT,        -- paypal | bank_transfer | crypto
  reference       TEXT,        -- transaction reference
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_payout_items_batch ON payout_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_payout_items_affiliate ON payout_items(affiliate_code);

-- ─── Notification Log ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel         TEXT NOT NULL,   -- slack | discord | email
  event_type      TEXT NOT NULL,
  payload_summary TEXT,
  status          TEXT NOT NULL DEFAULT 'sent', -- sent | failed
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ─── MRR / Revenue Snapshots ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mrr_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date_key        TEXT NOT NULL UNIQUE,    -- YYYY-MM-DD
  mrr_cents       INTEGER NOT NULL DEFAULT 0,
  arr_cents       INTEGER NOT NULL DEFAULT 0,
  total_customers INTEGER NOT NULL DEFAULT 0,
  new_customers   INTEGER NOT NULL DEFAULT 0,
  churned_customers INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_mrr_date ON mrr_snapshots(date_key);

-- ─── Seed Default Email Sequences ───────────────────────────────────────────

INSERT INTO email_sequences (name, trigger_event, description) VALUES
  ('Post-Purchase Onboarding', 'user.converted', 'Sent after a user completes a purchase'),
  ('Affiliate Commission Notification', 'affiliate.conversion', 'Notifies affiliate of earned commission'),
  ('Welcome Sequence', 'user.signup', 'Onboarding for new signups'),
  ('Win-Back Sequence', 'user.churned', 'Re-engagement for churned users');

-- Post-Purchase Onboarding steps
INSERT INTO email_steps (sequence_id, step_order, subject, template_key, delay_seconds) VALUES
  (1, 1, 'Welcome to Visibility! Here''s your quick-start guide', 'onboarding-welcome', 0),
  (1, 2, 'Day 1: Set up your first site in 2 minutes', 'onboarding-day1', 86400),
  (1, 3, 'Day 3: Your first insights are ready', 'onboarding-day3', 259200),
  (1, 4, 'Day 7: Pro tips from power users', 'onboarding-day7', 604800);

-- Affiliate Commission Notification steps
INSERT INTO email_steps (sequence_id, step_order, subject, template_key, delay_seconds) VALUES
  (2, 1, 'You earned a commission!', 'affiliate-commission', 0);

-- Welcome Sequence steps
INSERT INTO email_steps (sequence_id, step_order, subject, template_key, delay_seconds) VALUES
  (3, 1, 'Welcome to Visibility — let''s get started', 'welcome-signup', 0),
  (3, 2, 'Day 1: Your first SEO check', 'welcome-day1', 86400),
  (3, 3, 'Day 3: Tips that top users love', 'welcome-day3', 259200);

-- Win-Back Sequence steps
INSERT INTO email_steps (sequence_id, step_order, subject, template_key, delay_seconds) VALUES
  (4, 1, 'We miss you — here''s what''s new', 'winback-day1', 86400),
  (4, 2, 'Your SEO data is waiting', 'winback-day3', 259200),
  (4, 3, 'Last chance: 20% off to come back', 'winback-day7', 604800),
  (4, 4, 'Final reminder — your data expires soon', 'winback-day14', 1209600);
