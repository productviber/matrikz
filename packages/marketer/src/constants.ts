/**
 * Centralized Constants — All magic numbers, strings, and configuration
 * values that were previously scattered across the codebase.
 *
 * Organized by domain for easy discovery and maintenance.
 */

// ─── Worker Identity ────────────────────────────────────────────────────────

export const WORKER_NAME = 'visibility-marketing';
export const WORKER_VERSION = '1.0.0';

// ─── Trusted Sources ────────────────────────────────────────────────────────

export const TRUSTED_SOURCE = 'visibility-analytics';

// ─── Event Types ────────────────────────────────────────────────────────────

export const EVENT_TYPES = {
  AFFILIATE_CONVERSION: 'affiliate.conversion',
  USER_CONVERTED: 'user.converted',
  USER_SIGNUP: 'user.signup',
  USER_CHURNED: 'user.churned',
  USER_MILESTONE: 'user.milestone',
  AFFILIATE_CLICK: 'affiliate.click',
  INSIGHT_GENERATED: 'insight.generated',
  TRIAL_EXPIRING: 'trial.expiring',
} as const;

// ─── Contact Statuses ───────────────────────────────────────────────────────

export const CONTACT_STATUS = {
  LEAD: 'lead',
  TRIAL: 'trial',
  CUSTOMER: 'customer',
  CHURNED: 'churned',
} as const;

// ─── Contact Sources ────────────────────────────────────────────────────────

export const CONTACT_SOURCE = {
  DIRECT: 'direct',
  ORGANIC: 'organic',
  AFFILIATE: 'affiliate',
} as const;

// ─── Email Send Statuses ────────────────────────────────────────────────────

export const EMAIL_STATUS = {
  SCHEDULED: 'scheduled',
  SENT: 'sent',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

// ─── Payout Statuses ────────────────────────────────────────────────────────

export const PAYOUT_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SENT: 'sent',
} as const;

// ─── Affiliate Note Types ───────────────────────────────────────────────────

export const NOTE_TYPE = {
  CONVERSION: 'conversion',
  TIER_UPGRADE: 'tier_upgrade',
  PAYOUT: 'payout',
  GENERAL: 'general',
} as const;

// ─── Application Statuses ───────────────────────────────────────────────────

export const APPLICATION_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
} as const;

// ─── Time Durations (seconds) ───────────────────────────────────────────────

export const SECONDS_PER_DAY = 86_400;

export const TTL = {
  /** 30 days in seconds */
  DAYS_30: 30 * SECONDS_PER_DAY,
  /** 90 days in seconds */
  DAYS_90: 90 * SECONDS_PER_DAY,
  /** 1 year in seconds */
  YEAR_1: 365 * SECONDS_PER_DAY,
} as const;

// ─── Pagination Defaults ────────────────────────────────────────────────────

export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 200,
  MAX_CAMPAIGN_PAGE_SIZE: 100,
  PORTAL_RECENT_ITEMS: 20,
  CRON_BATCH_SIZE: 100,
} as const;

// ─── String Length Limits ───────────────────────────────────────────────────

export const MAX_LENGTH = {
  AFFILIATE_CODE: 30,
  CAMPAIGN_SLUG: 50,
  NOTIFICATION_SUMMARY: 500,
  JSON_PREVIEW_SHORT: 200,
  JSON_PREVIEW_LONG: 300,
  HASH_OUTPUT_HEX: 16,
} as const;

// ─── KV Key Prefixes ───────────────────────────────────────────────────────

export const KV_PREFIX = {
  AFFILIATE_STATS: 'affiliate-stats:',
  AFFILIATE_EMAIL: 'affiliate-email:',
  AFFILIATE_APPLICATION: 'affiliate-application:',
  AFFILIATE_APPLICATIONS_PENDING: 'affiliate-applications:pending',
  EMAIL_CONTEXT: 'email-ctx:',
  USER_CONVERSION: 'user-conversion:',
  DAILY_CONVERSIONS: 'daily-conversions:',
  DAILY_REVENUE: 'daily-revenue:',
  HEALTH_CHECK: '__health_check__',
} as const;

// ─── UTM Defaults ───────────────────────────────────────────────────────────

export const UTM_DEFAULTS = {
  SOURCE: 'affiliate',
  MEDIUM: 'referral',
} as const;

// ─── Base URLs ──────────────────────────────────────────────────────────────

export const BASE_URL = 'https://visibility.clodo.dev';

export const APP_URLS = {
  HOME: BASE_URL,
  COCKPIT: `${BASE_URL}/cockpit`,
  AFFILIATE_PORTAL: `${BASE_URL}/affiliate/portal`,
  PRICING: `${BASE_URL}/pricing`,
  PRICING_PROMO: (code: string) => `${BASE_URL}/pricing?promo=${code}`,
} as const;

// ─── Email Configuration ────────────────────────────────────────────────────

export const EMAIL_CONFIG = {
  DEFAULT_PROVIDER: 'brevo' as const,
  BREVO_API_URL: 'https://api.brevo.com/v3/smtp/email',
  SENDGRID_API_URL: 'https://api.sendgrid.com/v3/mail/send',
  PROMO_CODE: 'COMEBACK20',
} as const;

// ─── Cookie Configuration ───────────────────────────────────────────────────

export const COOKIE = {
  AFFILIATE_NAME: '__aff',
} as const;

// ─── Default Values ─────────────────────────────────────────────────────────

export const DEFAULTS = {
  PAYOUT_METHOD: 'manual',
  MRR_HISTORY_START: '2024-01-01',
  NOTIFICATION_EVENT_TYPE: 'general',
  MONTHS_PER_YEAR: 12,
  PLAN_YEARLY: 'yearly',
} as const;

// ─── Notification Channel ───────────────────────────────────────────────────

export const NOTIFICATION_CHANNEL = {
  SLACK: 'slack',
  DISCORD: 'discord',
  EMAIL: 'email',
} as const;

// ─── Service Binding ────────────────────────────────────────────────────────

export const INTERNAL_BASE_URL = 'https://internal';

// ─── Content Types ──────────────────────────────────────────────────────────

export const CONTENT_TYPE_JSON = 'application/json';

// ─── Email Template Styles ──────────────────────────────────────────────────

export const EMAIL_STYLES = {
  FONT_FAMILY: '-apple-system, sans-serif',
  CONTAINER: 'font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;',
  HEADING: 'color: #1a1a1a;',
  FOOTER: 'margin-top: 24px; color: #666;',
  CTA_PRIMARY: 'display: inline-block; background: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;',
  CTA_SUCCESS: 'display: inline-block; background: #059669; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;',
  CTA_DANGER: 'display: inline-block; background: #dc2626; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;',
  SIGN_OFF: '— The Clodo SEO Team',
  SIGN_OFF_AFFILIATE: '— The Clodo SEO Affiliate Program',
} as const;
