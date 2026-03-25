import type { Env } from '../types';
import { badRequest, ok, serverError, unauthorized } from '../lib/response';
import { verifyAffiliateCredentials } from '../lib/affiliate-auth';
import { issueAffiliateSessionToken } from '../lib/affiliate-session';

interface SessionRequestBody {
  code?: string;
  email?: string;
  ttlSecs?: number;
}

/**
 * POST /api/affiliate/session
 * Exchanges code+email credentials for a short-lived signed bearer token.
 */
export async function handleCreateAffiliateSession(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.AFFILIATE_AUTH_SECRET) {
    return serverError('Affiliate session auth is not configured');
  }

  let body: SessionRequestBody;
  try {
    body = await request.json() as SessionRequestBody;
  } catch {
    return badRequest('Invalid JSON body');
  }

  const code = body.code?.trim();
  const email = body.email?.trim().toLowerCase();
  if (!code || !email) {
    return badRequest('code and email are required');
  }

  const isVerified = await verifyAffiliateCredentials(env, code, email, { allowAnalyticsFallback: true });
  if (!isVerified) {
    return unauthorized('Invalid affiliate credentials');
  }

  const ttlSecs = typeof body.ttlSecs === 'number' ? Math.max(300, Math.min(body.ttlSecs, 86_400)) : 3600;
  const session = await issueAffiliateSessionToken(env, code, email, ttlSecs);

  return ok({
    token: session.token,
    tokenType: 'Bearer',
    expiresAt: session.expiresAt,
    expiresAtIso: new Date(session.expiresAt * 1000).toISOString(),
    code,
  });
}
