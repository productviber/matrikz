/**
 * Email Sequence Engine
 *
 * Manages drip email sequences using D1 for scheduling and
 * KV for deduplication. Supports Brevo and SendGrid providers.
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
 * Returns the number of emails sent.
 */
export async function processDueEmails(env: Env, batchSize: number = PAGINATION.DEFAULT_PAGE_SIZE): Promise<number> {
  const currentTime = now();

  // Fetch due sends
  const dueSends = await query<EmailSendRow & { subject: string; template_key: string; sequence_name: string }>(
    env.DB,
    `SELECT es.*, est.subject, est.template_key, seq.name as sequence_name
     FROM email_sends es
     JOIN email_steps est ON es.step_id = est.id
     JOIN email_sequences seq ON es.sequence_id = seq.id
     WHERE es.status = '${EMAIL_STATUS.SCHEDULED}' AND es.scheduled_at <= ?
     ORDER BY es.scheduled_at ASC
     LIMIT ?`,
    [currentTime, batchSize]
  );

  if (dueSends.length === 0) return 0;

  let sentCount = 0;

  for (const send of dueSends) {
    try {
      // Load context data from KV
      const contextJson = await env.KV_MARKETING.get(`${KV_PREFIX.EMAIL_CONTEXT}${send.contact_email}:${send.sequence_id}`);
      const context = contextJson ? JSON.parse(contextJson) : {};

      // Send the email
      await sendEmail(env, {
        to: send.contact_email,
        subject: send.subject,
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

  console.log(`[Email] Processed ${dueSends.length} due emails, ${sentCount} sent successfully`);
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
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Brevo API error ${res.status}: ${errBody}`);
  }
}

async function sendViaSendGrid(env: Env, to: string, subject: string, html: string) {
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
};
