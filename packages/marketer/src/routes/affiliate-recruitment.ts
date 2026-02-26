/**
 * Affiliate Recruitment Routes
 *
 * Handles affiliate signup, approval, and management.
 */

import type { Env } from '../types';
import { ok, badRequest, serverError, created } from '../lib/response';
import { execute, queryOne, now } from '../lib/db';

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
      return badRequest('Missing required fields: email, name');
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return badRequest('Invalid email format');
    }

    // Generate code once and reuse
    const code = generateCode(name);

    // Store application in KV for admin review
    const applicationKey = `affiliate-application:${code}`;
    const existingApp = await env.KV_MARKETING.get(applicationKey);
    if (existingApp) {
      return badRequest('An application with this name already exists');
    }

    const application = {
      code,
      email: email.toLowerCase().trim(),
      name,
      website: website ?? '',
      audience: audience ?? '',
      promotionPlan: promotionPlan ?? '',
      status: 'pending',
      appliedAt: new Date().toISOString(),
    };

    await env.KV_MARKETING.put(applicationKey, JSON.stringify(application), {
      expirationTtl: 90 * 86_400, // 90 days
    });

    // Also store in a list for admin review
    const pendingListJson = await env.KV_MARKETING.get('affiliate-applications:pending') ?? '[]';
    const pendingList: string[] = JSON.parse(pendingListJson);
    if (!pendingList.includes(code)) {
      pendingList.push(code);
      await env.KV_MARKETING.put('affiliate-applications:pending', JSON.stringify(pendingList));
    }

    // Log the application
    await execute(
      env.DB,
      `INSERT INTO affiliate_notes (affiliate_code, note_type, content)
       VALUES (?, 'general', ?)`,
      [code, `Application submitted by ${email} (${name}). Website: ${website ?? 'N/A'}`]
    );

    // Cache email mapping
    await env.KV_MARKETING.put(`affiliate-email:${code}`, email.toLowerCase().trim(), {
      expirationTtl: 365 * 86_400,
    });

    return created({
      code,
      status: 'pending',
      message: 'Application received! We\'ll review it within 48 hours.',
    });
  } catch (err) {
    console.error('[AffiliateApply] Error:', err);
    return serverError('Failed to process application');
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
  // Admin auth check
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${env.ADMIN_TOKEN}`) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { code, commissionRate } = await request.json() as {
      code: string;
      commissionRate?: number;
    };

    if (!code) {
      return badRequest('Missing required field: code');
    }

    // Load application
    const appJson = await env.KV_MARKETING.get(`affiliate-application:${code}`);
    if (!appJson) {
      return badRequest('Application not found');
    }

    const application = JSON.parse(appJson);

    if (application.status === 'approved') {
      return badRequest('Application already approved');
    }

    // Create affiliate in analytics worker via service binding
    try {
      const { createAffiliate } = await import('../lib/analytics-client');
      await createAffiliate(env, {
        code: application.code,
        name: application.name,
        email: application.email,
        commissionRate: commissionRate ?? 0.20,
      });
    } catch (err) {
      console.error('[AffiliateApprove] Failed to create in analytics:', err);
      return serverError('Failed to create affiliate in analytics worker');
    }

    // Update application status
    application.status = 'approved';
    application.approvedAt = new Date().toISOString();
    await env.KV_MARKETING.put(`affiliate-application:${code}`, JSON.stringify(application));

    // Remove from pending list
    const pendingListJson = await env.KV_MARKETING.get('affiliate-applications:pending') ?? '[]';
    const pendingList: string[] = JSON.parse(pendingListJson);
    const filtered = pendingList.filter((c) => c !== code);
    await env.KV_MARKETING.put('affiliate-applications:pending', JSON.stringify(filtered));

    // Initialize stats
    await env.KV_MARKETING.put(`affiliate-stats:${code}`, JSON.stringify({
      totalConversions: 0,
      totalEarnedCents: 0,
      lastConversionAt: null,
    }));

    // Log approval
    await execute(
      env.DB,
      `INSERT INTO affiliate_notes (affiliate_code, note_type, content)
       VALUES (?, 'general', ?)`,
      [code, `Approved with ${((commissionRate ?? 0.20) * 100).toFixed(0)}% commission rate`]
    );

    return ok({
      code,
      email: application.email,
      name: application.name,
      commissionRate: commissionRate ?? 0.20,
      status: 'approved',
    });
  } catch (err) {
    console.error('[AffiliateApprove] Error:', err);
    return serverError('Failed to approve affiliate');
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
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${env.ADMIN_TOKEN}`) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const pendingListJson = await env.KV_MARKETING.get('affiliate-applications:pending') ?? '[]';
  const pendingCodes: string[] = JSON.parse(pendingListJson);

  const applications = [];
  for (const code of pendingCodes) {
    const appJson = await env.KV_MARKETING.get(`affiliate-application:${code}`);
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
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 30);

  // Add a short random suffix for uniqueness
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}-${suffix}`;
}
