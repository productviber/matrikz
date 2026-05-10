/**
 * Visibility Marketing Worker — Main Entry Point
 *
 * This Cloudflare Worker receives real-time events from visibility-analytics
 * via service binding and powers the full affiliate-driven growth loop.
 *
 * Routes:
 *   POST /events                        — Service binding event ingestion
 *   GET  /health                        — Quick health check
 *   GET  /api/health                    — Detailed health check
 *   GET  /r/:slug                       — Referral link redirect
 *
 *   GET  /api/affiliate/portal          — Affiliate self-service dashboard
 *   GET  /api/affiliate/stats           — Quick affiliate stats
 *   POST /api/affiliate/session         — Exchange affiliate credentials for signed session token
 *   POST /api/affiliate/apply           — Affiliate recruitment form
 *   POST /api/affiliate/approve         — Admin: approve affiliate application
 *   GET  /api/affiliate/applications    — Admin: list pending applications
 *   PUT  /api/affiliate/:code/payout-details — Admin: set affiliate payout method
 *   GET  /api/affiliate/:code/payout-details — Admin: get affiliate payout method
 *
 *   POST /api/campaigns                 — Create campaign / referral link
 *   GET  /api/campaigns                 — List campaigns
 *   POST /api/campaigns/objectives      — Create campaign objective
 *   GET  /api/campaigns/objectives      — List campaign objectives
 *   GET  /api/campaigns/objectives/:id  — Get campaign objective
 *   GET  /api/campaigns/:slug           — Get campaign details
 *   PUT  /api/campaigns/:slug           — Update campaign
 *
 *   POST /api/payouts/batch             — Admin: create payout batch
 *   POST /api/payouts/batch/:id/process — Admin: process payout batch
 *   GET  /api/payouts                   — Admin: list payout batches
 *   GET  /api/payouts/:id               — Admin: get payout batch details
 *
 *   GET  /api/admin/dashboard           — Admin: marketing dashboard metrics
 *   GET  /api/admin/mrr                 — Admin: MRR/ARR history
 *   GET  /api/admin/emails/sequences    — Admin: list email sequences
 *   GET  /api/admin/emails/sends        — Admin: list email send history
 *   POST /api/admin/emails/process      — Admin: trigger email processing
 *   GET  /api/admin/contacts            — Admin: list CRM contacts
 *   GET  /api/admin/notifications       — Admin: notification log
 *   GET  /api/admin/shares              — Admin: list share leads
 *   GET  /api/admin/share-owners        — Admin: list share owner stats
 *   GET  /api/admin/pql-leads           — Admin: list PQL-qualified leads
 *   GET  /api/admin/outbound/health     — Admin: outbound delivery health
 *   GET  /api/admin/campaigns/outbound  — Admin: list outbound campaigns
 *   POST /api/admin/campaigns/outbound  — Admin: create outbound campaign
 *   GET  /api/admin/campaigns/outbound/:id         — Admin: get campaign
 *   POST /api/admin/campaigns/outbound/:id/start   — Admin: activate campaign
 *   POST /api/admin/campaigns/outbound/:id/pause   — Admin: pause campaign
 *   GET  /api/admin/outbound/channels               — Admin: aggregate channel stats
 *   GET  /api/admin/outbound/channels/:domain        — Admin: per-prospect channels & attempts
 *   POST /api/admin/outbound/channels/:domain/attempt — Admin: record manual outreach attempt
 *
 *   Skrip multichannel integration:
 *   GET  /api/admin/outbound/skrip/diagnostics  — Admin: Skrip integration diagnostics
 *   POST /api/admin/outbound/skrip/dispatch     — Admin: trigger outbox dispatch sweep
 *   POST /api/admin/outbound/skrip/reconcile    — Admin: trigger identity reconciliation
 *   GET  /api/admin/outbound/skrip/lineage      — Admin: message lineage by tenant/campaign
 *   GET  /api/admin/governance/ingress-slo       — Admin: governance ingress SLO summary
 *   GET  /api/admin/governance/enforcement-status — Admin: current active mode and policy config
 *   POST /api/admin/governance/mode-override      — Admin: set KV emergency mode override
 *   DELETE /api/admin/governance/mode-override    — Admin: clear KV emergency mode override
 *
 *   POST /api/admin/push/send           — Admin: enqueue push notification for a contact
 *   POST /api/admin/qa/affiliate-token  — QA only (QA_MODE_ENABLED=true): mint affiliate bearer token
 *   POST /api/push/subscribe            — Capture browser Web Push subscription
 *   DELETE /api/push/unsubscribe        — Record Web Push opt-out
 *   POST /api/push/receipt              — Capture browser push delivery/click/dismiss receipt
 *   GET  /api/push/status/:notificationId — Push receipt status projection
 *
 *   POST /webhooks/brevo                — Brevo deliverability webhooks
 *   POST /webhooks/skrip/v1/outcomes    — Skrip normalized outcome webhooks
 */

import type { Env } from './types';
import {
  WORKER_NAME,
  WORKER_VERSION,
  CONTENT_TYPE_JSON,
  PAGINATION,
  PATTERNS,
  ROUTE,
  MESSAGES,
  RATE_LIMIT,
  KV_PREFIX,
  TTL,
} from './constants';
import { routeEvent } from './events/router';
import { handleHealthCheck, handleDetailedHealth } from './routes/health';
import { handleAgenticRoute } from './routes/agentic';
import { handleAffiliatePortal, handleAffiliateStats } from './routes/affiliate-portal';
import { handleCreateAffiliateSession } from './routes/affiliate-session';
import { handleAffiliateApply, handleAffiliateApprove, handleListApplications } from './routes/affiliate-recruitment';
import { handleCreateCampaign, handleListCampaigns, handleGetCampaign, handleReferralRedirect, handleUpdateCampaign } from './routes/campaigns';
import {
  handleCampaignObjectiveScreen,
  handleCreateCampaignObjective,
  handleGetCampaignObjective,
  handleListCampaignObjectives,
} from './routes/campaign-objectives';
import {
  handleGetSegment,
  handleListSegments,
  handlePreviewSegment,
  handleSaveSegment,
  handleSegmentSelectionScreen,
} from './routes/campaign-segments';
import {
  handleChannelIntentScreen,
  handleGetChannelIntent,
  handlePutChannelIntent,
} from './routes/channel-intents';
import {
  handleSendStrategicBrief,
  handleStrategicBriefingScreen,
} from './routes/strategic-briefings';
import { handleCreatePayoutBatch, handleProcessPayoutBatch, handleListPayoutBatches, handleGetPayoutBatch } from './routes/payouts';
import {
  handleAdminDashboard,
  handleMrrHistory,
  handleListSequences,
  handleListEmailSends,
  handleProcessEmails,
  handleListContacts,
  handleListNotifications,
  handleListShareLeads,
  handleListShareOwners,
  handleListPQLLeads,
  handleOutboundHealth,
  handleListOutboundCampaigns,
  handleGetOutboundCampaign,
  handleCreateOutboundCampaign,
  handleStartOutboundCampaign,
  handlePauseOutboundCampaign,
  handleOutboundChannels,
  handleOutboundChannelsByDomain,
  handleRecordManualAttempt,
  handleAbStats,
  handleLinkedinQueue,
  handleOutboundFunnel,
  handleCrossSystemHealth,
  handleOutboundSLO,
  handleReputationTrend,
  handleEmailMetrics,
  handleEmailTimeline,
  handleEnqueueProspect,
  handleVariantMetrics,
  handlePruneVariants,
  handlePromoteVariantWinner,
  handleSkripDiagnostics,
  handleSkripDispatchTrigger,
  handleSkripReconcileTrigger,
  handleSkripLineage,
  handleAdminPushSend,
  handleSkripAttribution,
  handleSkripOptInFunnel,
  handleSkripAuthorityUpsert,
    handleSkripFlagSet,
    handleSkripPolicyState,
    handleKillSwitchDrill,
    handleDlqReplay,
  handleAdminAgenticSignals,
  handleAdminAgenticPerformance,
  handleAdminAgenticQuality,
  handleAgentDecisionTrace,
  handleApproveAgentAction,
  handleOverrideAgentAction,
  handleAgenticOutcomeExport,
  handleMarkStaleAgentActions,
  handleAttributeAgentActionOutcomes,
  handleGovernanceIngressSlo,
  handleGovernanceEnforcementStatus,
  handleGovernanceModeOverride,
  handleGovernanceExecutionSlo,
} from './routes/admin';
import { handleGdprExport, handleGdprDelete, handleUnsubscribe } from './routes/gdpr';
import { handleBrevoWebhook, handleBrevoInbound } from './routes/webhooks';
import { handleSkripOutcomeWebhook } from './routes/webhooks-skrip';
import { handleDispatchIngress } from './routes/dispatch';
import {
  handleDispatchSuccessRate,
  handleOutcomeFeedbackLatency,
  handleOutcomeFeedbackFailures,
} from './routes/outcome-metrics';
import { handlePushSubscribe, handlePushUnsubscribe } from './routes/skrip-push';
import { handlePushReceipt, handlePushStatus } from './routes/push-receipts';
import { handleQATokenMint } from './routes/qa-token';
import {
  handleWhatsAppSubscribe, handleWhatsAppUnsubscribe,
  handleSmsSubscribe, handleSmsUnsubscribe,
  handleTelegramSubscribe, handleTelegramUnsubscribe,
} from './routes/skrip-channels';
import { handleSetAffiliatePayoutDetails, handleGetAffiliatePayoutDetails } from './routes/affiliate-payout-setup';
import { handleIdentityTokenMint, handleIdentityTokenVerify } from './routes/identity-token';
import { corsPreflightResponse, notFound, tooManyRequests, badRequest } from './lib/response';
import {
  accessDenied,
  ensureAdminAccess,
  ensureAgenticAccess,
  ensureSystemAccess,
  ensureWebhookAccess,
  ensureUserAccess,
  auditDeniedAdminAttempt,
  detectAgenticTokenMisuse,
  auditAgenticAccess,
} from './lib/access';
import { resolveRouteLane } from './lib/route-lanes';
import { processDueEmails } from './lib/email';
import { checkRateLimit } from './lib/rate-limit';
import { validateConfig } from './lib/config';
import { toErrorResponse } from './lib/errors';
import { logEvent } from './lib/observability';
import { correlationIdFromRequest, setCorrelationId, clearCorrelationId } from './lib/correlation';
import { captureReputationSnapshot } from './lib/reputation';
import { dispatchOutboxBatch } from './lib/skrip/dispatcher';
import { reconcilePendingIdentities } from './lib/skrip/registration';
import { attributeAgentActionOutcomes, markStaleAgentActions } from './lib/growth/outcomes';
import { listGrowthSignals } from './lib/growth/signals';
import { proposeEligibleAgentActionsFromSignals } from './lib/growth/event-actions';

export default {
  /**
   * Main fetch handler — routes requests to the appropriate handler.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // ── Set correlation ID from incoming request (or generate new) ──
    correlationIdFromRequest(request);

    // ── Validate required bindings at first request ──
    const configErrors = validateConfig(env);
    if (configErrors.length > 0) {
      console.error(`[Worker] Missing required config: ${configErrors.join(', ')}`);
      return new Response(
        JSON.stringify({ ok: false, error: 'Worker misconfigured' }),
        { status: 503, headers: { 'Content-Type': CONTENT_TYPE_JSON } }
      );
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse();
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ── Service binding events from visibility-analytics ──
      const lane = resolveRouteLane(method, path);
      if (lane) {
        // Guard against agentic credentials being used on non-agentic routes.
        const agenticMisuse = detectAgenticTokenMisuse(request, env, lane);
        if (agenticMisuse) {
          return accessDenied(agenticMisuse);
        }

        const source = request.headers.get('x-source') ?? undefined;
        const decision =
          lane === 'admin' ? ensureAdminAccess(request, env)
            : lane === 'agentic' ? ensureAgenticAccess(request, env)
              : lane === 'system' ? ensureSystemAccess(request, env, source)
                : lane === 'webhook' ? ensureWebhookAccess(request, env)
                  : await ensureUserAccess(request, env);

        if (!decision.ok) {
          await auditDeniedAdminAttempt(env, request, decision);
          return accessDenied(decision);
        }

        // Emit structured audit record for every successful agentic access.
        if (lane === 'agentic') {
          ctx.waitUntil(auditAgenticAccess(env, request, `${method} ${path}`));
        }
      }

      if (method === 'POST' && path === '/events') {
        return routeEvent(request, env, ctx);
      }

      // ── Closed-loop dispatch ingress / operator metrics ──
      if (method === 'POST' && path === '/dispatch') {
        return handleDispatchIngress(request, env);
      }
      if (method === 'GET' && path === '/metrics/dispatch-success-rate') {
        return handleDispatchSuccessRate(request, env);
      }
      if (method === 'GET' && path === '/metrics/outcome-feedback-latency') {
        return handleOutcomeFeedbackLatency(request, env);
      }
      if (method === 'GET' && path === '/metrics/outcome-feedback-failures') {
        return handleOutcomeFeedbackFailures(request, env);
      }

      // ── Health checks ──
      if (method === 'GET' && path === '/health') {
        return handleHealthCheck();
      }
      if (method === 'GET' && path === '/api/health') {
        return handleDetailedHealth(request, env);
      }

      // ── Referral link redirect ──
      if (method === 'GET' && path.startsWith('/r/')) {
        const slug = path.slice(ROUTE.REFERRAL_PREFIX_LEN);
        if (slug) return handleReferralRedirect(request, env, slug);
      }

      // ── Affiliate Portal Routes ──
      if (method === 'GET' && path === '/api/affiliate/portal') {
        return handleAffiliatePortal(request, env);
      }
      if (method === 'GET' && path === '/api/affiliate/stats') {
        return handleAffiliateStats(request, env);
      }
      if (method === 'POST' && path === '/api/affiliate/session') {
        return handleCreateAffiliateSession(request, env);
      }
      if (method === 'POST' && path === '/api/affiliate/apply') {
        // Rate limit: 5 applications per hour per IP
        const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        const rl = await checkRateLimit(env, `apply:${ip}`, RATE_LIMIT.APPLY_MAX, RATE_LIMIT.APPLY_WINDOW_SECS);
        if (!rl.allowed) return tooManyRequests(MESSAGES.errors.rateLimitExceeded);
        return handleAffiliateApply(request, env);
      }
      if (method === 'POST' && path === '/api/affiliate/approve') {
        return handleAffiliateApprove(request, env);
      }
      if (method === 'GET' && path === '/api/affiliate/applications') {
        return handleListApplications(request, env);
      }

      // ── Affiliate Payout Details Routes (Admin) ──
      if (method === 'PUT' && path.match(PATTERNS.ROUTE_AFFILIATE_PAYOUT_DETAILS)) {
        const code = path.split('/')[ROUTE.AFFILIATE_CODE_INDEX];
        return handleSetAffiliatePayoutDetails(request, env, code);
      }
      if (method === 'GET' && path.match(PATTERNS.ROUTE_AFFILIATE_PAYOUT_DETAILS)) {
        const code = path.split('/')[ROUTE.AFFILIATE_CODE_INDEX];
        return handleGetAffiliatePayoutDetails(request, env, code);
      }

      // ── Campaign Routes ──
      if (method === 'POST' && path === '/api/campaigns') {
        return handleCreateCampaign(request, env);
      }
      if (method === 'GET' && path === '/api/campaigns') {
        return handleListCampaigns(request, env);
      }
      if (method === 'GET' && path === '/api/admin/campaign-objectives/screen') {
        return handleCampaignObjectiveScreen(request, env);
      }
      if (method === 'GET' && path === '/api/admin/campaign-segments/screen') {
        return handleSegmentSelectionScreen(request, env);
      }
      if (method === 'GET' && path === '/api/admin/channel-intent/screen') {
        return handleChannelIntentScreen(request, env);
      }
      if (method === 'GET' && path === '/api/admin/strategic-briefings/screen') {
        return handleStrategicBriefingScreen(request, env);
      }
      if (method === 'POST' && path === '/api/admin/strategic-briefings/send') {
        return handleSendStrategicBrief(request, env);
      }
      if (method === 'POST' && path === '/api/campaigns/objectives') {
        return handleCreateCampaignObjective(request, env);
      }
      if (method === 'GET' && path === '/api/campaigns/objectives') {
        return handleListCampaignObjectives(request, env);
      }
      if (method === 'GET' && path.match(PATTERNS.ROUTE_CAMPAIGN_OBJECTIVE_ID)) {
        const id = path.split('/').pop()!;
        return handleGetCampaignObjective(request, env, id);
      }
      if (method === 'POST' && path === '/api/segments/preview') {
        return handlePreviewSegment(request, env);
      }
      if (method === 'POST' && path === '/api/segments/save') {
        return handleSaveSegment(request, env);
      }
      if (method === 'GET' && path === '/api/segments') {
        return handleListSegments(request, env);
      }
      if (method === 'GET' && /^\/api\/segments\/[^/]+$/.test(path)) {
        const id = path.split('/').pop()!;
        return handleGetSegment(request, env, id);
      }
      if (method === 'GET' && /^\/api\/campaigns\/[^/]+\/channel-intent$/.test(path)) {
        const campaignId = path.split('/')[3]!;
        return handleGetChannelIntent(request, env, campaignId);
      }
      if (method === 'PUT' && /^\/api\/campaigns\/[^/]+\/channel-intent$/.test(path)) {
        const campaignId = path.split('/')[3]!;
        return handlePutChannelIntent(request, env, campaignId);
      }
      if (method === 'GET' && path.match(PATTERNS.ROUTE_CAMPAIGN_SLUG)) {
        const slug = path.split('/').pop()!;
        return handleGetCampaign(request, env, slug);
      }
      if (method === 'PUT' && path.match(PATTERNS.ROUTE_CAMPAIGN_SLUG)) {
        const slug = path.split('/').pop()!;
        return handleUpdateCampaign(request, env, slug);
      }

      // ── Payout Routes ──
      if (method === 'POST' && path === '/api/payouts/batch') {
        return handleCreatePayoutBatch(request, env);
      }
      if (method === 'POST' && path.match(PATTERNS.ROUTE_PAYOUT_BATCH_PROCESS)) {
        const batchId = parseInt(path.split('/')[ROUTE.PAYOUT_BATCH_ID_INDEX], 10);
        return handleProcessPayoutBatch(request, env, batchId);
      }
      if (method === 'GET' && path === '/api/payouts') {
        return handleListPayoutBatches(request, env);
      }
      if (method === 'GET' && path.match(PATTERNS.ROUTE_PAYOUT_ID)) {
        const batchId = parseInt(path.split('/').pop()!, 10);
        return handleGetPayoutBatch(request, env, batchId);
      }

      // ── GDPR / Compliance Routes ──
      if (method === 'GET' && path === '/api/affiliate/gdpr/export') {
        const code = new URL(request.url).searchParams.get('code') ?? 'anon';
        const rl = await checkRateLimit(env, `gdpr:${code}`, RATE_LIMIT.GDPR_MAX, RATE_LIMIT.GDPR_WINDOW_SECS);
        if (!rl.allowed) return tooManyRequests(MESSAGES.errors.rateLimitExceeded);
        return handleGdprExport(request, env);
      }
      if (method === 'DELETE' && path === '/api/affiliate/gdpr/delete') {
        const code = new URL(request.url).searchParams.get('code') ?? 'anon';
        const rl = await checkRateLimit(env, `gdpr:${code}`, RATE_LIMIT.GDPR_MAX, RATE_LIMIT.GDPR_WINDOW_SECS);
        if (!rl.allowed) return tooManyRequests(MESSAGES.errors.rateLimitExceeded);
        return handleGdprDelete(request, env);
      }
      if (method === 'POST' && path === '/api/unsubscribe') {
        const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        const rl = await checkRateLimit(env, `unsub:${ip}`, RATE_LIMIT.UNSUB_MAX, RATE_LIMIT.UNSUB_WINDOW_SECS);
        if (!rl.allowed) return tooManyRequests(MESSAGES.errors.rateLimitExceeded);
        return handleUnsubscribe(request, env);
      }

      // ── Agentic Growth Controller Routes ──
      if (path.startsWith('/api/agentic/')) {
        return handleAgenticRoute(request, env);
      }

      // ── Admin Routes ──
      if (method === 'GET' && path === '/api/admin/dashboard') {
        return handleAdminDashboard(request, env);
      }
      if (method === 'GET' && path === '/api/admin/mrr') {
        return handleMrrHistory(request, env);
      }
      if (method === 'GET' && path === '/api/admin/emails/sequences') {
        return handleListSequences(request, env);
      }
      if (method === 'GET' && path === '/api/admin/emails/sends') {
        return handleListEmailSends(request, env);
      }
      if (method === 'POST' && path === '/api/admin/emails/process') {
        return handleProcessEmails(request, env);
      }
      if (method === 'GET' && path === '/api/admin/contacts') {
        return handleListContacts(request, env);
      }
      if (method === 'GET' && path === '/api/admin/notifications') {
        return handleListNotifications(request, env);
      }

      // ── Share Admin Routes ──
      if (method === 'GET' && path === '/api/admin/shares') {
        return handleListShareLeads(request, env);
      }
      if (method === 'GET' && path === '/api/admin/share-owners') {
        return handleListShareOwners(request, env);
      }
      if (method === 'GET' && path === '/api/admin/pql-leads') {
        return handleListPQLLeads(request, env);
      }

      // ── Outbound Admin Routes ──
      if (method === 'GET' && path === '/api/admin/outbound/health') {
        return handleOutboundHealth(request, env);
      }
      if (method === 'GET' && path === '/api/admin/outbound/funnel') {
        return handleOutboundFunnel(request, env);
      }
      if (method === 'GET' && path === '/api/admin/outbound/system-health') {
        return handleCrossSystemHealth(request, env);
      }
      if (method === 'GET' && path === '/api/admin/outbound/slo') {
        return handleOutboundSLO(request, env);
      }
      if (method === 'GET' && path === '/api/admin/outbound/reputation') {
        return handleReputationTrend(request, env);
      }
      if (method === 'GET' && path === '/api/admin/outbound/skrip/diagnostics') {
        return handleSkripDiagnostics(request, env);
      }
      if (method === 'POST' && path === '/api/admin/outbound/skrip/dispatch') {
        return handleSkripDispatchTrigger(request, env);
      }
      if (method === 'POST' && path === '/api/admin/outbound/skrip/reconcile') {
        return handleSkripReconcileTrigger(request, env);
      }
      if (method === 'GET' && path === '/api/admin/outbound/skrip/lineage') {
        return handleSkripLineage(request, env);
      }
      if (method === 'GET' && path === '/api/admin/governance/ingress-slo') {
        return handleGovernanceIngressSlo(request, env);
      }
      if (method === 'GET' && path === '/api/admin/governance/enforcement-status') {
        return handleGovernanceEnforcementStatus(request, env);
      }
      if ((method === 'POST' || method === 'DELETE') && path === '/api/admin/governance/mode-override') {
        return handleGovernanceModeOverride(request, env);
      }
      if (method === 'GET' && path === '/api/admin/governance/execution-slo') {
        return handleGovernanceExecutionSlo(request, env);
      }
      if (method === 'GET' && path === '/api/admin/outbound/skrip/opt-in-funnel') {
        return handleSkripOptInFunnel(request, env);
      }
      if (method === 'POST' && path === '/api/admin/outbound/skrip/authority') {
        return handleSkripAuthorityUpsert(request, env);
      }
      if (method === 'POST' && path === '/api/admin/push/send') {
        return handleAdminPushSend(request, env);
      }
      if (method === 'POST' && path === '/api/admin/qa/affiliate-token') {
        return handleQATokenMint(request, env);
      }
      if (method === 'GET' && path === '/api/admin/outbound/skrip/attribution') {
        return handleSkripAttribution(request, env);
      }
      if (method === 'POST' && path === '/api/admin/skrip/flags') {
        return handleSkripFlagSet(request, env);
      }
      if (method === 'GET' && path === '/api/admin/skrip/policy-state') {
        return handleSkripPolicyState(request, env);
      }
      if (method === 'POST' && path === '/api/admin/skrip/killswitch/drill') {
        return handleKillSwitchDrill(request, env);
      }
      if (method === 'POST' && path === '/api/admin/skrip/dlq/replay') {
        return handleDlqReplay(request, env);
      }
      if (method === 'GET' && path === '/api/admin/agentic/signals') {
        return handleAdminAgenticSignals(request, env);
      }
      if (method === 'GET' && path === '/api/admin/agentic/performance') {
        return handleAdminAgenticPerformance(request, env);
      }
      if (method === 'GET' && path === '/api/admin/agentic/quality') {
        return handleAdminAgenticQuality(request, env);
      }
      const decisionTraceMatch = path.match(/^\/api\/admin\/agentic\/subjects\/([^/]+)\/decision-trace$/);
      if (method === 'GET' && decisionTraceMatch) {
        return handleAgentDecisionTrace(request, env, decisionTraceMatch[1]);
      }
      if (method === 'POST' && path === '/api/admin/agentic/outcomes/export') {
        return handleAgenticOutcomeExport(request, env);
      }
      if (method === 'POST' && path === '/api/admin/agentic/outcomes/review-stale') {
        return handleMarkStaleAgentActions(request, env);
      }
      if (method === 'POST' && path === '/api/admin/agentic/outcomes/attribute') {
        return handleAttributeAgentActionOutcomes(request, env);
      }
      const approveMatch = path.match(/^\/api\/admin\/agentic\/actions\/([^/]+)\/approve$/);
      if (method === 'POST' && approveMatch) {
        return handleApproveAgentAction(request, env, decodeURIComponent(approveMatch[1]));
      }
      const overrideMatch = path.match(/^\/api\/admin\/agentic\/actions\/([^/]+)\/override$/);
      if (method === 'POST' && overrideMatch) {
        return handleOverrideAgentAction(request, env, decodeURIComponent(overrideMatch[1]));
      }
      if (method === 'GET' && path === '/api/admin/outbound/ab-stats') {
        return handleAbStats(request, env);
      }
      if (method === 'GET' && path === '/api/admin/outbound/linkedin-queue') {
        return handleLinkedinQueue(request, env);
      }
      if (method === 'GET' && path === '/api/admin/campaigns/outbound') {
        return handleListOutboundCampaigns(request, env);
      }
      if (method === 'POST' && path === '/api/admin/campaigns/outbound') {
        return handleCreateOutboundCampaign(request, env);
      }
      // Parameterised outbound campaign routes
      if (path.startsWith('/api/admin/campaigns/outbound/')) {
        const segments = path.split('/');
        // /api/admin/campaigns/outbound/:id → 5 segments
        // /api/admin/campaigns/outbound/:id/start → 6 segments
        // /api/admin/campaigns/outbound/:id/pause → 6 segments
        const idStr = segments[5];
        const campaignId = idStr ? parseInt(idStr, 10) : NaN;
        if (isNaN(campaignId)) return badRequest('Invalid campaign ID');

        const action = segments[6]; // start | pause | undefined
        if (method === 'GET' && !action) {
          return handleGetOutboundCampaign(request, env, campaignId);
        }
        if (method === 'POST' && action === 'start') {
          return handleStartOutboundCampaign(request, env, campaignId);
        }
        if (method === 'POST' && action === 'pause') {
          return handlePauseOutboundCampaign(request, env, campaignId);
        }
      }

      // ── Outbound Channel Routes ──
      if (method === 'GET' && path === '/api/admin/outbound/channels') {
        return handleOutboundChannels(request, env);
      }
      if (path.startsWith('/api/admin/outbound/channels/')) {
        const remainder = path.replace('/api/admin/outbound/channels/', '');
        // POST /api/admin/outbound/channels/:domain/attempt
        if (method === 'POST' && remainder.endsWith('/attempt')) {
          const domain = remainder.replace(/\/attempt$/, '');
          if (!domain) return badRequest('Missing domain');
          return handleRecordManualAttempt(request, env, decodeURIComponent(domain));
        }
        // GET /api/admin/outbound/channels/:domain
        if (method === 'GET') {
          if (!remainder) return badRequest('Missing domain');
          return handleOutboundChannelsByDomain(request, env, decodeURIComponent(remainder));
        }
      }

      // ── Internal (service-binding) admin endpoints ──
      // Called by the analytics worker's operator dashboard. Lane='system'.
      if (method === 'GET' && path === '/api/internal/outbound/metrics') {
        return handleEmailMetrics(request, env);
      }
      if (method === 'GET' && path === '/api/internal/outbound/timeline') {
        return handleEmailTimeline(request, env);
      }
      if (method === 'GET' && path === '/api/internal/outbound/variants') {
        return handleVariantMetrics(request, env);
      }
      if (method === 'POST' && path === '/api/internal/outbound/variants/prune') {
        return handlePruneVariants(request, env);
      }
      if (method === 'POST' && path === '/api/internal/outbound/variants/promote-winner') {
        return handlePromoteVariantWinner(request, env);
      }
      if (method === 'POST' && path === '/api/internal/outbound/enqueue') {
        return handleEnqueueProspect(request, env);
      }

      // ── Webhooks ──
      if (method === 'POST' && path === '/webhooks/brevo') {
        return handleBrevoWebhook(request, env);
      }
      if (method === 'POST' && path === '/webhooks/brevo/inbound') {
        return handleBrevoInbound(request, env);
      }
      if (method === 'POST' && path === '/webhooks/skrip/v1/outcomes') {
        return handleSkripOutcomeWebhook(request, env);
      }

      // ── Identity Token (admin lane: mint; system lane: verify) ──
      if (method === 'POST' && path === '/api/identity/mint') {
        return handleIdentityTokenMint(request, env);
      }
      if (method === 'POST' && path === '/api/identity/verify') {
        return handleIdentityTokenVerify(request, env);
      }

      // ── Push Subscription (rate-limited per IP) ──
      if (
        (method === 'POST' && path === '/api/push/subscribe') ||
        (method === 'DELETE' && path === '/api/push/unsubscribe') ||
        (method === 'POST' && path === '/api/channels/whatsapp/subscribe') ||
        (method === 'DELETE' && path === '/api/channels/whatsapp/unsubscribe') ||
        (method === 'POST' && path === '/api/channels/sms/subscribe') ||
        (method === 'DELETE' && path === '/api/channels/sms/unsubscribe') ||
        (method === 'POST' && path === '/api/channels/telegram/subscribe') ||
        (method === 'DELETE' && path === '/api/channels/telegram/unsubscribe')
      ) {
        const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        const rl = await checkRateLimit(env, `subscribe:${ip}`, RATE_LIMIT.SUBSCRIBE_MAX, RATE_LIMIT.SUBSCRIBE_WINDOW_SECS);
        if (!rl.allowed) return tooManyRequests(MESSAGES.errors.rateLimitExceeded);
      }

      if (method === 'POST' && path === '/api/push/subscribe') {
        return handlePushSubscribe(request, env);
      }
      if (method === 'DELETE' && path === '/api/push/unsubscribe') {
        return handlePushUnsubscribe(request, env);
      }
      if (method === 'POST' && path === '/api/push/receipt') {
        return handlePushReceipt(request, env);
      }
      if (method === 'GET' && path.startsWith('/api/push/status/')) {
        return handlePushStatus(request, env);
      }

      // ── Multi-Channel Subscriptions (WhatsApp · SMS · Telegram) ──
      if (method === 'POST' && path === '/api/channels/whatsapp/subscribe') {
        return handleWhatsAppSubscribe(request, env);
      }
      if (method === 'DELETE' && path === '/api/channels/whatsapp/unsubscribe') {
        return handleWhatsAppUnsubscribe(request, env);
      }
      if (method === 'POST' && path === '/api/channels/sms/subscribe') {
        return handleSmsSubscribe(request, env);
      }
      if (method === 'DELETE' && path === '/api/channels/sms/unsubscribe') {
        return handleSmsUnsubscribe(request, env);
      }
      if (method === 'POST' && path === '/api/channels/telegram/subscribe') {
        return handleTelegramSubscribe(request, env);
      }
      if (method === 'DELETE' && path === '/api/channels/telegram/unsubscribe') {
        return handleTelegramUnsubscribe(request, env);
      }

      // ── Root — worker identifier ──
      if (method === 'GET' && path === '/') {
        return new Response(
          JSON.stringify({
            worker: WORKER_NAME,
            version: WORKER_VERSION,
            status: 'ok',
          }),
          { headers: { 'Content-Type': CONTENT_TYPE_JSON } }
        );
      }

      // ── 404 ──
      return notFound(MESSAGES.errors.routeNotFound);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Worker] Unhandled error on ${method} ${path}:`, msg);
      return toErrorResponse(err);
    }
  },

  /**
   * Scheduled (Cron) handler - processes due email sends.
   * Configure crons in wrangler.toml triggers section.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    setCorrelationId(`cron-${Date.now().toString(36)}`);
    console.log(`[Cron] Triggered at ${new Date(event.scheduledTime).toISOString()}`);
    ctx.waitUntil(logEvent(env, 'cron.triggered', { scheduledTime: event.scheduledTime }));

    ctx.waitUntil(
      processDueEmails(env, PAGINATION.CRON_BATCH_SIZE).then((count) => {
        console.log(`[Cron] Processed ${count} due emails`);
        return logEvent(env, 'cron.processDueEmails.completed', { processed: count });
      }).catch((err) => {
        console.error('[Cron] Email processing error:', err);
        return logEvent(env, 'cron.processDueEmails.failed', {
          error: err instanceof Error ? err.message : String(err),
        }, 'error');
      })
    );

    // Daily reputation snapshot — idempotent, runs once per UTC day
    ctx.waitUntil(
      captureReputationSnapshot(env).catch((err) => {
        console.warn('[Cron] Reputation snapshot failed:', err instanceof Error ? err.message : err);
      })
    );

    // Skrip outbox dispatch — sends pending channel_execution_outbox rows
    ctx.waitUntil(
      dispatchOutboxBatch(env, PAGINATION.CRON_BATCH_SIZE).then((result) => {
        console.log(`[Cron] Skrip dispatch: ${result.dispatched} dispatched, ${result.skipped} skipped, ${result.failed} failed`);
        return logEvent(env, 'cron.skripDispatch.completed', { ...result });
      }).catch((err) => {
        console.error('[Cron] Skrip dispatch error:', err);
        return logEvent(env, 'cron.skripDispatch.failed', {
          error: err instanceof Error ? err.message : String(err),
        }, 'error');
      })
    );

    // Skrip identity reconciliation — registers pending channel identities with Skrip
    ctx.waitUntil(
      reconcilePendingIdentities(env, PAGINATION.CRON_BATCH_SIZE).then((result) => {
        if (result.scanned > 0) {
          console.log(`[Cron] Skrip reconcile: ${result.registered} registered, ${result.failed} failed of ${result.scanned} scanned`);
        }
      }).catch((err) => {
        console.warn('[Cron] Skrip reconciliation error:', err instanceof Error ? err.message : err);
      })
    );

    ctx.waitUntil(
      markStaleAgentActions(env, PAGINATION.CRON_BATCH_SIZE).then(async (result) => {
        if (result.marked > 0) {
          console.log(`[Cron] Agent outcomes: ${result.marked} stale action(s) marked no_outcome_observed`);
        }
        // B2: Re-evaluate subjects whose actions went stale without an outcome.
        // Policy frequency caps prevent redundant proposals — safe to call freely.
        let reEvaluated = 0;
        for (const subject of result.subjectsForReview) {
          try {
            const signals = await listGrowthSignals(env, {
              tenantId: subject.tenantId,
              subjectId: subject.subjectId,
              includeExpired: false,
              limit: 10,
            });
            if (signals.length > 0) {
              await proposeEligibleAgentActionsFromSignals(env, signals, {
                sourceEvent: 'cron.stale_action_review',
              });
              reEvaluated++;
            }
          } catch (reErr) {
            console.warn(
              `[Cron] Re-evaluation failed for ${subject.subjectId}:`,
              reErr instanceof Error ? reErr.message : reErr,
            );
          }
        }
        if (reEvaluated > 0) {
          console.log(`[Cron] Agent outcomes: ${reEvaluated} subject(s) queued for re-evaluation`);
        }
      }).catch((err) => {
        console.warn('[Cron] Agent outcome review error:', err instanceof Error ? err.message : err);
      })
    );

    // Outcome attribution sweep — writes conversion/engagement outcomes from
    // email and Skrip lineage back into agent_action_outcomes.
    ctx.waitUntil(
      attributeAgentActionOutcomes(env, PAGINATION.CRON_BATCH_SIZE).then((result) => {
        if (result.attributed > 0) {
          console.log(
            `[Cron] Agent attribution: ${result.attributed} attributed (${result.conversionAttributed} conversion, ${result.engagementAttributed} engagement)`,
          );
        }
      }).catch((err) => {
        console.warn('[Cron] Agent attribution error:', err instanceof Error ? err.message : err);
      })
    );

    // Write cron execution snapshot to KV for 24h trend monitoring / alerting.
    // Runs unconditionally on every cron tick regardless of attribution outcome.
    ctx.waitUntil(
      (async () => {
        try {
          const cronSnapshot = JSON.stringify({
            runAt: Math.floor(Date.now() / 1000),
            runAtIso: new Date(event.scheduledTime).toISOString(),
            scheduledTime: event.scheduledTime,
          });
          const today = new Date(event.scheduledTime).toISOString().slice(0, 10);
          await Promise.all([
            env.KV_MARKETING.put(`${KV_PREFIX.CRON_SNAPSHOT}latest`, cronSnapshot),
            env.KV_MARKETING.put(`${KV_PREFIX.CRON_SNAPSHOT}${today}`, cronSnapshot, { expirationTtl: TTL.DAYS_90 }),
          ]);
        } catch (snapshotErr) {
          console.warn('[Cron] Snapshot KV write failed:', snapshotErr instanceof Error ? snapshotErr.message : snapshotErr);
        }
      })()
    );
  },
};
