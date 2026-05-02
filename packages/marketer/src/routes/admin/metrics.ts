/**
 * Internal admin metrics & operator endpoints (service-to-service).
 *
 * These routes are mounted under /api/internal/outbound/* and authenticated
 * via the system lane (CF service-binding header or SYSTEM_TOKEN). They are
 * called by the analytics worker's /admin/outbound/metrics, /prospect/:id,
 * and /prospect/:id/enqueue routes, which own the HTML rendering and the
 * operator session.
 *
 * Responsibilities kept narrow:
 *   - /metrics    : aggregates over email_sends + suppression_list
 *   - /timeline   : per-contact ordered email history (send + outcome)
 *   - /enqueue    : manual enrollment of a single contact in cold outreach
 *
 * No PII is logged. All inputs are validated at the boundary. Aggregations
 * are capped at documented limits to protect D1.
 */

import type { Env, OutboundProspectEnrichedData } from '../../types';
import { ok, badRequest, serverError } from '../../lib/response';
import { query, queryOne } from '../../lib/db';
import { enrollInSequences } from '../../lib/email';
import { upsertContact } from '../../lib/crm';
import { isSuppressed } from '../../lib/suppression';
import { CONTACT_SOURCE, CONTACT_STATUS, EVENT_TYPES, KV_PREFIX, TTL, isPersonalEmail } from '../../constants';

/** Upper bounds — protect D1 from runaway scans. */
const METRICS_LIMITS = Object.freeze({
    MAX_TIMELINE_ROWS: 50,
    MAX_CAPABILITY_BREAKDOWN_ROWS: 100,
    MAX_BATCH_BREAKDOWN_ROWS: 50,
    MAX_VARIANT_ROWS: 200,
    MAX_SUBJECT_ROWS: 200,
    MAX_TIER_ROWS: 16,
});

/**
 * GET /api/internal/outbound/metrics
 *
 * Query params:
 *   windowDays (default 30, max 365) — restrict aggregations
 *
 * Returns:
 *   {
 *     statusCounts:         { scheduled, sent, failed, cancelled }
 *     byCapabilityHook:     [{ capability_hook_id, sent, scheduled, failed }]
 *     bySequence:           [{ sequence_id, name, sent, scheduled, failed }]
 *     suppression:          { total, byReason: [{ reason, count }] }
 *     windowDays:           number
 *   }
 */
export async function handleEmailMetrics(
    request: Request,
    env: Env
): Promise<Response> {
    const url = new URL(request.url);
    const raw = Number.parseInt(url.searchParams.get('windowDays') ?? '30', 10);
    const windowDays = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 365) : 30;
    const sinceEpoch = Math.floor(Date.now() / 1000) - windowDays * 86400;

    try {
        const statusRows = await query<{ status: string; count: number }>(
            env.DB,
            `SELECT status, COUNT(*) AS count
         FROM email_sends
        WHERE (scheduled_at >= ? OR sent_at >= ?)
        GROUP BY status`,
            [sinceEpoch, sinceEpoch]
        );

        const statusCounts = statusRows.reduce<Record<string, number>>((acc, r) => {
            acc[r.status] = r.count;
            return acc;
        }, {});

        const byCapabilityHook = await query<{
            capability_hook_id: string | null;
            sent: number;
            scheduled: number;
            failed: number;
            total: number;
        }>(
            env.DB,
            `SELECT
          COALESCE(capability_hook_id, '(none)') AS capability_hook_id,
          SUM(CASE WHEN status = 'sent'      THEN 1 ELSE 0 END) AS sent,
          SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
          SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
          COUNT(*) AS total
         FROM email_sends
        WHERE (scheduled_at >= ? OR sent_at >= ?)
        GROUP BY capability_hook_id
        ORDER BY total DESC
        LIMIT ?`,
            [sinceEpoch, sinceEpoch, METRICS_LIMITS.MAX_CAPABILITY_BREAKDOWN_ROWS]
        );

        const bySequence = await query<{
            sequence_id: number;
            name: string;
            sent: number;
            scheduled: number;
            failed: number;
            total: number;
        }>(
            env.DB,
            `SELECT
          es.sequence_id,
          seq.name,
          SUM(CASE WHEN es.status = 'sent'      THEN 1 ELSE 0 END) AS sent,
          SUM(CASE WHEN es.status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
          SUM(CASE WHEN es.status = 'failed'    THEN 1 ELSE 0 END) AS failed,
          COUNT(*) AS total
         FROM email_sends es
    LEFT JOIN email_sequences seq ON seq.id = es.sequence_id
        WHERE (es.scheduled_at >= ? OR es.sent_at >= ?)
        GROUP BY es.sequence_id, seq.name
        ORDER BY total DESC
        LIMIT ?`,
            [sinceEpoch, sinceEpoch, METRICS_LIMITS.MAX_BATCH_BREAKDOWN_ROWS]
        );

        const suppressionTotal = await queryOne<{ count: number }>(
            env.DB,
            `SELECT COUNT(*) AS count FROM suppression_list`
        );

        const suppressionByReason = await query<{ reason: string; count: number }>(
            env.DB,
            `SELECT COALESCE(reason, '(none)') AS reason, COUNT(*) AS count
         FROM suppression_list
        GROUP BY reason
        ORDER BY count DESC
        LIMIT 20`
        );

        return ok({
            windowDays,
            statusCounts,
            byCapabilityHook,
            bySequence,
            suppression: {
                total: suppressionTotal?.count ?? 0,
                byReason: suppressionByReason,
            },
        });
    } catch (err) {
        console.error('[metrics] aggregation failed:', err instanceof Error ? err.message : err);
        return serverError('Failed to aggregate email metrics');
    }
}

/**
 * GET /api/internal/outbound/timeline?email=<contact_email>
 *
 * Returns up to METRICS_LIMITS.MAX_TIMELINE_ROWS send events for the contact,
 * plus suppression_list presence. Sends are ordered newest-first.
 */
export async function handleEmailTimeline(
    request: Request,
    env: Env
): Promise<Response> {
    const url = new URL(request.url);
    const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
    if (!email || email.length > 254 || email.indexOf('@') === -1) {
        return badRequest('email query parameter required and must be a valid address');
    }

    try {
        const sends = await query<{
            id: number;
            sequence_id: number | null;
            sequence_name: string | null;
            step_order: number | null;
            subject: string | null;
            template_subject: string | null;
            status: string;
            capability_hook_id: string | null;
            variant: string | null;
            subject_variant_idx: number | null;
            body_variant_idx: number | null;
            brevo_message_id: string | null;
            scheduled_at: number;
            sent_at: number | null;
            opened_at: number | null;
            clicked_at: number | null;
            replied_at: number | null;
            open_count: number | null;
            click_count: number | null;
            error: string | null;
        }>(
            env.DB,
            `SELECT es.id, es.sequence_id, seq.name AS sequence_name,
              est.step_order,
              COALESCE(es.rendered_subject, est.subject) AS subject,
              est.subject AS template_subject,
              es.status, es.capability_hook_id, es.variant,
              es.subject_variant_idx, es.body_variant_idx, es.brevo_message_id,
              es.scheduled_at, es.sent_at,
              es.opened_at, es.clicked_at, es.replied_at,
              es.open_count, es.click_count,
              es.error
         FROM email_sends es
    LEFT JOIN email_sequences seq ON seq.id = es.sequence_id
    LEFT JOIN email_steps est    ON est.id = es.step_id
        WHERE es.contact_email = ?
        ORDER BY es.id DESC
        LIMIT ?`,
            [email, METRICS_LIMITS.MAX_TIMELINE_ROWS]
        );

        const suppression = await queryOne<{
            reason: string | null;
            created_at: number | null;
        }>(
            env.DB,
            `SELECT reason, created_at FROM suppression_list WHERE email = ? LIMIT 1`,
            [email]
        );

        const contact = await queryOne<{
            id: number;
            status: string;
            source: string;
            metadata: string | null;
            created_at: number | null;
        }>(
            env.DB,
            `SELECT id, status, source, metadata, created_at
         FROM marketing_contacts
        WHERE email = ? LIMIT 1`,
            [email]
        );

        return ok({
            email,
            contact,
            suppression,
            sends,
            sendCount: sends.length,
        });
    } catch (err) {
        console.error('[timeline] query failed:', err instanceof Error ? err.message : err);
        return serverError('Failed to load contact timeline');
    }
}

/**
 * POST /api/internal/outbound/enqueue
 *
 * Body: {
 *   email: string;                          // required
 *   prospect?: OutboundProspectEnrichedData; // optional enrichment payload
 *   force?: boolean;                         // if true, bypass score threshold
 * }
 *
 * Upserts contact (source=outbound, status=prospect), writes KV context,
 * and calls enrollInSequences. Suppression and personal-email gates are
 * still enforced. Returns `{ enrolled, skipped?, reason? }`.
 */
export async function handleEnqueueProspect(
    request: Request,
    env: Env
): Promise<Response> {
    let body: { email?: string; prospect?: Partial<OutboundProspectEnrichedData>; force?: boolean };
    try {
        body = await request.json();
    } catch {
        return badRequest('Invalid JSON body');
    }

    const email = (body.email ?? '').trim().toLowerCase();
    if (!email || email.indexOf('@') === -1 || email.length > 254) {
        return badRequest('email is required and must be valid');
    }

    if (isPersonalEmail(email)) {
        return ok({ enrolled: 0, skipped: true, reason: 'personal-email-domain' });
    }

    if (await isSuppressed(env.DB, email)) {
        return ok({ enrolled: 0, skipped: true, reason: 'suppressed' });
    }

    const p = body.prospect ?? {};
    const domain = p.domain ?? email.split('@')[1] ?? 'unknown';
    const capabilityHook = p.capabilityHook ?? null;

    try {
        await upsertContact(env, email, {
            status: CONTACT_STATUS.PROSPECT,
            source: CONTACT_SOURCE.OUTBOUND,
            metadata: JSON.stringify({
                prospectId: p.prospectId ?? null,
                domain,
                companyName: p.companyName ?? null,
                contactName: p.contactName ?? null,
                prospectSource: p.source ?? 'manual',
                prospectScore: p.score ?? null,
                auditScore: p.auditScore ?? null,
                auditGrade: p.auditGrade ?? null,
                capabilityHookId: capabilityHook?.id ?? null,
                manuallyEnqueuedAt: new Date().toISOString(),
            }),
        });

        const contextKey = `${KV_PREFIX.EMAIL_CONTEXT}${email}:cold-outreach`;
        const existingJson = await env.KV_MARKETING.get(contextKey);
        const existing = existingJson ? JSON.parse(existingJson) : {};
        await env.KV_MARKETING.put(
            contextKey,
            JSON.stringify({
                ...existing,
                domain,
                companyName: p.companyName ?? existing.companyName ?? domain,
                contactEmail: email,
                contactName: p.contactName ?? existing.contactName ?? null,
                score: p.score ?? existing.score ?? null,
                auditScore: p.auditScore ?? existing.auditScore ?? null,
                auditGrade: p.auditGrade ?? existing.auditGrade ?? null,
                issueCount: p.issueCount ?? existing.issueCount ?? null,
                passCount: p.passCount ?? existing.passCount ?? null,
                techStack: p.techStack ?? existing.techStack ?? [],
                primaryTopic: p.primaryTopic ?? existing.primaryTopic ?? null,
                angles: p.angles ?? existing.angles ?? [],
                capabilityHook: capabilityHook ?? existing.capabilityHook ?? null,
                manuallyEnqueuedAt: new Date().toISOString(),
            }),
            { expirationTtl: TTL.DAYS_90 }
        );

        const enrolled = await enrollInSequences(
            env,
            email,
            EVENT_TYPES.OUTBOUND_PROSPECT_DISCOVERED,
            {
                domain,
                companyName: p.companyName ?? domain,
                contactName: p.contactName ?? null,
                score: p.score ?? null,
                auditScore: p.auditScore ?? null,
                auditGrade: p.auditGrade ?? null,
                capabilityHook,
            },
            capabilityHook?.id ?? null,
        );

        if (enrolled === 0) {
            return ok({ enrolled: 0, skipped: true, reason: 'already-enrolled' });
        }

        return ok({ enrolled, email, domain, capabilityHookId: capabilityHook?.id ?? null });
    } catch (err) {
        console.error('[enqueue] failed:', err instanceof Error ? err.message : err);
        return serverError('Failed to enqueue prospect');
    }
}

/**
 * GET /api/internal/outbound/variants
 *
 * Per-template + per-subject-variant engagement breakdown. Powers the
 * "Subject performance" admin dashboard:
 *
 *   | Template              | idx | Sent | Opens | Clicks | Replies | Open% | Click% |
 *
 * Query params:
 *   windowDays (default 30, max 365)
 *
 * All aggregations are capped at MAX_VARIANT_ROWS and restricted to `status='sent'`.
 */
export async function handleVariantMetrics(
    request: Request,
    env: Env
): Promise<Response> {
    const url = new URL(request.url);
    const raw = Number.parseInt(url.searchParams.get('windowDays') ?? '30', 10);
    const windowDays = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 365) : 30;
    const sinceEpoch = Math.floor(Date.now() / 1000) - windowDays * 86400;

    try {
        const byVariant = await query<{
            template_key: string;
            framing_tier: string | null;
            subject_variant_idx: number | null;
            sent: number;
            opened: number;
            clicked: number;
            replied: number;
            open_events: number;
            click_events: number;
        }>(
            env.DB,
            `SELECT est.template_key,
              es.framing_tier,
              es.subject_variant_idx,
              COUNT(*)                                    AS sent,
              SUM(CASE WHEN es.opened_at  IS NOT NULL THEN 1 ELSE 0 END) AS opened,
              SUM(CASE WHEN es.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
              SUM(CASE WHEN es.replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied,
              COALESCE(SUM(es.open_count), 0)             AS open_events,
              COALESCE(SUM(es.click_count), 0)            AS click_events
         FROM email_sends es
         JOIN email_steps est ON est.id = es.step_id
        WHERE es.status = 'sent'
          AND es.sent_at >= ?
        GROUP BY est.template_key, es.framing_tier, es.subject_variant_idx
        ORDER BY sent DESC
        LIMIT ?`,
            [sinceEpoch, METRICS_LIMITS.MAX_VARIANT_ROWS]
        );

        // Compute rates in-app (SQLite division returns integers for INTEGER inputs)
        const variantRows = byVariant.map((row) => ({
            ...row,
            open_rate: row.sent > 0 ? row.opened / row.sent : 0,
            click_rate: row.sent > 0 ? row.clicked / row.sent : 0,
            reply_rate: row.sent > 0 ? row.replied / row.sent : 0,
        }));

        // Per-tier rollup (good / standard / compulsion) — the primary signal
        // for whether score-band framing is pulling its weight.
        const byTier = await query<{
            framing_tier: string | null;
            sent: number;
            opened: number;
            clicked: number;
            replied: number;
        }>(
            env.DB,
            `SELECT es.framing_tier,
              COUNT(*)                                    AS sent,
              SUM(CASE WHEN es.opened_at  IS NOT NULL THEN 1 ELSE 0 END) AS opened,
              SUM(CASE WHEN es.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
              SUM(CASE WHEN es.replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied
         FROM email_sends es
        WHERE es.status = 'sent' AND es.sent_at >= ?
        GROUP BY es.framing_tier
        ORDER BY sent DESC
        LIMIT ?`,
            [sinceEpoch, METRICS_LIMITS.MAX_TIER_ROWS]
        );

        const tierRows = byTier.map((row) => ({
            ...row,
            open_rate: row.sent > 0 ? row.opened / row.sent : 0,
            click_rate: row.sent > 0 ? row.clicked / row.sent : 0,
            reply_rate: row.sent > 0 ? row.replied / row.sent : 0,
        }));

        // Top-performing actually-rendered subject strings (distinct text, grouped).
        const bySubject = await query<{
            rendered_subject: string | null;
            template_key: string;
            sent: number;
            opened: number;
            clicked: number;
        }>(
            env.DB,
            `SELECT es.rendered_subject, est.template_key,
              COUNT(*) AS sent,
              SUM(CASE WHEN es.opened_at  IS NOT NULL THEN 1 ELSE 0 END) AS opened,
              SUM(CASE WHEN es.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked
         FROM email_sends es
         JOIN email_steps est ON est.id = es.step_id
        WHERE es.status = 'sent'
          AND es.sent_at >= ?
          AND es.rendered_subject IS NOT NULL
        GROUP BY es.rendered_subject, est.template_key
        ORDER BY sent DESC
        LIMIT ?`,
            [sinceEpoch, METRICS_LIMITS.MAX_SUBJECT_ROWS]
        );

        const subjectRows = bySubject.map((row) => ({
            ...row,
            open_rate: row.sent > 0 ? row.opened / row.sent : 0,
            click_rate: row.sent > 0 ? row.clicked / row.sent : 0,
        }));

        // Rollup totals so the UI can show "overall" above the breakdown.
        const totals = await queryOne<{
            sent: number;
            opened: number;
            clicked: number;
            replied: number;
        }>(
            env.DB,
            `SELECT COUNT(*) AS sent,
              SUM(CASE WHEN opened_at  IS NOT NULL THEN 1 ELSE 0 END) AS opened,
              SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
              SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied
         FROM email_sends
        WHERE status = 'sent' AND sent_at >= ?`,
            [sinceEpoch]
        );

        return ok({
            windowDays,
            totals: totals ?? { sent: 0, opened: 0, clicked: 0, replied: 0 },
            byTier: tierRows,
            byVariant: variantRows,
            bySubject: subjectRows,
        });
    } catch (err) {
        console.error('[variants] aggregation failed:', err instanceof Error ? err.message : err);
        return serverError('Failed to aggregate variant metrics');
    }
}

// ─── Prune weakest variant ──────────────────────────────────────────────────

/** Defaults for the prune-weakest heuristic. Conservative to avoid accidental
 *  retirement of an under-exposed variant that just hasn't been sampled yet. */
const PRUNE_DEFAULTS = Object.freeze({
    /** Min sends per variant before it's eligible for prune consideration. */
    MIN_SAMPLES: 50,
    /** Eligible variants required before prune fires (pool integrity guard). */
    MIN_ELIGIBLE_VARIANTS: 3,
    /** Weakest variant must score below this fraction of the pool median. */
    WEAKEST_MAX_FRACTION_OF_MEDIAN: 0.5,
    /** Aggregation window (days). */
    WINDOW_DAYS: 30,
});

const ALLOWED_TIERS = new Set(['good', 'standard', 'compulsion']);
const ALLOWED_TYPES = new Set(['subject', 'body']);

/** Engagement score matches recordVariantEngagement bumps (reply/click/open). */
function scoreFor(row: { sent: number; opened: number; clicked: number; replied: number }): number {
    if (row.sent <= 0) return 0;
    return (row.replied * 10 + row.clicked * 5 + row.opened * 2) / row.sent;
}

function medianOf(nums: number[]): number {
    if (!nums.length) return 0;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * POST /api/internal/outbound/variants/prune
 *
 * Body: {
 *   templateKey: string,
 *   tier: 'good' | 'standard' | 'compulsion',
 *   variantType: 'subject' | 'body',
 *   dryRun?: boolean  (default true),
 *   minSamples?: number  (default 50)
 * }
 *
 * Identifies the weakest variant in the (templateKey, tier, variantType) pool
 * whose engagement score is < 50% of the pool median, has ≥minSamples sends,
 * and where at least MIN_ELIGIBLE_VARIANTS variants qualify for comparison.
 *
 * When dryRun is false, writes weight=0 at that index to KV `ab:variants:<tpl>`
 * under the tier-scoped key. A weight of 0 is treated as "disabled" by
 * pickWeightedIndex, so the slot is retained for historical index stability
 * but no longer selectable. At most one variant is pruned per call.
 *
 * Always returns a structured report (never throws). Intended for manual
 * operator invocation; no cron wiring.
 */
export async function handlePruneVariants(
    request: Request,
    env: Env
): Promise<Response> {
    if (request.method !== 'POST') {
        return badRequest('POST required');
    }
    let body: Record<string, unknown>;
    try {
        body = (await request.json()) as Record<string, unknown>;
    } catch {
        return badRequest('Invalid JSON body');
    }

    const templateKey = typeof body.templateKey === 'string' ? body.templateKey : '';
    const tier = typeof body.tier === 'string' ? body.tier : '';
    const variantType = typeof body.variantType === 'string' ? body.variantType : '';
    const dryRun = body.dryRun !== false; // default true
    const rawMinSamples = typeof body.minSamples === 'number' ? body.minSamples : PRUNE_DEFAULTS.MIN_SAMPLES;
    const minSamples = Number.isFinite(rawMinSamples) && rawMinSamples > 0
        ? Math.floor(rawMinSamples)
        : PRUNE_DEFAULTS.MIN_SAMPLES;

    if (!templateKey || !ALLOWED_TIERS.has(tier) || !ALLOWED_TYPES.has(variantType)) {
        return badRequest(
            'templateKey, tier (good|standard|compulsion), variantType (subject|body) are required',
        );
    }

    const sinceEpoch = Math.floor(Date.now() / 1000) - PRUNE_DEFAULTS.WINDOW_DAYS * 86400;
    const idxColumn = variantType === 'subject' ? 'subject_variant_idx' : 'body_variant_idx';
    const poolKey = `${variantType}:${templateKey}:${tier}`;

    try {
        // Per-variant engagement from D1 (authoritative source, not KV weights).
        // Using dynamic column name is safe because variantType is whitelisted.
        const rows = await query<{
            idx: number | null;
            sent: number;
            opened: number;
            clicked: number;
            replied: number;
        }>(
            env.DB,
            `SELECT ${idxColumn} AS idx,
              COUNT(*) AS sent,
              SUM(CASE WHEN es.opened_at  IS NOT NULL THEN 1 ELSE 0 END) AS opened,
              SUM(CASE WHEN es.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
              SUM(CASE WHEN es.replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied
         FROM email_sends es
         JOIN email_steps est ON est.id = es.step_id
        WHERE es.status = 'sent'
          AND es.sent_at >= ?
          AND est.template_key = ?
          AND es.framing_tier = ?
          AND ${idxColumn} IS NOT NULL
        GROUP BY ${idxColumn}
        ORDER BY ${idxColumn} ASC
        LIMIT ?`,
            [sinceEpoch, templateKey, tier, METRICS_LIMITS.MAX_VARIANT_ROWS],
        );

        const samples = rows.map((r) => ({
            idx: r.idx as number,
            sent: r.sent,
            opened: r.opened,
            clicked: r.clicked,
            replied: r.replied,
            score: scoreFor(r),
        }));

        const eligible = samples.filter((s) => s.sent >= minSamples);

        // Load current KV weights so the caller can see what would change.
        const kvKey = `ab:variants:${templateKey}`;
        const raw = await env.KV_MARKETING.get(kvKey);
        const data: Record<string, number[]> = raw ? JSON.parse(raw) : {};
        const currentWeights = data[poolKey] ?? [];

        if (eligible.length < PRUNE_DEFAULTS.MIN_ELIGIBLE_VARIANTS) {
            return ok({
                action: 'no_candidate',
                reason: 'insufficient_eligible_variants',
                poolKey,
                windowDays: PRUNE_DEFAULTS.WINDOW_DAYS,
                minSamples,
                eligibleCount: eligible.length,
                required: PRUNE_DEFAULTS.MIN_ELIGIBLE_VARIANTS,
                samples,
                currentWeights,
            });
        }

        const median = medianOf(eligible.map((e) => e.score));
        const weakest = eligible.reduce((lo, s) => (s.score < lo.score ? s : lo));
        const threshold = median * PRUNE_DEFAULTS.WEAKEST_MAX_FRACTION_OF_MEDIAN;
        const alreadyDisabled = (currentWeights[weakest.idx] ?? 1) <= 0;

        if (weakest.score >= threshold || alreadyDisabled) {
            return ok({
                action: 'no_candidate',
                reason: alreadyDisabled
                    ? 'weakest_already_disabled'
                    : 'weakest_above_threshold',
                poolKey,
                windowDays: PRUNE_DEFAULTS.WINDOW_DAYS,
                minSamples,
                weakest,
                median,
                threshold,
                samples,
                currentWeights,
            });
        }

        if (dryRun) {
            return ok({
                action: 'dry_run',
                wouldPrune: weakest,
                poolKey,
                windowDays: PRUNE_DEFAULTS.WINDOW_DAYS,
                minSamples,
                median,
                threshold,
                samples,
                currentWeights,
            });
        }

        // Apply: write weight=0 at the weakest index, preserving array shape.
        const nextWeights = [...currentWeights];
        while (nextWeights.length <= weakest.idx) nextWeights.push(1);
        nextWeights[weakest.idx] = 0;
        data[poolKey] = nextWeights;
        await env.KV_MARKETING.put(kvKey, JSON.stringify(data), {
            expirationTtl: TTL.DAYS_90,
        });

        return ok({
            action: 'pruned',
            pruned: weakest,
            poolKey,
            windowDays: PRUNE_DEFAULTS.WINDOW_DAYS,
            minSamples,
            median,
            threshold,
            samples,
            nextWeights,
        });
    } catch (err) {
        console.error('[prune] failed:', err instanceof Error ? err.message : err);
        return serverError('Failed to prune variant');
    }
}
