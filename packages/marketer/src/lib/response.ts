/**
 * Response helpers — consistent JSON responses for the marketing worker.
 */

import type { ApiResponse, Env } from '../types';
import { CORS, CONTENT_TYPE_JSON } from '../constants';

const JSON_HEADERS = { 'Content-Type': CONTENT_TYPE_JSON };

/** Build CORS headers, preferring env.ALLOWED_ORIGIN over the constant default. */
function corsHeaders(env?: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env?.ALLOWED_ORIGIN ?? CORS.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': CORS.ALLOWED_METHODS,
    'Access-Control-Allow-Headers': CORS.ALLOWED_HEADERS,
  };
}

// ─── Auth Middleware (shared) ───────────────────────────────────────────────

/**
 * Check if the request has a valid admin Bearer token.
 * Shared across admin.ts, payouts.ts, recruitment.ts, campaigns.ts.
 */
export function isAdmin(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${env.ADMIN_TOKEN}`;
}

export function json<T>(data: T, status = 200, extra?: Record<string, string>, env?: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(env), ...extra },
  });
}

export function ok<T>(data?: T, meta?: Record<string, unknown>, env?: Env): Response {
  const body: ApiResponse<T> = { ok: true, data, meta };
  return json(body, 200, undefined, env);
}

export function created<T>(data?: T, env?: Env): Response {
  return json<ApiResponse<T>>({ ok: true, data }, 201, undefined, env);
}

export function badRequest(error: string, env?: Env): Response {
  return json<ApiResponse>({ ok: false, error }, 400, undefined, env);
}

export function unauthorized(error = 'Unauthorized', env?: Env): Response {
  return json<ApiResponse>({ ok: false, error }, 401, undefined, env);
}

export function notFound(error = 'Not found', env?: Env): Response {
  return json<ApiResponse>({ ok: false, error }, 404, undefined, env);
}

export function serverError(error = 'Internal server error', env?: Env): Response {
  return json<ApiResponse>({ ok: false, error }, 500, undefined, env);
}

export function tooManyRequests(error = 'Too many requests', env?: Env): Response {
  return json<ApiResponse>({ ok: false, error }, 429, undefined, env);
}

export function corsPreflightResponse(env?: Env): Response {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}
