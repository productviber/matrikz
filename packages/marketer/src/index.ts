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
 *   POST /api/affiliate/apply           — Affiliate recruitment form
 *   POST /api/affiliate/approve         — Admin: approve affiliate application
 *   GET  /api/affiliate/applications    — Admin: list pending applications
 *   PUT  /api/affiliate/:code/payout-details — Admin: set affiliate payout method
 *   GET  /api/affiliate/:code/payout-details — Admin: get affiliate payout method
 *
 *   POST /api/campaigns                 — Create campaign / referral link
 *   GET  /api/campaigns                 — List campaigns
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
} from './constants';import { routeEvent } from './events/router';
import { handleHealthCheck, handleDetailedHealth } from './routes/health';
import { handleAffiliatePortal, handleAffiliateStats } from './routes/affiliate-portal';
import { handleAffiliateApply, handleAffiliateApprove, handleListApplications } from './routes/affiliate-recruitment';
import { handleCreateCampaign, handleListCampaigns, handleGetCampaign, handleReferralRedirect, handleUpdateCampaign } from './routes/campaigns';
import { handleCreatePayoutBatch, handleProcessPayoutBatch, handleListPayoutBatches, handleGetPayoutBatch } from './routes/payouts';
import {
  handleAdminDashboard,
  handleMrrHistory,
  handleListSequences,
  handleListEmailSends,
  handleProcessEmails,
  handleListContacts,
  handleListNotifications,
} from './routes/admin';
import { handleGdprExport, handleGdprDelete, handleUnsubscribe } from './routes/gdpr';
import { handleSetAffiliatePayoutDetails, handleGetAffiliatePayoutDetails } from './routes/affiliate-payout-setup';
import { corsPreflightResponse, notFound, tooManyRequests } from './lib/response';
import { processDueEmails } from './lib/email';
import { checkRateLimit } from './lib/rate-limit';

export default {
  /**
   * Main fetch handler — routes requests to the appropriate handler.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse();
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ── Service binding events from visibility-analytics ──
      if (method === 'POST' && path === '/events') {
        return routeEvent(request, env, ctx);
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
      return new Response(
        JSON.stringify({ ok: false, error: MESSAGES.errors.internalError }),
        { status: 500, headers: { 'Content-Type': CONTENT_TYPE_JSON } }
      );
    }
  },

  /**
   * Scheduled (Cron) handler - processes due email sends.
   * Configure crons in wrangler.toml triggers section.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[Cron] Triggered at ${new Date(event.scheduledTime).toISOString()}`);

    ctx.waitUntil(
      processDueEmails(env, PAGINATION.CRON_BATCH_SIZE).then((count) => {
        console.log(`[Cron] Processed ${count} due emails`);
      }).catch((err) => {
        console.error('[Cron] Email processing error:', err);
      })
    );
  },
};
