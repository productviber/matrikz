/**
 * Event Router — Routes incoming events from visibility-analytics
 * to the appropriate handler. Unknown events are logged and ignored
 * for forward compatibility.
 */

import type {
  Env,
  EventEnvelope,
  AffiliateConversionData,
  UserConvertedData,
  UserSignupData,
  UserChurnedData,
  UserMilestoneData,
  AffiliateClickData,
  InsightGeneratedData,
  PlanUpgradedData,
  PlanDowngradedData,
  TrialExpiringData,
  ShareCreatedData,
  ShareViewedData,
  ShareEngagedData,
  ShareCTAClickedData,
  ShareConvertedData,
  ShareRevokedData,
  OutboundProspectDiscoveredData,
  OutboundProspectEnrichedData,
  AuditCompletedData,
  LeadCapturedData,
} from '../types';
import {
  TRUSTED_SOURCE,
  EVENT_TYPES,
  CONTENT_TYPE_JSON,
  MAX_LENGTH,
  EVENT_SECURITY,
  KV_PREFIX,
} from '../constants';
import { ensureSystemAccess, accessDenied } from '../lib/access';
import { logEvent } from '../lib/observability';
import { handleAffiliateConversion } from './affiliate-conversion';
import { handleUserConverted } from './user-converted';
import { handleUserSignup } from './user-signup';
import { handleUserChurned } from './user-churned';
import { handleUserMilestone } from './user-milestone';
import { handleAffiliateClick } from './affiliate-click';
import {
  handleShareCreated,
  handleShareViewed,
  handleShareEngaged,
  handleShareCTAClicked,
  handleShareConverted,
  handleShareRevoked,
} from './share-events';
import {
  handleAppInstalled,
  handleAppUninstalled,
  handleAnalysisCompleted,
  handleFirstAnalysis,
  handleAIChatUsed,
} from './shopify-lifecycle';
import type {
  AppInstalledData,
  AppUninstalledData,
  AnalysisCompletedData,
  FirstAnalysisData,
  AIChatUsedData,
} from './shopify-lifecycle';
import { handlePlanUpgraded, handlePlanDowngraded } from './plan-lifecycle';
import { handleTrialExpiring } from './trial-expiring';
import { handleInsightGenerated } from './insight-generated';
import { handleProspectDiscovered, handleProspectEnriched, handleProspectConverted } from './outbound-events';
import { handleAuditCompleted, handleLeadCaptured } from './audit-funnel';
import { materializeGrowthSignalsFromEvent } from '../lib/growth/signals';
import { proposeEligibleAgentActionsFromSignals } from '../lib/growth/event-actions';
import {
  evaluateAndGuardGovernanceIngress,
  writeGovernanceIngressDecision,
} from '../lib/governance-ingress';

/**
 * Main event handler — called by the worker entry point for POST /events.
 */
export async function routeEvent(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const rawBody = await request.text();
    const envelope: EventEnvelope = JSON.parse(rawBody);
    const { event, source, timestamp, data } = envelope;

    // ── Validate system access lane ──
    const systemAccess = ensureSystemAccess(request, env, source);
    if (!systemAccess.ok) {
      console.warn(`[Events] Rejected by system guard: ${systemAccess.error}`);
      ctx.waitUntil(logEvent(env, 'events.rejected.system_guard', {
        event,
        source,
        reason: systemAccess.error ?? 'unknown',
      }, 'warn'));
      return accessDenied(systemAccess);
    }

    // ── Validate source ──
    if (source !== TRUSTED_SOURCE) {
      console.warn(`[Events] Rejected event from unknown source: ${source}`);
      ctx.waitUntil(logEvent(env, 'events.rejected.unknown_source', { event, source }, 'warn'));
      return new Response(JSON.stringify({ ok: false, error: 'Unknown source' }), {
        status: 400,
        headers: { 'Content-Type': CONTENT_TYPE_JSON },
      });
    }

    // ── Validate envelope ──
    if (!event || !timestamp || !data) {
      ctx.waitUntil(logEvent(env, 'events.rejected.invalid_envelope', {
        source,
        hasEvent: Boolean(event),
        hasTimestamp: Boolean(timestamp),
      }, 'warn'));
      return new Response(JSON.stringify({ ok: false, error: 'Invalid event envelope' }), {
        status: 400,
        headers: { 'Content-Type': CONTENT_TYPE_JSON },
      });
    }

    // ── Governance ingress authority gate (progressive: off|observe|enforce) ──
    const governanceDecision = await evaluateAndGuardGovernanceIngress(envelope, request, env);
    ctx.waitUntil(writeGovernanceIngressDecision(env, governanceDecision));

    if (governanceDecision.duplicateSuppressed) {
      return new Response(JSON.stringify({
        ok: true,
        event,
        duplicateSuppressed: true,
        governance: {
          decisionId: governanceDecision.decisionId,
          enforcementOutcome: governanceDecision.enforcementOutcome,
          reason: governanceDecision.reason,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': CONTENT_TYPE_JSON },
      });
    }

    if (!governanceDecision.allowed) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Governance authority validation failed',
        governance: {
          decisionId: governanceDecision.decisionId,
          enforcementOutcome: governanceDecision.enforcementOutcome,
          reason: governanceDecision.reason,
        },
      }), {
        status: 403,
        headers: { 'Content-Type': CONTENT_TYPE_JSON },
      });
    }

    // ── Freshness and replay checks ──
    const timestampSecs = Math.floor(new Date(timestamp).getTime() / 1000);
    if (!Number.isFinite(timestampSecs)) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid timestamp' }), {
        status: 400,
        headers: { 'Content-Type': CONTENT_TYPE_JSON },
      });
    }

    const nowSecs = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSecs - timestampSecs) > EVENT_SECURITY.MAX_SKEW_SECS) {
      ctx.waitUntil(logEvent(env, 'events.rejected.stale_timestamp', {
        event,
        source,
        timestamp,
      }, 'warn'));
      return new Response(JSON.stringify({ ok: false, error: 'Stale event timestamp' }), {
        status: 400,
        headers: { 'Content-Type': CONTENT_TYPE_JSON },
      });
    }

    const replayHash = await sha256Hex(rawBody);
    const replayId = extractEventReplayId(envelope, request);
    const replayKey = replayId
      ? `${KV_PREFIX.DAILY_EVENTS}replay:${source}:${event}:${replayId}`
      : `${KV_PREFIX.DAILY_EVENTS}replay:${replayHash}`;
    const replaySeen = await env.KV_MARKETING.get(replayKey);
    if (replaySeen) {
      ctx.waitUntil(logEvent(env, 'events.rejected.duplicate', {
        event,
        source,
        replayKey,
      }, 'warn'));
      return new Response(JSON.stringify({ ok: false, error: 'Duplicate event' }), {
        status: 409,
        headers: { 'Content-Type': CONTENT_TYPE_JSON },
      });
    }
    await env.KV_MARKETING.put(replayKey, replayId ?? replayHash, {
      expirationTtl: EVENT_SECURITY.REPLAY_TTL_SECS,
    });

    console.log(`[Events] Received: ${event} at ${timestamp}`);
    ctx.waitUntil(logEvent(env, 'events.received', { event, source, timestamp }));

    // ── Route by event type ──
    switch (event) {
      case EVENT_TYPES.AFFILIATE_CONVERSION:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleAffiliateConversion(env, data as AffiliateConversionData, timestamp)
        );
        break;

      case EVENT_TYPES.USER_CONVERTED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleUserConverted(env, data as UserConvertedData, timestamp)
        );
        break;

      // ── User signup — welcome sequence + CRM upsert ──
      case EVENT_TYPES.USER_SIGNUP:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleUserSignup(env, data as UserSignupData, timestamp)
        );
        break;

      case EVENT_TYPES.USER_CHURNED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleUserChurned(env, data as UserChurnedData, timestamp)
        );
        break;

      case EVENT_TYPES.USER_MILESTONE:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleUserMilestone(env, data as UserMilestoneData, timestamp)
        );
        break;

      case EVENT_TYPES.AFFILIATE_CLICK:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleAffiliateClick(env, data as AffiliateClickData, timestamp)
        );
        break;

      case EVENT_TYPES.INSIGHT_GENERATED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleInsightGenerated(env, data as InsightGeneratedData, timestamp)
        );
        break;

      // ── Shopify App lifecycle events (via analytics engine event bus) ──
      case EVENT_TYPES.APP_INSTALLED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleAppInstalled(env, data as AppInstalledData, timestamp)
        );
        break;

      case EVENT_TYPES.APP_UNINSTALLED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleAppUninstalled(env, data as AppUninstalledData, timestamp)
        );
        break;

      case EVENT_TYPES.ANALYSIS_COMPLETED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleAnalysisCompleted(env, data as AnalysisCompletedData, timestamp)
        );
        break;

      case EVENT_TYPES.FIRST_ANALYSIS:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleFirstAnalysis(env, data as FirstAnalysisData, timestamp)
        );
        break;

      case EVENT_TYPES.AI_CHAT_USED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleAIChatUsed(env, data as AIChatUsedData, timestamp)
        );
        break;

      case EVENT_TYPES.PLAN_UPGRADED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handlePlanUpgraded(env, data as PlanUpgradedData, timestamp)
        );
        break;

      case EVENT_TYPES.PLAN_DOWNGRADED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handlePlanDowngraded(env, data as PlanDowngradedData, timestamp)
        );
        break;

      // ── Share PLG events (from visibility-analytics micro-share system) ──
      case EVENT_TYPES.SHARE_CREATED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleShareCreated(env, data as ShareCreatedData, timestamp)
        );
        break;

      case EVENT_TYPES.SHARE_VIEWED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleShareViewed(env, data as ShareViewedData, timestamp)
        );
        break;

      case EVENT_TYPES.SHARE_ENGAGED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleShareEngaged(env, data as ShareEngagedData, timestamp)
        );
        break;

      case EVENT_TYPES.SHARE_CTA_CLICKED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleShareCTAClicked(env, data as ShareCTAClickedData, timestamp)
        );
        break;

      case EVENT_TYPES.SHARE_CONVERTED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleShareConverted(env, data as ShareConvertedData, timestamp)
        );
        break;

      case EVENT_TYPES.SHARE_REVOKED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleShareRevoked(env, data as ShareRevokedData, timestamp)
        );
        break;

      case EVENT_TYPES.TRIAL_EXPIRING:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleTrialExpiring(env, data as TrialExpiringData, timestamp)
        );
        break;

      // ── Outbound prospect events (from analytics discovery/enrichment) ──
      case EVENT_TYPES.OUTBOUND_PROSPECT_DISCOVERED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleProspectDiscovered(env, data as OutboundProspectDiscoveredData, timestamp)
        );
        break;

      case EVENT_TYPES.OUTBOUND_PROSPECT_ENRICHED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleProspectEnriched(env, data as OutboundProspectEnrichedData, timestamp)
        );
        break;

      // Outbound attribution loop closed — prospect signed up via cold email CTA
      case EVENT_TYPES.OUTBOUND_PROSPECT_CONVERTED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleProspectConverted(env, data as {
            email: string | null;
            outboundRef: string;
            visitorId: string | null;
            provider: string;
            siteId: string;
          }, timestamp)
        );
        break;

      // ── Audit funnel events (from analytics free-audit flow) ──
      case EVENT_TYPES.AUDIT_COMPLETED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleAuditCompleted(env, data as AuditCompletedData, timestamp)
        );
        break;

      case EVENT_TYPES.LEAD_CAPTURED:
        dispatchEventTask(ctx, event, source, timestamp, () =>
          handleLeadCaptured(env, data as LeadCapturedData, timestamp)
        );
        break;

      default:
        console.log(
          `[Events] Unknown event type: ${event}`,
          JSON.stringify(data).slice(0, MAX_LENGTH.JSON_PREVIEW_SHORT)
        );
    }

    ctx.waitUntil(
      materializeGrowthSignalsFromEvent(env, event, data, timestamp)
        .then((signals) => proposeEligibleAgentActionsFromSignals(env, signals, { sourceEvent: event, timestamp }))
        .catch((err) => {
          console.warn('[Events] Growth signal/action materialization failed:', err instanceof Error ? err.message : err);
        })
    );

    return new Response(JSON.stringify({ ok: true, event }), {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE_JSON },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[Events] Handler error:', errMsg);
    ctx.waitUntil(logEvent(env, 'events.error', { error: errMsg }, 'error'));
    return new Response(JSON.stringify({ ok: false, error: 'Event processing error' }), {
      status: 500,
      headers: { 'Content-Type': CONTENT_TYPE_JSON },
    });
  }
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function extractEventReplayId(envelope: EventEnvelope, request: Request): string | null {
  const headerId = request.headers.get('x-event-id')?.trim();
  if (headerId) return headerId;

  const dataRecord = envelope.data as Record<string, unknown> | null;
  const payloadId = dataRecord && typeof dataRecord === 'object'
    ? pickFirstString(dataRecord, ['eventId', 'idempotencyKey', 'nonce', '_platformEventId'])
    : null;

  return payloadId;
}

function pickFirstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function dispatchEventTask(
  ctx: ExecutionContext,
  event: string,
  source: string,
  timestamp: string,
  task: () => Promise<void>
): void {
  ctx.waitUntil(
    task().catch((err) => {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[Events] Async handler failed: event=${event} source=${source} ts=${timestamp} error=${error}`);
    })
  );
}
