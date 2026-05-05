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

  // Optional service binding to ai-engine for structured growth advice
  AI_ENGINE?: Fetcher;

    // Optional service binding to Skrip messaging platform
    // When present, used instead of SKRIP_BASE_URL to avoid CF error 1042
    SKRIP_SERVICE?: Fetcher;

  // Vars
  FROM_EMAIL: string;
  FROM_NAME: string;
  ADMIN_TOKEN: string;
  /** Optional rollover admin token (accept during rotation window) */
  ADMIN_TOKEN_ROLLOVER?: string;
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
  /** Optional token for non-service-binding system-to-system calls */
  SYSTEM_TOKEN?: string;
  /** Optional rollover token for system calls */
  SYSTEM_TOKEN_ROLLOVER?: string;
  /** Optional token for agentic automation access lane */
  AGENT_TOKEN?: string;
  /** Optional rollover token for agentic automation */
  AGENT_TOKEN_ROLLOVER?: string;
  /** Optional token for webhook ingestion hardening */
  WEBHOOK_TOKEN?: string;
  /** Optional rollover token for webhook ingress */
  WEBHOOK_TOKEN_ROLLOVER?: string;
  /** Secret used to issue/verify signed affiliate user sessions */
  AFFILIATE_AUTH_SECRET?: string;
  /** Optional webhook body signing secret for HMAC verification */
  WEBHOOK_SIGNING_SECRET?: string;
  /** Skrip base API URL, e.g. https://api.skrip.example */
  SKRIP_BASE_URL?: string;
  /** Service-to-service bearer token for Skrip */
  SKRIP_SERVICE_TOKEN?: string;
  /** Shared HMAC secret for Visibility-Marketing -> Skrip requests */
  SKRIP_SIGNING_SECRET?: string;
  /** Shared HMAC secret for Skrip -> Visibility-Marketing webhooks */
  SKRIP_WEBHOOK_SIGNING_SECRET?: string;
  /** Default global enablement for Skrip integration when flags are absent */
  SKRIP_DEFAULT_ENABLEMENT?: string;
  /** Optional override for upstream timeout in milliseconds */
  SKRIP_TIMEOUT_MS?: string;
  /** Optional override for ai-engine advisory timeout in milliseconds */
  AI_ENGINE_TIMEOUT_MS?: string;
  /** Shared secret for growth-agent service authentication */
  INTERNAL_SECRET?: string;
  /** Optional rollover secret accepted during rotation window */
  INTERNAL_SECRET_ROLLOVER?: string;
  /** Optional override for growth-agent timeout in milliseconds */
  GROWTH_AGENT_TIMEOUT_MS?: string;
  /** Emergency kill switch for agent executions. Accepts 'true' to block. */
  AGENT_EXECUTION_DISABLED?: string;
  /**
   * Isolated email channel authority flag.
   * When 'true', enroll_sequence actions are evaluated against the Skrip
   * channel_authorities table for the 'email' channel.
   * Must NOT be activated until the parity gate in docs/email-convergence-parity-checklist.md
   * is fully signed off. Default: unset (uses existing email engine).
   */
  SKRIP_EMAIL_AUTHORITY_ENABLED?: string;
  /** Comma-separated scopes for AGENT_TOKEN. Defaults to read/propose/dry-run. */
  AGENT_TOKEN_SCOPES?: string;
  /** Comma-separated scopes for AGENT_TOKEN_ROLLOVER. */
  AGENT_TOKEN_ROLLOVER_SCOPES?: string;
  /**
   * When set to 'true', enables the QA token-mint endpoint
   * (POST /api/admin/qa/affiliate-token). Must NOT be 'true' in production.
   */
  QA_MODE_ENABLED?: string;
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
  purchaseType: string;  // 'starter' | 'growth' | 'pro'
  plan: string;           // 'starter' | 'growth' | 'pro'
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
  insightCount: number;
  topInsightType: string;
  severity: string;
  /** @deprecated kept for backward compat — use topInsightType */
  headlineType?: string;
  /** @deprecated kept for backward compat — use topInsightType */
  insightCategory?: string;
}

export interface PlanUpgradedData {
  userId: string;
  previousPlan: string;
  newPlan: string;
  amountCents: number;
  gateway: string;
  period: string;       // 'monthly' | 'yearly'
}

export interface PlanDowngradedData {
  userId: string;
  previousPlan: string;
  newPlan: string;
  amountCents: number;
  gateway: string;
  period: string;       // 'monthly' | 'yearly'
}

export interface TrialExpiringData {
  userId: string;
  plan: string;
  daysRemaining: number;
  expiresAt: string;    // ISO 8601
}

// ─── Share Event Payloads (from visibility-analytics micro-share system) ────

/** All share events include these PLG/PQL fields */
interface ShareEventBase {
  category: 'share';
  plgStage: string;     // awareness | activation | engagement | intent | conversion | lifecycle
  pqlScoreHint: number; // 0-100, additive hint for PQL scoring
}

export interface ShareCreatedData extends ShareEventBase {
  owner: string;        // owner's email
  token: string;        // vs_xxx share token
  scopes: string[];     // e.g. ['pulse', 'action']
  role: string;         // viewer | analyst | collaborator
  tier: string;         // owner's billing tier
}

export interface ShareViewedData extends ShareEventBase {
  token: string;
  owner?: string;       // share owner email (sent by analytics)
  accessCount: number;  // cumulative view count
  scopes: string[];
  ip?: string;          // viewer IP (sent by analytics)
}

export interface ShareEngagedData extends ShareEventBase {
  token: string;
  dwellSeconds: number; // 30, 60, 120, or 300
}

export interface ShareCTAClickedData extends ShareEventBase {
  token: string;
  dwellSeconds: number; // time spent before clicking
}

export interface ShareConvertedData extends ShareEventBase {
  shareToken: string;   // attributed share link token
  newUserId: string;    // email of newly signed-up user
}

export interface ShareRevokedData extends ShareEventBase {
  owner: string;
  token: string;
}

// ─── Known Event Types ──────────────────────────────────────────────────────

export type KnownEventType =
  | 'affiliate.conversion'
  | 'user.converted'
  | 'user.signup'
  | 'user.churned'
  | 'user.milestone'
  | 'affiliate.click'
  | 'insight.generated'
  | 'trial.expiring'
  | 'plan.upgraded'
  | 'plan.downgraded'
  | 'share.created'
  | 'share.viewed'
  | 'share.engaged'
  | 'share.cta_clicked'
  | 'share.converted'
  | 'share.revoked'
  | 'outbound.prospect_discovered'
  | 'outbound.prospect_enriched'
  | 'audit.completed'
  | 'lead.captured';

// ─── Audit Funnel Event Payloads (from analytics free-audit flow) ───────────

/** Payload for audit.completed events — anonymous domain-level signal */
export interface AuditCompletedData {
  domain: string;
  score: number;
  grade: string;
  url: string;
  issueCount?: number;
  passCount?: number;
}

/** Payload for lead.captured events — identified user from audit confirmation */
export interface LeadCapturedData {
  email: string;
  domain: string;
  source: string;    // 'free-audit'
  score: number;
  grade: string;
  url: string;
}

// ─── Outbound Event Payloads (from analytics discovery/enrichment) ──────────

/** Payload for outbound.prospect_discovered events */
export interface OutboundProspectDiscoveredData {
  prospectId: number;
  domain: string;
  companyName: string | null;
  contactEmail: string | null;
  contactName: string | null;
  contactTitle: string | null;
  source: string;          // 'apollo' | 'producthunt' | 'hackernews' | 'reddit' | 'manual'
  sourceUrl: string | null;
  industry: string | null;
  employeeRange: string | null;
  score: number;           // 0-100 prospect quality score
  description: string | null;
}

/** Contact form detected on prospect's website */
export interface ContactForm {
  action: string;      // Form action URL (absolute)
  method: string;      // HTTP method (POST/GET)
  fields: string[];    // Named input/textarea fields found
  pageUrl: string;     // Page where the form was found
  type: string;        // 'contact'
}

/** Social media profiles detected on prospect's website */
export interface SocialHandles {
  twitter: string | null;
  linkedin: string | null;
  facebook: string | null;
  github: string | null;
  instagram: string | null;
}

/** Payload for outbound.prospect_enriched events */
export interface OutboundProspectEnrichedData {
  prospectId: number;
  domain: string;
  companyName: string | null;
  contactEmail: string | null;
  contactName: string | null;
  contactTitle?: string | null;
  source?: string;          // 'apollo' | 'producthunt' | 'hackernews' | 'reddit' | 'manual'
  score: number;
  auditScore: number | null;
  auditGrade: string | null;
  issueCount: number | null;
  passCount: number | null;
  techStack: string[];
  prevTechStack?: string[];
  trafficEstimate?: string | null;
  primaryTopic: string | null;
  industry?: string | null;
  angles: Array<{ type: string; hook: string; detail: string }>;
  /** Top audited page paths from analytics multi-page sweep (e.g. ['/', '/pricing']). */
  auditedPages?: string[];
  wordCount: number | null;
  reportUrl?: string | null;
  contactForms?: ContactForm[];
  socialHandles?: SocialHandles;
  /**
   * One relevant tool capability picked by the analytics worker's
   * capability-catalog. Becomes the `{{capabilityHook.*}}` merge
   * fields in cold-outreach email templates. `id` is stable for
   * attribution analytics; `headline` is 5-10 words; `oneLiner` is
   * a single sentence. Optional for backward compatibility.
   */
  capabilityHook?: {
    id: string;
    headline: string;
    oneLiner: string;
    cta?: string;
  };
  batchId?: string;
}

// ─── D1 Row Types — Marketing DB ────────────────────────────────────────────

export interface MarketingContactRow {
  id: number;
  email: string;
  status: 'prospect' | 'lead' | 'trial' | 'customer' | 'churned' | 'engaged';
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

export interface ShareLeadRow {
  id: number;
  token: string;
  owner_email: string | null;
  status: string;       // cold | warm | hot | pql | converted | revoked
  plg_stage: string;    // PLG funnel stage
  pql_score: number;
  total_views: number;
  total_dwell_seconds: number;
  scopes_viewed: string | null;  // JSON array
  first_seen_at: number;
  last_seen_at: number;
  converted_user_id: string | null;
  converted_at: number | null;
  metadata: string | null;
  updated_at: number;
}

export interface ShareOwnerStatsRow {
  id: number;
  owner_email: string;
  total_shares: number;
  total_views: number;
  total_engagements: number;
  total_cta_clicks: number;
  total_conversions: number;
  last_share_at: number | null;
  last_conversion_at: number | null;
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

export type CampaignObjectiveType = 'activation' | 'retention' | 'reactivation' | 'conversion' | 'expansion';

export type CampaignObjectiveUrgency = 'low' | 'medium' | 'high';

export type CampaignObjectiveStatus = 'draft' | 'active' | 'paused' | 'archived';

export interface CampaignObjectiveRow {
  id: string;
  objective_type: CampaignObjectiveType;
  campaign_name: string;
  business_goal_statement: string;
  urgency: CampaignObjectiveUrgency;
  success_metric_primary: string;
  success_metric_secondary: string | null;
  start_at: string;
  end_at: string;
  timezone: string;
  dry_run: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  status: CampaignObjectiveStatus;
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

// ─── Skrip Integration Rows ────────────────────────────────────────────────

export interface ChannelAuthorityRow {
  id: number;
  tenant_id: string;
  campaign_id: string | null;
  channel: string;
  authority: string;
  rollout_state: string;
  feature_flag_key: string | null;
  created_at: number;
  updated_at: number;
}

export interface ContactChannelIdentityRow {
  id: number;
  tenant_id: string;
  external_contact_id: string;
  canonical_id: string | null;
  channel: string;
  address: string | null;
  consent_state: string;
  suppression_state: string;
  availability_state: string;
  identity_confidence: number;
  registration_state: string;
  last_reconciled_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ChannelExecutionOutboxRow {
  id: number;
  tenant_id: string;
  campaign_id: string;
  journey_id: string | null;
  step_id: string;
  contact_id: string;
  channel: string;
  schedule_slot: string;
  idempotency_key: string;
  payload_json: string;
  status: string;
  attempt_count: number;
  next_attempt_at: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  correlation_id: string;
  created_at: number;
  updated_at: number;
}

export interface ChannelMessageLineageRow {
  id: number;
  tenant_id: string;
  campaign_id: string;
  journey_id: string | null;
  step_id: string;
  contact_id: string;
  channel: string;
  message_id: string;
  skrip_outbound_id: string | null;
  provider_ref: string | null;
  idempotency_key: string;
  latest_status: string;
  first_sent_at: number | null;
  last_outcome_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ChannelOutcomeDeadLetterRow {
  id: number;
  tenant_id: string | null;
  event_id: string;
  event_type: string;
  payload_json: string;
  error_code: string | null;
  error_message: string | null;
  retryable: number;
  first_failed_at: number;
  last_failed_at: number;
  replayed_at: number | null;
}

export interface PushOptInEventRow {
  id: number;
  tenant_id: string;
  contact_id: string | null;
  browser_session_id: string | null;
  event_type: string;
  correlation_id: string;
  metadata_json: string | null;
  occurred_at: number;
}

export interface PushNotificationRow {
  notification_id: string;
  tenant_id: string;
  contact_id: string | null;
  campaign_id: string | null;
  step_id: string | null;
  channel: string;
  sent_at: number | null;
  delivered_at: number | null;
  clicked_at: number | null;
  dismissed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PushNotificationReceiptEventRow {
  id: number;
  notification_id: string;
  receipt_type: string;
  occurred_at: number;
  source: string;
  correlation_id: string | null;
  receipt_id: string | null;
  payload_json: string | null;
  created_at: number;
}

// ─── Agent-Led Growth Rows ─────────────────────────────────────────────────

export type GrowthSignalStatus = 'active' | 'dismissed' | 'converted' | 'expired';
export type GrowthSignalSeverity = 'low' | 'medium' | 'high' | 'critical';
export type GrowthSubjectType = 'contact' | 'domain' | 'shop' | 'affiliate' | 'share';

export interface GrowthSignalRow {
  id: number;
  signal_id: string;
  tenant_id: string;
  subject_type: GrowthSubjectType | string;
  subject_id: string;
  signal_type: string;
  severity: GrowthSignalSeverity | string;
  confidence: number;
  detected_at: number;
  expires_at: number;
  source_event_id: string | null;
  evidence_json: string;
  status: GrowthSignalStatus | string;
  created_at: number;
  updated_at: number;
}

export type AgentActionStatus =
  | 'proposed'
  | 'policy_checked'
  | 'approved'
  | 'executed'
  | 'rejected'
  | 'failed'
  | 'rolled_back'
  | 'outcome_observed'
  | 'no_outcome_observed';

export type AgentActionType =
  | 'wait'
  | 'manual_review'
  | 'enroll_sequence'
  | 'send_via_skrip'
  | 'pause_campaign'
  | 'start_campaign'
  | 'pause_contact'
  | 'escalate_to_human';

export type AgentRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ProposedAgentAction {
  type: AgentActionType | string;
  params?: Record<string, unknown>;
  reason?: string;
}

export interface GrowthPolicyResult {
  allowed: boolean;
  blockedReasons: string[];
  warnings: string[];
  requiredApproval: boolean;
  effectiveChannels: string[];
  cooldownUntil: number | null;
  evidence: Record<string, unknown>;
}

export interface AgentActionRow {
  id: number;
  action_id: string;
  idempotency_key: string;
  correlation_id: string;
  agent_id: string;
  tenant_id: string;
  subject_id: string;
  signal_id: string | null;
  proposed_action: string;
  proposed_action_json: string;
  status: AgentActionStatus | string;
  risk_level: AgentRiskLevel | string;
  confidence: number;
  evidence_json: string;
  input_hash: string;
  output_hash: string;
  policy_result_json: string;
  ai_metadata_json: string | null;
  created_at: number;
  updated_at: number;
  approved_at: number | null;
  executed_at: number | null;
  outcome_due_at: number | null;
  outcome_json: string | null;
}

export interface AgentActionEventRow {
  id: number;
  action_id: string;
  event_type: string;
  actor: string;
  correlation_id: string;
  payload_json: string;
  created_at: number;
}

export interface AgentActionOutcomeRow {
  id: number;
  action_id: string;
  outcome_type: string;
  observed_at: number;
  window_seconds: number;
  attribution_strength: string;
  revenue_or_value: number | null;
  evidence_json: string;
  created_at: number;
}

export interface GrowthExecutionIntent {
  tenantId: string;
  subjectId: string;
  actionId: string;
  actionType: string;
  actionReason: string | null;
  riskLevel: string;
  confidence: number;
  strategySource: 'growth-agent' | 'fallback';
  growthCapability: string;
  promptVersion: string | null;
  responseSchemaVersion: string | null;
  correlationId: string;
  requestId: string;
  channelHints: string[];
  messageBriefRequired: boolean;
  executionTarget: 'skrip' | 'manual_review' | 'campaign_control' | 'wait' | 'sequence';
  policyFlags: {
    allowed: boolean;
    requiredApproval: boolean;
    warnings: string[];
    blockedReasons: string[];
    effectiveChannels: string[];
    cooldownUntil: number | null;
  };
  createdAt: number;
}

export interface GrowthMessageBrief {
  objective: string;
  channel: string;
  locale: string;
  headline: string;
  bodyIntent: string;
  cta: string;
  tone: string;
  personalizationHints: string[];
  offerContext: Record<string, unknown>;
  fallbackTemplateKey: string | null;
}

export interface GrowthMessageBriefResult {
  brief: GrowthMessageBrief;
  source: 'ai' | 'deterministic';
  degradedReason: string | null;
  metadata: Record<string, unknown> | null;
}

export interface GrowthSkripStrategicRequest {
  tenantId: string;
  subjectId: string;
  contactIdentityId: string;
  objective: string;
  urgency: string;
  reason: string;
  channelPreferences: string[];
  constraints: {
    brandVoice: string;
    locale: string;
    forbiddenClaims: string[];
    complianceTags: string[];
    allowedHours?: {
      startHour: number;
      endHour: number;
      timezone?: string;
    };
  };
  brief: GrowthMessageBrief;
  lineage: {
    correlationId: string;
    requestId: string;
    agentActionId: string | null;
    growthCapability: string;
    promptVersion: string | null;
    responseSchemaVersion: string | null;
    strategyVersion: string;
  };
  execution: {
    dryRun: boolean;
    idempotencyKey: string;
    priority: 'normal' | 'high';
  };
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
  // ── Share PLG Sequences ──
  {
    name: 'Share Lead Warm Followup',
    triggerEvent: 'share.engaged',
    steps: [
      { subject: 'Someone is exploring your shared insights', templateKey: 'share-engaged-owner', delaySeconds: 0 },
    ],
  },
  {
    name: 'Share CTA Dropout',
    triggerEvent: 'share.cta_clicked',
    steps: [
      { subject: 'Still interested? Pick up where you left off', templateKey: 'share-cta-dropout', delaySeconds: 86_400 },
    ],
  },
  {
    name: 'Share Conversion Celebration',
    triggerEvent: 'share.converted',
    steps: [
      { subject: 'Someone you shared with just signed up!', templateKey: 'share-conversion-owner', delaySeconds: 0 },
    ],
  },
];

// ─── API Response Types ─────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /** Machine-readable error code, present on all error responses. */
  code?: string;
  /** Correlation ID for distributed tracing, present on all error responses. */
  correlationId?: string;
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
  // Share PLG metrics
  dailyShareViews: number;
  totalPQLs: number;
  shareConversionsToday: number;
}
