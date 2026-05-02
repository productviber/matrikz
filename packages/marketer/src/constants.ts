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
  // ── Share PLG Events (from visibility-analytics micro-share system) ──
  SHARE_CREATED: 'share.created',
  SHARE_VIEWED: 'share.viewed',
  SHARE_ENGAGED: 'share.engaged',
  SHARE_CTA_CLICKED: 'share.cta_clicked',
  SHARE_CONVERTED: 'share.converted',
  SHARE_REVOKED: 'share.revoked',
  // ── Shopify App Lifecycle Events (via analytics engine event bus) ──
  APP_INSTALLED: 'user.app_installed',
  APP_UNINSTALLED: 'user.app_uninstalled',
  ANALYSIS_COMPLETED: 'analysis.completed',
  FIRST_ANALYSIS: 'user.first_analysis',
  AI_CHAT_USED: 'ai.chat_used',
  PLAN_UPGRADED: 'plan.upgraded',
  PLAN_DOWNGRADED: 'plan.downgraded',
  // ── Outbound Events (from analytics discovery/enrichment pipeline) ──
  OUTBOUND_PROSPECT_DISCOVERED: 'outbound.prospect_discovered',
  OUTBOUND_PROSPECT_ENRICHED: 'outbound.prospect_enriched',
  // ── Outbound Tracking Events (reverse: marketing → analytics) ──
  OUTBOUND_EMAIL_SENT: 'outbound.email_sent',
  OUTBOUND_EMAIL_OPENED: 'outbound.email_opened',
  OUTBOUND_EMAIL_CLICKED: 'outbound.email_clicked',
  OUTBOUND_EMAIL_BOUNCED: 'outbound.email_bounced',
  OUTBOUND_EMAIL_COMPLAINED: 'outbound.email_complained',
  OUTBOUND_EMAIL_REPLIED: 'outbound.email_replied',
  OUTBOUND_UNSUBSCRIBED: 'outbound.unsubscribed',
  /** Cold-email prospect completed OAuth — closes the attribution loop. */
  OUTBOUND_PROSPECT_CONVERTED: 'outbound.prospect_converted',
  // ── Audit Funnel Events (from analytics free-audit flow) ──
  AUDIT_COMPLETED: 'audit.completed',
  LEAD_CAPTURED: 'lead.captured',
} as const;

// ─── Contact Statuses ───────────────────────────────────────────────────────

export const CONTACT_STATUS = {
  LEAD: 'lead',
  TRIAL: 'trial',
  CUSTOMER: 'customer',
  CHURNED: 'churned',
  PROSPECT: 'prospect',
  ENGAGED: 'engaged',
} as const;

// ─── Contact Sources ────────────────────────────────────────────────────────

export const CONTACT_SOURCE = {
  DIRECT: 'direct',
  ORGANIC: 'organic',
  AFFILIATE: 'affiliate',
  SHARE: 'share',
  OUTBOUND: 'outbound',
} as const;

// ─── Email Send Statuses ────────────────────────────────────────────────────

export const EMAIL_STATUS = {
  SCHEDULED: 'scheduled',
  SENT: 'sent',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

// ─── Skrip Integration ─────────────────────────────────────────────────────

export const SKRIP_CHANNEL = {
  EMAIL: 'email',
  PUSH: 'push',
  SMS: 'sms',
  WHATSAPP: 'whatsapp',
  TELEGRAM: 'telegram',
} as const;

export const SKRIP_POLICY = {
  EMAIL_ONLY: 'email_only',
  PUSH_ASSIST: 'push_assist',
  PUSH_PRIMARY_WITH_EMAIL_FALLBACK: 'push_primary_with_email_fallback',
  MULTI_CHANNEL_PROGRESSIVE: 'multi_channel_progressive',
} as const;

export const SKRIP_AUTHORITY = {
  VISIBILITY_MARKETING: 'visibility_marketing',
  SKRIP: 'skrip',
} as const;

export const SKRIP_ROLLOUT_STATE = {
  DISABLED: 'disabled',
  DRY_RUN: 'dry_run',
  ENABLED: 'enabled',
  ROLLBACK: 'rollback',
} as const;

export const SKRIP_OUTBOX_STATUS = {
  DRY_RUN: 'dry_run',
  PENDING: 'pending',
  DISPATCHED: 'dispatched',
  RETRYING: 'retrying',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export const SKRIP_CONFIG = {
  DEFAULT_TENANT_ID: 'default',
  DEFAULT_TIMEOUT_MS: 10_000,
  MAX_RETRIES: 3,
  CIRCUIT_FAILURE_THRESHOLD: 3,
  CIRCUIT_OPEN_TTL_SECS: 60,
  MAX_TIMESTAMP_DRIFT_MS: 5 * 60 * 1000,
  NONCE_TTL_SECS: 15 * 60,
  HEADER_TIMESTAMP: 'x-skrip-timestamp',
  HEADER_NONCE: 'x-skrip-nonce',
  HEADER_SIGNATURE: 'x-skrip-signature',
  HEADER_CORRELATION_ID: 'x-skrip-correlation-id',
  HEADER_TENANT_ID: 'x-vm-tenant-id',
} as const;

// ─── Agent-Led Growth Foundation ───────────────────────────────────────────

export const GROWTH_SIGNAL_STATUS = {
  ACTIVE: 'active',
  DISMISSED: 'dismissed',
  CONVERTED: 'converted',
  EXPIRED: 'expired',
} as const;

export const GROWTH_SIGNAL_SEVERITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;

export const GROWTH_SIGNAL_TYPE = {
  INSTALLED_NO_FIRST_ANALYSIS: 'installed_no_first_analysis',
  AUDIT_COMPLETED_NO_SIGNUP: 'audit_completed_no_signup',
  SIGNUP_NO_SITE_CONNECTED: 'signup_no_site_connected',
  FIRST_ANALYSIS_NO_RETURN: 'first_analysis_no_return',
  TRIAL_EXPIRING_HIGH_INTENT: 'trial_expiring_high_intent',
  UNINSTALL_WITH_RECENT_ENGAGEMENT: 'uninstall_with_recent_engagement',
  COLD_CLICKED_NO_REPLY: 'cold_clicked_no_reply',
  AUDIT_GRADE_LOW_HIGH_FIT: 'audit_grade_low_high_fit',
  PRICING_VISIT_NO_SIGNUP: 'pricing_visit_no_signup',
  SHARE_CREATED_NO_CONVERSION: 'share_created_no_conversion',
  AFFILIATE_CLICK_NO_SIGNUP: 'affiliate_click_no_signup',
  WARM_AUDIT_LEAD_FOLLOWUP: 'warm_audit_lead_followup',
} as const;

export const GROWTH_SUBJECT_TYPE = {
  CONTACT: 'contact',
  DOMAIN: 'domain',
  SHOP: 'shop',
  AFFILIATE: 'affiliate',
  SHARE: 'share',
} as const;

export const AGENT_ACTION_TYPE = {
  WAIT: 'wait',
  MANUAL_REVIEW: 'manual_review',
  ENROLL_SEQUENCE: 'enroll_sequence',
  SEND_VIA_SKRIP: 'send_via_skrip',
  PAUSE_CAMPAIGN: 'pause_campaign',
  START_CAMPAIGN: 'start_campaign',
  PAUSE_CONTACT: 'pause_contact',
  ESCALATE_TO_HUMAN: 'escalate_to_human',
} as const;

export const AGENT_ACTION_STATUS = {
  PROPOSED: 'proposed',
  POLICY_CHECKED: 'policy_checked',
  APPROVED: 'approved',
  EXECUTED: 'executed',
  REJECTED: 'rejected',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back',
  OUTCOME_OBSERVED: 'outcome_observed',
  NO_OUTCOME_OBSERVED: 'no_outcome_observed',
} as const;

export const AGENT_ACTION_EVENT = {
  PROPOSED: 'proposed',
  POLICY_CHECKED: 'policy_checked',
  APPROVED: 'approved',
  EXECUTED: 'executed',
  REJECTED: 'rejected',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back',
  OUTCOME_OBSERVED: 'outcome_observed',
  NO_OUTCOME_OBSERVED: 'no_outcome_observed',
} as const;

export const AGENT_RISK_LEVEL = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;

export const GROWTH_POLICY = {
  DEFAULT_SIGNAL_TTL_DAYS: 7,
  HIGH_INTENT_SIGNAL_TTL_DAYS: 14,
  ACTION_WINDOW_SECONDS: 24 * 60 * 60,
  DEFAULT_OUTCOME_WINDOW_SECONDS: 14 * 24 * 60 * 60,
  MAX_LIST_LIMIT: 200,
  DEFAULT_LIST_LIMIT: 50,
  DEFAULT_CONFIDENCE: 65,
  MIN_EXECUTION_CONFIDENCE: 40,
  DEFAULT_AGENT_ID: 'visibility-growth-agent',
  KILL_SWITCH_GLOBAL_KEY: 'agent:growth:kill:global',
  KILL_SWITCH_TENANT_PREFIX: 'agent:growth:kill:tenant:',
  KILL_SWITCH_CAMPAIGN_PREFIX: 'agent:growth:kill:campaign:',
  KILL_SWITCH_CHANNEL_PREFIX: 'agent:growth:kill:channel:',
  DAILY_ACTION_LIMIT: 100,
} as const;

export const AI_ENGINE_CONFIG = {
  DEFAULT_TIMEOUT_MS: 8_000,
  MAX_RETRIES: 1,
  CIRCUIT_FAILURE_THRESHOLD: 3,
  CIRCUIT_OPEN_TTL_SECS: 60,
  CAPABILITY_VERSION: '2026-05-02',
  RESPONSE_SCHEMA_VERSION: 'growth-action-v1',
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
  MILESTONE: 'milestone',
  GENERAL: 'general',
} as const;

// ─── Application Statuses ───────────────────────────────────────────────────

export const APPLICATION_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
} as const;

// ─── SQLite Boolean Flags ───────────────────────────────────────────────────

export const SQLITE_BOOL = {
  TRUE: 1,
  FALSE: 0,
} as const;

// ─── Time Durations (seconds) ───────────────────────────────────────────────

export const SECONDS_PER_DAY = 86_400;

export const TTL = {
  /** 1 day in seconds */
  DAYS_1: 1 * SECONDS_PER_DAY,
  /** 30 days in seconds */
  DAYS_30: 30 * SECONDS_PER_DAY,
  /** 90 days in seconds */
  DAYS_90: 90 * SECONDS_PER_DAY,
  /** 1 year in seconds */
  YEAR_1: 365 * SECONDS_PER_DAY,
  /** 7 days in seconds */
  DAYS_7: 7 * SECONDS_PER_DAY,
  /** 2 days in seconds (throttle counter retention) */
  DAYS_2: 2 * SECONDS_PER_DAY,
} as const;

// ─── Pagination Defaults ────────────────────────────────────────────────────

export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 200,
  MAX_CAMPAIGN_PAGE_SIZE: 100,
  PORTAL_RECENT_ITEMS: 20,
  CRON_BATCH_SIZE: 100,
} as const;

/**
 * Wall-clock budget for the cron email processing loop.
 * Cold sends have intentional 2-6 s inter-send delays to respect warmup
 * schedules and avoid IP-reputation damage. The budget stops claiming new
 * sends when the cron invocation approaches its platform timeout, ensuring
 * deferred sends are picked up cleanly on the next run rather than getting
 * orphaned mid-loop.
 */
export const CRON_EMAIL_TIME_BUDGET_MS = 25_000;

// ─── String Length Limits ───────────────────────────────────────────────────

export const MAX_LENGTH = {
  AFFILIATE_CODE: 30,
  CAMPAIGN_SLUG: 50,
  NOTIFICATION_SUMMARY: 500,
  JSON_PREVIEW_SHORT: 200,
  JSON_PREVIEW_LONG: 300,
  HASH_OUTPUT_HEX: 16,
  RANDOM_SUFFIX_START: 2,
  RANDOM_SUFFIX_END: 6,
} as const;

// ─── KV Key Prefixes ───────────────────────────────────────────────────────

export const KV_PREFIX = {
  CLICK_DEDUP: 'click-dedup:',
  AFFILIATE_STATS: 'affiliate-stats:',
  AFFILIATE_EMAIL: 'affiliate-email:',
  AFFILIATE_APPLICATION: 'affiliate-application:',
  AFFILIATE_APPLICATIONS_PENDING: 'affiliate-applications:pending',
  EMAIL_CONTEXT: 'email-ctx:',
  USER_CONVERSION: 'user-conversion:',
  DAILY_CONVERSIONS: 'daily-conversions:',
  DAILY_REVENUE: 'daily-revenue:',
  HEALTH_CHECK: '__health_check__',
  /** Stores per-affiliate payout method details (bank/UPI/Stripe account) */
  AFFILIATE_PAYOUT_DETAILS: 'affiliate-payout:',
  /** Share lead PQL data keyed by token */
  SHARE_LEAD: 'share-lead:',
  /** Aggregated share stats per owner email */
  SHARE_OWNER_STATS: 'share-owner:',
  /** Daily share view counter */
  DAILY_SHARE_VIEWS: 'daily-share-views:',
  /** Daily event counters (churn, milestone, clicks) */
  DAILY_EVENTS: 'daily-events:',
  /** Outbound warmup state per campaign */
  OUTBOUND_WARMUP: 'outbound:warmup:',
  /** Outbound daily send throttle counter */
  OUTBOUND_THROTTLE: 'outbound:throttle:',
  /** Outbound domain gap tracker */
  OUTBOUND_DOMAIN_GAP: 'outbound:domain-gap:',
  /** Deliverability daily counters (YYYY-MM-DD suffix) */
  OUTBOUND_DELIVERABILITY: 'outbound:deliverability:',
  /** Bounce records per email (soft/hard/complaint) */
  OUTBOUND_BOUNCE: 'outbound:bounce:',
  /** Engagement tracking per email (opens, clicks, last activity) */
  OUTBOUND_ENGAGEMENT: 'outbound:engagement:',
  /**
   * A/B variant correlation record written at send-time, read by webhook
   * handlers so we can credit the right variant pool on opens/clicks/replies.
   * Full key shape: `ab:send:<email>:<email_sends.id>`
   * Payload: `{ templateKey, subIdx, bodyIdx, sentAt }`
   */
  AB_SEND: 'ab:send:',
  /** Contact form submission dedup tracker (per domain) */
  OUTBOUND_FORM: 'outbound:form:',
  /** Nonce dedupe keys for replay-protected sensitive user actions */
  AUTH_NONCE: 'auth:nonce:',
  /** Feature flags for Skrip progressive enablement */
  SKRIP_FLAG: 'skrip:flag:',
  /** Circuit breaker state for Skrip upstream calls */
  SKRIP_CIRCUIT: 'skrip:circuit:',
  /** Consecutive failure counters for Skrip upstream calls */
  SKRIP_FAILURE: 'skrip:failure:',
  /** Circuit breaker state for ai-engine advisory calls */
  AI_ENGINE_CIRCUIT: 'ai-engine:circuit:',
  /** Consecutive failure counters for ai-engine advisory calls */
  AI_ENGINE_FAILURE: 'ai-engine:failure:',
} as const;

// ─── Payout Providers ──────────────────────────────────────────────────────

/**
 * Supported payout provider keys — set `PAYOUT_PROVIDER` env var to activate.
 * 'stub' is the default and safe for development.
 */
export const PAYOUT_PROVIDERS = {
  STUB: 'stub',
  RAZORPAY: 'razorpay',
  STRIPE: 'stripe',
} as const;

/** Payout method types stored in KV for each affiliate */
export const PAYOUT_METHOD = {
  UPI: 'upi',
  BANK: 'bank',
  STRIPE: 'stripe',
} as const;

/** Razorpay X2B (Business→Beneficiary) payout API endpoints */
export const RAZORPAY_API = {
  BASE: 'https://api.razorpay.com/v1',
  CONTACTS: 'https://api.razorpay.com/v1/contacts',
  FUND_ACCOUNTS: 'https://api.razorpay.com/v1/fund_accounts',
  PAYOUTS: 'https://api.razorpay.com/v1/payouts',
} as const;

/** Stripe API base */
export const STRIPE_API = {
  BASE: 'https://api.stripe.com/v1',
  TRANSFERS: 'https://api.stripe.com/v1/transfers',
  PAYOUTS: 'https://api.stripe.com/v1/payouts',
} as const;

/** Payout event types for the payout_events audit log */
export const PAYOUT_EVENT = {
  INITIATED: 'initiated',
  CONTACT_CREATED: 'contact_created',
  FUND_ACCOUNT_CREATED: 'fund_account_created',
  TRANSFER_SENT: 'transfer_sent',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SKIPPED: 'skipped',
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
  UNSUBSCRIBE: (email: string) => `${BASE_URL}/unsubscribe?email=${encodeURIComponent(email)}`,
} as const;

// ─── Route Parsing ──────────────────────────────────────────────────────────

export const ROUTE = {
  /** Length of '/r/' prefix to strip for slug extraction */
  REFERRAL_PREFIX_LEN: 3,
  /** Index of batch ID segment in /api/payouts/batch/:id/process */
  PAYOUT_BATCH_ID_INDEX: 4,
  /** Index of affiliate code in /api/affiliate/:code/payout-details */
  AFFILIATE_CODE_INDEX: 3,
} as const;

// ─── Regex Patterns ─────────────────────────────────────────────────────────

export const PATTERNS = {
  EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  SLUG_STRIP: /[^a-z0-9\s-]/g,
  SLUG_SPACES: /\s+/g,
  NOTE_PLAN: /Conversion:\s*(\w+)\s*plan/,
  NOTE_SALE_AMOUNT: /sale\s*\$(\d+\.\d+)/,
  NOTE_COMMISSION: /commission\s*\$(\d+\.\d+)/,
  ROUTE_CAMPAIGN_SLUG: /^\/api\/campaigns\/[^/]+$/,
  ROUTE_PAYOUT_BATCH_PROCESS: /^\/api\/payouts\/batch\/\d+\/process$/,
  ROUTE_PAYOUT_ID: /^\/api\/payouts\/\d+$/,
  /** Matches /api/affiliate/:code/payout-details */
  ROUTE_AFFILIATE_PAYOUT_DETAILS: /^\/api\/affiliate\/[^/]+\/payout-details$/,
} as const;

// ─── Email Configuration ────────────────────────────────────────────────────

export const EMAIL_CONFIG = {
  DEFAULT_PROVIDER: 'brevo' as const,
  BREVO_API_URL: 'https://api.brevo.com/v3/smtp/email',
  BREVO_AUTH_HEADER: 'api-key',
  SENDGRID_API_URL: 'https://api.sendgrid.com/v3/mail/send',
  SENDGRID_CONTENT_TYPE: 'text/html',
  PROMO_CODE: 'COMEBACK20',
} as const;

// ─── Cookie Configuration ───────────────────────────────────────────────────

export const COOKIE = {
  AFFILIATE_NAME: '__aff',
  SAME_SITE: 'Lax',
  SECURE: true,
} as const;

// ─── Default Values ─────────────────────────────────────────────────────────

export const DEFAULTS = {
  PAYOUT_METHOD: 'manual',
  MRR_HISTORY_START: '2024-01-01',
  NOTIFICATION_EVENT_TYPE: 'general',
  MONTHS_PER_YEAR: 12,
  PLAN_YEARLY: 'yearly',
  NOT_AVAILABLE: 'N/A',
  UNKNOWN_PLAN: 'unknown',
  ZERO_CONVERSION_RATE: '0.0%',
  REDACTED_USER_ID: 'redacted',
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

// ─── CORS Configuration ─────────────────────────────────────────────────────

export const CORS = {
  /** Fallback allowed origin — override via env.ALLOWED_ORIGIN in wrangler.toml */
  ALLOWED_ORIGIN: 'https://visibility.clodo.dev',
  ALLOWED_METHODS: 'GET, POST, PUT, DELETE, OPTIONS',
  ALLOWED_HEADERS: 'Content-Type, Authorization, x-agent-token, x-system-token, x-webhook-token, x-request-timestamp, x-request-nonce',
} as const;

// ─── Rate Limiting ──────────────────────────────────────────────────────────

export const RATE_LIMIT = {
  /** Affiliate application endpoint — 5 per hour per IP */
  APPLY_MAX: 5,
  APPLY_WINDOW_SECS: 3600,
  /** Unsubscribe endpoint — 10 per hour per IP */
  UNSUB_MAX: 10,
  UNSUB_WINDOW_SECS: 3600,
  /** GDPR export/delete — 3 per day per code */
  GDPR_MAX: 3,
  GDPR_WINDOW_SECS: 86_400,
} as const;

// ─── Event Security ────────────────────────────────────────────────────────

export const EVENT_SECURITY = {
  /** Maximum accepted event timestamp skew in seconds. */
  MAX_SKEW_SECS: 300,
  /** TTL for dedupe keys used for replay protection. */
  REPLAY_TTL_SECS: 900,
} as const;

// ─── Service Binding Header ─────────────────────────────────────────────────

/** Cloudflare sets this header on inbound service-binding requests */
export const CF_SERVICE_HEADER = 'cf-worker';

// ─── GDPR KV Prefix (also exported from gdpr.ts for consumer convenience) ──

export const KV_UNSUBSCRIBE_PREFIX = 'unsub:';

// ─── PLG (Product-Led Growth) Stages ────────────────────────────────────────

export const PLG_STAGE = {
  AWARENESS: 'awareness',
  ACTIVATION: 'activation',
  ENGAGEMENT: 'engagement',
  INTENT: 'intent',
  CONVERSION: 'conversion',
  LIFECYCLE: 'lifecycle',
} as const;

// ─── PQL (Product-Qualified Lead) Thresholds ────────────────────────────────

/**
 * Cumulative PQL score thresholds for lead status transitions.
 * The visibility-analytics worker sends pqlScoreHint per event;
 * this worker accumulates them and promotes lead status accordingly.
 */
export const PQL_THRESHOLD = {
  /** Lead is cold below this */
  WARM: 20,
  /** Lead is warm at this level */
  HOT: 50,
  /** Lead is product-qualified at this level */
  PQL: 80,
} as const;

/** Share lead statuses — maps to PQL thresholds */
export const SHARE_LEAD_STATUS = {
  COLD: 'cold',
  WARM: 'warm',
  HOT: 'hot',
  PQL: 'pql',
  CONVERTED: 'converted',
  REVOKED: 'revoked',
} as const;

// ─── Commission Tiers ───────────────────────────────────────────────────────

export interface CommissionTierDef {
  name: string;
  minConversions: number;
  rate: number; // 0.0–1.0
}

export const COMMISSION_TIERS: CommissionTierDef[] = [
  { name: 'Starter', minConversions: 0, rate: 0.20 },
  { name: 'Silver', minConversions: 10, rate: 0.25 },
  { name: 'Gold', minConversions: 50, rate: 0.30 },
  { name: 'Platinum', minConversions: 200, rate: 0.35 },
];

// ─── Earnings Milestones (cents) ────────────────────────────────────────────

/** Thresholds that trigger special milestone notifications: $100, $500, $1K, $5K */
export const EARNINGS_MILESTONES = [10_000, 50_000, 100_000, 500_000] as const;

// ─── Email Template Styles ──────────────────────────────────────────────────

export const EMAIL_STYLES = {
  FONT_FAMILY: '-apple-system, sans-serif',
  CONTAINER: 'font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;',
  HEADING: 'color: #1a1a1a;',
  FOOTER: 'margin-top: 24px; color: #666;',
  CTA_PRIMARY: 'display: inline-block; background: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;',
  CTA_SUCCESS: 'display: inline-block; background: #059669; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;',
  CTA_DANGER: 'display: inline-block; background: #dc2626; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;',
  TABLE: 'width: 100%; border-collapse: collapse; margin: 16px 0;',
  TABLE_CELL: 'padding: 8px; border-bottom: 1px solid #eee;',
  TABLE_CELL_LAST: 'padding: 8px;',
  SMALL_PRINT: 'font-size: 14px; color: #888;',
  SIGN_OFF: '— The AXEO Team',
  SIGN_OFF_PERSONAL: '— Alex from AXEO',
  SIGN_OFF_AFFILIATE: '— The AXEO Affiliate Program',
} as const;

// ─── Internationalization (i18n) Message Catalog ────────────────────────────

/**
 * All user-facing strings extracted into a message catalog.
 * This enables future multi-language support by swapping the catalog.
 *
 * Usage: `MESSAGES.errors.missingFields('email, name')`
 *        `MESSAGES.email.greeting`
 */
export const MESSAGES = {
  // ── API Error / Status Messages ──
  errors: {
    missingCodeEmail: 'Missing required params: code, email',
    invalidCredentials: 'Invalid affiliate credentials',
    missingFieldsEmailName: 'Missing required fields: email, name',
    invalidEmailFormat: 'Invalid email format',
    applicationExists: 'An application with this name already exists',
    applicationNotFound: 'Application not found',
    applicationAlreadyApproved: 'Application already approved',
    missingFieldCode: 'Missing required field: code',
    missingFieldName: 'Missing required field: name',
    missingParamCode: 'Missing required param: code',
    campaignNotFound: 'Campaign not found',
    campaignSlugExists: (slug: string) => `Campaign with slug "${slug}" already exists`,
    noValidFields: 'No valid fields to update',
    authRequired: 'Authentication required to create campaigns',
    authRequiredUpdate: 'Authentication required to update campaigns',
    batchNotFound: 'Batch not found',
    batchAlreadyProcessed: (status: string) => `Batch is already ${status}`,
    noAffiliatesFound: 'No affiliates with conversions found',
    noUnpaidEarnings: 'No unpaid earnings to process',
    routeNotFound: 'Route not found',
    internalError: 'Internal server error',
    failedCreateAffiliate: 'Failed to create affiliate in analytics worker',
    failedProcessApplication: 'Failed to process application',
    failedApproveAffiliate: 'Failed to approve affiliate',
    failedCreateCampaign: 'Failed to create campaign',
    failedUpdateCampaign: 'Failed to update campaign',
    failedCreateBatch: 'Failed to create payout batch',
    failedProcessBatch: 'Failed to process payout batch',
    failedDashboard: 'Failed to load dashboard',
    failedProcessEmails: 'Failed to process emails',
    invalidJson: 'Invalid JSON body',
    rateLimitExceeded: 'Too many requests — please try again later',
    selfReferralBlocked: 'Self-referral is not permitted',
    affiliateNotFound: 'Affiliate not found',
    invalidPayoutMethod: 'Invalid payout method — must be upi, bank, or stripe',
    missingUpiId: 'upiId is required for UPI payout method',
    missingBankDetails: 'bankAccount (name, ifsc, accountNumber) required for bank payout method',
    missingStripeAccountId: 'stripeAccountId is required for stripe payout method',
    payoutDetailsNotFound: 'No payout details configured for this affiliate',
    // ── Webhook Errors ──
    invalidWebhookPayload: 'Invalid webhook payload',
    missingWebhookFields: 'Missing event or email',
    webhookProcessingFailed: 'Webhook processing failed',
  },
  // ── GDPR / unsubscribe ──
  // ── Success Messages ──
  success: {
    applicationReceived: "Application received! We'll review it within 48 hours.",
    processedEmails: (count: number) => `Processed ${count} due emails`,
    gdprDeleted: 'All personal data has been erased.',
    unsubscribed: 'You have been unsubscribed from all marketing emails.',
    clickForwarded: 'Click event forwarded to analytics.',
    payoutDetailsSaved: 'Payout details saved successfully.',
    webhookProcessed: 'Webhook processed successfully.',
  },
  // ── Email Template Copy ──
  email: {
    greeting: 'Hi there,',
    genericBody: 'Thank you for being part of AXEO.',
    onboardingWelcomeTitle: 'Welcome to AXEO! 🚀',
    onboardingWelcomeBody: (plan: string) => `You've just unlocked the <strong>${plan}</strong> plan. Here's how to get the most out of Visibility:`,
    onboardingStep1: 'Connect your site',
    onboardingStep1Detail: 'Add your domain in the Dashboard',
    onboardingStep2: 'Link Google Search Console',
    onboardingStep2Detail: "We'll pull in your real performance data",
    onboardingStep3: 'Check your Pulse',
    onboardingStep3Detail: 'Your SEO health score updates daily',
    ctaDashboard: 'Open Your Dashboard →',
    day1Title: 'Set up your first site in 2 minutes ⏱️',
    day1Body: "Most users see their first insights within 24 hours of connecting. If you haven't already:",
    day1Step1: 'Click "Add Site" and enter your domain',
    day1Step2: 'Authorize Google Search Console access',
    day1Body2: "That's it! We'll start analyzing your SEO health immediately.",
    day3Title: 'Your first insights are ready 📊',
    day3Body: 'By now, Visibility has been analyzing your site for a few days. Check your dashboard for:',
    day3Item1: 'Your <strong>SEO Health Score</strong>',
    day3Item2: '<strong>Top opportunities</strong> — pages with quick-win potential',
    day3Item3: '<strong>Action items</strong> — prioritized fixes for maximum impact',
    ctaInsights: 'See Your Insights →',
    day7Title: 'Pro tips from power users 💡',
    day7Body: "You've been using AXEO for a week! Here are tips from our top users:",
    day7Tip1: '<strong>Set up weekly reports</strong> — Track your progress automatically',
    day7Tip2: '<strong>Use the AI assistant</strong> — Ask it about any metric for deeper analysis',
    day7Tip3: '<strong>Share reports</strong> — Send SEO snapshots to your team or clients',
    day7Footer: 'Questions? Just reply to this email — we read every message.',
    commissionTitle: 'You earned a commission! 🎉',
    commissionBody: 'A user you referred just made a purchase. Here are the details:',
    labelPlan: 'Plan',
    labelSaleAmount: 'Sale Amount',
    labelCommission: 'Your Commission',
    labelTotalEarnings: 'Total Earnings',
    ctaAffiliateDashboard: 'View Your Dashboard →',
    welcomeTitle: 'Welcome to AXEO 👋',
    welcomeBody: 'Thanks for signing up! AXEO gives you real-time insights into your search engine performance.',
    welcomeWhat: "Here's what you can do right now:",
    welcomeStep1: 'Connect your Google Search Console',
    welcomeStep2: 'Check your SEO Pulse',
    welcomeStep2Detail: "your site's health score",
    welcomeStep3: 'Explore AI-powered insights',
    ctaGetStarted: 'Get Started →',
    welcomeDay1Title: 'Your first SEO check ✅',
    welcomeDay1Body: 'Have you connected your first site yet? It only takes a minute:',
    ctaConnectSite: 'Connect a Site →',
    welcomeDay1Body2: "Once connected, you'll get daily insights on your search performance.",
    welcomeDay3Title: 'Tips that top users love 🌟',
    welcomeDay3Body: 'Our most successful users do these 3 things:',
    welcomeDay3Tip1: '<strong>Check their Pulse daily</strong> — Even a 1-minute glance keeps you ahead',
    welcomeDay3Tip2: '<strong>Act on the top recommendation</strong> — Our AI prioritizes what matters most',
    welcomeDay3Tip3: '<strong>Share reports with their team</strong> — Alignment drives results',
    ctaPlans: 'See our plans →',
    winbackDay1Title: 'We miss you 👋',
    winbackDay1Body: "We noticed your AXEO subscription has ended. Here's what's new since you left:",
    winbackDay1Item1: 'New AI-powered content recommendations',
    winbackDay1Item2: 'Improved keyword tracking accuracy',
    winbackDay1Item3: 'Faster dashboard loading',
    ctaReactivate: 'Reactivate Your Account →',
    winbackDay3Title: 'Your SEO data is waiting 📈',
    winbackDay3Body: 'Your historical SEO data is still in our system. Reactivate to pick up right where you left off — no setup needed.',
    ctaComeBack: 'Come Back →',
    winbackDay7Title: '20% off to come back 🎁',
    winbackDay7Body: (promoCode: string) => `We'd love to have you back. Use code <strong>${promoCode}</strong> for 20% off any plan.`,
    ctaClaim: 'Claim 20% Off →',
    winbackDay7Expiry: 'Offer valid for 7 days.',
    winbackDay14Title: 'Final reminder — your data expires soon ⏳',
    winbackDay14Body: 'Your historical SEO data will be archived in 14 days. After that, you\'ll need to start fresh.',
    winbackDay14Body2: 'Reactivate now to keep your data and continue tracking your progress.',
    ctaReactivateNow: 'Reactivate Now →',
    unsubscribeText: 'Unsubscribe from these emails',
  },
  // ── Notification Messages ──
  notifications: {
    newConversion: (plan: string, amount: string, gateway: string) =>
      `💰 **New Conversion!**\nPlan: ${plan}\nAmount: ${amount}\nGateway: ${gateway}`,
    affiliateConversion: (code: string, plan: string, amount: string, commission: string) =>
      `🤝 **Affiliate Conversion!**\nAffiliate: ${code}\nPlan: ${plan}\nSale: ${amount}\nCommission: ${commission}`,
    tierUpgrade: (code: string, tierName: string, rate: number) =>
      `🏆 **Affiliate Tier Upgrade!**\nAffiliate: ${code}\nNew Tier: ${tierName} (${(rate * 100).toFixed(0)}% commission)`,
    earningsMilestone: (code: string, amount: string) =>
      `🎯 **Affiliate Milestone!**\nAffiliate: ${code}\nTotal Earnings: ${amount}`,
    payoutCompleted: (batchId: number, total: string, count: number) =>
      `💸 **Payout Batch Completed!**\nBatch #${batchId}\nTotal: ${total}\nAffiliates: ${count}`,
    shareConversion: (ownerEmail: string, token: string, newUserId: string) =>
      `🔗 **Share Conversion!**\nOwner: ${ownerEmail}\nShare: ${token}\nNew User: ${newUserId}`,
    shareHighEngagement: (token: string, dwellSeconds: number, pqlScore: number) =>
      `🔥 **High-Engagement Share Lead!**\nShare: ${token}\nDwell: ${dwellSeconds}s\nPQL Score: ${pqlScore}`,
    sharePQLReached: (token: string, pqlScore: number) =>
      `🎯 **Share Lead Reached PQL!**\nShare: ${token}\nPQL Score: ${pqlScore}`,
  },
  // ── Affiliate Notes ──
  notes: {
    applicationSubmitted: (email: string, name: string, website: string) =>
      `Application submitted by ${email} (${name}). Website: ${website}`,
    approved: (ratePercent: string) =>
      `Approved with ${ratePercent}% commission rate`,
    tierUpgrade: (tierName: string, ratePercent: string, conversions: number) =>
      `Upgraded to ${tierName} tier (${ratePercent}% commission) at ${conversions} conversions`,
    payoutProcessed: (amount: string, method: string, reference: string) =>
      `Payout of ${amount} via ${method} (ref: ${reference})`,
    payoutFailed: (amount: string, method: string, errorMessage: string) =>
      `Payout of ${amount} via ${method} failed: ${errorMessage}`,
    payoutDetailsUpdated: (method: string) =>
      `Payout details updated — method: ${method}`,
    userSignupEnrolled: (email: string, steps: number) =>
      `User ${email} enrolled in ${steps} welcome email step(s)`,
    shareCreated: (owner: string, token: string, scopes: string) =>
      `Share created by ${owner}: ${token} (scopes: ${scopes})`,
    shareConversion: (owner: string, token: string, newUser: string) =>
      `Share ${token} by ${owner} converted — new user: ${newUser}`,
    shareRevoked: (owner: string, token: string) =>
      `Share ${token} revoked by ${owner}`,
  },
} as const;

// ─── Currency / Locale ──────────────────────────────────────────────────────

export const CURRENCY = {
  CODE: 'USD',
  SYMBOL: '$',
  DECIMALS: 2,
  LOCALE: 'en-US',
} as const;

// ─── Outbound Compliance Thresholds ─────────────────────────────────────────

/**
 * TLD → estimated UTC offset for send-window optimization.
 * Covers the most common TLDs seen in outbound prospects.
 * Falls back to 0 (UTC/London) for unknown TLDs.
 */
export const TLD_UTC_OFFSET: Record<string, number> = {
  'com': -5, 'net': -5, 'org': -5, 'io': 0, 'dev': -5,
  'co.uk': 0, 'uk': 0, 'eu': 1,
  'de': 1, 'fr': 1, 'nl': 1, 'it': 1, 'es': 1, 'at': 1, 'ch': 1, 'be': 1,
  'au': 10, 'nz': 12, 'jp': 9, 'kr': 9, 'sg': 8, 'in': 5,
  'ca': -5, 'us': -5, 'br': -3,
  'se': 1, 'no': 1, 'dk': 1, 'fi': 2, 'pl': 1, 'cz': 1,
  'il': 2, 'ae': 4, 'za': 2,
};

/** Ideal local send window: 9am–11am and 1pm–3pm recipient time. */
export const SEND_WINDOW = {
  IDEAL_START: 9,
  IDEAL_END: 16,
} as const;

/**
 * Personal / freemail domains — never enroll in cold outreach.
 * Canonical list shared with visibility-analytics COMPLIANCE.BLOCKED_DOMAINS.
 */
export const PERSONAL_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'mail.com', 'protonmail.com', 'zoho.com', 'yandex.com',
  'gmx.com', 'gmx.de', 'live.com', 'msn.com', 'me.com',
  'hey.com', 'fastmail.com', 'inbox.com',
  'web.de', 'mail.ru', 'qq.com',
  'yahoo.co.uk', 'yahoo.co.jp', 'outlook.de', 'outlook.fr',
  'pm.me', 'tutanota.com', 'cock.li', 'riseup.net',
]);

/**
 * Check if an email address uses a personal / freemail domain.
 * Mirrors analytics-side isPersonalEmail() for consistency.
 */
export function isPersonalEmail(email: string): boolean {
  if (!email) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return true;
  return PERSONAL_EMAIL_DOMAINS.has(domain);
}

export const COMPLIANCE = {
  /** Max cold emails per sequence (CAN-SPAM best practice). */
  MAX_SEQUENCE_STEPS: 3,
  /** Auto-pause campaign if bounce rate exceeds 5%. */
  MAX_BOUNCE_RATE: 0.05,
  /** Auto-pause campaign if complaint rate exceeds 0.1%. */
  MAX_COMPLAINT_RATE: 0.001,
  /** Soft bounce strikes before permanent suppress. */
  SOFT_BOUNCE_THRESHOLD: 3,
  /** Soft bounce window in seconds (7 days). */
  SOFT_BOUNCE_WINDOW: 7 * SECONDS_PER_DAY,
  /** Deliverability counter retention in seconds (30 days). */
  DELIVERABILITY_RETENTION: 30 * SECONDS_PER_DAY,
  /** Permanent suppress TTL — effectively forever. */
  PERMANENT_SUPPRESS_TTL: TTL.YEAR_1 * 10,
} as const;

// ─── White-Label / Branding Defaults ────────────────────────────────────────

/**
 * Default brand strings. Override via env vars for white-labelling:
 *   BRAND_NAME, BRAND_PRODUCT, BRAND_TAGLINE, BRAND_DOMAIN
 */
export const BRAND = {
  NAME: 'AXEO',
  PRODUCT: 'Visibility',
  TAGLINE: 'Free SEO intelligence for modern teams',
  DOMAIN: 'visibility.clodo.dev',
  SUPPORT_EMAIL: 'support@visibility.clodo.dev',
} as const;

/**
 * Resolve a brand value with env override.
 * Pattern: env.BRAND_NAME ?? BRAND.NAME
 */
export function resolveBrand(env: Record<string, unknown>, key: keyof typeof BRAND): string {
  const envKey = `BRAND_${key}`;
  return (env as Record<string, string>)[envKey] ?? BRAND[key];
}
