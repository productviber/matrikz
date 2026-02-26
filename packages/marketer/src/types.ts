/**
 * Visibility Marketing Worker — Type Definitions
 *
 * Covers: Cloudflare bindings, event envelopes, D1 row types,
 * email sequences, commission tiers, and API payloads.
 */

import type { D1Database, KVNamespace, R2Bucket, Fetcher } from '@cloudflare/workers-types';

// ─── Cloudflare Env Bindings ────────────────────────────────────────────────

export interface Env {
  // D1 — marketing-specific database
  DB: D1Database;

  // KV — campaign tracking, drip sequences, affiliate notifications
  KV_MARKETING: KVNamespace;

  // R2 — email templates, marketing assets (optional)
  R2_ASSETS?: R2Bucket;

  // Service binding back to visibility-analytics
  ANALYTICS: Fetcher;

  // Vars
  FROM_EMAIL: string;
  FROM_NAME: string;
  ADMIN_TOKEN: string;
  EMAIL_API_KEY?: string;           // Brevo / SendGrid API key
  EMAIL_PROVIDER?: 'brevo' | 'sendgrid';
  SLACK_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL?: string;
  ENVIRONMENT: 'development' | 'production';
  /** Allowed CORS origin, defaults to CORS.ALLOWED_ORIGIN constant */
  ALLOWED_ORIGIN?: string;
  /** Payout provider key: 'stub' (default) | 'razorpay' | 'stripe' */
  PAYOUT_PROVIDER?: string;
  /** Razorpay X2B credentials for payout disbursement */
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  /** Stripe secret key for transfer disbursement */
  STRIPE_SECRET_KEY?: string;
}

// ─── Event Envelope ─────────────────────────────────────────────────────────

export interface EventEnvelope<T = unknown> {
  event: string;
  source: string;
  timestamp: string; // ISO 8601
  data: T;
}

// ─── Event Payloads ─────────────────────────────────────────────────────────

export interface AffiliateConversionData {
  affiliateCode: string;
  userId: string;
  eventType: string;
  amountCents: number;
  commissionCents: number;
  plan: string;
}

export interface UserConvertedData {
  userId: string;
  purchaseType: string;  // 'base' | 'pro' | 'enterprise' | 'credits'
  plan: string;           // 'monthly' | 'yearly' | 'pro' | 'credits'
  amountCents: number;
  gateway: string;        // 'stripe' | 'razorpay'
}

// Future event payloads
export interface UserSignupData {
  userId: string;
  provider: string;
  referrer?: string;
  affiliateCode?: string;
}

export interface UserChurnedData {
  userId: string;
  previousPlan: string;
  daysActive: number;
  lastActivity: string;
}

export interface UserMilestoneData {
  userId: string;
  milestoneType: string;
  milestoneValue: number;
}

export interface AffiliateClickData {
  affiliateCode: string;
  landingPage: string;
  referrer: string;
  country: string;
}

export interface InsightGeneratedData {
  userId: string;
  headlineType: string;
  insightCategory: string;
}

// ─── Known Event Types ──────────────────────────────────────────────────────

export type KnownEventType =
  | 'affiliate.conversion'
  | 'user.converted'
  | 'user.signup'
  | 'user.churned'
  | 'user.milestone'
  | 'affiliate.click'
  | 'insight.generated';

// ─── D1 Row Types — Marketing DB ────────────────────────────────────────────

export interface MarketingContactRow {
  id: number;
  email: string;
  status: 'lead' | 'trial' | 'customer' | 'churned';
  source: string | null;
  affiliate_code: string | null;
  first_seen_at: number;
  converted_at: number | null;
  plan: string | null;
  gateway: string | null;
  total_spent_cents: number;
  metadata: string | null;  // JSON string
  updated_at: number;
}

export interface EmailSequenceRow {
  id: number;
  name: string;
  trigger_event: string;
  description: string | null;
  is_active: number;  // 0 | 1
  created_at: number;
}

export interface EmailStepRow {
  id: number;
  sequence_id: number;
  step_order: number;
  subject: string;
  template_key: string;  // R2 key or inline template name
  delay_seconds: number; // 0 = immediate
  is_active: number;
  created_at: number;
}

export interface EmailSendRow {
  id: number;
  contact_email: string;
  sequence_id: number;
  step_id: number;
  status: 'scheduled' | 'sent' | 'failed' | 'cancelled';
  scheduled_at: number;
  sent_at: number | null;
  error: string | null;
  created_at: number;
}

export interface AffiliateNoteRow {
  id: number;
  affiliate_code: string;
  note_type: 'conversion' | 'tier_upgrade' | 'payout' | 'general';
  content: string;
  created_at: number;
}

export interface CampaignRow {
  id: number;
  name: string;
  slug: string;           // URL-safe identifier
  affiliate_code: string | null;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string | null;
  utm_term: string | null;
  destination_url: string;
  clicks: number;
  conversions: number;
  is_active: number;
  created_at: number;
  updated_at: number;
}

export interface PayoutBatchRow {
  id: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  total_amount_cents: number;
  affiliate_count: number;
  initiated_at: number;
  completed_at: number | null;
  notes: string | null;
}

export interface PayoutItemRow {
  id: number;
  batch_id: number;
  affiliate_code: string;
  affiliate_email: string;
  amount_cents: number;
  method: string | null;
  reference: string | null;
  status: 'pending' | 'sent' | 'failed';
  created_at: number;
}

// ─── Payout Details (stored in KV per affiliate) ────────────────────────────

/** UPI payout details — used by Razorpay X2B for Indian transfers */
export interface UpiPayoutDetails {
  method: 'upi';
  upiId: string;
  accountHolderName: string;
}

/** Bank account payout details — used by Razorpay X2B IMPS/NEFT transfers */
export interface BankPayoutDetails {
  method: 'bank';
  accountHolderName: string;
  ifsc: string;
  accountNumber: string;
}

/** Stripe connected account — used for Stripe Transfer API */
export interface StripePayoutDetails {
  method: 'stripe';
  stripeAccountId: string;  // acct_xxxxx
}

/** Union of all supported affiliate payout detail types */
export type PayoutDetails = UpiPayoutDetails | BankPayoutDetails | StripePayoutDetails;

// ─── Payout Events (D1 audit log) ──────────────────────────────────────────

export interface PayoutEventRow {
  id: number;
  batch_id: number;
  affiliate_code: string;
  event_type: string;     // initiated | contact_created | fund_account_created | transfer_sent | succeeded | failed | skipped
  provider: string;       // razorpay | stripe | stub
  reference: string | null;
  amount_cents: number;
  status: string;         // success | failure
  error: string | null;
  created_at: number;
}

export interface NotificationLogRow {
  id: number;
  channel: 'slack' | 'discord' | 'email';
  event_type: string;
  payload_summary: string;
  status: 'sent' | 'failed';
  created_at: number;
}

export interface MrrSnapshotRow {
  id: number;
  date_key: string;       // YYYY-MM-DD
  mrr_cents: number;
  arr_cents: number;
  total_customers: number;
  new_customers: number;
  churned_customers: number;
  created_at: number;
}

// ─── Commission Tiers ───────────────────────────────────────────────────────

export interface CommissionTier {
  name: string;
  minConversions: number;
  rate: number;  // 0.0–1.0
}

// Re-export from constants so existing imports still work
export { COMMISSION_TIERS } from './constants';

// ─── Email Sequence Definitions ─────────────────────────────────────────────

export interface SequenceDefinition {
  name: string;
  triggerEvent: string;
  steps: {
    subject: string;
    templateKey: string;
    delaySeconds: number;
  }[];
}

export const DEFAULT_SEQUENCES: SequenceDefinition[] = [
  {
    name: 'Post-Purchase Onboarding',
    triggerEvent: 'user.converted',
    steps: [
      { subject: 'Welcome to Visibility! Here is your quick-start guide', templateKey: 'onboarding-welcome', delaySeconds: 0 },
      { subject: 'Day 1: Set up your first site in 2 minutes', templateKey: 'onboarding-day1', delaySeconds: 86_400 },
      { subject: 'Day 3: Your first insights are ready', templateKey: 'onboarding-day3', delaySeconds: 259_200 },
      { subject: 'Day 7: Pro tips from power users', templateKey: 'onboarding-day7', delaySeconds: 604_800 },
    ],
  },
  {
    name: 'Affiliate Commission Notification',
    triggerEvent: 'affiliate.conversion',
    steps: [
      { subject: '🎉 You earned a commission!', templateKey: 'affiliate-commission', delaySeconds: 0 },
    ],
  },
  {
    name: 'Welcome Sequence',
    triggerEvent: 'user.signup',
    steps: [
      { subject: 'Welcome to Visibility - let us get started', templateKey: 'welcome-signup', delaySeconds: 0 },
      { subject: 'Day 1: Your first SEO check', templateKey: 'welcome-day1', delaySeconds: 86_400 },
      { subject: 'Day 3: Tips that top users love', templateKey: 'welcome-day3', delaySeconds: 259_200 },
    ],
  },
  {
    name: 'Win-Back Sequence',
    triggerEvent: 'user.churned',
    steps: [
      { subject: 'We miss you - here is what is new', templateKey: 'winback-day1', delaySeconds: 86_400 },
      { subject: 'Your SEO data is waiting', templateKey: 'winback-day3', delaySeconds: 259_200 },
      { subject: 'Last chance: 20% off to come back', templateKey: 'winback-day7', delaySeconds: 604_800 },
      { subject: 'Final reminder — your data expires soon', templateKey: 'winback-day14', delaySeconds: 1_209_600 },
    ],
  },
];

// ─── API Response Types ─────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface AffiliatePortalData {
  code: string;
  label: string;
  tier: string;
  commissionRate: number;
  totalClicks: number;
  totalConversions: number;
  totalEarnedCents: number;
  unpaidEarningsCents: number;
  recentConversions: {
    userId: string;   // hashed
    plan: string;
    amountCents: number;
    commissionCents: number;
    convertedAt: string;
  }[];
  payoutHistory: {
    amountCents: number;
    method: string;
    reference: string;
    createdAt: string;
  }[];
}

export interface CampaignStats {
  id: number;
  name: string;
  slug: string;
  clicks: number;
  conversions: number;
  conversionRate: number;
  isActive: boolean;
}

export interface DashboardMetrics {
  mrr: number;
  arr: number;
  totalCustomers: number;
  newCustomersToday: number;
  affiliateConversionsToday: number;
  pendingPayoutsCents: number;
  activeSequences: number;
  emailsSentToday: number;
}
