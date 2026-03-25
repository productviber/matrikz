/**
 * Affiliate Recruitment Routes
 *
 * Handles affiliate signup, approval, and management.
 */

import type { Env } from '../types';
import { COMMISSION_TIERS } from '../types';
import { ok, badRequest, serverError, created } from '../lib/response';
import { execute, queryOne, now } from '../lib/db';
import {
  KV_PREFIX,
  TTL,
  NOTE_TYPE,
  APPLICATION_STATUS,
  CONTENT_TYPE_JSON,
  MAX_LENGTH,
  PATTERNS,
  DEFAULTS,
  MESSAGES,
} from '../constants';

interface AffiliateApplication {
  email: string;
  name: string;
  website?: string;
  audience?: string;        // Description of their audience
  promotionPlan?: string;   // How they plan to promote
}

/**
 * POST /api/affiliate/apply
 *
 * Submit an affiliate application. Creates a pending record in the marketing DB.
 * On approval, the admin can promote them to the analytics worker.
 */
export async function handleAffiliateApply(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body: AffiliateApplication = await request.json();
    const { email, name, website, audience, promotionPlan } = body;

    if (!email || !name) {
      return badRequest(MESSAGES.errors.missingFieldsEmailName);
    }

    // Validate email format
    if (!PATTERNS.EMAIL.test(email)) {
      return badRequest(MESSAGES.errors.invalidEmailFormat);
    }

    // Generate code once and reuse
    const code = generateCode(name);

    // Store application in KV for admin review
    const applicationKey = `${KV_PREFIX.AFFILIATE_APPLICATION}${code}`;
    const existingApp = await env.KV_MARKETING.get(applicationKey);
    if (existingApp) {
      return badRequest(MESSAGES.errors.applicationExists);
    }

    const application = {
      code,
      email: email.toLowerCase().trim(),
      name,
      website: website ?? '',
      audience: audience ?? '',
      promotionPlan: promotionPlan ?? '',
      status: APPLICATION_STATUS.PENDING,
      appliedAt: new Date().toISOString(),
    };

    await env.KV_MARKETING.put(applicationKey, JSON.stringify(application), {
      expirationTtl: TTL.DAYS_90,
    });

    // Also store in a list for admin review
    const pendingListJson = await env.KV_MARKETING.get(KV_PREFIX.AFFILIATE_APPLICATIONS_PENDING) ?? '[]';
    const pendingList: string[] = JSON.parse(pendingListJson);
    if (!pendingList.includes(code)) {
      pendingList.push(code);
      await env.KV_MARKETING.put(KV_PREFIX.AFFILIATE_APPLICATIONS_PENDING, JSON.stringify(pendingList));
    }

    // Log the application
    await execute(
      env.DB,
      `INSERT INTO affiliate_notes (affiliate_code, note_type, content)
       VALUES (?, '${NOTE_TYPE.GENERAL}', ?)`,
      [code, MESSAGES.notes.applicationSubmitted(email, name, website ?? DEFAULTS.NOT_AVAILABLE)]
    );

    // Cache email mapping
    await env.KV_MARKETING.put(`${KV_PREFIX.AFFILIATE_EMAIL}${code}`, email.toLowerCase().trim(), {
      expirationTtl: TTL.YEAR_1,
    });

    return created({
      code,
      status: APPLICATION_STATUS.PENDING,
      message: MESSAGES.success.applicationReceived,
    });
  } catch (err) {
    console.error('[AffiliateApply] Error:', err);
    return serverError(MESSAGES.errors.failedProcessApplication);
  }
}

/**
 * POST /api/affiliate/approve (Admin only)
 *
 * Approve a pending affiliate application and create them in the analytics worker.
 */
export async function handleAffiliateApprove(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const { code, commissionRate } = await request.json() as {
      code: string;
      commissionRate?: number;
    };

    if (!code) {
      return badRequest(MESSAGES.errors.missingFieldCode);
    }

    // Load application
    const appJson = await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_APPLICATION}${code}`);
    if (!appJson) {
      return badRequest(MESSAGES.errors.applicationNotFound);
    }

    const application = JSON.parse(appJson);

    if (application.status === APPLICATION_STATUS.APPROVED) {
      return badRequest(MESSAGES.errors.applicationAlreadyApproved);
    }

    // Create affiliate in analytics worker via service binding
    try {
      const { createAffiliate } = await import('../lib/analytics-client');
      await createAffiliate(env, {
        code: application.code,
        name: application.name,
        email: application.email,
        commissionRate: commissionRate ?? COMMISSION_TIERS[0].rate,
      });
    } catch (err) {
      console.error('[AffiliateApprove] Failed to create in analytics:', err);
      return serverError(MESSAGES.errors.failedCreateAffiliate);
    }

    // Update application status
    application.status = APPLICATION_STATUS.APPROVED;
    application.approvedAt = new Date().toISOString();
    await env.KV_MARKETING.put(`${KV_PREFIX.AFFILIATE_APPLICATION}${code}`, JSON.stringify(application));

    // Remove from pending list
    const pendingListJson = await env.KV_MARKETING.get(KV_PREFIX.AFFILIATE_APPLICATIONS_PENDING) ?? '[]';
    const pendingList: string[] = JSON.parse(pendingListJson);
    const filtered = pendingList.filter((c) => c !== code);
    await env.KV_MARKETING.put(KV_PREFIX.AFFILIATE_APPLICATIONS_PENDING, JSON.stringify(filtered));

    // Initialize stats
    await env.KV_MARKETING.put(`${KV_PREFIX.AFFILIATE_STATS}${code}`, JSON.stringify({
      totalConversions: 0,
      totalEarnedCents: 0,
      lastConversionAt: null,
    }));

    // Log approval
    await execute(
      env.DB,
      `INSERT INTO affiliate_notes (affiliate_code, note_type, content)
       VALUES (?, '${NOTE_TYPE.GENERAL}', ?)`,
      [code, MESSAGES.notes.approved(((commissionRate ?? COMMISSION_TIERS[0].rate) * 100).toFixed(0))]
    );

    return ok({
      code,
      email: application.email,
      name: application.name,
      commissionRate: commissionRate ?? COMMISSION_TIERS[0].rate,
      status: APPLICATION_STATUS.APPROVED,
    });
  } catch (err) {
    console.error('[AffiliateApprove] Error:', err);
    return serverError(MESSAGES.errors.failedApproveAffiliate);
  }
}

/**
 * GET /api/affiliate/applications (Admin only)
 *
 * List pending affiliate applications.
 */
export async function handleListApplications(
  request: Request,
  env: Env
): Promise<Response> {
  const pendingListJson = await env.KV_MARKETING.get(KV_PREFIX.AFFILIATE_APPLICATIONS_PENDING) ?? '[]';
  const pendingCodes: string[] = JSON.parse(pendingListJson);

  const applications = [];
  for (const code of pendingCodes) {
    const appJson = await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_APPLICATION}${code}`);
    if (appJson) {
      applications.push(JSON.parse(appJson));
    }
  }

  return ok({ applications, count: applications.length });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate a URL-safe affiliate code from a name.
 */
function generateCode(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(PATTERNS.SLUG_STRIP, '')
    .replace(PATTERNS.SLUG_SPACES, '-')
    .slice(0, MAX_LENGTH.AFFILIATE_CODE);

  // Add a short random suffix for uniqueness
  const suffix = Math.random().toString(36).slice(MAX_LENGTH.RANDOM_SUFFIX_START, MAX_LENGTH.RANDOM_SUFFIX_END);
  return `${base}-${suffix}`;
}
