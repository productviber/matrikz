-- Migration 0015: Add address column to contact_channel_identities
--
-- Stores the channel-specific address (push token, phone number, Telegram chat ID, etc.)
-- required by Skrip for contact registration and message delivery.

ALTER TABLE contact_channel_identities
  ADD COLUMN address TEXT;

CREATE INDEX IF NOT EXISTS idx_contact_channel_identities_address
  ON contact_channel_identities (tenant_id, channel, address)
  WHERE address IS NOT NULL;
