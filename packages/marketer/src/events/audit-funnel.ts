/**
 * Audit Funnel Event Handlers — Processes intent signals from the
 * visibility-analytics free-audit flow.
 *
 * Triggered when:
 *   - `audit.completed`: An anonymous visitor completed a site audit
 *   - `lead.captured`: A visitor confirmed their email after an audit
 *
 * Responsibilities:
 *   1. Track domain-level intent signals (audit.completed)
 *   2. Upsert confirmed audit leads as 'lead' in the marketing CRM
 *   3. Store audit context in KV for warm email template rendering
 *   4. Enroll warm leads in a dedicated audit-followup sequence
 *
 * Architecture:
 *   - Analytics runs the audit, emits events via service binding
 *   - Marketing receives events → upserts CRM + enrolls in warm sequences
 *   - Warm leads get a different, higher-converting sequence than cold outreach
 */

import type { Env, AuditCompletedData, LeadCapturedData } from '../types';
import { CONTACT_STATUS, CONTACT_SOURCE, KV_PREFIX, TTL } from '../constants';
import { upsertContact } from '../lib/crm';
import { enrollInSequences, cancelPendingEmails } from '../lib/email';

/**
 * Handle audit.completed — anonymous domain-level intent signal.
 *
 * Stores the audit result keyed by domain so that if the same domain
 * later appears as a cold prospect, we know they've already shown intent.
 */
export async function handleAuditCompleted(
    env: Env,
    data: AuditCompletedData,
    timestamp: string
): Promise<void> {
    const { domain, score, grade, url } = data;

    console.log(`[AuditFunnel] Audit completed for ${domain} (score=${score}, grade=${grade})`);

    // Store domain-level intent signal in KV
    await env.KV_MARKETING.put(
        `intent:audit:${domain}`,
        JSON.stringify({ score, grade, url, completedAt: timestamp }),
        { expirationTtl: TTL.DAYS_90 }
    );
}

/**
 * Handle lead.captured — identified warm lead from audit confirmation.
 *
 * This is a high-intent signal: the user ran an audit AND confirmed their
 * email address. They're warmer than any cold prospect.
 *
 * Flow:
 *   1. Upsert as 'lead' (higher status than 'prospect')
 *   2. Store audit-specific context for warm email templates
 *   3. Enroll in audit-followup sequence (warm cadence)
 */
export async function handleLeadCaptured(
    env: Env,
    data: LeadCapturedData,
    timestamp: string
): Promise<void> {
    const { email, domain, source, score, grade, url } = data;

    console.log(`[AuditFunnel] Lead captured: ${email} (domain=${domain}, score=${score}, grade=${grade})`);

    if (!email) {
        console.log('[AuditFunnel] No email in lead.captured payload — skipping');
        return;
    }

    // 0. Cancel any existing cold outreach sequences for this contact.
    //    They showed intent by running an audit — cold emails conflict with warm.
    const cancelled = await cancelPendingEmails(env, email, 'outbound.prospect_discovered');
    if (cancelled > 0) {
        console.log(`[AuditFunnel] Cancelled ${cancelled} cold outreach email(s) for ${email} — promoting to warm`);
    }

    // 1. Upsert contact as 'lead' with source tracking
    await upsertContact(env, email, {
        status: CONTACT_STATUS.LEAD,
        source: source === 'free-audit' ? CONTACT_SOURCE.ORGANIC : CONTACT_SOURCE.DIRECT,
        metadata: JSON.stringify({
            domain,
            auditScore: score,
            auditGrade: grade,
            auditUrl: url,
            capturedAt: timestamp,
            intentSource: 'free-audit',
        }),
    });

    // 2. Store warm context for template rendering
    const contextKey = `${KV_PREFIX.EMAIL_CONTEXT}${email}:audit-followup`;
    await env.KV_MARKETING.put(
        contextKey,
        JSON.stringify({
            domain,
            email,
            score,
            grade,
            url,
            capturedAt: timestamp,
        }),
        { expirationTtl: TTL.DAYS_90 }
    );

    // 3. Enroll in audit-followup sequence (warm cadence)
    // This sequence should exist with trigger_event = 'lead.captured'
    const enrolledSteps = await enrollInSequences(
        env,
        email,
        'lead.captured',
        { domain, score, grade, url }
    );
    console.log(`[AuditFunnel] Enrolled ${email} in ${enrolledSteps} audit-followup step(s)`);
}
