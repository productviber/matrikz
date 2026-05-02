/**
 * Score-band framing tiers for outbound email subject/body selection.
 *
 * Every outbound send is classified into exactly one of three tiers based on
 * the recipient's visibility audit score. Each tier ships a distinct copy tone
 * tuned for the psychology of that band:
 *
 *   good        (>=90)   — Polish/validator tone. "You're ahead, here's how to
 *                          push further." Optimistic, compounding.
 *   standard    (60..89) — Diagnostic tone. "Solid foundation, specific gaps."
 *                          Neutral, improvement-framed.
 *   compulsion  (<60)    — Urgency tone. "Traffic leaking, revenue on the line."
 *                          High-stakes, loss-framed.
 *
 * A/B learning is scoped per tier (weights keyed by `subject:<tpl>:<tier>` and
 * `body:<tpl>:<tier>`) so a winning compulsion subject never contaminates
 * optimisation for the good-tier pool. Each tier converges independently.
 *
 * The `framing_tier` column on `email_sends` (migration 0012) persists the
 * chosen tier for every send, enabling permanent tier-level reply-rate
 * segmentation in the `/admin/outbound/variants` dashboard.
 */

export type FramingTier = 'good' | 'standard' | 'compulsion';

export const FRAMING_TIERS = Object.freeze({
    GOOD: Object.freeze({ id: 'good' as const, minScore: 90 }),
    STANDARD: Object.freeze({ id: 'standard' as const, minScore: 60 }),
    COMPULSION: Object.freeze({ id: 'compulsion' as const, minScore: 0 }),
});

/**
 * Tier used when the audit score is missing, non-numeric, or otherwise
 * unresolvable. Keeps the pipeline fail-safe — a send is never blocked on
 * missing score data.
 */
export const DEFAULT_FRAMING_TIER: FramingTier = 'standard';

export const ALL_FRAMING_TIERS: readonly FramingTier[] = Object.freeze([
    FRAMING_TIERS.GOOD.id,
    FRAMING_TIERS.STANDARD.id,
    FRAMING_TIERS.COMPULSION.id,
]);

/**
 * Map a numeric audit score (0-100) to its framing tier.
 *
 * Fail-safe: null/undefined/NaN/-Infinity/Infinity all resolve to the default
 * tier. Never throws. Never returns a non-tier string.
 */
export function resolveFramingTier(score: number | null | undefined): FramingTier {
    if (typeof score !== 'number' || !Number.isFinite(score)) {
        return DEFAULT_FRAMING_TIER;
    }
    if (score >= FRAMING_TIERS.GOOD.minScore) return FRAMING_TIERS.GOOD.id;
    if (score >= FRAMING_TIERS.STANDARD.minScore) return FRAMING_TIERS.STANDARD.id;
    return FRAMING_TIERS.COMPULSION.id;
}

// ── Cold outreach pools ─────────────────────────────────────────────────────
// Three subject variants per (tier, step). Small pools keep A/B convergence
// fast (per Thompson-sampling, variance shrinks as sqrt(trials) → ~100 sends
// per variant is enough to distinguish a 5-point reply-rate delta).

const COLD_SUBJECTS_BY_TIER: Record<FramingTier, Record<string, string[]>> = {
    good: {
        'cold-outreach-step1': [
            '{{companyName}} - {{passCount}}/8 strong, one area to push further',
            '{{domain}} scored {{auditScore}}/100 - the upside from here',
            '{{companyName}} is doing most things right - where to level up',
        ],
        'cold-outreach-step2': [
            'The polish play for {{domain}}',
            '{{companyName}}: the one optimisation left on the table',
            'Re: {{domain}} - compounding your lead',
        ],
        'cold-outreach-step3': [
            'Last note on squeezing more from {{domain}}',
            '{{companyName}} - closing the loop on the optimisation I flagged',
        ],
    },
    standard: {
        'cold-outreach-step1': [
            '{{companyName}} - {{passCount}} strengths, {{issueCount}} specific gaps',
            '{{domain}}: {{auditScore}}/100 with {{issueCount}} things holding it back',
            'Looked at {{domain}} - {{issueCount}} specific fixes worth your time',
        ],
        'cold-outreach-step2': [
            'One thing about {{domain}} I wanted to flag',
            '{{companyName}} - spotted something worth 3 minutes of your time',
            'Re: {{domain}} - {{quickWinTitle}}',
        ],
        'cold-outreach-step3': [
            'Last note about {{domain}}',
            '{{companyName}} - closing the loop',
            'Wrapping up on {{domain}}',
        ],
    },
    compulsion: {
        'cold-outreach-step1': [
            '{{companyName}} is losing visibility on {{issueCount}} fixable issues',
            '{{domain}}: {{auditScore}}/100 - and what that costs each week',
            'Prospects can\'t find {{companyName}} - {{issueCount}} reasons why',
        ],
        'cold-outreach-step2': [
            'The single biggest leak on {{domain}}',
            '{{companyName}}: every day this stays broken costs leads',
            'Re: {{domain}} - this is the one that\'s hurting you',
        ],
        'cold-outreach-step3': [
            'Final check-in on {{domain}}\'s visibility gap',
            '{{companyName}} - last flag before I drop off',
        ],
    },
};

const COLD_BODIES_BY_TIER: Record<FramingTier, Record<string, string[]>> = {
    good: {
        'cold-outreach-step1': [
            'I ran {{domain}} through our visibility check — you\'re already ahead of most sites in your space. One area stood out where there\'s clear upside if you want to widen the lead.',
            '{{domain}} scored {{auditScore}}/100 — genuinely strong. Thought you\'d want to see the single place where a small change compounds into a real edge.',
        ],
        'cold-outreach-step2': [
            'Following up — given how solid {{domain}} already is, this one refinement is probably the highest-ROI thing left.',
            'You\'re past the "fix the basics" stage on {{domain}}. This is the optimisation play I\'d prioritise from here.',
        ],
        'cold-outreach-step3': [
            'Last note — if you ever want to chase that final push on {{domain}}, the playbook\'s ready when you are.',
        ],
    },
    standard: {
        'cold-outreach-step1': [
            'I was looking at {{domain}} and ran it through our visibility tool. Thought you might want to see what came up.',
            'I came across {{domain}} and was curious how it stacked up on search visibility. Here\'s what I found.',
            'I took a look at {{domain}} - a few things stood out that I thought were worth sharing.',
        ],
        'cold-outreach-step2': [
            'I sent over some notes on {{domain}} a few days ago - wanted to flag one specific thing that stood out.',
            'Following up on my last email - I pulled out the single biggest improvement I\'d focus on for {{domain}}.',
            'Not sure if you saw my last note. There was one finding for {{domain}} I thought was worth highlighting.',
        ],
        'cold-outreach-step3': [
            'This is my last note about {{domain}} - I promise.',
            'Just wanted to close the loop on {{domain}} and make sure you had the full picture.',
            'Last follow-up from me on this - after this, no more emails on this topic.',
        ],
    },
    compulsion: {
        'cold-outreach-step1': [
            'I checked {{domain}} and {{issueCount}} specific things are actively costing you traffic right now. Not opinions — things search engines literally can\'t parse or index properly.',
            '{{domain}} scored {{auditScore}}/100. That\'s the kind of score where prospects reach you through luck, not through search. Here\'s what\'s in the way.',
        ],
        'cold-outreach-step2': [
            'Of everything I flagged on {{domain}}, this one is bleeding the most traffic. Fixing it is a 2-hour job.',
            'Following up — the single biggest issue on {{domain}} is also the cheapest to fix. Wanted to make sure it\'s on your radar.',
        ],
        'cold-outreach-step3': [
            'Last flag: every week {{domain}} stays in this state, the gap with your competitors widens. After this I drop off.',
        ],
    },
};

// ── Warm (audit follow-up) pools ────────────────────────────────────────────
// Only step1 is tier-split — that's where the audit score is the main hook.
// Steps 2/3 fall back to the existing WARM_*_VARIANTS pools regardless of tier.

const WARM_SUBJECTS_BY_TIER: Record<FramingTier, Record<string, string[]>> = {
    good: {
        'audit-followup-step1': [
            'Your {{domain}} audit: {{auditScore}}/100 — where to push from here',
            '{{domain}} scored {{auditGrade}} — the level-up plays',
        ],
    },
    standard: {
        'audit-followup-step1': [
            'Your {{domain}} audit results - {{auditScore}}/100',
            '{{domain}} scored {{auditGrade}} - here\'s what that means',
            'Your site audit is ready - {{issueCount}} things to look at',
        ],
    },
    compulsion: {
        'audit-followup-step1': [
            'Your {{domain}} audit: {{auditScore}}/100 — {{issueCount}} issues costing you traffic',
            '{{domain}} scored {{auditGrade}} — here\'s the cost of leaving this as-is',
        ],
    },
};

const WARM_BODIES_BY_TIER: Record<FramingTier, Record<string, string[]>> = {
    good: {
        'audit-followup-step1': [
            'Your {{domain}} audit came back at {{auditScore}}/100 (Grade {{auditGrade}}) — already ahead of most sites. The interesting question now is what compounds the lead. Here\'s where I\'d focus.',
        ],
    },
    standard: {
        'audit-followup-step1': [
            'You ran an audit on {{domain}} - here\'s what we found. Your visibility score is {{auditScore}}/100 (Grade {{auditGrade}}), which puts you {{gradeContext}}.',
            'Thanks for running your site through our tool. {{domain}} scored {{auditScore}}/100, and there are {{issueCount}} specific things that could be improved.',
        ],
    },
    compulsion: {
        'audit-followup-step1': [
            '{{domain}} scored {{auditScore}}/100 — Grade {{auditGrade}}. That\'s the band where search traffic trickles in by luck, not design. {{issueCount}} specific blockers are on the list. Here\'s the priority order.',
        ],
    },
};

/**
 * Return the tier-specific cold subject pool for a template key, or undefined
 * if no tier-specific pool exists (caller falls back to the legacy pool).
 */
export function selectColdSubjectPool(
    templateKey: string,
    tier: FramingTier,
): string[] | undefined {
    return COLD_SUBJECTS_BY_TIER[tier]?.[templateKey];
}

// ── Capability-hook subject pools (cold) ────────────────────────────────────
// These reference {{capabilityHookHeadline}} directly and are ONLY selectable
// when that token is present in the send context. When the hook is absent,
// these pool slots are filtered out at pick time in prepareTemplateContext.
//
// Index stability: capability variants always occupy the trailing slots of the
// combined pool (base pool first, capability pool appended). This lets KV
// weights stored at indices N..N+M-1 keep their meaning across sends that
// have a hook vs. sends that don't — the picker simply excludes unselectable
// slots by truncating the weights array to the effective pool length.

const COLD_CAPABILITY_SUBJECTS_BY_TIER: Record<FramingTier, Record<string, string[]>> = {
    good: {
        'cold-outreach-step1': [
            '{{capabilityHookHeadline}} — for {{domain}}',
            'Spotted on {{domain}}: {{capabilityHookHeadline}}',
        ],
        'cold-outreach-step2': [
            'Re: {{domain}} — {{capabilityHookHeadline}}',
        ],
    },
    standard: {
        'cold-outreach-step1': [
            '{{capabilityHookHeadline}} — for {{domain}}',
            '{{domain}}: {{capabilityHookHeadline}}',
        ],
        'cold-outreach-step2': [
            'Re: {{domain}} — {{capabilityHookHeadline}}',
        ],
    },
    compulsion: {
        'cold-outreach-step1': [
            '{{capabilityHookHeadline}} is costing {{domain}} traffic',
            '{{domain}}: {{capabilityHookHeadline}}',
        ],
        'cold-outreach-step2': [
            'Re: {{domain}} — {{capabilityHookHeadline}}',
        ],
    },
};

/**
 * Return the tier-specific capability-hook subject pool for a template key,
 * or undefined if no capability pool exists for that (tier, template). The
 * caller must only include this pool in selection when the send context has
 * a non-empty `capabilityHookHeadline`.
 */
export function selectColdCapabilitySubjectPool(
    templateKey: string,
    tier: FramingTier,
): string[] | undefined {
    return COLD_CAPABILITY_SUBJECTS_BY_TIER[tier]?.[templateKey];
}

export function selectColdBodyPool(
    templateKey: string,
    tier: FramingTier,
): string[] | undefined {
    return COLD_BODIES_BY_TIER[tier]?.[templateKey];
}

export function selectWarmSubjectPool(
    templateKey: string,
    tier: FramingTier,
): string[] | undefined {
    return WARM_SUBJECTS_BY_TIER[tier]?.[templateKey];
}

export function selectWarmBodyPool(
    templateKey: string,
    tier: FramingTier,
): string[] | undefined {
    return WARM_BODIES_BY_TIER[tier]?.[templateKey];
}

/**
 * KV map-key for per-tier variant weights. Stored under `ab:variants:<tpl>`:
 *   { 'subject:<tpl>:<tier>': [w0, w1, w2, ...], 'body:<tpl>:<tier>': [...] }
 *
 * Keeps legacy non-tiered keys (`subject:<tpl>`, `body:<tpl>`) readable as a
 * fallback so pre-migration weights continue to inform selection until each
 * tier accumulates enough independent data.
 */
export function variantWeightsKey(
    variantType: 'subject' | 'body',
    templateKey: string,
    tier: FramingTier,
): string {
    return `${variantType}:${templateKey}:${tier}`;
}

export function legacyVariantWeightsKey(
    variantType: 'subject' | 'body',
    templateKey: string,
): string {
    return `${variantType}:${templateKey}`;
}
