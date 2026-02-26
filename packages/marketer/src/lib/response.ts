/**
 * Response helpers — consistent JSON responses for the marketing worker.
 */

import type { ApiResponse, Env } from '../types';
import { CORS, CONTENT_TYPE_JSON } from '../constants';

const JSON_HEADERS = { 'Content-Type': CONTENT_TYPE_JSON };
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': CORS.ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': CORS.ALLOWED_METHODS,
  'Access-Control-Allow-Headers': CORS.ALLOWED_HEADERS,
};

// ─── Auth Middleware (shared) ───────────────────────────────────────────────

/**
 * Check if the request has a valid admin Bearer token.
 * Shared across admin.ts, payouts.ts, recruitment.ts, campaigns.ts.
 */
export function isAdmin(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${env.ADMIN_TOKEN}`;
}

export function json<T>(data: T, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS, ...extra },
  });
}

export function ok<T>(data?: T, meta?: Record<string, unknown>): Response {
  const body: ApiResponse<T> = { ok: true, data, meta };
  return json(body, 200);
}

export function created<T>(data?: T): Response {
  return json<ApiResponse<T>>({ ok: true, data }, 201);
}

export function badRequest(error: string): Response {
  return json<ApiResponse>({ ok: false, error }, 400);
}

export function unauthorized(error = 'Unauthorized'): Response {
  return json<ApiResponse>({ ok: false, error }, 401);
}

export function notFound(error = 'Not found'): Response {
  return json<ApiResponse>({ ok: false, error }, 404);
}

export function serverError(error = 'Internal server error'): Response {
  return json<ApiResponse>({ ok: false, error }, 500);
}

export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
