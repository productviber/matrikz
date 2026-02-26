-- Visibility Cockpit Database Schema
-- Shared D1 database for both analytics and marketer workers

-- Users table (shared by both workers)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  subscription_tier TEXT DEFAULT 'starter', -- 'starter', 'pro', 'enterprise'
  trial_ends_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Sites table (shared by both workers)
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  domain TEXT NOT NULL,
  health_score INTEGER DEFAULT 0,
  domain_authority INTEGER DEFAULT 0,
  content_strength INTEGER DEFAULT 0,
  technical_health INTEGER DEFAULT 0,
  traffic_potential INTEGER DEFAULT 0,
  last_analyzed_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, domain)
);

-- Analytics-specific: GSC data
CREATE TABLE IF NOT EXISTS gsc_data (
  site_id TEXT NOT NULL REFERENCES sites(id),
  date TEXT NOT NULL,
  keyword TEXT NOT NULL,
  position REAL,
  clicks INTEGER,
  impressions INTEGER,
  ctr REAL,
  created_at INTEGER,
  PRIMARY KEY (site_id, date, keyword),
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

-- Analytics-specific: Bing data
CREATE TABLE IF NOT EXISTS bing_data (
  site_id TEXT NOT NULL REFERENCES sites(id),
  date TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER,
  created_at INTEGER,
  PRIMARY KEY (site_id, date, metric),
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

-- Analytics-specific: Cloudflare data
CREATE TABLE IF NOT EXISTS cloudflare_data (
  site_id TEXT NOT NULL REFERENCES sites(id),
  date TEXT NOT NULL,
  requests INTEGER,
  cached_bandwidth INTEGER,
  uncached_bandwidth INTEGER,
  threats_blocked INTEGER,
  created_at INTEGER,
  PRIMARY KEY (site_id, date),
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

-- Marketer-specific: Conversions
CREATE TABLE IF NOT EXISTS conversions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  source TEXT NOT NULL, -- 'organic', 'affiliate', 'referral', 'paid', 'direct'
  affiliate_id TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  referrer TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);

-- Marketer-specific: Affiliates
CREATE TABLE IF NOT EXISTS affiliates (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  commission_rate REAL DEFAULT 0.20, -- 20% default
  total_conversions INTEGER DEFAULT 0,
  total_commission_paid REAL DEFAULT 0,
  status TEXT DEFAULT 'active', -- 'active', 'paused', 'inactive'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Marketer-specific: Email campaigns
CREATE TABLE IF NOT EXISTS email_campaigns (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  template TEXT,
  status TEXT DEFAULT 'draft', -- 'draft', 'scheduled', 'sent', 'archived'
  sent_at INTEGER,
  opened_count INTEGER DEFAULT 0,
  clicked_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sites_user_id ON sites(user_id);
CREATE INDEX IF NOT EXISTS idx_gsc_data_site_date ON gsc_data(site_id, date);
CREATE INDEX IF NOT EXISTS idx_conversions_user_id ON conversions(user_id);
CREATE INDEX IF NOT EXISTS idx_conversions_affiliate_id ON conversions(affiliate_id);
CREATE INDEX IF NOT EXISTS idx_conversions_created_at ON conversions(created_at);
