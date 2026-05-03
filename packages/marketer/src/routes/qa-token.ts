import type { Env } from '../types';
import { badRequest, forbidden, ok, serverError } from '../lib/response';
import { issueAffiliateSessionToken } from '../lib/affiliate-session';

interface QATokenRequestBody {
  code?: string;
  email?: string;
  ttlSecs?: number;
}

/**
 * POST /api/admin/qa/affiliate-token
 *
 * Admin-only helper that mints a short-lived affiliate bearer token without
 * performing credential verification. Intended solely for automated QA /
 * smoke-test pipelines where a real payout_items row may not exist.
 *
 * DISABLED unless `QA_MODE_ENABLED=true` in the worker env.
 * This env var must never be set to 'true' in production deployments.
 */
export async function handleQATokenMint(
  request: Request,
  env: Env
): Promise<Response> {
  if (env.QA_MODE_ENABLED !== 'true') {
    return forbidden('This endpoint is disabled in production');
  }

  if (!env.AFFILIATE_AUTH_SECRET) {
    return serverError('Affiliate session auth is not configured');
  }

  let body: QATokenRequestBody;
  try {
    body = await request.json() as QATokenRequestBody;
  } catch {
    return badRequest('Invalid JSON body');
  }

  const code = body.code?.trim();
  const email = body.email?.trim().toLowerCase();
  if (!code || !email) {
    return badRequest('code and email are required');
  }

  const ttlSecs =
    typeof body.ttlSecs === 'number'
      ? Math.max(60, Math.min(body.ttlSecs, 86_400))
      : 3600;

  const session = await issueAffiliateSessionToken(env, code, email, ttlSecs);

  return ok({
    token: session.token,
    tokenType: 'Bearer',
    expiresAt: session.expiresAt,
    expiresAtIso: new Date(session.expiresAt * 1000).toISOString(),
    code,
    _qa: true,
  });
}
