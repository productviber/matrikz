/**
 * Contact Form Submission Channel
 *
 * Submits personalised audit messages via website contact forms
 * as a second outreach channel alongside email. Bypasses email
 * deliverability issues entirely — form submissions land in the
 * prospect's CRM/inbox/helpdesk directly.
 *
 * Integration:
 *   - Called after a cold-outreach-step1 email is sent
 *   - Reads contactForms from KV context (stored by outbound-events.ts)
 *   - Submits to the first valid contact form found
 *   - Tracks submission in KV to prevent double-submission
 *
 * Field mapping heuristics handle major form builders:
 *   WordPress Contact Form 7, Gravity Forms, HubSpot, Typeform,
 *   generic HTML forms, etc.
 */

import type { Env, ContactForm } from '../types';
import { KV_PREFIX, TTL, APP_URLS } from '../constants';

// ── Field Name Mapping ──────────────────────────────────────────────────

/**
 * Maps common form field names to our data values.
 * Order matters: first match wins for each category.
 */
const FIELD_MAP: Record<string, RegExp> = {
  name:    /^(name|your[\-_]?name|full[\-_]?name|first[\-_]?name|sender[\-_]?name|contact[\-_]?name|from[\-_]?name)$/i,
  email:   /^(email|your[\-_]?email|e[\-_]?mail|email[\-_]?address|sender[\-_]?email|contact[\-_]?email|from[\-_]?email|reply[\-_]?to)$/i,
  subject: /^(subject|your[\-_]?subject|email[\-_]?subject|topic|regarding)$/i,
  message: /^(message|your[\-_]?message|comment|body|text|inquiry|question|feedback|description|details|content|note|notes|how[\-_]?can[\-_]?we[\-_]?help)$/i,
  company: /^(company|company[\-_]?name|organization|organisation|business)$/i,
  phone:   /^(phone|tel|telephone|mobile|your[\-_]?phone|phone[\-_]?number)$/i,
  website: /^(website|url|site|your[\-_]?website|web)$/i,
};

/**
 * Build form data payload by mapping the form's field names to our values.
 */
function buildFormPayload(
  fields: string[],
  context: {
    domain: string;
    companyName: string;
    auditScore: number | null;
    auditGrade: string | null;
    issueCount: number | null;
    passCount: number | null;
    auditPageUrl: string;
    fromName: string;
    fromEmail: string;
  }
): Record<string, string> {
  const payload: Record<string, string> = {};

  // Pre-build the message text
  const messageText = [
    `Hi,`,
    ``,
    `I was looking at ${context.domain} and ran a quick visibility check. Your site scored ${context.auditScore ?? '—'}/100 (Grade ${context.auditGrade ?? '—'}).`,
    ``,
    context.issueCount
      ? `I found ${context.passCount ?? 0} things working well and ${context.issueCount} areas that could use attention.`
      : `Overall looks solid — a few areas stood out that might be worth a look.`,
    ``,
    `Full breakdown here: ${context.auditPageUrl}`,
    ``,
    `No strings attached — just thought it might be useful.`,
    ``,
    `${context.fromName}`,
    `${context.fromEmail}`,
  ].join('\n');

  const subjectText = `Quick note about ${context.domain}'s search visibility`;

  for (const field of fields) {
    const lower = field.toLowerCase();

    if (FIELD_MAP.name.test(field)) {
      payload[field] = context.fromName;
    } else if (FIELD_MAP.email.test(field)) {
      payload[field] = context.fromEmail;
    } else if (FIELD_MAP.subject.test(field)) {
      payload[field] = subjectText;
    } else if (FIELD_MAP.message.test(field)) {
      payload[field] = messageText;
    } else if (FIELD_MAP.company.test(field)) {
      payload[field] = 'AXEO';
    } else if (FIELD_MAP.phone.test(field)) {
      // Leave blank — we don't have a phone number and it's usually optional
      payload[field] = '';
    } else if (FIELD_MAP.website.test(field)) {
      payload[field] = 'https://visibility.clodo.dev';
    } else {
      // Unknown field — leave blank to avoid form validation errors
      payload[field] = '';
    }
  }

  return payload;
}

/**
 * Submit a personalised message to a prospect's contact form.
 *
 * @param env       Worker environment bindings
 * @param form      Contact form metadata (action, method, fields)
 * @param context   KV context with prospect + audit data
 * @returns         true if submitted successfully, false otherwise
 */
export async function submitContactForm(
  env: Env,
  form: ContactForm,
  context: Record<string, unknown>
): Promise<boolean> {
  const domain = String(context.domain ?? '');
  const fromName = String(env.FROM_NAME ?? 'Alex from AXEO');
  const fromEmail = String(env.FROM_EMAIL ?? 'product@clodo.dev');

  // Build the audit page URL
  const domainEncoded = encodeURIComponent(domain);
  const auditPageUrl = `${APP_URLS.HOME}/audit?url=${domainEncoded}`;

  const payload = buildFormPayload(form.fields, {
    domain,
    companyName: String(context.companyName ?? domain),
    auditScore: context.auditScore as number | null,
    auditGrade: context.auditGrade as string | null,
    issueCount: context.issueCount as number | null,
    passCount: context.passCount as number | null,
    auditPageUrl,
    fromName,
    fromEmail,
  });

  // Ensure we have at least a message field mapped
  const hasMessage = Object.values(payload).some(v => v.length > 100);
  if (!hasMessage) {
    console.log(`[ContactForm] No message field mapped for form ${form.action} — skipping`);
    return false;
  }

  try {
    const body = form.method === 'GET'
      ? undefined
      : new URLSearchParams(payload).toString();

    const url = form.method === 'GET'
      ? `${form.action}?${new URLSearchParams(payload).toString()}`
      : form.action;

    const res = await fetch(url, {
      method: form.method,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (compatible; VisibilityAudit/1.0)',
        'Accept': 'text/html,application/json',
        'Origin': new URL(form.pageUrl).origin,
        'Referer': form.pageUrl,
      },
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    // Most contact forms return 200 or 302 on success
    if (res.ok || res.status === 302 || res.status === 301) {
      console.log(`[ContactForm] Submitted to ${form.action} for ${domain} — status ${res.status}`);
      return true;
    }

    console.log(`[ContactForm] Failed: ${form.action} returned ${res.status}`);
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ContactForm] Error submitting to ${form.action}: ${msg}`);
    return false;
  }
}

/**
 * Attempt contact form outreach for a prospect after email is sent.
 * Reads contact forms from KV context, dedupes via KV tracker,
 * and submits to the first valid form found.
 *
 * Only runs for cold-outreach-step1 (initial contact).
 * Step 2 and 3 are email-only to avoid spamming the form.
 *
 * @param env       Worker environment bindings
 * @param email     Prospect's email address
 * @param context   Full KV context (includes contactForms from enrichment)
 * @returns         true if a form was submitted, false otherwise
 */
export async function attemptFormOutreach(
  env: Env,
  email: string,
  context: Record<string, unknown>
): Promise<boolean> {
  const contactForms = context.contactForms as ContactForm[] | undefined;
  if (!contactForms || contactForms.length === 0) {
    return false;
  }

  const domain = String(context.domain ?? '');

  // Dedup check — only submit once per domain
  const dedupKey = `${KV_PREFIX.OUTBOUND_FORM}${domain}`;
  const existing = await env.KV_MARKETING.get(dedupKey);
  if (existing) {
    console.log(`[ContactForm] Already submitted for ${domain} — skipping`);
    return false;
  }

  // Try each contact form until one succeeds
  for (const form of contactForms) {
    const success = await submitContactForm(env, form, context);
    if (success) {
      // Track the submission for dedup (90-day TTL)
      await env.KV_MARKETING.put(
        dedupKey,
        JSON.stringify({
          formAction: form.action,
          email,
          submittedAt: new Date().toISOString(),
        }),
        { expirationTtl: TTL.DAYS_90 }
      );
      return true;
    }
  }

  return false;
}
