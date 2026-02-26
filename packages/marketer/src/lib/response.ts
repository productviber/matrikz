/**
 * Response helpers — consistent JSON responses for the marketing worker.
 */

import type { ApiResponse } from '../types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

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
