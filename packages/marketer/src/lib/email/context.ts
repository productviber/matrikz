import { APP_URLS, EMAIL_STYLES } from '../../constants';
import { pickWeightedIndex } from './ab';
import {
  resolveFramingTier,
  selectColdSubjectPool,
  selectColdCapabilitySubjectPool,
  selectColdBodyPool,
  selectWarmSubjectPool,
  selectWarmBodyPool,
  variantWeightsKey,
  legacyVariantWeightsKey,
  type FramingTier,
} from './framing';

const GREETING_PREFIXES = ['Hi', 'Hey', 'Hello', 'Hi there', 'Good morning'];

const CLOSING_LINES = [
  'Best,',
  'Cheers,',
  'Thanks,',
  'Talk soon,',
  'All the best,',
  'Looking forward to hearing from you,',
  'Warmly,',
  'Until next time,',
];

const SUBJECT_VARIANTS: Record<string, string[]> = {
  'cold-outreach-step1': [
    '{{companyName}} - {{passCount}} strengths and {{issueCount}} weaknesses we noticed',
    '{{domain}}: {{passCount}} things going well, {{issueCount}} holding you back',
    'Looked at {{domain}} - {{issueCount}} things stood out',
    'Quick question about {{companyName}}\'s search presence',
    '{{companyName}} - {{auditScore}}/100 on a visibility check',
  ],
  'cold-outreach-step2': [
    'One thing about {{domain}} I wanted to flag',
    '{{companyName}} - spotted something worth 3 minutes of your time',
    'Re: {{domain}} - found a specific improvement',
    'Following up on {{companyName}}',
    '{{companyName}}: {{quickWinTitle}}',
  ],
  'cold-outreach-step3': [
    'Last note about {{domain}}',
    '{{companyName}} - closing the loop',
    'Wrapping up on {{domain}}',
    'One last thing re: {{companyName}}',
  ],
};

const BODY_VARIANTS: Record<string, string[]> = {
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
};

const RETARGET_BODY_STEP3: string[] = [
  'I noticed you took a look - wanted to share one specific thing about {{domain}} that I think is worth 5 minutes.',
  'Since you showed some interest, here\'s the single highest-impact finding from your {{domain}} audit.',
  'Looks like this caught your eye. Here\'s the quick version of what I\'d fix first on {{domain}}.',
];

const WARM_SUBJECT_VARIANTS: Record<string, string[]> = {
  'audit-followup-step1': [
    'Your {{domain}} audit results - {{auditScore}}/100',
    '{{domain}} scored {{auditGrade}} - here\'s what that means',
    'Your site audit is ready - {{issueCount}} things to look at',
  ],
  'audit-followup-step2': [
    'The #1 thing I\'d fix on {{domain}} right now',
    '{{domain}}: one change that could move the needle',
    'Quick win for {{domain}} - takes about 15 minutes',
  ],
  'audit-followup-step3': [
    'Last note on your {{domain}} audit',
    '{{domain}} - closing the loop on your results',
    'Your audit expires soon - wanted to make sure you saw this',
  ],
};

const WARM_BODY_VARIANTS: Record<string, string[]> = {
  'audit-followup-step1': [
    'You ran an audit on {{domain}} - here\'s what we found. Your visibility score is {{auditScore}}/100 (Grade {{auditGrade}}), which puts you {{gradeContext}}.',
    'Thanks for running your site through our tool. {{domain}} scored {{auditScore}}/100, and there are {{issueCount}} specific things that could be improved.',
    'I saw you checked {{domain}} with our visibility audit. Here\'s the quick summary: {{auditScore}}/100 with {{passCount}} things going well and {{issueCount}} areas to work on.',
  ],
  'audit-followup-step2': [
    'I pulled out the single biggest improvement from your {{domain}} audit - it\'s something you could fix this week.',
    'Looking at your audit results again, one thing stood out more than the rest. Here\'s what I\'d prioritise.',
    'Of the {{issueCount}} things we flagged on {{domain}}, this one has the highest impact-to-effort ratio.',
  ],
  'audit-followup-step3': [
    'Just wanted to make sure your {{domain}} audit results didn\'t get lost in the shuffle.',
    'This is my last note about your audit. After this, I won\'t follow up again unless you reach out.',
    'Your audit link will stay live, but I wanted to flag one last thing before I close the loop.',
  ],
};

/**
 * Minimal HTML escape for user-adjacent fields placed inside a server-rendered
 * email block. Keeps the capability-hook surface XSS-safe even though our
 * current hook copy is hard-coded in the capability catalog.
 */
function escapeHookHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Flatten the structured capabilityHook onto the template context as:
 *   capabilityHookId, capabilityHookHeadline, capabilityHookOneLiner, capabilityHookCta
 *   capabilityHookBlock  — ready-to-drop HTML snippet (empty string when no hook)
 *
 * Our renderer supports dot-notation merges too (`{{capabilityHook.headline}}`),
 * but flat fields keep older templates + R2-served copy working without edits.
 * The block field lets templates render the whole section with a single token.
 */
function applyCapabilityHook(processed: Record<string, unknown>): void {
  const hook = processed.capabilityHook as
    | { id?: string; headline?: string; oneLiner?: string; cta?: string }
    | null
    | undefined;

  const headline = hook?.headline ?? '';
  const oneLiner = hook?.oneLiner ?? '';
  processed.capabilityHookId = hook?.id ?? '';
  processed.capabilityHookHeadline = headline;
  processed.capabilityHookOneLiner = oneLiner;
  processed.capabilityHookCta = hook?.cta ?? '';

  processed.capabilityHookBlock = headline
    ? `<p style="background:#f8fafc;border-left:3px solid #3b82f6;padding:10px 14px;margin:14px 0;border-radius:4px;">`
    + `<strong>${escapeHookHtml(headline)}</strong>`
    + (oneLiner ? ` &mdash; ${escapeHookHtml(oneLiner)}` : '')
    + `</p>`
    : '';
}

function normalizeAuditedPagePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.startsWith('/')) return raw;
  try {
    const u = new URL(raw);
    return u.pathname && u.pathname.length > 0 ? u.pathname : '/';
  } catch {
    return null;
  }
}

function applyAuditedPages(processed: Record<string, unknown>): void {
  const raw = Array.isArray(processed.auditedPages) ? processed.auditedPages : [];
  const normalized: string[] = [];
  for (const candidate of raw) {
    const path = normalizeAuditedPagePath(candidate);
    if (!path || normalized.includes(path)) continue;
    normalized.push(path);
    if (normalized.length >= 5) break;
  }

  const effective = normalized.length > 0 ? normalized : ['/'];
  const top = effective.slice(0, 2);
  const extra = Math.max(0, effective.length - top.length);
  const summary = `${top.join(', ')}${extra > 0 ? ` (+${extra} more)` : ''}`;

  processed.auditedPages = effective;
  processed.auditedPagesCount = effective.length;
  processed.auditedPagesSummary = summary;
  processed.auditedPagesHeadline = `We audited ${effective.length} page${effective.length === 1 ? '' : 's'}: ${summary}.`;
}

export function prepareTemplateContext(
  context: Record<string, unknown>,
  templateKey: string,
  variantWeights?: Record<string, number[]> | null,
): Record<string, unknown> {
  const processed = { ...context };
  applyCapabilityHook(processed);
  applyAuditedPages(processed);

  const domain = String(processed.domain ?? '');
  processed.domainEncoded = encodeURIComponent(domain);

  const contactName = processed.contactName as string | null;
  const prefix = GREETING_PREFIXES[Math.floor(Math.random() * GREETING_PREFIXES.length)];
  processed.contactNameGreeting = contactName
    ? ` ${contactName.split(' ')[0]}`
    : '';
  processed.greetingPrefix = prefix;

  const angles = processed.angles as Array<{ type: string; hook: string; detail: string }> | undefined;
  if (angles && angles.length > 0) {
    const selectedAngle = selectAngleForStep(angles, templateKey);
    processed.quickWinTitle = selectedAngle.hook || selectedAngle.type || 'Improve your visibility score';
    processed.quickWinAction = selectedAngle.detail || 'Review and address this issue in your site\'s configuration';
    processed.quickWinImpact = estimateImpact(selectedAngle.type);
    processed._angleType = selectedAngle.type;
    processed._angleIdx = angles.indexOf(selectedAngle);
    // Expose secondary angle for step3 recap if available
    if (angles.length > 1) {
      const secondary = angles.find(a => a !== selectedAngle) ?? angles[1];
      processed.secondaryWinTitle = secondary.hook || secondary.type;
      processed.secondaryWinImpact = estimateImpact(secondary.type);
    }
  } else {
    processed.quickWinTitle = 'Optimise your meta descriptions';
    processed.quickWinAction = 'Add unique, compelling meta descriptions to your key pages';
    processed.quickWinImpact = 'Better click-through rates from search results';
    processed._angleType = 'default';
    processed._angleIdx = -1;
  }

  const techStack = processed.techStack;
  if (Array.isArray(techStack) && techStack.length > 0) {
    processed.techStackDisplay = techStack.slice(0, 5).join(', ');
  } else {
    processed.techStackDisplay = 'Not detected';
  }

  const email = String(processed.contactEmail ?? processed.to ?? '');
  processed.unsubscribeLink = `<a href="${APP_URLS.UNSUBSCRIBE(email)}" style="color: #94a3b8;">Unsubscribe</a>`;

  // Resolve framing tier from the audit score (fail-safe → 'standard').
  // Tier drives both the subject/body pool selection AND the A/B learning
  // partition — each tier's variants converge independently.
  const scoreSource = typeof processed.auditScore === 'number'
    ? processed.auditScore
    : typeof processed.score === 'number'
      ? processed.score
      : null;
  const tier: FramingTier = resolveFramingTier(scoreSource);
  processed._framingTier = tier;

  const tierSubjects = selectColdSubjectPool(templateKey, tier);
  const basePool = tierSubjects ?? SUBJECT_VARIANTS[templateKey];
  // Capability-hook subjects are appended to the trailing slots of the
  // effective pool ONLY when the hook is resolvable at send time. Index
  // stability: base[0..N-1] keeps meaning, cap[N..N+M-1] keeps meaning.
  // Sends without a hook simply see a shorter effective pool (base only).
  const hasCapabilityHook =
    typeof processed.capabilityHookHeadline === 'string' &&
    processed.capabilityHookHeadline.length > 0;
  const capSubjects = hasCapabilityHook && tierSubjects
    ? (selectColdCapabilitySubjectPool(templateKey, tier) ?? [])
    : [];
  const variants = basePool ? [...basePool, ...capSubjects] : undefined;
  if (variants && variants.length > 0) {
    const rawWeightsKey = tierSubjects
      ? variantWeightsKey('subject', templateKey, tier)
      : legacyVariantWeightsKey('subject', templateKey);
    // Keep weight array aligned with the pool it describes: when the tier pool
    // is active, only consult tier-keyed weights; fall back to legacy weights
    // only when the legacy pool is active. Slice to the effective pool length
    // so stored weights for currently-unavailable capability slots are
    // correctly excluded from this pick.
    const rawWeights = variantWeights?.[rawWeightsKey];
    const subjectWeights = rawWeights ? rawWeights.slice(0, variants.length) : undefined;
    const forcedSubjectIdx = typeof processed._subjectVariantIdxForced === 'number'
      ? processed._subjectVariantIdxForced
      : null;
    const selectedIdx = forcedSubjectIdx !== null && forcedSubjectIdx >= 0 && forcedSubjectIdx < variants.length
      ? forcedSubjectIdx
      : pickWeightedIndex(variants.length, subjectWeights);
    const selectedSubject = variants[selectedIdx];
    processed.variantSubject = selectedSubject.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const val = processed[key];
      return val !== undefined ? String(val) : '';
    });
    processed._subjectVariantIdx = selectedIdx;
    processed._subjectPoolSize = variants.length;
    processed._subjectWeightsKey = rawWeightsKey;
  }

  if (!processed.reportUrl && domain) {
    processed.reportUrl = `${APP_URLS.HOME}/audit?url=${processed.domainEncoded}`;
  }

  processed.closingLine = CLOSING_LINES[Math.floor(Math.random() * CLOSING_LINES.length)];

  const timeVariants = ['this morning', 'earlier today', 'just now', 'a moment ago'];
  processed.sendTimePhrase = timeVariants[Math.floor(Math.random() * timeVariants.length)];

  const tierBodies = selectColdBodyPool(templateKey, tier);
  const bodyPool = tierBodies ?? BODY_VARIANTS[templateKey];
  if (bodyPool && bodyPool.length > 0) {
    let effectivePool = bodyPool;
    if (templateKey === 'cold-outreach-step3' && processed._hasOpened) {
      effectivePool = RETARGET_BODY_STEP3;
    }
    // Weights only apply when the same pool produced them. Retarget pool has
    // no learned weights yet; tier pool uses tier-keyed weights; legacy pool
    // uses legacy-keyed weights.
    const rawWeightsKey = tierBodies
      ? variantWeightsKey('body', templateKey, tier)
      : legacyVariantWeightsKey('body', templateKey);
    const bodyWeights = effectivePool === RETARGET_BODY_STEP3
      ? undefined
      : variantWeights?.[rawWeightsKey];
    const forcedBodyIdx = typeof processed._bodyVariantIdxForced === 'number'
      ? processed._bodyVariantIdxForced
      : null;
    const bodyIdx = forcedBodyIdx !== null && forcedBodyIdx >= 0 && forcedBodyIdx < effectivePool.length
      ? forcedBodyIdx
      : pickWeightedIndex(effectivePool.length, bodyWeights);
    const selectedBody = effectivePool[bodyIdx];
    processed.bodyVariant = selectedBody.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const val = processed[key];
      return val !== undefined ? String(val) : '';
    });
    processed._bodyVariantIdx = bodyIdx;
    processed._bodyPoolSize = effectivePool.length;
    processed._bodyWeightsKey = rawWeightsKey;
  }

  processed.auditPageUrl = `${APP_URLS.HOME}/audit?url=${processed.domainEncoded}`;
  processed.personalSignOff = EMAIL_STYLES.SIGN_OFF_PERSONAL;

  return processed;
}

export function prepareWarmTemplateContext(
  context: Record<string, unknown>,
  templateKey: string,
  variantWeights?: Record<string, number[]> | null,
): Record<string, unknown> {
  const processed = { ...context };
  applyCapabilityHook(processed);
  applyAuditedPages(processed);

  const domain = String(processed.domain ?? '');
  processed.domainEncoded = encodeURIComponent(domain);

  const contactName = processed.contactName as string | null;
  processed.contactNameGreeting = contactName
    ? ` ${String(contactName).split(' ')[0]}`
    : '';

  const grade = String(processed.grade ?? processed.auditGrade ?? '');
  if (grade === 'A' || grade === 'A+') {
    processed.gradeContext = 'ahead of most sites in your space';
  } else if (grade === 'B') {
    processed.gradeContext = 'in good shape with room to grow';
  } else if (grade === 'C') {
    processed.gradeContext = 'about average - there\'s clear upside';
  } else {
    processed.gradeContext = 'below where it could be - but fixable';
  }
  processed.auditScore = processed.auditScore ?? processed.score;
  processed.auditGrade = processed.auditGrade ?? processed.grade;

  const angles = processed.angles as Array<{ type: string; hook: string; detail: string }> | undefined;
  if (angles && angles.length > 0) {
    const selectedAngle = selectAngleForStep(angles, templateKey);
    processed.quickWinTitle = selectedAngle.hook || selectedAngle.type || 'Improve your visibility score';
    processed.quickWinAction = selectedAngle.detail || 'Review and address this issue in your site\'s configuration';
    processed.quickWinImpact = estimateImpact(selectedAngle.type);
    processed._angleType = selectedAngle.type;
    processed._angleIdx = angles.indexOf(selectedAngle);
  } else {
    processed.quickWinTitle = 'Optimise your meta descriptions';
    processed.quickWinAction = 'Add unique, compelling meta descriptions to your key pages';
    processed.quickWinImpact = 'Better click-through rates from search results';
  }

  processed.auditPageUrl = `${APP_URLS.HOME}/audit?url=${processed.domainEncoded}`;
  processed.personalSignOff = EMAIL_STYLES.SIGN_OFF_PERSONAL;

  // Warm sends already include the score in the context (the user ran an
  // audit). Tier drives subject/body framing for step1 (score-sensitive)
  // and A/B learning partitioning across all warm steps.
  const warmScoreSource = typeof processed.auditScore === 'number'
    ? processed.auditScore
    : typeof processed.score === 'number'
      ? processed.score
      : null;
  const warmTier: FramingTier = resolveFramingTier(warmScoreSource);
  processed._framingTier = warmTier;

  const tierWarmSubjects = selectWarmSubjectPool(templateKey, warmTier);
  const subjects = tierWarmSubjects ?? WARM_SUBJECT_VARIANTS[templateKey];
  if (subjects && subjects.length > 0) {
    const warmSubjectWeightsKey = tierWarmSubjects
      ? variantWeightsKey('subject', templateKey, warmTier)
      : legacyVariantWeightsKey('subject', templateKey);
    const subjectWeights = variantWeights?.[warmSubjectWeightsKey];
    const forcedSubjectIdx = typeof processed._subjectVariantIdxForced === 'number'
      ? processed._subjectVariantIdxForced
      : null;
    const idx = forcedSubjectIdx !== null && forcedSubjectIdx >= 0 && forcedSubjectIdx < subjects.length
      ? forcedSubjectIdx
      : pickWeightedIndex(subjects.length, subjectWeights);
    processed.variantSubject = subjects[idx].replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const val = processed[key];
      return val !== undefined ? String(val) : '';
    });
    processed._subjectVariantIdx = idx;
    processed._subjectPoolSize = subjects.length;
    processed._subjectWeightsKey = warmSubjectWeightsKey;
  }

  const tierWarmBodies = selectWarmBodyPool(templateKey, warmTier);
  const bodies = tierWarmBodies ?? WARM_BODY_VARIANTS[templateKey];
  if (bodies && bodies.length > 0) {
    const warmBodyWeightsKey = tierWarmBodies
      ? variantWeightsKey('body', templateKey, warmTier)
      : legacyVariantWeightsKey('body', templateKey);
    const bodyWeights = variantWeights?.[warmBodyWeightsKey];
    const forcedBodyIdx = typeof processed._bodyVariantIdxForced === 'number'
      ? processed._bodyVariantIdxForced
      : null;
    const idx = forcedBodyIdx !== null && forcedBodyIdx >= 0 && forcedBodyIdx < bodies.length
      ? forcedBodyIdx
      : pickWeightedIndex(bodies.length, bodyWeights);
    processed.bodyVariant = bodies[idx].replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const val = processed[key];
      return val !== undefined ? String(val) : '';
    });
    processed._bodyVariantIdx = idx;
    processed._bodyPoolSize = bodies.length;
    processed._bodyWeightsKey = warmBodyWeightsKey;
  }

  return processed;
}

/**
 * Select the best angle for a given email step.
 * Step1 (intro): highest-impact angle (critical-seo > low-score > others)
 * Step2 (quick win): most-specific/actionable angle, avoids step1 angle when possible
 * Step3 (recap): most-urgent/visual angle (schema/social), or fallback to top
 * Warm sequences always use highest-impact.
 */
const ANGLE_PRIORITY: Record<string, number> = {
  'critical-seo': 100,
  'low-score': 80,
  'missing-schema': 70,
  'content-gaps': 60,
  'thin-content': 50,
  'social-tags': 40,
  'growth-potential': 30,
};

function selectAngleForStep(
  angles: Array<{ type: string; hook: string; detail: string }>,
  templateKey: string,
): { type: string; hook: string; detail: string } {
  if (angles.length <= 1) return angles[0];

  const sorted = [...angles].sort(
    (a, b) => (ANGLE_PRIORITY[b.type] ?? 10) - (ANGLE_PRIORITY[a.type] ?? 10),
  );

  if (templateKey.endsWith('-step2') && sorted.length > 1) {
    // Step2: pick second-best angle for variety (different from step1's highest-impact)
    return sorted[1];
  }
  if (templateKey.endsWith('-step3') && sorted.length > 2) {
    // Step3: pick third angle for maximum coverage
    return sorted[2];
  }
  // Step1 and all warm sequences: highest impact
  return sorted[0];
}

function estimateImpact(angleType: string): string {
  const impacts: Record<string, string> = {
    'critical-seo': '15-25% improvement in search visibility within 4-6 weeks',
    'low-score': '20-30 point improvement in visibility score',
    'missing-schema': 'Rich snippets in search results, boosting click-through by 20-30%',
    'content-gaps': 'Improved topical authority and keyword coverage',
    'thin-content': 'Higher quality scores and better rankings for key pages',
    'social-tags': 'Better social media previews, increasing referral traffic',
    'growth-potential': 'Unlock untapped organic traffic in your niche',
  };
  return impacts[angleType] || '15-25% improvement in search visibility within 4-6 weeks';
}
