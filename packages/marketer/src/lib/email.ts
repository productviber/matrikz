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
} from '../constants';
import { query, queryOne, execute, now } from './db';
import { runWithConcurrency } from './concurrency';
import { isUnsubscribed } from '../routes/gdpr';
import { executeSecondaryChannels } from './channel-orchestrator';
import { pickWeightedIndex, recordVariantEngagement, loadVariantWeights } from './email/ab';
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

const WARM_EMAIL_CONCURRENCY = 4;

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

/**
 * Enroll a contact in all active sequences matching an event type.
 */
export async function enrollInSequences(
  env: Env,
  contactEmail: string,
  triggerEvent: string,
  contextData?: Record<string, unknown>
): Promise<number> {
  const sequences = await query<{ id: number; name: string }>(
    env.DB,
    `SELECT id, name FROM email_sequences WHERE trigger_event = ? AND is_active = 1`,
    [triggerEvent]
  );

  if (sequences.length === 0) return 0;

  let totalScheduled = 0;
  const baseTime = now();

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
      const scheduledAt = baseTime + step.delay_seconds;
      await execute(
        env.DB,
        `INSERT INTO email_sends (contact_email, sequence_id, step_id, status, scheduled_at)
         VALUES (?, ?, ?, '${EMAIL_STATUS.SCHEDULED}', ?)`,
        [contactEmail, seq.id, step.id, scheduledAt]
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
      let context = contextJson ? JSON.parse(contextJson) as Record<string, unknown> : {};

      if (isColdOutreach && Object.keys(context).length <= 1) {
        const coldCtxJson = await env.KV_MARKETING.get(`${KV_PREFIX.EMAIL_CONTEXT}${send.contact_email}:cold-outreach`);
        if (coldCtxJson) {
          context = { ...context, ...(JSON.parse(coldCtxJson) as Record<string, unknown>) };
        }
      }

      if (isColdOutreach) {
        context = prepareTemplateContext(context, send.template_key);
      } else {
        // Warm sends: prepare template context with weighted A/B variant selection
        const warmWeights = await loadVariantWeights(env.KV_MARKETING, send.template_key);
        context = prepareWarmTemplateContext(context, send.template_key, warmWeights);
      }

      const subject = (context.variantSubject)
        ? String(context.variantSubject)
        : send.subject;

      await sendEmail(env, {
        to: send.contact_email,
        subject,
        templateKey: send.template_key,
        context,
      });

      await execute(
        env.DB,
        `UPDATE email_sends SET status = '${EMAIL_STATUS.SENT}', sent_at = ? WHERE id = ?`,
        [now(), send.id]
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
}

/**
 * Send one email via configured provider.
 */
async function sendEmail(env: Env, payload: EmailPayload): Promise<void> {
  const { to, subject, templateKey, context } = payload;

  if (await isUnsubscribed(env, to)) {
    console.log(`[Email] Skipping send to ${to} - unsubscribed`);
    return;
  }

  const htmlBody = await renderTemplate(env, templateKey, {
    ...context,
    subject,
    to,
  });

  if (env.ENVIRONMENT === 'development' || !env.EMAIL_API_KEY) {
    console.log(`[Email:Dev] Would send to ${to}: "${subject}" (template: ${templateKey})`);
    return;
  }

  const isCold = templateKey.startsWith('cold-outreach-');
  await sendWithProvider(env, to, subject, htmlBody, {
    skipBulkHeaders: isCold,
  });
}
