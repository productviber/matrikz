/**
 * Outbound Event Handlers — Processes prospect discovery and enrichment events
 * from the visibility-analytics worker.
 *
 * Triggered when:
 *   - `outbound.prospect_discovered`: A new prospect found via Apollo/PH/HN/Reddit
 *   - `outbound.prospect_enriched`: Prospect enriched with audit data, tech stack, angles
 *
 * Responsibilities:
 *   1. Upsert contact as "prospect" in the marketing CRM
 *   2. Store enrichment context in KV for cold email template rendering
 *   3. Enroll qualified prospects in the cold outreach email sequence
 *   4. Update contact metadata when enrichment data arrives
 *   5. Skip enrollment if prospect has no email (nothing to send to)
 *
 * Architecture alignment:
 *   - Analytics discovers + enriches → emits events
 *   - Marketing receives events → upserts CRM + enrolls in sequences
 *   - Marketing's existing processDueEmails() cron handles actual sending
 *   - See: docs/OUTBOUND_SYSTEM_ARCHITECTURE.md §3, §7, §8.3
 */

import type { Env, OutboundProspectDiscoveredData, OutboundProspectEnrichedData, ContactForm, SocialHandles } from '../types';
import { CONTACT_STATUS, CONTACT_SOURCE, EVENT_TYPES, KV_PREFIX, TTL, isPersonalEmail } from '../constants';
import { upsertContact } from '../lib/crm';
import { enrollInSequences } from '../lib/email';
import { execute } from '../lib/db';
import { storeProspectChannels, executeWithoutEmail } from '../lib/channel-orchestrator';
import { isSuppressed } from '../lib/suppression';

/**
 * Handle outbound.prospect_discovered event.
 *
 * Creates a CRM contact with status 'prospect' and source 'outbound'.
 * If the prospect has a qualified email (non-personal domain), enrolls
 * them in the cold outreach sequence.
 */
export async function handleProspectDiscovered(
  env: Env,
  data: OutboundProspectDiscoveredData,
  timestamp: string
): Promise<void> {
  const { prospectId, domain, companyName, contactEmail, contactName, contactTitle, source, score } = data;

  console.log(
    `[Outbound] Prospect discovered: ${domain} (score=${score}, source=${source}, email=${contactEmail ? 'yes' : 'no'})`
  );

  // No email → can't send anything, just log
  if (!contactEmail) {
    console.log(`[Outbound] No contact email for ${domain} — skipping CRM upsert`);
    return;
  }

  // Block personal email domains (CAN-SPAM compliance, low quality)
  if (isPersonalEmail(contactEmail)) {
    console.log(`[Outbound] Personal email domain — skipping ${contactEmail}`);
    return;
  }

  // Check permanent suppression list (CAN-SPAM — survives KV TTL expiry)
  if (await isSuppressed(env.DB, contactEmail)) {
    console.log(`[Outbound] Permanently suppressed: ${contactEmail} — skipping enrollment`);
    return;
  }

  // ── 1. Upsert contact in CRM ──
  await upsertContact(env, contactEmail, {
    status: CONTACT_STATUS.PROSPECT,
    source: CONTACT_SOURCE.OUTBOUND,
    metadata: JSON.stringify({
      prospectId,
      domain,
      companyName: companyName ?? null,
      contactName: contactName ?? null,
      contactTitle: contactTitle ?? null,
      prospectSource: source,
      prospectScore: score,
      discoveredAt: timestamp,
    }),
  });

  // ── 2. Store prospect context in KV for template rendering ──
  // The sequence engine reads this when rendering cold outreach templates.
  const contextKey = `${KV_PREFIX.EMAIL_CONTEXT}${contactEmail}:cold-outreach`;
  await env.KV_MARKETING.put(
    contextKey,
    JSON.stringify({
      domain,
      companyName: companyName ?? domain,
      contactEmail,
      contactName: contactName ?? null,
      contactTitle: contactTitle ?? null,
      prospectSource: source,
      score,
    }),
    { expirationTtl: TTL.DAYS_90 }
  );

  // ── 3. Enroll in cold outreach sequence ──
  // Only enroll if prospect quality is reasonable (score >= 40)
  if (score >= 40) {
    const enrolledSteps = await enrollInSequences(
      env,
      contactEmail,
      EVENT_TYPES.OUTBOUND_PROSPECT_DISCOVERED,
      {
        domain,
        companyName: companyName ?? domain,
        contactName: contactName ?? null,
        score,
      },
      null, // no capability hook at discovery time — enrichment will backfill attribution
    );
    console.log(`[Outbound] Enrolled ${contactEmail} in ${enrolledSteps} cold outreach step(s)`);
  } else {
    console.log(`[Outbound] Score ${score} too low for cold outreach — CRM-only for ${contactEmail}`);
  }
}

/**
 * Handle outbound.prospect_enriched event.
 *
 * Updates the CRM contact metadata with enrichment data (audit score,
 * tech stack, angles, etc.) and refreshes the KV context so that
 * pending cold emails render with full personalisation.
 *
 * If the contact is new (no prior discovery event — e.g. PH/HN/Reddit
 * sources where email wasn't available at discovery time), also enrolls
 * the prospect in the cold outreach sequence.
 */
export async function handleProspectEnriched(
  env: Env,
  data: OutboundProspectEnrichedData,
  timestamp: string
): Promise<void> {
  const {
    prospectId, domain, companyName, contactEmail,
    contactName, source, score, auditScore, auditGrade,
    issueCount, passCount, techStack,
    primaryTopic, angles, auditedPages, wordCount, reportUrl,
    contactForms, socialHandles, capabilityHook,
  } = data;

  console.log(
    `[Outbound] Prospect enriched: ${domain} (auditScore=${auditScore}, grade=${auditGrade}, angles=${angles?.length ?? 0}, capability=${capabilityHook?.id ?? 'none'})`
  );

  if (!contactEmail) {
    console.log(`[Outbound] No email for enriched prospect ${domain} — trying alternative channels`);

    // Still store channels even without email — forms/social/chat may be reachable
    try {
      const channelCount = await storeProspectChannels(env, {
        domain,
        contactEmail: null,
        contactForms: contactForms ?? [],
        socialHandles: socialHandles ?? {},
        techStack: techStack ?? [],
      });

      if (channelCount > 0) {
        // Build a minimal context for template rendering
        const context = {
          domain,
          companyName: companyName ?? domain,
          auditScore: auditScore ?? null,
          auditGrade: auditGrade ?? null,
          issueCount: issueCount ?? null,
          passCount: passCount ?? null,
        };

        // Look up active campaign slug for attempt tracking
        const activeCampaign = await env.DB.prepare(
          `SELECT slug FROM outbound_campaigns WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
        ).first<{ slug: string }>();

        const result = await executeWithoutEmail(env, domain, context, activeCampaign?.slug ?? 'default');
        console.log(`[Outbound] No-email channel result for ${domain}: ${result ? 'reached' : 'no automated channel succeeded'}`);
      } else {
        console.log(`[Outbound] No email and no channels detected for ${domain}`);
      }
    } catch (err) {
      console.error(`[Outbound] No-email channel attempt failed for ${domain}: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }

  // Block personal email domains (CAN-SPAM compliance, low quality)
  if (isPersonalEmail(contactEmail)) {
    console.log(`[Outbound] Personal email domain — skipping ${contactEmail}`);
    return;
  }

  // Check permanent suppression list (CAN-SPAM — survives KV TTL expiry)
  if (await isSuppressed(env.DB, contactEmail)) {
    console.log(`[Outbound] Permanently suppressed: ${contactEmail} — skipping enrichment enrollment`);
    return;
  }

  // ── 1. Check if contact already exists (discovery may have already enrolled them) ──
  const existingContact = await env.DB.prepare(
    'SELECT id, status FROM marketing_contacts WHERE email = ?'
  ).bind(contactEmail).first<{ id: number; status: string }>();

  const upsertFields: Parameters<typeof upsertContact>[2] = {
    metadata: JSON.stringify({
      prospectId,
      domain,
      companyName: companyName ?? null,
      contactName: contactName ?? null,
      prospectSource: source ?? null,
      prospectScore: score,
      auditScore: auditScore ?? null,
      auditGrade: auditGrade ?? null,
      issueCount: issueCount ?? null,
      passCount: passCount ?? null,
      techStack: techStack ?? [],
      primaryTopic: primaryTopic ?? null,
      anglesCount: angles?.length ?? 0,
      auditedPagesCount: Array.isArray(auditedPages) ? auditedPages.length : 0,
      capabilityHookId: capabilityHook?.id ?? null,
      enrichedAt: timestamp,
    }),
  };

  if (!existingContact) {
    upsertFields.status = CONTACT_STATUS.PROSPECT;
    upsertFields.source = CONTACT_SOURCE.OUTBOUND;
  }

  await upsertContact(env, contactEmail, upsertFields);

  // ── 2. Update KV context with full enrichment data for template rendering ──
  const contextKey = `${KV_PREFIX.EMAIL_CONTEXT}${contactEmail}:cold-outreach`;
  const existingJson = await env.KV_MARKETING.get(contextKey);
  const existing = existingJson ? JSON.parse(existingJson) : {};

  const enrichedContext = {
    ...existing,
    domain,
    companyName: companyName ?? existing.companyName ?? domain,
    contactEmail,
    contactName: contactName ?? existing.contactName ?? null,
    score,
    auditScore: auditScore ?? null,
    auditGrade: auditGrade ?? null,
    issueCount: issueCount ?? null,
    passCount: passCount ?? null,
    techStack: techStack ?? [],
    primaryTopic: primaryTopic ?? null,
    angles: angles ?? [],
    auditedPages: Array.isArray(auditedPages) ? auditedPages : existing.auditedPages ?? [],
    wordCount: wordCount ?? null,
    reportUrl: reportUrl ?? existing.reportUrl ?? null,
    contactForms: contactForms ?? existing.contactForms ?? [],
    socialHandles: socialHandles ?? existing.socialHandles ?? {},
    capabilityHook: capabilityHook ?? existing.capabilityHook ?? null,
    enrichedAt: timestamp,
  };

  await env.KV_MARKETING.put(
    contextKey,
    JSON.stringify(enrichedContext),
    { expirationTtl: TTL.DAYS_90 }
  );

  // ── 3. Enroll in cold outreach sequence if contact is new ──
  // For non-Apollo sources (PH/HN/Reddit), the discovery event had no email
  // so enrollment was skipped. Now that enrichment found the email, enroll here.
  if (!existingContact && score >= 40) {
    const enrolledSteps = await enrollInSequences(
      env,
      contactEmail,
      EVENT_TYPES.OUTBOUND_PROSPECT_DISCOVERED, // sequences are keyed on this trigger
      {
        domain,
        companyName: companyName ?? domain,
        contactName: contactName ?? null,
        score,
        auditScore: auditScore ?? null,
        auditGrade: auditGrade ?? null,
        capabilityHook: capabilityHook ?? null,
      },
      capabilityHook?.id ?? null,
    );
    console.log(`[Outbound] Enrolled enriched prospect ${contactEmail} in ${enrolledSteps} cold outreach step(s)`);
  }

  // ── 4. Store detected channels in D1 for orchestration ──
  try {
    const channelCount = await storeProspectChannels(env, {
      domain,
      contactEmail,
      contactForms: contactForms ?? [],
      socialHandles: socialHandles ?? {},
      techStack: techStack ?? [],
    });
    console.log(`[Outbound] Stored ${channelCount} channels for ${domain}`);
  } catch (err) {
    // Non-critical — don't fail enrichment handler for channel storage
    console.error(`[Outbound] Failed to store channels for ${domain}: ${err instanceof Error ? err.message : err}`);
  }

  console.log(`[Outbound] Updated enrichment context for ${contactEmail}`);
}

/**
 * Handle outbound.prospect_converted event.
 *
 * Fired from the analytics worker's OAuth callback ONLY when the OAuth state
 * payload carries a valid `outboundRef` (or_xxx token) — i.e. the user arrived
 * via a cold outreach email CTA.
 *
 * Responsibilities:
 *   1. Update marketing_contacts status → 'converted' (was 'prospect/engaged')
 *   2. Cancel all pending cold-drip email steps so the user doesn't keep
 *      receiving cold outreach after they've signed up.
 *   3. Log conversion attribution data for ROI analysis.
 */
export async function handleProspectConverted(
  env: Env,
  data: {
    email: string | null;
    outboundRef: string;
    visitorId: string | null;
    provider: string;
    siteId: string;
  },
  timestamp: string
): Promise<void> {
  const { email, outboundRef, visitorId, provider, siteId } = data;

  if (!email) {
    console.log(`[Outbound] prospect_converted without email — outboundRef=${outboundRef}, skipping`);
    return;
  }

  console.log(
    `[Outbound] Prospect converted via OAuth: email=${email}, outboundRef=${outboundRef}, provider=${provider}`
  );

  // ── 1. Update CRM contact status → trial (they connected via OAuth) ──
  try {
    await upsertContact(env, email, {
      status: CONTACT_STATUS.TRIAL,
      metadata: JSON.stringify({
        convertedViaOutbound: true,
        outboundRef,
        visitorId: visitorId ?? null,
        oauthProvider: provider,
        siteId,
        convertedAt: timestamp,
      }),
    });
  } catch (err) {
    console.error(`[Outbound] Failed to update contact status for ${email}: ${err instanceof Error ? err.message : err}`);
    // Non-critical — continue and attempt email cancellation
  }

  // ── 2. Cancel pending cold-drip email steps ──
  // Mark all 'pending' sends for this contact as 'cancelled' so the cron
  // job doesn't deliver cold outreach to someone who has already signed up.
  try {
    await execute(env.DB, `
      UPDATE email_sends
      SET status = 'cancelled', updated_at = datetime('now')
      WHERE contact_email = ?
        AND status = 'pending'
        AND sequence_id IN (
          SELECT id FROM email_sequences WHERE trigger_event = 'outbound.prospect_discovered'
        )
    `, [email]);
    console.log(`[Outbound] Cancelled pending cold-drip steps for ${email}`);
  } catch (err) {
    console.error(`[Outbound] Failed to cancel cold-drip steps for ${email}: ${err instanceof Error ? err.message : err}`);
  }

  // ── 3. Remove KV cold-outreach context (no longer needed) ──
  // Keep enrichment data — useful for warm onboarding sequences.
  try {
    await env.KV_MARKETING.delete(`${KV_PREFIX.EMAIL_CONTEXT}${email}:cold-outreach`);
  } catch {
    /* non-critical */
  }

  console.log(`[Outbound] Conversion attribution recorded for ${email} (ref=${outboundRef})`);
}
