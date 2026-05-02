/**
 * Response helpers — consistent JSON responses for the marketing worker.
 */

import type { ApiResponse, Env } from '../types';
import { CORS, CONTENT_TYPE_JSON } from '../constants';
import { getCorrelationId } from './correlation';

const JSON_HEADERS = { 'Content-Type': CONTENT_TYPE_JSON };

/** Build CORS headers, preferring env.ALLOWED_ORIGIN over the constant default. */
function corsHeaders(env?: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env?.ALLOWED_ORIGIN ?? CORS.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': CORS.ALLOWED_METHODS,
    'Access-Control-Allow-Headers': CORS.ALLOWED_HEADERS,
  };
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
  return json<ApiResponse>({ ok: false, error, code: 'bad_request', correlationId: getCorrelationId() }, 400, undefined, env);
}

export function unauthorized(error = 'Unauthorized', env?: Env): Response {
  return json<ApiResponse>({ ok: false, error, code: 'unauthorized', correlationId: getCorrelationId() }, 401, undefined, env);
}

export function forbidden(error = 'Forbidden', env?: Env): Response {
  return json<ApiResponse>({ ok: false, error, code: 'forbidden', correlationId: getCorrelationId() }, 403, undefined, env);
}

export function notFound(error = 'Not found', env?: Env): Response {
  return json<ApiResponse>({ ok: false, error, code: 'not_found', correlationId: getCorrelationId() }, 404, undefined, env);
}

export function serverError(error = 'Internal server error', env?: Env): Response {
  return json<ApiResponse>({ ok: false, error, code: 'internal_error', correlationId: getCorrelationId() }, 500, undefined, env);
}

export function tooManyRequests(error = 'Too many requests', env?: Env): Response {
  return json<ApiResponse>({ ok: false, error, code: 'rate_limited', correlationId: getCorrelationId() }, 429, undefined, env);
}

export function corsPreflightResponse(env?: Env): Response {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}
