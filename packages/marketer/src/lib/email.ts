/**
 * Email Sequence Engine
 *
 * Manages drip email sequences using D1 for scheduling and
 * KV for deduplication. Supports Brevo and SendGrid providers.
 */

import type { Env, EmailSendRow } from '../types';
import { query, queryOne, execute, now } from './db';

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
      `SELECT id FROM email_sends WHERE contact_email = ? AND sequence_id = ? AND status IN ('scheduled', 'sent') LIMIT 1`,
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
         VALUES (?, ?, ?, 'scheduled', ?)`,
        [contactEmail, seq.id, step.id, scheduledAt]
      );
      totalScheduled++;
    }

    // Store context data in KV for template rendering
    if (contextData) {
      await env.KV_MARKETING.put(
        `email-ctx:${contactEmail}:${seq.id}`,
        JSON.stringify(contextData),
        { expirationTtl: 30 * 86_400 } // 30 days
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
export async function processDueEmails(env: Env, batchSize = 50): Promise<number> {
  const currentTime = now();

  // Fetch due sends
  const dueSends = await query<EmailSendRow & { subject: string; template_key: string; sequence_name: string }>(
    env.DB,
    `SELECT es.*, est.subject, est.template_key, seq.name as sequence_name
     FROM email_sends es
     JOIN email_steps est ON es.step_id = est.id
     JOIN email_sequences seq ON es.sequence_id = seq.id
     WHERE es.status = 'scheduled' AND es.scheduled_at <= ?
     ORDER BY es.scheduled_at ASC
     LIMIT ?`,
    [currentTime, batchSize]
  );

  if (dueSends.length === 0) return 0;

  let sentCount = 0;

  for (const send of dueSends) {
    try {
      // Load context data from KV
      const contextJson = await env.KV_MARKETING.get(`email-ctx:${send.contact_email}:${send.sequence_id}`);
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
        `UPDATE email_sends SET status = 'sent', sent_at = ? WHERE id = ?`,
        [now(), send.id]
      );
      sentCount++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Email] Failed to send ${send.id} to ${send.contact_email}: ${errorMsg}`);
      await execute(
        env.DB,
        `UPDATE email_sends SET status = 'failed', error = ? WHERE id = ?`,
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
  let sql = `UPDATE email_sends SET status = 'cancelled' WHERE contact_email = ? AND status = 'scheduled'`;
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

  // Render template (simple mustache-like replacement)
  const htmlBody = await renderTemplate(env, templateKey, { ...context, subject, to });

  if (env.ENVIRONMENT === 'development' || !env.EMAIL_API_KEY) {
    console.log(`[Email:Dev] Would send to ${to}: "${subject}" (template: ${templateKey})`);
    return;
  }

  const provider = env.EMAIL_PROVIDER ?? 'brevo';

  if (provider === 'brevo') {
    await sendViaBrevo(env, to, subject, htmlBody);
  } else if (provider === 'sendgrid') {
    await sendViaSendGrid(env, to, subject, htmlBody);
  }
}

async function sendViaBrevo(env: Env, to: string, subject: string, html: string) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': env.EMAIL_API_KEY!,
      'Content-Type': 'application/json',
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
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.EMAIL_API_KEY!}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: env.FROM_EMAIL, name: env.FROM_NAME },
      subject,
      content: [{ type: 'text/html', value: html }],
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
        return interpolate(html, vars);
      }
    } catch {
      // Fall through to built-in
    }
  }

  // Built-in fallback templates
  const template = BUILT_IN_TEMPLATES[templateKey] ?? BUILT_IN_TEMPLATES['generic'];
  return interpolate(template, vars);
}

function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key];
    return val !== undefined ? String(val) : '';
  });
}

const BUILT_IN_TEMPLATES: Record<string, string> = {
  generic: `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">{{subject}}</h2>
      <p>Hello,</p>
      <p>Thank you for being part of Visibility.</p>
      <p style="margin-top: 24px; color: #666;">— The Clodo SEO Team</p>
    </div>
  `,
  'onboarding-welcome': `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">Welcome to Visibility! 🚀</h2>
      <p>Hi there,</p>
      <p>You've just unlocked the <strong>{{plan}}</strong> plan. Here's how to get the most out of Visibility:</p>
      <ol>
        <li><strong>Connect your site</strong> — Add your domain in the Cockpit dashboard</li>
        <li><strong>Link Google Search Console</strong> — We'll pull in your real performance data</li>
        <li><strong>Check your Pulse</strong> — Your SEO health score updates daily</li>
      </ol>
      <p><a href="https://visibility.clodo.dev/cockpit" style="display: inline-block; background: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Open Your Dashboard →</a></p>
      <p style="margin-top: 24px; color: #666;">— The Clodo SEO Team</p>
    </div>
  `,
  'onboarding-day1': `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">Set up your first site in 2 minutes ⏱️</h2>
      <p>Hi there,</p>
      <p>Most users see their first insights within 24 hours of connecting. If you haven't already:</p>
      <ol>
        <li>Go to your <a href="https://visibility.clodo.dev/cockpit">Cockpit</a></li>
        <li>Click "Add Site" and enter your domain</li>
        <li>Authorize Google Search Console access</li>
      </ol>
      <p>That's it! We'll start analyzing your SEO health immediately.</p>
      <p style="margin-top: 24px; color: #666;">— The Clodo SEO Team</p>
    </div>
  `,
  'onboarding-day3': `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">Your first insights are ready 📊</h2>
      <p>Hi there,</p>
      <p>By now, Visibility has been analyzing your site for a few days. Check your dashboard for:</p>
      <ul>
        <li>Your <strong>SEO Health Score</strong></li>
        <li><strong>Top opportunities</strong> — pages with quick-win potential</li>
        <li><strong>Action items</strong> — prioritized fixes for maximum impact</li>
      </ul>
      <p><a href="https://visibility.clodo.dev/cockpit" style="display: inline-block; background: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;">See Your Insights →</a></p>
      <p style="margin-top: 24px; color: #666;">— The Clodo SEO Team</p>
    </div>
  `,
  'onboarding-day7': `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">Pro tips from power users 💡</h2>
      <p>Hi there,</p>
      <p>You've been using Visibility for a week! Here are tips from our top users:</p>
      <ul>
        <li><strong>Set up weekly reports</strong> — Track your progress automatically</li>
        <li><strong>Use the AI assistant</strong> — Ask it about any metric for deeper analysis</li>
        <li><strong>Share reports</strong> — Send SEO snapshots to your team or clients</li>
      </ul>
      <p>Questions? Just reply to this email — we read every message.</p>
      <p style="margin-top: 24px; color: #666;">— The Clodo SEO Team</p>
    </div>
  `,
  'affiliate-commission': `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">You earned a commission! 🎉</h2>
      <p>Great news!</p>
      <p>A user you referred just made a purchase. Here are the details:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Plan</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">{{plan}}</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Sale Amount</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">{{saleAmount}}</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Your Commission</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">{{commissionAmount}}</td></tr>
        <tr><td style="padding: 8px;"><strong>Total Earnings</strong></td><td style="padding: 8px;">{{totalEarnings}}</td></tr>
      </table>
      <p><a href="https://visibility.clodo.dev/affiliate/portal" style="display: inline-block; background: #059669; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;">View Your Dashboard →</a></p>
      <p style="margin-top: 24px; color: #666;">— The Clodo SEO Affiliate Program</p>
    </div>
  `,
  'welcome-signup': `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">Welcome to Visibility 👋</h2>
      <p>Hi there,</p>
      <p>Thanks for signing up! Visibility gives you real-time insights into your search engine performance.</p>
      <p>Here's what you can do right now:</p>
      <ol>
        <li><strong>Connect your Google Search Console</strong></li>
        <li><strong>Check your SEO Pulse</strong> — your site's health score</li>
        <li><strong>Explore AI-powered insights</strong></li>
      </ol>
      <p><a href="https://visibility.clodo.dev/cockpit" style="display: inline-block; background: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Get Started →</a></p>
      <p style="margin-top: 24px; color: #666;">— The Clodo SEO Team</p>
    </div>
  `,
  'welcome-day1': `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">Your first SEO check ✅</h2>
      <p>Hi there,</p>
      <p>Have you connected your first site yet? It only takes a minute:</p>
      <p><a href="https://visibility.clodo.dev/cockpit" style="display: inline-block; background: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Connect a Site →</a></p>
      <p>Once connected, you'll get daily insights on your search performance.</p>
      <p style="margin-top: 24px; color: #666;">— The Clodo SEO Team</p>
    </div>
  `,
  'welcome-day3': `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">Tips that top users love 🌟</h2>
      <p>Hi there,</p>
      <p>Our most successful users do these 3 things:</p>
      <ol>
        <li><strong>Check their Pulse daily</strong> — Even a 1-minute glance keeps you ahead</li>
        <li><strong>Act on the top recommendation</strong> — Our AI prioritizes what matters most</li>
        <li><strong>Share reports with their team</strong> — Alignment drives results</li>
      </ol>
      <p>Ready to try the pro features? <a href="https://visibility.clodo.dev/pricing">See our plans →</a></p>
      <p style="margin-top: 24px; color: #666;">— The Clodo SEO Team</p>
    </div>
  `,
  'winback-day1': `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">We miss you 👋</h2>
      <p>Hi there,</p>
      <p>We noticed your Visibility subscription has ended. Here's what's new since you left:</p>
      <ul>
        <li>New AI-powered content recommendations</li>
        <li>Improved keyword tracking accuracy</li>
        <li>Faster dashboard loading</li>
      </ul>
      <p><a href="https://visibility.clodo.dev/pricing" style="display: inline-block; background: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Reactivate Your Account →</a></p>
      <p style="margin-top: 24px; color: #666;">— The Clodo SEO Team</p>
    </div>
  `,
  'winback-day3': `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">Your SEO data is waiting 📈</h2>
      <p>Hi there,</p>
      <p>Your historical SEO data is still in our system. Reactivate to pick up right where you left off — no setup needed.</p>
      <p><a href="https://visibility.clodo.dev/pricing" style="display: inline-block; background: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Come Back →</a></p>
      <p style="margin-top: 24px; color: #666;">— The Clodo SEO Team</p>
    </div>
  `,
  'winback-day7': `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">20% off to come back 🎁</h2>
      <p>Hi there,</p>
      <p>We'd love to have you back. Use code <strong>COMEBACK20</strong> for 20% off any plan.</p>
      <p><a href="https://visibility.clodo.dev/pricing?promo=COMEBACK20" style="display: inline-block; background: #059669; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Claim 20% Off →</a></p>
      <p style="font-size: 14px; color: #888;">Offer valid for 7 days.</p>
      <p style="margin-top: 24px; color: #666;">— The Clodo SEO Team</p>
    </div>
  `,
  'winback-day14': `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">Final reminder — your data expires soon ⏳</h2>
      <p>Hi there,</p>
      <p>Your historical SEO data will be archived in 14 days. After that, you'll need to start fresh.</p>
      <p>Reactivate now to keep your data and continue tracking your progress.</p>
      <p><a href="https://visibility.clodo.dev/pricing?promo=COMEBACK20" style="display: inline-block; background: #dc2626; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Reactivate Now →</a></p>
      <p style="margin-top: 24px; color: #666;">— The Clodo SEO Team</p>
    </div>
  `,
};
