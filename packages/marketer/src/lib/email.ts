/**
 * Email sequence orchestration.
 *
 * This module keeps scheduling and delivery orchestration in one place,
 * while rendering/provider/context helpers live in submodules under `lib/email/*`.
 */

import type { Env, EmailSendRow } from '../types';
import {
  KV_PREFIX,
  TTL,
  EMAIL_STATUS,
  PAGINATION,
  TLD_UTC_OFFSET,
  SEND_WINDOW,
  CRON_EMAIL_TIME_BUDGET_MS,
} from '../constants';
import { query, queryOne, execute, now } from './db';
import { runWithConcurrency } from './concurrency';
import { isUnsubscribed } from '../routes/gdpr';
import { executeSecondaryChannels } from './channel-orchestrator';
import { getSubjectAllActiveChannels } from './growth/context';
import {
  pickWeightedIndex,
  recordVariantEngagement,
  loadVariantWeights,
  resolvePersistentVariantAssignment,
} from './email/ab';
import {
  prepareTemplateContext as prepareTemplateContextV2,
  prepareWarmTemplateContext,
} from './email/context';
import { renderTemplate } from './email/renderer';
import { sendWithProvider } from './email/provider';
import {
  checkThrottle,
  checkDomainGap,
  incrementSendCounter,
  recordDomainSend,
  todayDateKey,
  parseCampaignSchedule,
  COMPLIANCE,
} from './warmup';
import { verifyEmailDomain } from './email/verify';
import type { WarmupStep } from './warmup';
import { createAiEngineClient } from './ai-engine/client';

const WARM_EMAIL_CONCURRENCY = 4;

/**
 * Resolve recipient UTC offset from email domain TLD with compound-TLD support.
 */
function resolveRecipientUtcOffset(email: string): number {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  const parts = domain.split('.');
  const tld2 = parts.length >= 3 ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}` : '';
  const tld1 = parts[parts.length - 1] ?? '';
  return TLD_UTC_OFFSET[tld2] ?? TLD_UTC_OFFSET[tld1] ?? 0;
}

/**
 * Align a UTC timestamp to the recipient's local weekday send window.
 * Keeps cadence semantics by never scheduling earlier than `earliestUtcTs`.
 */
function alignToRecipientSendWindow(earliestUtcTs: number, email: string): number {
  const offsetHours = resolveRecipientUtcOffset(email);
  const offsetSeconds = offsetHours * 3600;

  // Convert to "synthetic local time" by applying the UTC offset.
  const local = new Date((earliestUtcTs + offsetSeconds) * 1000);

  // Push weekend sends to Monday 09:00 local.
  const localDay = local.getUTCDay();
  if (localDay === 0 || localDay === 6) {
    const daysToMonday = localDay === 0 ? 1 : 2;
    local.setUTCDate(local.getUTCDate() + daysToMonday);
    local.setUTCHours(SEND_WINDOW.IDEAL_START, 0, 0, 0);
  }

  const localHour = local.getUTCHours();
  if (localHour < SEND_WINDOW.IDEAL_START) {
    local.setUTCHours(SEND_WINDOW.IDEAL_START, 0, 0, 0);
  } else if (localHour >= SEND_WINDOW.IDEAL_END) {
    local.setUTCDate(local.getUTCDate() + 1);
    local.setUTCHours(SEND_WINDOW.IDEAL_START, 0, 0, 0);

    // If we rolled into weekend, jump to Monday.
    const rolledDay = local.getUTCDay();
    if (rolledDay === 0 || rolledDay === 6) {
      const daysToMonday = rolledDay === 0 ? 1 : 2;
      local.setUTCDate(local.getUTCDate() + daysToMonday);
      local.setUTCHours(SEND_WINDOW.IDEAL_START, 0, 0, 0);
    }
  }

  const alignedUtcTs = Math.floor(local.getTime() / 1000) - offsetSeconds;
  return Math.max(alignedUtcTs, earliestUtcTs);
}

export { pickWeightedIndex, recordVariantEngagement, loadVariantWeights };
export { prepareWarmTemplateContext };
export { injectUtmParams } from './email/renderer';

export function prepareTemplateContext(
  context: Record<string, unknown>,
  templateKey: string,
  variantWeights?: Record<string, number[]> | null,
): Record<string, unknown> {
  return prepareTemplateContextV2(context, templateKey, variantWeights);
}

function sanitizeSubjectLine(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  if (trimmed.length > 160) return trimmed.slice(0, 160).trim();
  return trimmed;
}

function sanitizePersonalizationCopy(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > 500 ? cleaned.slice(0, 500).trim() : cleaned;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function applyAiPersonalizationForOutbound(
  env: Env,
  input: {
    to: string;
    templateKey: string;
    subject: string;
    context: Record<string, unknown>;
    activeCampaignSlug: string;
  },
): Promise<{ subject: string; context: Record<string, unknown>; source: 'ai' | 'fallback'; reason?: string }> {
  const hints = Array.isArray(input.context.personalizationHints)
    ? input.context.personalizationHints.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : [];
  if (hints.length === 0) {
    return { subject: input.subject, context: input.context, source: 'fallback', reason: 'no_hints' };
  }

  const governanceMode = (env.GOVERNANCE_EXECUTION_MODE ?? 'off').toLowerCase();
  if (governanceMode === 'enforce' && !env.AI_ENGINE) {
    return { subject: input.subject, context: input.context, source: 'fallback', reason: 'enforce_mode_ai_unavailable' };
  }

  const aiClient = createAiEngineClient(env);
  if (!aiClient.configured) {
    return { subject: input.subject, context: input.context, source: 'fallback', reason: 'ai_binding_unavailable' };
  }

  try {
    const response = await aiClient.messageBrief({
      tenantId: 'default',
      subjectId: input.to,
      objective: input.templateKey,
      channelHints: ['email'],
      personalizationHints: hints,
      evidence: {
        campaignSlug: input.activeCampaignSlug,
        domain: input.context.domain ?? null,
        companyName: input.context.companyName ?? null,
      },
      policy: {
        suppressionChecked: true,
        throttleChecked: true,
        warmupChecked: true,
      },
    });

    if (!response.ok || !response.data || typeof response.data !== 'object') {
      return { subject: input.subject, context: input.context, source: 'fallback', reason: response.error ?? 'ai_error' };
    }

    const envelope = response.data as Record<string, unknown>;
    const candidate = (typeof envelope.data === 'object' && envelope.data !== null)
      ? envelope.data as Record<string, unknown>
      : envelope;

    const aiSubject = sanitizeSubjectLine(candidate.headline);
    const aiOpening = sanitizePersonalizationCopy(candidate.bodyIntent);

    const nextContext = { ...input.context };
    if (aiOpening) {
      nextContext.aiPersonalizationOpening = aiOpening;
      nextContext.aiPersonalizationHintsUsed = hints;
    }

    return {
      subject: aiSubject ?? input.subject,
      context: nextContext,
      source: aiSubject || aiOpening ? 'ai' : 'fallback',
      reason: aiSubject || aiOpening ? undefined : 'ai_empty_payload',
    };
  } catch (err) {
    return {
      subject: input.subject,
      context: input.context,
      source: 'fallback',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function injectAiPersonalizationBlock(htmlBody: string, opening: string): string {
  const block = `<p style="background:#f8fafc;border-left:3px solid #0ea5e9;padding:10px 14px;border-radius:4px;margin:0 0 16px 0;">${escapeHtml(opening)}</p>`;
  const containerOpen = /<div[^>]*>/i;
  if (!containerOpen.test(htmlBody)) {
    return `${block}${htmlBody}`;
  }
  return htmlBody.replace(containerOpen, (m) => `${m}${block}`);
}

/**
 * Enroll a contact in all active sequences matching an event type.
 *
 * @param capabilityHookId Optional attribution tag persisted onto each
 *   email_sends row (see migration 0010). Lets the admin metrics dashboard
 *   group opens / clicks / replies by capability hook. Pass `undefined` when
 *   the caller does not have a hook for this contact — the column is NULL.
 */
export async function enrollInSequences(
  env: Env,
  contactEmail: string,
  triggerEvent: string,
  contextData?: Record<string, unknown>,
  capabilityHookId?: string | null,
): Promise<number> {
  const isOutboundTrigger = triggerEvent.startsWith('outbound.');
  if (isOutboundTrigger) {
    const activeChannels = await getSubjectAllActiveChannels(env, 'default', contactEmail);
    if (activeChannels.length > 0) {
      await cancelPendingEmails(env, contactEmail, triggerEvent);
      console.log(
        `[Email] Suppressed cold outreach enrollment for ${contactEmail} because warmer channels are active: ${activeChannels.map((channel) => channel.channel).join(', ')}`,
      );
      return 0;
    }
  }

  const sequences = await query<{ id: number; name: string }>(
    env.DB,
    `SELECT id, name FROM email_sequences WHERE trigger_event = ? AND is_active = 1`,
    [triggerEvent]
  );

  if (sequences.length === 0) return 0;

  let totalScheduled = 0;
  const baseTime = now();
  const hookIdParam = capabilityHookId && capabilityHookId.length > 0 ? capabilityHookId : null;

  for (const seq of sequences) {
    const existing = await queryOne(
      env.DB,
      `SELECT id FROM email_sends WHERE contact_email = ? AND sequence_id = ? AND status IN ('${EMAIL_STATUS.SCHEDULED}', '${EMAIL_STATUS.SENT}') LIMIT 1`,
      [contactEmail, seq.id]
    );
    if (existing) {
      console.log(`[Email] ${contactEmail} already enrolled in sequence ${seq.name}, skipping`);
      continue;
    }

    const steps = await query<{ id: number; step_order: number; delay_seconds: number }>(
      env.DB,
      `SELECT id, step_order, delay_seconds FROM email_steps WHERE sequence_id = ? AND is_active = 1 ORDER BY step_order`,
      [seq.id]
    );

    for (const step of steps) {
      const earliestAt = baseTime + step.delay_seconds;
      const scheduledAt = isOutboundTrigger
        ? alignToRecipientSendWindow(earliestAt, contactEmail)
        : earliestAt;
      await execute(
        env.DB,
        `INSERT INTO email_sends (contact_email, sequence_id, step_id, status, scheduled_at, capability_hook_id)
         VALUES (?, ?, ?, '${EMAIL_STATUS.SCHEDULED}', ?, ?)`,
        [contactEmail, seq.id, step.id, scheduledAt, hookIdParam]
      );
      totalScheduled++;
    }

    if (contextData) {
      await env.KV_MARKETING.put(
        `${KV_PREFIX.EMAIL_CONTEXT}${contactEmail}:${seq.id}`,
        JSON.stringify(contextData),
        { expirationTtl: TTL.DAYS_30 }
      );
    }

    console.log(`[Email] Enrolled ${contactEmail} in "${seq.name}" - ${steps.length} steps scheduled`);
  }

  return totalScheduled;
}

// ─── Campaign Metrics ───────────────────────────────────────────────────────

/**
 * Increment a metric counter on the active outbound campaign.
 * Non-throwing — metric tracking must never block email delivery.
 */
export async function incrementCampaignMetric(
  db: Env['DB'],
  campaignSlug: string,
  metric: 'total_sent' | 'total_opened' | 'total_clicked' | 'total_replied' | 'total_bounced' | 'total_unsub',
): Promise<void> {
  try {
    await execute(
      db,
      `UPDATE outbound_campaigns SET ${metric} = ${metric} + 1, updated_at = ? WHERE slug = ? AND status IN ('active', 'paused')`,
      [Math.floor(Date.now() / 1000), campaignSlug],
    );
  } catch (err) {
    console.warn(`[Campaign] Failed to increment ${metric} on ${campaignSlug}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Process all currently due scheduled emails.
 */
export async function processDueEmails(
  env: Env,
  batchSize: number = PAGINATION.DEFAULT_PAGE_SIZE,
  options: { force?: boolean } = {}
): Promise<number> {
  const currentTime = now();

  const dueSends = await query<EmailSendRow & {
    subject: string;
    template_key: string;
    sequence_name: string;
    trigger_event: string;
  }>(
    env.DB,
    `SELECT es.*, est.subject, est.template_key, seq.name as sequence_name, seq.trigger_event
     FROM email_sends es
     JOIN email_steps est ON es.step_id = est.id
     JOIN email_sequences seq ON es.sequence_id = seq.id
     WHERE es.status = '${EMAIL_STATUS.SCHEDULED}' AND es.scheduled_at <= ?
     ORDER BY es.scheduled_at ASC
     LIMIT ?`,
    [currentTime, batchSize]
  );

  if (dueSends.length === 0) return 0;

  const dateKey = todayDateKey();
  let coldBudgetExhausted = false;
  let coldThrottleChecked = false;

  let activeCampaignSlug = 'cold-outreach-v1';
  let activeCampaignSchedule: ReadonlyArray<WarmupStep> | undefined;
  {
    const campaign = await queryOne<{ slug: string; warmup_schedule: string | null }>(
      env.DB,
      `SELECT slug, warmup_schedule FROM outbound_campaigns WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`
    );
    if (campaign) {
      activeCampaignSlug = campaign.slug;
      activeCampaignSchedule = parseCampaignSchedule(campaign.warmup_schedule);
    }
  }

  const nowDate = new Date(currentTime * 1000);
  const utcHour = nowDate.getUTCHours();
  const utcDay = nowDate.getUTCDay();
  // Baseline business-hours gate (UTC) — per-prospect TLD-based adjustment below
  const isWeekday = utcDay >= 1 && utcDay <= 5;
  const isBusinessHours = options.force || (isWeekday && utcHour >= 7 && utcHour < 20);
  // Wider window (7-20 UTC) since per-prospect check below tightens it

  let coldAutoPaused = false;
  {
    const yesterday = new Date(nowDate);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayKey = yesterday.toISOString().slice(0, 10);
    const metricsJson = await env.KV_MARKETING.get(`${KV_PREFIX.OUTBOUND_DELIVERABILITY}${yesterdayKey}`);
    if (metricsJson) {
      const m = JSON.parse(metricsJson) as Record<string, number>;
      const totalSent = (m.delivered ?? 0) + (m.bounced ?? 0);
      if (totalSent >= 10) {
        const bounceRate = (m.bounced ?? 0) / totalSent;
        const complaintRate = (m.complained ?? 0) / totalSent;
        if (bounceRate > COMPLIANCE.MAX_BOUNCE_RATE) {
          console.error(`[Email] AUTO-PAUSE: bounce rate ${(bounceRate * 100).toFixed(1)}% exceeds ${COMPLIANCE.MAX_BOUNCE_RATE * 100}% threshold`);
          coldAutoPaused = true;
        }
        if (complaintRate > COMPLIANCE.MAX_COMPLAINT_RATE) {
          console.error(`[Email] AUTO-PAUSE: complaint rate ${(complaintRate * 100).toFixed(2)}% exceeds ${COMPLIANCE.MAX_COMPLAINT_RATE * 100}% threshold`);
          coldAutoPaused = true;
        }
      }
    }
  }

  let sentCount = 0;
  let skippedThrottle = 0;
  let skippedDomainGap = 0;
  let coldSendIndex = 0;
  const loopStartedAt = Date.now();

  /**
   * Check if the current UTC hour is within the prospect's local business window.
   * Uses TLD heuristic — no external API needed.
   */
  const isInProspectSendWindow = (email: string): boolean => {
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    // Extract TLD: handle compound TLDs like co.uk
    const parts = domain.split('.');
    const tld2 = parts.length >= 3 ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}` : '';
    const tld1 = parts[parts.length - 1] ?? '';
    const offset = TLD_UTC_OFFSET[tld2] ?? TLD_UTC_OFFSET[tld1] ?? 0;
    const recipientHour = (utcHour + offset + 24) % 24;
    return recipientHour >= SEND_WINDOW.IDEAL_START && recipientHour < SEND_WINDOW.IDEAL_END;
  };

  const coldSends = dueSends.filter((send) => send.trigger_event?.startsWith('outbound.'));
  const warmSends = dueSends.filter((send) => !send.trigger_event?.startsWith('outbound.'));

  const processSingleSend = async (
    send: EmailSendRow & { subject: string; template_key: string; sequence_name: string; trigger_event: string },
    isColdOutreach: boolean,
  ): Promise<boolean> => {
    try {
      const contextJson = await env.KV_MARKETING.get(`${KV_PREFIX.EMAIL_CONTEXT}${send.contact_email}:${send.sequence_id}`);
      let baseContext = contextJson ? JSON.parse(contextJson) as Record<string, unknown> : {};

      if (isColdOutreach && Object.keys(baseContext).length <= 1) {
        const coldCtxJson = await env.KV_MARKETING.get(`${KV_PREFIX.EMAIL_CONTEXT}${send.contact_email}:cold-outreach`);
        if (coldCtxJson) {
          baseContext = { ...baseContext, ...(JSON.parse(coldCtxJson) as Record<string, unknown>) };
        }
      }

      // Keep campaign slug in context so outbound analytics and AI personalization
      // can attribute generated copy back to the active experiment.
      baseContext = {
        ...baseContext,
        campaignSlug: activeCampaignSlug,
        contactEmail: send.contact_email,
      };

      const variantWeights = await loadVariantWeights(env.KV_MARKETING, send.template_key);
      let context = isColdOutreach
        ? prepareTemplateContext(baseContext, send.template_key, variantWeights)
        : prepareWarmTemplateContext(baseContext, send.template_key, variantWeights);

      if (isColdOutreach) {
        const subjectPoolSize = typeof context._subjectPoolSize === 'number' ? context._subjectPoolSize : 0;
        const bodyPoolSize = typeof context._bodyPoolSize === 'number' ? context._bodyPoolSize : 0;
        const subjectWeightsKey = typeof context._subjectWeightsKey === 'string' ? context._subjectWeightsKey : null;
        const bodyWeightsKey = typeof context._bodyWeightsKey === 'string' ? context._bodyWeightsKey : null;

        let forcedSubjectIdx: number | null = null;
        let forcedBodyIdx: number | null = null;

        if (subjectPoolSize > 0) {
          forcedSubjectIdx = await resolvePersistentVariantAssignment(env.KV_MARKETING, {
            campaignSlug: activeCampaignSlug,
            contactEmail: send.contact_email,
            templateKey: send.template_key,
            variantType: 'subject',
            poolSize: subjectPoolSize,
            weights: subjectWeightsKey ? variantWeights?.[subjectWeightsKey]?.slice(0, subjectPoolSize) : undefined,
          });
        }

        if (bodyPoolSize > 0) {
          forcedBodyIdx = await resolvePersistentVariantAssignment(env.KV_MARKETING, {
            campaignSlug: activeCampaignSlug,
            contactEmail: send.contact_email,
            templateKey: send.template_key,
            variantType: 'body',
            poolSize: bodyPoolSize,
            weights: bodyWeightsKey ? variantWeights?.[bodyWeightsKey]?.slice(0, bodyPoolSize) : undefined,
          });
        }

        if (forcedSubjectIdx !== null || forcedBodyIdx !== null) {
          const forcedContext = {
            ...baseContext,
            ...(forcedSubjectIdx !== null ? { _subjectVariantIdxForced: forcedSubjectIdx } : {}),
            ...(forcedBodyIdx !== null ? { _bodyVariantIdxForced: forcedBodyIdx } : {}),
          };
          context = prepareTemplateContext(forcedContext, send.template_key, variantWeights);
        }
      }

      let subject = (context.variantSubject)
        ? String(context.variantSubject)
        : send.subject;

      if (isColdOutreach) {
        const personalized = await applyAiPersonalizationForOutbound(env, {
          to: send.contact_email,
          templateKey: send.template_key,
          subject,
          context,
          activeCampaignSlug,
        });
        context = personalized.context;
        subject = personalized.subject;
      }

      // Extract variant indices set by prepareTemplateContext / prepareWarmTemplateContext.
      // Stored as numbers (null if the template has no variant pool).
      const subjectVariantIdx = typeof context._subjectVariantIdx === 'number'
        ? context._subjectVariantIdx
        : null;
      const bodyVariantIdx = typeof context._bodyVariantIdx === 'number'
        ? context._bodyVariantIdx
        : null;
      // Framing tier drives score-band copy selection AND A/B learning partition.
      const framingTier = typeof context._framingTier === 'string'
        ? context._framingTier
        : null;

      const providerResult = await sendEmail(env, {
        to: send.contact_email,
        subject,
        templateKey: send.template_key,
        context,
        sendId: send.id,
      });

      // Persist engagement correlator for webhook (see constants.KV_PREFIX.AB_SEND).
      // Best-effort — webhook has a fallback query path if this KV write fails.
      try {
        await env.KV_MARKETING.put(
          `${KV_PREFIX.AB_SEND}${send.contact_email}:${send.id}`,
          JSON.stringify({
            templateKey: send.template_key,
            subIdx: subjectVariantIdx,
            bodyIdx: bodyVariantIdx,
            tier: framingTier,
            sentAt: now(),
          }),
          { expirationTtl: TTL.DAYS_90 },
        );
      } catch (kvErr) {
        console.warn(
          `[Email] ab:send KV write failed for send ${send.id}:`,
          kvErr instanceof Error ? kvErr.message : kvErr,
        );
      }

      await execute(
        env.DB,
        `UPDATE email_sends
            SET status = '${EMAIL_STATUS.SENT}',
                sent_at = ?,
                rendered_subject = ?,
                subject_variant_idx = ?,
                body_variant_idx = ?,
                brevo_message_id = ?,
                framing_tier = ?
          WHERE id = ?`,
        [
          now(),
          subject,
          subjectVariantIdx,
          bodyVariantIdx,
          providerResult.messageId,
          framingTier,
          send.id,
        ],
      );

      if (isColdOutreach) {
        await incrementSendCounter(env.KV_MARKETING, dateKey);
        await incrementCampaignMetric(env.DB, activeCampaignSlug, 'total_sent');

        const domain = send.contact_email.split('@')[1]?.toLowerCase();
        if (domain) {
          await recordDomainSend(env.KV_MARKETING, domain, now());
        }

        const prospectDomain = String(context.domain ?? domain ?? '');
        if (prospectDomain) {
          try {
            const secondaryChannels = await executeSecondaryChannels(
              env,
              prospectDomain,
              send.contact_email,
              context,
              send.template_key,
              activeCampaignSlug
            );
            if (secondaryChannels.length > 0) {
              console.log(`[Email] Secondary channels used for ${send.contact_email}: ${secondaryChannels.join(', ')}`);
            }
          } catch (chErr) {
            console.log(`[Email] Channel orchestration error for ${send.contact_email}: ${chErr instanceof Error ? chErr.message : chErr}`);
          }
        }

        const updated = await checkThrottle(
          env.KV_MARKETING,
          activeCampaignSlug,
          dateKey,
          now(),
          activeCampaignSchedule
        );
        coldBudgetExhausted = !updated.allowed;
        coldSendIndex++;
      }

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Email] Failed to send ${send.id} to ${send.contact_email}: ${errorMsg}`);
      await execute(
        env.DB,
        `UPDATE email_sends SET status = '${EMAIL_STATUS.FAILED}', error = ? WHERE id = ?`,
        [errorMsg, send.id]
      );
      return false;
    }
  };

  for (const send of coldSends) {
    const isColdOutreach = true;

    // Time-budget guard: stop claiming new cold sends if the cron is near its
    // wall-clock limit. Deferred sends are picked up cleanly on the next run.
    if (Date.now() - loopStartedAt > CRON_EMAIL_TIME_BUDGET_MS) {
      console.log('[Email] Cron time budget reached, deferring remaining cold sends');
      break;
    }

    if (isColdOutreach) {
      if (!isBusinessHours) {
        skippedThrottle++;
        continue;
      }

      // Per-prospect send window: skip if it's outside their estimated local business hours
      if (!options.force && !isInProspectSendWindow(send.contact_email)) {
        continue; // Silently defer — will be picked up next cron run when their window aligns
      }

      if (coldAutoPaused) {
        skippedThrottle++;
        continue;
      }

      if (coldSendIndex > 0) {
        const delayMs = 2000 + Math.floor(Math.random() * 4000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      if (!coldThrottleChecked) {
        const throttle = await checkThrottle(
          env.KV_MARKETING,
          activeCampaignSlug,
          dateKey,
          currentTime,
          activeCampaignSchedule
        );
        coldBudgetExhausted = !throttle.allowed;
        coldThrottleChecked = true;
        if (coldBudgetExhausted) {
          console.log(`[Email] Cold outreach throttled: ${throttle.reason}`);
        }
      }

      if (coldBudgetExhausted) {
        skippedThrottle++;
        continue;
      }

      const domain = send.contact_email.split('@')[1]?.toLowerCase();
      if (domain) {
        const domainOk = await checkDomainGap(env.KV_MARKETING, domain, currentTime);
        if (!domainOk) {
          console.log(`[Email] Domain gap not met for ${domain}, deferring send ${send.id}`);
          skippedDomainGap++;
          continue;
        }

        // MX verification on first step only (step_order = 1) — skip entire send if domain has no MX
        if (send.template_key.endsWith('-step1')) {
          const mxResult = await verifyEmailDomain(env.KV_MARKETING, send.contact_email);
          if (!mxResult.valid) {
            console.log(`[Email] MX verification failed for ${domain}: ${mxResult.reason}, cancelling sequence`);
            await execute(
              env.DB,
              `UPDATE email_sends SET status = '${EMAIL_STATUS.CANCELLED}', error = ? WHERE contact_email = ? AND sequence_id = ? AND status = '${EMAIL_STATUS.SCHEDULED}'`,
              [`mx_verification_failed:${mxResult.reason}`, send.contact_email, send.sequence_id],
            );
            continue;
          }
        }
      }
    }

    const sent = await processSingleSend(send, true);
    if (sent) {
      sentCount++;
    }
  }

  await runWithConcurrency(warmSends, WARM_EMAIL_CONCURRENCY, async (send) => {
    const sent = await processSingleSend(send, false);
    if (sent) sentCount++;
  });

  const throttleInfo = (skippedThrottle + skippedDomainGap) > 0
    ? ` (${skippedThrottle} throttled, ${skippedDomainGap} domain-gapped)`
    : '';
  console.log(`[Email] Processed ${dueSends.length} due emails, ${sentCount} sent${throttleInfo}`);
  return sentCount;
}

/**
 * Cancel pending scheduled emails for a contact.
 */
export async function cancelPendingEmails(
  env: Env,
  contactEmail: string,
  triggerEvent?: string
): Promise<number> {
  let sql = `UPDATE email_sends SET status = '${EMAIL_STATUS.CANCELLED}' WHERE contact_email = ? AND status = '${EMAIL_STATUS.SCHEDULED}'`;
  const params: unknown[] = [contactEmail];

  if (triggerEvent) {
    sql += ` AND sequence_id IN (SELECT id FROM email_sequences WHERE trigger_event = ?)`;
    params.push(triggerEvent);
  }

  const result = await execute(env.DB, sql, params);
  return result.meta?.changes ?? 0;
}

interface EmailPayload {
  to: string;
  subject: string;
  templateKey: string;
  context: Record<string, unknown>;
  /** email_sends.id threaded to the provider as a tag for webhook correlation. */
  sendId?: number;
}

/**
 * Send one email via configured provider.
 *
 * Returns the provider's message id (or `null` if suppressed / in dev mode /
 * provider did not surface one). Callers persist the id onto the email_sends
 * row so webhooks can correlate opens, clicks, bounces, and complaints.
 */
async function sendEmail(
  env: Env,
  payload: EmailPayload,
): Promise<{ messageId: string | null }> {
  const { to, subject, templateKey, context, sendId } = payload;

  if (await isUnsubscribed(env, to)) {
    console.log(`[Email] Skipping send to ${to} - unsubscribed`);
    return { messageId: null };
  }

  let htmlBody = await renderTemplate(env, templateKey, {
    ...context,
    subject,
    to,
  });

  const personalizationOpening = typeof context.aiPersonalizationOpening === 'string'
    ? context.aiPersonalizationOpening
    : null;
  if (personalizationOpening) {
    htmlBody = injectAiPersonalizationBlock(htmlBody, personalizationOpening);
  }

  if (env.ENVIRONMENT === 'development' || !env.EMAIL_API_KEY) {
    console.log(`[Email:Dev] Would send to ${to}: "${subject}" (template: ${templateKey})`);
    return { messageId: null };
  }

  const isCold = templateKey.startsWith('cold-outreach-');
  return sendWithProvider(env, to, subject, htmlBody, {
    skipBulkHeaders: isCold,
    sendId,
    templateKey,
  });
}
