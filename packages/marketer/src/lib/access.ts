import type { Env } from '../types';
import {
  CONTENT_TYPE_JSON,
  TRUSTED_SOURCE,
  CF_SERVICE_HEADER,
  KV_PREFIX,
  TTL,
} from '../constants';
import { resolveAffiliateIdentity } from './affiliate-session';
import { timingSafeEqual } from './security';

export type AccessLane = 'admin' | 'user' | 'system' | 'agentic' | 'webhook';

export interface AccessDecision {
  ok: boolean;
  lane: AccessLane;
  status: number;
  error?: string;
}

function getBearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth) return null;
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
}

function parseTokenCandidates(primary?: string, rollover?: string): string[] {
  const fromPrimary = primary ? [primary.trim()] : [];
  const fromRollover = (rollover ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return [...fromPrimary, ...fromRollover];
}

function hasMatchingToken(token: string, candidates: string[]): boolean {
  const normalizedToken = token.trim();
  return candidates.some((candidate) => timingSafeEqual(normalizedToken, candidate));
}

function requestFingerprint(request: Request): string {
  const url = new URL(request.url);
  const ip = request.headers.get('CF-Connecting-IP') ?? request.headers.get('x-forwarded-for') ?? 'na';
  const ua = request.headers.get('User-Agent') ?? 'na';
  const acceptLang = request.headers.get('Accept-Language') ?? 'na';
  return [request.method, url.pathname, ip, ua.slice(0, 80), acceptLang.slice(0, 32)].join('|');
}

export function deny(lane: AccessLane, status: number, error: string): AccessDecision {
  return { ok: false, lane, status, error };
}

export function allow(lane: AccessLane): AccessDecision {
  return { ok: true, lane, status: 200 };
}

export function accessDenied(decision: AccessDecision): Response {
  return new Response(JSON.stringify({ ok: false, error: decision.error ?? 'Unauthorized' }), {
    status: decision.status,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
  });
}

export async function auditDeniedAdminAttempt(
  env: Env,
  request: Request,
  decision: AccessDecision,
): Promise<void> {
  if (decision.lane !== 'admin') return;

  const now = Date.now();
  const key = `${KV_PREFIX.AUTH_NONCE}admin-denied:${now}:${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    at: new Date(now).toISOString(),
    status: decision.status,
    reason: decision.error ?? 'Unauthorized',
    fingerprint: requestFingerprint(request),
  };

  await env.KV_MARKETING.put(key, JSON.stringify(record), { expirationTtl: TTL.DAYS_30 });
  console.warn(`[Access] Denied admin request: ${record.reason}; fp=${record.fingerprint}`);
}

export function ensureAdminAccess(request: Request, env: Env): AccessDecision {
  const token = getBearerToken(request);
  if (!token) return deny('admin', 401, 'Admin bearer token required');

  const candidates = parseTokenCandidates(env.ADMIN_TOKEN, env.ADMIN_TOKEN_ROLLOVER);
  if (!hasMatchingToken(token, candidates)) {
    return deny('admin', 401, 'Invalid admin token');
  }

  return allow('admin');
}

export function ensureAgenticAccess(request: Request, env: Env): AccessDecision {
  const candidates = parseTokenCandidates(env.AGENT_TOKEN, env.AGENT_TOKEN_ROLLOVER);
  if (candidates.length === 0) {
    return deny('agentic', 503, 'Agentic access is not configured');
  }

  const headerToken = request.headers.get('x-agent-token');
  const bearer = getBearerToken(request);
  const token = headerToken ?? bearer;
  if (!token) return deny('agentic', 401, 'Agent token required');
  if (!hasMatchingToken(token, candidates)) return deny('agentic', 401, 'Invalid agent token');
  return allow('agentic');
}

export function ensureSystemAccess(
  request: Request,
  env: Env,
  source?: string
): AccessDecision {
  const cfWorker = request.headers.get(CF_SERVICE_HEADER);
  if (cfWorker) {
    if (source && source !== TRUSTED_SOURCE) {
      return deny('system', 400, 'Unknown source');
    }
    return allow('system');
  }

  const candidates = parseTokenCandidates(env.SYSTEM_TOKEN, env.SYSTEM_TOKEN_ROLLOVER);
  if (candidates.length === 0) {
    return deny('system', 401, 'Service binding header required');
  }

  const explicitToken = request.headers.get('x-system-token');
  const bearer = getBearerToken(request);
  const token = explicitToken ?? bearer;
  if (!token) return deny('system', 401, 'System token required');
  if (!hasMatchingToken(token, candidates)) return deny('system', 401, 'Invalid system token');

  if (source && source !== TRUSTED_SOURCE) {
    return deny('system', 400, 'Unknown source');
  }

  return allow('system');
}

export function ensureWebhookAccess(request: Request, env: Env): AccessDecision {
  const candidates = parseTokenCandidates(env.WEBHOOK_TOKEN, env.WEBHOOK_TOKEN_ROLLOVER);
  // Backward compatible mode: if no webhook token is configured, keep endpoint open.
  if (candidates.length === 0) return allow('webhook');

  const token = request.headers.get('x-webhook-token') ?? getBearerToken(request);
  if (!token) return deny('webhook', 401, 'Webhook token required');
  if (!hasMatchingToken(token, candidates)) return deny('webhook', 401, 'Invalid webhook token');
  return allow('webhook');
}

export async function ensureUserAccess(request: Request, env: Env): Promise<AccessDecision> {
  // /api/unsubscribe remains intentionally public and rate-limited.
  const path = new URL(request.url).pathname;
  if (path === '/api/unsubscribe' || path === '/api/affiliate/session') return allow('user');

  // If no affiliate auth secret is configured, keep legacy query-param auth path.
  if (!env.AFFILIATE_AUTH_SECRET) return allow('user');

  const identity = await resolveAffiliateIdentity(request, env);
  if (!identity) {
    return deny('user', 401, 'Affiliate bearer token required');
  }
  return allow('user');
}
