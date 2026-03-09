/**
 * Email Sequence Engine
 *
 * Manages drip email sequences using D1 for scheduling and
 * KV for deduplication. Supports Brevo and SendGrid providers.
 *
 * Cold outreach emails (trigger_event starting with 'outbound.')
 * are subject to warmup throttling and per-domain gap enforcement.
 * Regular drip emails (welcome, onboarding, etc.) bypass throttling.
 */

import type { Env, EmailSendRow } from '../types';
import {
  KV_PREFIX,
  TTL,
  EMAIL_STATUS,
  EMAIL_CONFIG,
  CONTENT_TYPE_JSON,
  PAGINATION,
  APP_URLS,
  EMAIL_STYLES,
  MESSAGES,
} from '../constants';
import { query, queryOne, execute, now } from './db';
import { isUnsubscribed } from '../routes/gdpr';
import {
  checkThrottle,
  checkDomainGap,
  incrementSendCounter,
  recordDomainSend,
  todayDateKey,
  COMPLIANCE,
} from './warmup';

// ─── Sequence Enrollment ────────────────────────────────────────────────────

/**
 * Enroll a contact in all active sequences matching an event type.
 * Schedules future email sends based on each step's delay.
 */
export async function enrollInSequences(
  env: Env,
  contactEmail: string,
  triggerEvent: string,
  contextData?: Record<string, unknown>
): Promise<number> {
  // Find active sequences for this trigger
  const sequences = await query<{ id: number; name: string }>(
    env.DB,
    `SELECT id, name FROM email_sequences WHERE trigger_event = ? AND is_active = 1`,
    [triggerEvent]
  );

  if (sequences.length === 0) return 0;

  let totalScheduled = 0;
  const baseTime = now();

  for (const seq of sequences) {
    // Check if already enrolled (dedupe)
    const existing = await queryOne(
      env.DB,
      `SELECT id FROM email_sends WHERE contact_email = ? AND sequence_id = ? AND status IN ('${EMAIL_STATUS.SCHEDULED}', '${EMAIL_STATUS.SENT}') LIMIT 1`,
      [contactEmail, seq.id]
    );
    if (existing) {
      console.log(`[Email] ${contactEmail} already enrolled in sequence ${seq.name}, skipping`);
      continue;
    }

    // Get steps for this sequence
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

    // Store context data in KV for template rendering
    if (contextData) {
      await env.KV_MARKETING.put(
        `${KV_PREFIX.EMAIL_CONTEXT}${contactEmail}:${seq.id}`,
        JSON.stringify(contextData),
        { expirationTtl: TTL.DAYS_30 }
      );
    }

    console.log(`[Email] Enrolled ${contactEmail} in "${seq.name}" — ${steps.length} steps scheduled`);
  }

  return totalScheduled;
}

// ─── Email Processing ───────────────────────────────────────────────────────

/**
 * Process due emails. Should be called periodically (e.g. via Cron trigger).
 *
 * Cold outreach sends (sequences with trigger_event starting with 'outbound.')
 * are subject to warmup throttling and per-domain gap checks.
 * Regular drip emails bypass all throttling.
 *
 * Returns the number of emails sent.
 */
export async function processDueEmails(env: Env, batchSize: number = PAGINATION.DEFAULT_PAGE_SIZE): Promise<number> {
  const currentTime = now();

  // Fetch due sends — include trigger_event to identify cold outreach
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

  // Cold outreach throttle state — lazily initialised on first cold send
  const dateKey = todayDateKey();
  let coldBudgetExhausted = false;
  let coldThrottleChecked = false;
  const DEFAULT_CAMPAIGN_SLUG = 'cold-outreach-v1';

  // ── Business hours gate for cold outreach (8–18 UTC, weekdays) ───
  const nowDate = new Date(currentTime * 1000);
  const utcHour = nowDate.getUTCHours();
  const utcDay = nowDate.getUTCDay(); // 0=Sun, 6=Sat
  const isBusinessHours = utcDay >= 1 && utcDay <= 5 && utcHour >= 8 && utcHour < 18;

  // ── Auto-pause: check yesterday's deliverability metrics ───────────
  let coldAutoPaused = false;
  {
    const yesterday = new Date(nowDate);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayKey = yesterday.toISOString().slice(0, 10);
    const metricsJson = await env.KV_MARKETING.get(`${KV_PREFIX.OUTBOUND_DELIVERABILITY}${yesterdayKey}`);
    if (metricsJson) {
      const m = JSON.parse(metricsJson);
      const totalSent = (m.delivered ?? 0) + (m.bounced ?? 0);
      if (totalSent >= 10) { // Only evaluate after meaningful volume
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

  for (const send of dueSends) {
    const isColdOutreach = send.trigger_event?.startsWith('outbound.');

    // ── Throttle gate for cold outreach only ───────────────────────────
    if (isColdOutreach) {
      // Skip cold outreach outside business hours (Mon–Fri 08–18 UTC)
      if (!isBusinessHours) {
        skippedThrottle++;
        continue;
      }

      // Skip all cold sends if auto-paused due to deliverability breach
      if (coldAutoPaused) {
        skippedThrottle++;
        continue;
      }

      // Random inter-send delay (2–6s) between cold sends to look natural
      if (coldSendIndex > 0) {
        const delayMs = 2000 + Math.floor(Math.random() * 4000);
        await new Promise(r => setTimeout(r, delayMs));
      }

      // Check daily budget once per batch (avoids repeated KV reads)
      if (!coldThrottleChecked) {
        const throttle = await checkThrottle(
          env.KV_MARKETING,
          DEFAULT_CAMPAIGN_SLUG,
          dateKey,
          currentTime
        );
        coldBudgetExhausted = !throttle.allowed;
        coldThrottleChecked = true;
        if (coldBudgetExhausted) {
          console.log(`[Email] Cold outreach throttled: ${throttle.reason}`);
        }
      }

      // Skip if daily limit reached — leave as 'scheduled' for next cron cycle
      if (coldBudgetExhausted) {
        skippedThrottle++;
        continue;
      }

      // Per-domain gap check (72h between sends to same domain)
      const domain = send.contact_email.split('@')[1]?.toLowerCase();
      if (domain) {
        const domainOk = await checkDomainGap(env.KV_MARKETING, domain, currentTime);
        if (!domainOk) {
          console.log(`[Email] Domain gap not met for ${domain}, deferring send ${send.id}`);
          skippedDomainGap++;
          continue;
        }
      }
    }

    try {
      // Load context data from KV
      const contextJson = await env.KV_MARKETING.get(`${KV_PREFIX.EMAIL_CONTEXT}${send.contact_email}:${send.sequence_id}`);
      let context = contextJson ? JSON.parse(contextJson) : {};

      // Also try cold-outreach context key (enrichment handler stores under this key)
      if (isColdOutreach && Object.keys(context).length <= 1) {
        const coldCtxJson = await env.KV_MARKETING.get(`${KV_PREFIX.EMAIL_CONTEXT}${send.contact_email}:cold-outreach`);
        if (coldCtxJson) {
          context = { ...context, ...JSON.parse(coldCtxJson) };
        }
      }

      // Pre-process context for cold outreach (derives domainEncoded, contactNameGreeting, etc.)
      if (isColdOutreach) {
        context = prepareTemplateContext(context, send.template_key);
      }

      // Use variant subject if available (non-deterministic subject line)
      const subject = (isColdOutreach && context.variantSubject)
        ? String(context.variantSubject)
        : send.subject;

      // Send the email
      await sendEmail(env, {
        to: send.contact_email,
        subject,
        templateKey: send.template_key,
        context,
      });

      // Mark as sent
      await execute(
        env.DB,
        `UPDATE email_sends SET status = '${EMAIL_STATUS.SENT}', sent_at = ? WHERE id = ?`,
        [now(), send.id]
      );
      sentCount++;

      // Track cold outreach send for throttle + domain gap
      if (isColdOutreach) {
        await incrementSendCounter(env.KV_MARKETING, dateKey);

        const domain = send.contact_email.split('@')[1]?.toLowerCase();
        if (domain) {
          await recordDomainSend(env.KV_MARKETING, domain, now());
        }

        // Re-check budget after each cold send
        const updated = await checkThrottle(
          env.KV_MARKETING,
          DEFAULT_CAMPAIGN_SLUG,
          dateKey,
          now()
        );
        coldBudgetExhausted = !updated.allowed;
        coldSendIndex++;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Email] Failed to send ${send.id} to ${send.contact_email}: ${errorMsg}`);
      await execute(
        env.DB,
        `UPDATE email_sends SET status = '${EMAIL_STATUS.FAILED}', error = ? WHERE id = ?`,
        [errorMsg, send.id]
      );
    }
  }

  const throttleInfo = (skippedThrottle + skippedDomainGap) > 0
    ? ` (${skippedThrottle} throttled, ${skippedDomainGap} domain-gapped)`
    : '';
  console.log(`[Email] Processed ${dueSends.length} due emails, ${sentCount} sent${throttleInfo}`);
  return sentCount;
}

// ─── Cancel Sequences ───────────────────────────────────────────────────────

/**
 * Cancel all pending (scheduled) emails for a contact, optionally filtered by trigger event.
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

// ─── Email Sending ──────────────────────────────────────────────────────────

interface EmailPayload {
  to: string;
  subject: string;
  templateKey: string;
  context: Record<string, unknown>;
}

/**
 * Send a single email via the configured provider (Brevo or SendGrid).
 * Falls back to console logging in development mode.
 */
async function sendEmail(env: Env, payload: EmailPayload): Promise<void> {
  const { to, subject, templateKey, context } = payload;

  // Never send to unsubscribed addresses (CAN-SPAM / GDPR)
  if (await isUnsubscribed(env, to)) {
    console.log(`[Email] Skipping send to ${to} — unsubscribed`);
    return;
  }

  // Render template (simple mustache-like replacement)
  const htmlBody = await renderTemplate(env, templateKey, { ...context, subject, to });

  if (env.ENVIRONMENT === 'development' || !env.EMAIL_API_KEY) {
    console.log(`[Email:Dev] Would send to ${to}: "${subject}" (template: ${templateKey})`);
    return;
  }

  const provider = env.EMAIL_PROVIDER ?? EMAIL_CONFIG.DEFAULT_PROVIDER;

  if (provider === 'brevo') {
    await sendViaBrevo(env, to, subject, htmlBody);
  } else if (provider === 'sendgrid') {
    await sendViaSendGrid(env, to, subject, htmlBody);
  }
}

async function sendViaBrevo(env: Env, to: string, subject: string, html: string) {
  const unsubUrl = APP_URLS.UNSUBSCRIBE(to);
  const res = await fetch(EMAIL_CONFIG.BREVO_API_URL, {
    method: 'POST',
    headers: {
      [EMAIL_CONFIG.BREVO_AUTH_HEADER]: env.EMAIL_API_KEY!,
      'Content-Type': CONTENT_TYPE_JSON,
    },
    body: JSON.stringify({
      sender: { name: env.FROM_NAME, email: env.FROM_EMAIL },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Brevo API error ${res.status}: ${errBody}`);
  }
}

async function sendViaSendGrid(env: Env, to: string, subject: string, html: string) {
  const unsubUrl = APP_URLS.UNSUBSCRIBE(to);
  const res = await fetch(EMAIL_CONFIG.SENDGRID_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.EMAIL_API_KEY!}`,
      'Content-Type': CONTENT_TYPE_JSON,
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: env.FROM_EMAIL, name: env.FROM_NAME },
      subject,
      content: [{ type: EMAIL_CONFIG.SENDGRID_CONTENT_TYPE, value: html }],
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`SendGrid API error ${res.status}: ${errBody}`);
  }
}

// ─── Template Rendering ─────────────────────────────────────────────────────

/**
 * Simple template renderer. Tries R2 first, then falls back to built-in templates.
 * Supports {{variable}} interpolation.
 */
async function renderTemplate(
  env: Env,
  templateKey: string,
  vars: Record<string, unknown>
): Promise<string> {
  // Try R2 first
  if (env.R2_ASSETS) {
    try {
      const obj = await env.R2_ASSETS.get(`templates/${templateKey}.html`);
      if (obj) {
        let html = await obj.text();
        return interpolate(html, { ...vars, unsubscribe: unsubscribeFooter(String(vars.to ?? '')) });
      }
    } catch {
      // Fall through to built-in
    }
  }

  // Built-in fallback templates
  const template = BUILT_IN_TEMPLATES[templateKey] ?? BUILT_IN_TEMPLATES['generic'];
  return interpolate(template, { ...vars, unsubscribe: unsubscribeFooter(String(vars.to ?? '')) });
}

function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key];
    return val !== undefined ? String(val) : '';
  });
}

// ─── Cold Outreach Context Pre-Processing ───────────────────────────────

/**
 * Greeting name variations — adds non-deterministic human feel.
 * Prevents spam-filter pattern detection across 150 daily sends.
 */
const GREETING_PREFIXES = ['Hi', 'Hey', 'Hello', 'Hi there'];

/**
 * Closing line variations — prevents identical footprints across sends.
 * Picked randomly per send by prepareTemplateContext().
 */
const CLOSING_LINES = [
  'Best,',
  'Cheers,',
  'Thanks,',
  'Talk soon,',
  'All the best,',
  'Looking forward to hearing from you,',
];

/**
 * Subject line variation pools for each cold outreach step.
 * Each send randomly selects from the pool to avoid identical subjects.
 */
const SUBJECT_VARIANTS: Record<string, string[]> = {
  'cold-outreach-step1': [
    '{{companyName}} — your site scored {{auditScore}}/100 on visibility',
    '{{companyName}}: free visibility audit results inside',
    'We audited {{domain}} — {{issueCount}} things to improve',
    '{{domain}} visibility report: {{auditScore}}/100 (Grade {{auditGrade}})',
  ],
  'cold-outreach-step2': [
    'Quick SEO fix for {{companyName}} (3 min read)',
    'One change that could boost {{domain}}\'s visibility',
    '{{companyName}} — a specific fix we found for your site',
    'We found a quick win for {{domain}}',
  ],
  'cold-outreach-step3': [
    'Last note about {{companyName}}\'s visibility',
    'Final follow-up: {{domain}} audit results',
    '{{companyName}} — closing the loop on your audit',
  ],
};

/**
 * Pre-process raw KV context into fully-resolved template variables.
 * Derives computed fields (domainEncoded, contactNameGreeting, quickWin*, etc.)
 * and adds non-deterministic variation for subjects and greetings.
 *
 * @param context  Raw context from KV (stored by outbound-events.ts)
 * @param templateKey  The template being rendered (e.g. 'cold-outreach-step1')
 * @returns Processed context with all template variables populated
 */
export function prepareTemplateContext(
  context: Record<string, unknown>,
  templateKey: string
): Record<string, unknown> {
  const processed = { ...context };

  // ── Domain encoding for CTA URLs ──
  const domain = String(processed.domain ?? '');
  processed.domainEncoded = encodeURIComponent(domain);

  // ── Contact name greeting with random prefix ──
  const contactName = processed.contactName as string | null;
  const prefix = GREETING_PREFIXES[Math.floor(Math.random() * GREETING_PREFIXES.length)];
  processed.contactNameGreeting = contactName
    ? ` ${contactName.split(' ')[0]}` // Use first name only  
    : '';
  // Replace the subject's "Hi" with the random prefix via a separate variable
  processed.greetingPrefix = prefix;

  // ── Quick win extraction from angles ──
  const angles = processed.angles as Array<{ type: string; hook: string; detail: string }> | undefined;
  if (angles && angles.length > 0) {
    const topAngle = angles[0];
    processed.quickWinTitle = topAngle.hook || topAngle.type || 'Improve your visibility score';
    processed.quickWinAction = topAngle.detail || 'Review and address this issue in your site\'s configuration';
    processed.quickWinImpact = _estimateImpact(topAngle.type);
  } else {
    processed.quickWinTitle = 'Optimise your meta descriptions';
    processed.quickWinAction = 'Add unique, compelling meta descriptions to your key pages';
    processed.quickWinImpact = 'Better click-through rates from search results';
  }

  // ── Tech stack display ──
  const techStack = processed.techStack;
  if (Array.isArray(techStack) && techStack.length > 0) {
    processed.techStackDisplay = techStack.slice(0, 5).join(', ');
  } else {
    processed.techStackDisplay = 'Not detected';
  }

  // ── Unsubscribe link HTML for inline use in templates ──
  const email = String(processed.contactEmail ?? processed.to ?? '');
  processed.unsubscribeLink = `<a href="${APP_URLS.UNSUBSCRIBE(email)}" style="color: #94a3b8;">Unsubscribe</a>`;

  // ── Subject line variation (non-deterministic) ──
  const variants = SUBJECT_VARIANTS[templateKey];
  if (variants && variants.length > 0) {
    const selectedSubject = variants[Math.floor(Math.random() * variants.length)];
    // Interpolate variables already in context into the subject
    processed.variantSubject = selectedSubject.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const val = processed[key];
      return val !== undefined ? String(val) : '';
    });
  }

  // ── Report URL (if pre-generated audit report exists) ──
  if (!processed.reportUrl && domain) {
    // Fallback to live audit URL
    processed.reportUrl = `${APP_URLS.HOME}/audit?url=${processed.domainEncoded}`;
  }

  // ── Closing line variation (non-deterministic) ──
  processed.closingLine = CLOSING_LINES[Math.floor(Math.random() * CLOSING_LINES.length)];

  // ── Send-time display variation (humanises "sent at" feel) ──
  const timeVariants = ['this morning', 'earlier today', 'just now', 'a moment ago'];
  processed.sendTimePhrase = timeVariants[Math.floor(Math.random() * timeVariants.length)];

  return processed;
}

/**
 * Estimate impact description for a given angle type.
 */
function _estimateImpact(angleType: string): string {
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

/** Unsubscribe footer appended to all email templates */
function unsubscribeFooter(to: string): string {
  return `<p style="${EMAIL_STYLES.SMALL_PRINT}; margin-top: 32px; border-top: 1px solid #eee; padding-top: 12px;"><a href="${APP_URLS.UNSUBSCRIBE(to)}" style="color: #888;">${MESSAGES.email.unsubscribeText}</a></p>`;
}

const BUILT_IN_TEMPLATES: Record<string, string> = {
  generic: `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">{{subject}}</h2>
      <p>${MESSAGES.email.greeting}</p>
      <p>${MESSAGES.email.genericBody}</p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'onboarding-welcome': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Welcome to Visibility! \uD83D\uDE80</h2>
      <p>Hi there,</p>
      <p>You've just unlocked the <strong>{{plan}}</strong> plan. Here's how to get the most out of Visibility:</p>
      <ol>
        <li><strong>Connect your site</strong> \u2014 Add your domain in the Cockpit dashboard</li>
        <li><strong>Link Google Search Console</strong> \u2014 We'll pull in your real performance data</li>
        <li><strong>Check your Pulse</strong> \u2014 Your SEO health score updates daily</li>
      </ol>
      <p><a href="${APP_URLS.COCKPIT}" style="${EMAIL_STYLES.CTA_PRIMARY}">Open Your Dashboard \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'onboarding-day1': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Set up your first site in 2 minutes \u23F1\uFE0F</h2>
      <p>Hi there,</p>
      <p>Most users see their first insights within 24 hours of connecting. If you haven't already:</p>
      <ol>
        <li>Go to your <a href="${APP_URLS.COCKPIT}">Cockpit</a></li>
        <li>Click "Add Site" and enter your domain</li>
        <li>Authorize Google Search Console access</li>
      </ol>
      <p>That's it! We'll start analyzing your SEO health immediately.</p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'onboarding-day3': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Your first insights are ready \uD83D\uDCCA</h2>
      <p>Hi there,</p>
      <p>By now, Visibility has been analyzing your site for a few days. Check your dashboard for:</p>
      <ul>
        <li>Your <strong>SEO Health Score</strong></li>
        <li><strong>Top opportunities</strong> \u2014 pages with quick-win potential</li>
        <li><strong>Action items</strong> \u2014 prioritized fixes for maximum impact</li>
      </ul>
      <p><a href="${APP_URLS.COCKPIT}" style="${EMAIL_STYLES.CTA_PRIMARY}">See Your Insights \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'onboarding-day7': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Pro tips from power users \uD83D\uDCA1</h2>
      <p>Hi there,</p>
      <p>You've been using Visibility for a week! Here are tips from our top users:</p>
      <ul>
        <li><strong>Set up weekly reports</strong> \u2014 Track your progress automatically</li>
        <li><strong>Use the AI assistant</strong> \u2014 Ask it about any metric for deeper analysis</li>
        <li><strong>Share reports</strong> \u2014 Send SEO snapshots to your team or clients</li>
      </ul>
      <p>Questions? Just reply to this email \u2014 we read every message.</p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'affiliate-commission': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">${MESSAGES.email.commissionTitle}</h2>
      <p>Great news!</p>
      <p>${MESSAGES.email.commissionBody}</p>
      <table style="${EMAIL_STYLES.TABLE}">
        <tr><td style="${EMAIL_STYLES.TABLE_CELL}"><strong>${MESSAGES.email.labelPlan}</strong></td><td style="${EMAIL_STYLES.TABLE_CELL}">{{plan}}</td></tr>
        <tr><td style="${EMAIL_STYLES.TABLE_CELL}"><strong>${MESSAGES.email.labelSaleAmount}</strong></td><td style="${EMAIL_STYLES.TABLE_CELL}">{{saleAmount}}</td></tr>
        <tr><td style="${EMAIL_STYLES.TABLE_CELL}"><strong>${MESSAGES.email.labelCommission}</strong></td><td style="${EMAIL_STYLES.TABLE_CELL}">{{commissionAmount}}</td></tr>
        <tr><td style="${EMAIL_STYLES.TABLE_CELL_LAST}"><strong>${MESSAGES.email.labelTotalEarnings}</strong></td><td style="${EMAIL_STYLES.TABLE_CELL_LAST}">{{totalEarnings}}</td></tr>
      </table>
      <p><a href="${APP_URLS.AFFILIATE_PORTAL}" style="${EMAIL_STYLES.CTA_SUCCESS}">${MESSAGES.email.ctaAffiliateDashboard}</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF_AFFILIATE}</p>
      {{unsubscribe}}
    </div>
  `,
  'welcome-signup': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Welcome to Visibility \uD83D\uDC4B</h2>
      <p>Hi there,</p>
      <p>Thanks for signing up! Visibility gives you real-time insights into your search engine performance.</p>
      <p>Here's what you can do right now:</p>
      <ol>
        <li><strong>Connect your Google Search Console</strong></li>
        <li><strong>Check your SEO Pulse</strong> \u2014 your site's health score</li>
        <li><strong>Explore AI-powered insights</strong></li>
      </ol>
      <p><a href="${APP_URLS.COCKPIT}" style="${EMAIL_STYLES.CTA_PRIMARY}">Get Started \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'welcome-day1': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Your first SEO check \u2705</h2>
      <p>Hi there,</p>
      <p>Have you connected your first site yet? It only takes a minute:</p>
      <p><a href="${APP_URLS.COCKPIT}" style="${EMAIL_STYLES.CTA_PRIMARY}">Connect a Site \u2192</a></p>
      <p>Once connected, you'll get daily insights on your search performance.</p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'welcome-day3': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Tips that top users love \uD83C\uDF1F</h2>
      <p>Hi there,</p>
      <p>Our most successful users do these 3 things:</p>
      <ol>
        <li><strong>Check their Pulse daily</strong> \u2014 Even a 1-minute glance keeps you ahead</li>
        <li><strong>Act on the top recommendation</strong> \u2014 Our AI prioritizes what matters most</li>
        <li><strong>Share reports with their team</strong> \u2014 Alignment drives results</li>
      </ol>
      <p>Ready to try the pro features? <a href="${APP_URLS.PRICING}">See our plans \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'winback-day1': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">We miss you \uD83D\uDC4B</h2>
      <p>Hi there,</p>
      <p>We noticed your Visibility subscription has ended. Here's what's new since you left:</p>
      <ul>
        <li>New AI-powered content recommendations</li>
        <li>Improved keyword tracking accuracy</li>
        <li>Faster dashboard loading</li>
      </ul>
      <p><a href="${APP_URLS.PRICING}" style="${EMAIL_STYLES.CTA_PRIMARY}">Reactivate Your Account \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'winback-day3': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Your SEO data is waiting \uD83D\uDCC8</h2>
      <p>Hi there,</p>
      <p>Your historical SEO data is still in our system. Reactivate to pick up right where you left off \u2014 no setup needed.</p>
      <p><a href="${APP_URLS.PRICING}" style="${EMAIL_STYLES.CTA_PRIMARY}">Come Back \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'winback-day7': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">20% off to come back \uD83C\uDF81</h2>
      <p>Hi there,</p>
      <p>We'd love to have you back. Use code <strong>${EMAIL_CONFIG.PROMO_CODE}</strong> for 20% off any plan.</p>
      <p><a href="${APP_URLS.PRICING_PROMO(EMAIL_CONFIG.PROMO_CODE)}" style="${EMAIL_STYLES.CTA_SUCCESS}">Claim 20% Off \u2192</a></p>
      <p style="${EMAIL_STYLES.SMALL_PRINT}">Offer valid for 7 days.</p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'winback-day14': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Final reminder \u2014 your data expires soon \u23F3</h2>
      <p>Hi there,</p>
      <p>Your historical SEO data will be archived in 14 days. After that, you'll need to start fresh.</p>
      <p>Reactivate now to keep your data and continue tracking your progress.</p>
      <p><a href="${APP_URLS.PRICING_PROMO(EMAIL_CONFIG.PROMO_CODE)}" style="${EMAIL_STYLES.CTA_DANGER}">Reactivate Now \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,

  // ─── Share PLG Email Templates ──────────────────────────────────────────

  'share-engaged-owner': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Someone is exploring your shared insights \uD83D\uDD0D</h2>
      <p>Hi there,</p>
      <p>A visitor just spent <strong>{{dwellSeconds}} seconds</strong> reviewing the SEO data you shared via your link <code>{{token}}</code>.</p>
      <p>That level of engagement means they're genuinely interested. Here's what you can do:</p>
      <ul>
        <li><strong>Follow up directly</strong> \u2014 They're already warm on the value of your insights</li>
        <li><strong>Share more data</strong> \u2014 Create a new share link with additional scopes</li>
        <li><strong>Invite them</strong> \u2014 If they sign up, you both benefit from shared analytics</li>
      </ul>
      <p><a href="${APP_URLS.COCKPIT}" style="${EMAIL_STYLES.CTA_PRIMARY}">Manage Your Shares \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'share-cta-dropout': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Still interested? Pick up where you left off \uD83D\uDCCA</h2>
      <p>Hi there,</p>
      <p>You recently explored an SEO insights report and clicked to learn more, but didn't finish signing up.</p>
      <p>Here's what you'll unlock with a free Visibility account:</p>
      <ul>
        <li><strong>Real-time SEO Pulse</strong> \u2014 Daily health score for your site</li>
        <li><strong>AI-powered recommendations</strong> \u2014 Prioritized fixes for maximum impact</li>
        <li><strong>Google Search Console integration</strong> \u2014 All your data in one dashboard</li>
      </ul>
      <p><a href="${APP_URLS.COCKPIT}" style="${EMAIL_STYLES.CTA_PRIMARY}">Create Your Free Account \u2192</a></p>
      <p style="${EMAIL_STYLES.SMALL_PRINT}">You received this because you interacted with a shared Visibility report.</p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'share-conversion-owner': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Someone you shared with just signed up! \uD83C\uDF89</h2>
      <p>Hi there,</p>
      <p>Great news \u2014 a person who viewed your shared insights (link <code>{{token}}</code>) has created a Visibility account.</p>
      <p>Your share stats:</p>
      <table style="${EMAIL_STYLES.TABLE}">
        <tr><td style="${EMAIL_STYLES.TABLE_CELL}"><strong>Total Shares</strong></td><td style="${EMAIL_STYLES.TABLE_CELL}">{{totalShares}}</td></tr>
        <tr><td style="${EMAIL_STYLES.TABLE_CELL}"><strong>Total Conversions</strong></td><td style="${EMAIL_STYLES.TABLE_CELL}">{{totalConversions}}</td></tr>
      </table>
      <p>Keep sharing your insights \u2014 every conversion strengthens your network.</p>
      <p><a href="${APP_URLS.COCKPIT}" style="${EMAIL_STYLES.CTA_SUCCESS}">View Your Dashboard \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,

  // ─── Cold Outreach Templates (outbound prospect sequences) ────────────────
  // These are rendered by the sequence engine for outbound.prospect_discovered
  // events. Context variables come from KV (stored by outbound-events.ts).
  // See: docs/OUTBOUND_SYSTEM_ARCHITECTURE.md §8.4

  'cold-outreach-step1': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">{{companyName}} \u2014 your site scored {{auditScore}}/100 on visibility</h2>
      <p>{{greetingPrefix}}{{contactNameGreeting}},</p>
      <p>We ran a free visibility audit on <strong>{{domain}}</strong> and wanted to share the results \u2014 no strings attached.</p>
      <div style="background:#f8fafc;border-radius:8px;padding:20px;margin:20px 0;border-left:4px solid #3b82f6">
        <div style="font-size:28px;font-weight:bold;color:#3b82f6">{{auditScore}}/100 <span style="font-size:16px;color:#64748b">Grade {{auditGrade}}</span></div>
        <div style="margin-top:8px;color:#334155">
          <span style="color:#22c55e">\u2713 {{passCount}} passed</span> \u00A0\u00B7\u00A0
          <span style="color:#ef4444">\u2717 {{issueCount}} issues</span>
        </div>
      </div>
      <p><a href="{{reportUrl}}?utm_source=outbound&utm_medium=email&utm_campaign=cold_outreach&utm_content=step1" style="${EMAIL_STYLES.CTA_PRIMARY}">View Your Full Report \u2192</a></p>
      <p style="color:#64748b;font-size:14px">This audit is completely free \u2014 we built Visibility to help sites improve their search performance.</p>
      <p style="font-size:12px;color:#94a3b8">You received this because we found {{domain}} on a public directory and thought our free audit might be useful. We will never send more than 3 emails.</p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,

  'cold-outreach-step2': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Quick SEO fix for {{companyName}} (3 min read)</h2>
      <p>{{greetingPrefix}}{{contactNameGreeting}},</p>
      <p>I shared your visibility audit a few days ago \u2014 wanted to follow up with <strong>one specific fix</strong> that could make a real difference for {{domain}}.</p>
      <div style="background:#f0fdf4;border-radius:8px;padding:20px;margin:20px 0;border-left:4px solid #22c55e">
        <div style="font-weight:bold;color:#166534;margin-bottom:8px">{{quickWinTitle}}</div>
        <div style="color:#334155;margin-bottom:4px">\u2192 {{quickWinAction}}</div>
        <div style="color:#64748b;font-size:14px">Expected impact: {{quickWinImpact}}</div>
      </div>
      <p>For context, sites in <strong>{{primaryTopic}}</strong> that address this typically see a <strong>15-25% improvement</strong> in search impressions within 4-6 weeks.</p>
      <p><a href="{{reportUrl}}?utm_source=outbound&utm_medium=email&utm_campaign=cold_outreach&utm_content=step2" style="${EMAIL_STYLES.CTA_PRIMARY}">Track Your Progress \u2192</a></p>
      <p style="font-size:12px;color:#94a3b8">Not interested? {{unsubscribeLink}}</p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,

  'cold-outreach-step3': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Last note about {{companyName}}'s visibility</h2>
      <p>{{greetingPrefix}}{{contactNameGreeting}},</p>
      <p>This is my last email about your site's visibility audit \u2014 I promise.</p>
      <p>Quick recap of what we found for <strong>{{domain}}</strong>:</p>
      <ul style="color:#334155;line-height:1.8">
        <li>Visibility score: <strong>{{auditScore}}/100</strong> (Grade {{auditGrade}})</li>
        <li>{{issueCount}} improvement opportunities identified</li>
        <li>Tech detected: {{techStackDisplay}}</li>
      </ul>
      <p><a href="{{reportUrl}}?utm_source=outbound&utm_medium=email&utm_campaign=cold_outreach&utm_content=step3" style="${EMAIL_STYLES.CTA_PRIMARY}">View Your Full Report \u2192</a></p>
      <p style="color:#64748b;font-size:14px">If you ever want to track how your visibility changes over time, you can <a href="${APP_URLS.HOME}/audit?url={{domainEncoded}}&connect=gsc" style="color:#3b82f6">connect Google Search Console for free</a>.</p>
      <p>Either way, I hope the audit was useful. <strong>No more emails from us on this.</strong></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
};
