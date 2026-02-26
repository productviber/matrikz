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

// ─── SQLite Boolean Flags ───────────────────────────────────────────────────

export const SQLITE_BOOL = {
  TRUE: 1,
  FALSE: 0,
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
  /** 7 days in seconds */
  DAYS_7: 7 * SECONDS_PER_DAY,
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
  RANDOM_SUFFIX_START: 2,
  RANDOM_SUFFIX_END: 6,
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
  UNSUBSCRIBE: (email: string) => `${BASE_URL}/unsubscribe?email=${encodeURIComponent(email)}`,
} as const;

// ─── Route Parsing ──────────────────────────────────────────────────────────

export const ROUTE = {
  /** Length of '/r/' prefix to strip for slug extraction */
  REFERRAL_PREFIX_LEN: 3,
  /** Index of batch ID segment in /api/payouts/batch/:id/process */
  PAYOUT_BATCH_ID_INDEX: 4,
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
  ALLOWED_ORIGIN: '*',
  ALLOWED_METHODS: 'GET, POST, PUT, DELETE, OPTIONS',
  ALLOWED_HEADERS: 'Content-Type, Authorization',
} as const;

// ─── Commission Tiers ───────────────────────────────────────────────────────

export interface CommissionTierDef {
  name: string;
  minConversions: number;
  rate: number; // 0.0–1.0
}

export const COMMISSION_TIERS: CommissionTierDef[] = [
  { name: 'Starter',   minConversions: 0,   rate: 0.20 },
  { name: 'Silver',    minConversions: 10,  rate: 0.25 },
  { name: 'Gold',      minConversions: 50,  rate: 0.30 },
  { name: 'Platinum',  minConversions: 200, rate: 0.35 },
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
  SIGN_OFF: '— The Clodo SEO Team',
  SIGN_OFF_AFFILIATE: '— The Clodo SEO Affiliate Program',
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
  },
  // ── Success Messages ──
  success: {
    applicationReceived: "Application received! We'll review it within 48 hours.",
    processedEmails: (count: number) => `Processed ${count} due emails`,
  },
  // ── Email Template Copy ──
  email: {
    greeting: 'Hi there,',
    genericBody: 'Thank you for being part of Visibility.',
    onboardingWelcomeTitle: 'Welcome to Visibility! 🚀',
    onboardingWelcomeBody: (plan: string) => `You've just unlocked the <strong>${plan}</strong> plan. Here's how to get the most out of Visibility:`,
    onboardingStep1: 'Connect your site',
    onboardingStep1Detail: 'Add your domain in the Cockpit dashboard',
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
    day7Body: "You've been using Visibility for a week! Here are tips from our top users:",
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
    welcomeTitle: 'Welcome to Visibility 👋',
    welcomeBody: 'Thanks for signing up! Visibility gives you real-time insights into your search engine performance.',
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
    winbackDay1Body: "We noticed your Visibility subscription has ended. Here's what's new since you left:",
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
  },
} as const;

// ─── Currency / Locale ──────────────────────────────────────────────────────

export const CURRENCY = {
  CODE: 'USD',
  SYMBOL: '$',
  DECIMALS: 2,
  LOCALE: 'en-US',
} as const;
