/**
 * Channel Orchestrator — Multi-channel outreach coordination.
 *
 * Manages the full lifecycle of prospect channels:
 *   1. Detection: stores channels discovered during enrichment
 *   2. Orchestration: cascades through channels in priority order
 *   3. Tracking: records every attempt with status and outcome
 *
 * Channel priority (lower number = tried first):
 *   1. email           — Brevo transactional API
 *   2. contact_form    — HTTP POST to detected web forms
 *   3. twitter         — Manual (surfaced in admin)
 *   4. linkedin        — Manual (surfaced in admin)
 *   5. chat_intercom   — Manual (surfaced in admin)
 *   6. chat_drift      — Manual (surfaced in admin)
 *   7. chat_crisp      — Manual (surfaced in admin)
 *   8. chat_hubspot    — Manual (surfaced in admin)
 *
 * Automated channels: email, contact_form
 * Manual channels: social handles, chat widgets (shown in admin for human follow-up)
 *
 * @module lib/channel-orchestrator
 */

import type { Env, ContactForm, SocialHandles } from '../types';
import { execute, query, queryOne } from './db';
import { submitContactForm } from './contact-form';
import { enqueueEligibleSkripChannels } from './skrip/outbox';
import { emitChannelFallbackEvent } from './telemetry';

// ── Channel Priority Map ────────────────────────────────────────────────

export const CHANNEL_PRIORITY: Record<string, number> = {
  email:          1,
  contact_form:   2,
  twitter:        3,
  linkedin:       4,
  facebook:       5,
  github:         6,
  instagram:      7,
  chat_intercom:  8,
  chat_drift:     9,
  chat_crisp:     10,
  chat_hubspot:   11,
} as const;

// Chat widget names as detected by _detectTechStack in analytics
const CHAT_WIDGETS = ['intercom', 'drift', 'crisp', 'hubspot'] as const;

// ── Channel Storage ─────────────────────────────────────────────────────

/**
 * Store all detected outreach channels for a prospect in D1.
 * Called once during enrichment via handleProspectEnriched().
 *
 * Upserts: if the prospect was previously enriched, existing channels
 * are updated (UNIQUE constraint on domain+type uses INSERT OR REPLACE).
 *
 * @returns Number of channels stored
 */
export async function storeProspectChannels(
  env: Env,
  data: {
    domain: string;
    contactEmail: string | null;
    contactForms: ContactForm[];
    socialHandles: SocialHandles | Record<string, unknown>;
    techStack: string[];
  }
): Promise<number> {
  const { domain, contactEmail, contactForms, socialHandles, techStack } = data;
  let count = 0;

  // ── Email channel ──
  if (contactEmail) {
    await execute(
      env.DB,
      `INSERT OR REPLACE INTO prospect_channels (prospect_domain, contact_email, channel_type, channel_value, priority, detected_at)
       VALUES (?, ?, 'email', ?, ?, unixepoch())`,
      [domain, contactEmail, contactEmail, CHANNEL_PRIORITY.email]
    );
    count++;
  }

  // ── Contact forms ──
  if (contactForms.length > 0) {
    // Store the best form (first one — already prioritised by extraction)
    const best = contactForms[0];
    await execute(
      env.DB,
      `INSERT OR REPLACE INTO prospect_channels (prospect_domain, contact_email, channel_type, channel_value, channel_meta, priority, detected_at)
       VALUES (?, ?, 'contact_form', ?, ?, ?, unixepoch())`,
      [domain, contactEmail, best.action, JSON.stringify(best), CHANNEL_PRIORITY.contact_form]
    );
    count++;
  }

  // ── Social handles ──
  const socialMap: Record<string, string | null> = {
    twitter:   (socialHandles as SocialHandles).twitter ?? null,
    linkedin:  (socialHandles as SocialHandles).linkedin ?? null,
    facebook:  (socialHandles as SocialHandles).facebook ?? null,
    github:    (socialHandles as SocialHandles).github ?? null,
    instagram: (socialHandles as SocialHandles).instagram ?? null,
  };

  for (const [platform, url] of Object.entries(socialMap)) {
    if (!url) continue;
    await execute(
      env.DB,
      `INSERT OR REPLACE INTO prospect_channels (prospect_domain, contact_email, channel_type, channel_value, priority, detected_at)
       VALUES (?, ?, ?, ?, ?, unixepoch())`,
      [domain, contactEmail, platform, url, CHANNEL_PRIORITY[platform] ?? 99]
    );
    count++;
  }

  // ── Chat widgets (from tech stack detection) ──
  for (const widget of CHAT_WIDGETS) {
    if (techStack.some(t => t.toLowerCase() === widget)) {
      const channelType = `chat_${widget}`;
      await execute(
        env.DB,
        `INSERT OR REPLACE INTO prospect_channels (prospect_domain, contact_email, channel_type, channel_value, priority, detected_at)
         VALUES (?, ?, ?, ?, ?, unixepoch())`,
        [domain, contactEmail, channelType, widget, CHANNEL_PRIORITY[channelType] ?? 99]
      );
      count++;
    }
  }

  return count;
}

// ── Channel Attempt Tracking ────────────────────────────────────────────

/**
 * Record an outreach attempt for a specific channel.
 * Every send (email, form, manual social DM) gets a row here.
 */
export async function recordChannelAttempt(
  env: Env,
  data: {
    domain: string;
    contactEmail: string | null;
    channelType: string;
    channelValue: string;
    stepKey?: string;
    campaignSlug?: string;
    status: 'attempted' | 'delivered' | 'failed';
    responseCode?: number;
    error?: string;
  }
): Promise<void> {
  await execute(
    env.DB,
    `INSERT INTO channel_attempts
     (prospect_domain, contact_email, channel_type, channel_value, step_key, campaign_slug, status, response_code, error, attempted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
    [
      data.domain,
      data.contactEmail ?? null,
      data.channelType,
      data.channelValue,
      data.stepKey ?? null,
      data.campaignSlug ?? null,
      data.status,
      data.responseCode ?? null,
      data.error ?? null,
    ]
  );
}

// ── Orchestration ───────────────────────────────────────────────────────

/**
 * Execute multi-channel outreach for a prospect after the primary
 * email send. Called from processDueEmails() for step1 cold outreach.
 *
 * Cascade logic:
 *   1. After email sent → attempt contact_form (if detected, not yet attempted)
 *   2. Social + chat channels are flagged as 'detected' for manual follow-up
 *
 * @param env      Worker env
 * @param domain   Prospect domain
 * @param email    Prospect email
 * @param context  Full KV context for template rendering
 * @param stepKey  Current step key (e.g. 'cold-outreach-step1')
 * @param campaignSlug  Active campaign slug
 * @returns        Channels actually used (automated)
 */
export async function executeSecondaryChannels(
  env: Env,
  domain: string,
  email: string,
  context: Record<string, unknown>,
  stepKey: string,
  campaignSlug: string,
  options: {
    tenantId?: string | null;
    messageId?: string | null;
    allowedSkripChannels?: string[] | null;
    fallbackChain?: string[] | null;
  } = {},
): Promise<string[]> {
  const usedChannels: string[] = [];

  try {
    const skripEnqueues = await enqueueEligibleSkripChannels(env, {
      tenantId: options.tenantId ?? undefined,
      campaignId: campaignSlug,
      stepId: stepKey,
      contactId: email,
      domain,
      context,
      allowedChannels: options.allowedSkripChannels ?? undefined,
      fallbackChain: options.fallbackChain ?? undefined,
    });

    if (skripEnqueues.length > 0) {
      console.log(
        `[Orchestrator] Staged ${skripEnqueues.length} Skrip channel(s) for ${email}: ${skripEnqueues.map((entry) => `${entry.channel}:${entry.status}`).join(', ')}`,
      );

      const activeFallbackChain = options.fallbackChain ?? [];
      const resolvedTarget = activeFallbackChain.find((channel) => channel !== 'email' && skripEnqueues.some((entry) => entry.channel === channel))
        ?? skripEnqueues[0].channel;

      if (resolvedTarget) {
        await emitChannelFallbackEvent(env, {
          tenantId: options.tenantId ?? 'default',
          messageId: options.messageId ?? `fallback:${email}:${Date.now()}`,
          correlationId: options.messageId ?? undefined,
          fromChannel: 'email',
          toChannel: resolvedTarget,
          reason: 'campaign_secondary_channel_stage',
          campaignId: campaignSlug,
          stepId: stepKey,
          contactId: email,
        });
      }
    }
  } catch (err) {
    console.log(`[Orchestrator] Skrip staging error for ${email}: ${err instanceof Error ? err.message : err}`);
  }

  // ── Track the email send (marked 'attempted' until Brevo webhook confirms delivery) ──
  await recordChannelAttempt(env, {
    domain,
    contactEmail: email,
    channelType: 'email',
    channelValue: email,
    stepKey,
    campaignSlug,
    status: 'attempted',
  });

  // ── Attempt contact form (only on step1) ──
  if (stepKey === 'cold-outreach-step1') {
    const formChannel = await queryOne<{ channel_value: string; channel_meta: string }>(
      env.DB,
      `SELECT channel_value, channel_meta FROM prospect_channels
       WHERE prospect_domain = ? AND channel_type = 'contact_form'`,
      [domain]
    );

    if (formChannel) {
      // Check if already attempted for this domain
      const priorAttempt = await queryOne<{ id: number }>(
        env.DB,
        `SELECT id FROM channel_attempts
         WHERE prospect_domain = ? AND channel_type = 'contact_form'
         LIMIT 1`,
        [domain]
      );

      if (!priorAttempt && formChannel.channel_meta) {
        try {
          const form: ContactForm = JSON.parse(formChannel.channel_meta);
          const success = await submitContactForm(env, form, context);

          await recordChannelAttempt(env, {
            domain,
            contactEmail: email,
            channelType: 'contact_form',
            channelValue: formChannel.channel_value,
            stepKey,
            campaignSlug,
            status: success ? 'delivered' : 'failed',
          });

          if (success) {
            usedChannels.push('contact_form');
            console.log(`[Orchestrator] Contact form submitted for ${domain}`);
          }
        } catch (err) {
          await recordChannelAttempt(env, {
            domain,
            contactEmail: email,
            channelType: 'contact_form',
            channelValue: formChannel.channel_value,
            stepKey,
            campaignSlug,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return usedChannels;
}

/**
 * When no email is available, try alternative channels in cascade order.
 * Currently supports contact_form only (social/chat are manual).
 *
 * Called from prospect enrollment when contactEmail is null but
 * other channels exist.
 *
 * @returns true if any automated channel succeeded
 */
export async function executeWithoutEmail(
  env: Env,
  domain: string,
  context: Record<string, unknown>,
  campaignSlug: string
): Promise<boolean> {
  // Check for contact form channel
  const formChannel = await queryOne<{ channel_value: string; channel_meta: string }>(
    env.DB,
    `SELECT channel_value, channel_meta FROM prospect_channels
     WHERE prospect_domain = ? AND channel_type = 'contact_form'`,
    [domain]
  );

  if (formChannel?.channel_meta) {
    const priorAttempt = await queryOne<{ id: number }>(
      env.DB,
      `SELECT id FROM channel_attempts WHERE prospect_domain = ? AND channel_type = 'contact_form' LIMIT 1`,
      [domain]
    );

    if (!priorAttempt) {
      try {
        const form: ContactForm = JSON.parse(formChannel.channel_meta);
        const success = await submitContactForm(env, form, context);

        await recordChannelAttempt(env, {
          domain,
          contactEmail: null,
          channelType: 'contact_form',
          channelValue: formChannel.channel_value,
          stepKey: 'cold-outreach-step1',
          campaignSlug,
          status: success ? 'delivered' : 'failed',
        });

        if (success) {
          console.log(`[Orchestrator] No email — contact form submitted for ${domain}`);
          return true;
        }
      } catch (err) {
        console.error(`[Orchestrator] No-email form attempt failed for ${domain}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Social + chat channels logged as available but require manual action
  const manualChannels = await query<{ channel_type: string; channel_value: string }>(
    env.DB,
    `SELECT channel_type, channel_value FROM prospect_channels
     WHERE prospect_domain = ? AND channel_type NOT IN ('email', 'contact_form')
     ORDER BY priority ASC`,
    [domain]
  );

  if (manualChannels.length > 0) {
    console.log(`[Orchestrator] No email/form for ${domain} — ${manualChannels.length} manual channels available: ${manualChannels.map(c => c.channel_type).join(', ')}`);
  }

  return false;
}

// ── Admin Query Helpers ─────────────────────────────────────────────────

/**
 * Get all channels for a specific prospect domain.
 */
export async function getProspectChannels(
  env: Env,
  domain: string
): Promise<Array<{
  channel_type: string;
  channel_value: string;
  priority: number;
  detected_at: number;
  attempts: number;
  last_status: string | null;
}>> {
  return query(
    env.DB,
    `SELECT pc.channel_type, pc.channel_value, pc.priority, pc.detected_at,
            COALESCE(ca.attempts, 0) as attempts,
            ca.last_status
     FROM prospect_channels pc
     LEFT JOIN (
       SELECT channel_type, prospect_domain,
              COUNT(*) as attempts,
              (SELECT status FROM channel_attempts ca2
               WHERE ca2.prospect_domain = channel_attempts.prospect_domain
                 AND ca2.channel_type = channel_attempts.channel_type
               ORDER BY attempted_at DESC LIMIT 1) as last_status
       FROM channel_attempts
       GROUP BY prospect_domain, channel_type
     ) ca ON ca.prospect_domain = pc.prospect_domain AND ca.channel_type = pc.channel_type
     WHERE pc.prospect_domain = ?
     ORDER BY pc.priority ASC`,
    [domain]
  );
}

/**
 * Get aggregate channel statistics across all prospects.
 */
export async function getChannelStats(
  env: Env
): Promise<{
  channelCounts: Record<string, number>;
  attemptCounts: Record<string, { attempted: number; delivered: number; failed: number }>;
  totalProspects: number;
  prospectsWith: Record<string, number>;
}> {
  // Count prospects per channel type
  const channelRows = await query<{ channel_type: string; count: number }>(
    env.DB,
    `SELECT channel_type, COUNT(*) as count FROM prospect_channels GROUP BY channel_type ORDER BY count DESC`
  );

  // Count attempts per channel type and status
  const attemptRows = await query<{ channel_type: string; status: string; count: number }>(
    env.DB,
    `SELECT channel_type, status, COUNT(*) as count FROM channel_attempts GROUP BY channel_type, status`
  );

  // Total unique prospects with any channel
  const totalRow = await queryOne<{ count: number }>(
    env.DB,
    `SELECT COUNT(DISTINCT prospect_domain) as count FROM prospect_channels`
  );

  const channelCounts: Record<string, number> = {};
  const prospectsWith: Record<string, number> = {};
  for (const r of channelRows) {
    channelCounts[r.channel_type] = r.count;
    prospectsWith[r.channel_type] = r.count;
  }

  const attemptCounts: Record<string, { attempted: number; delivered: number; failed: number }> = {};
  for (const r of attemptRows) {
    if (!attemptCounts[r.channel_type]) {
      attemptCounts[r.channel_type] = { attempted: 0, delivered: 0, failed: 0 };
    }
    if (r.status === 'attempted') attemptCounts[r.channel_type].attempted += r.count;
    else if (r.status === 'delivered') attemptCounts[r.channel_type].delivered += r.count;
    else if (r.status === 'failed') attemptCounts[r.channel_type].failed += r.count;
  }

  return {
    channelCounts,
    attemptCounts,
    totalProspects: totalRow?.count ?? 0,
    prospectsWith,
  };
}
