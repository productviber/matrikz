import { CONTENT_TYPE_JSON } from '../constants';

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, status = 500, code = 'internal_error', details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class AuthError extends AppError {
  constructor(message = 'Unauthorized', details?: Record<string, unknown>) {
    super(message, 401, 'auth_error', details);
    this.name = 'AuthError';
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request', details?: Record<string, unknown>) {
    super(message, 400, 'validation_error', details);
    this.name = 'ValidationError';
  }
}

export class DependencyError extends AppError {
  constructor(message = 'Dependency unavailable', details?: Record<string, unknown>) {
    super(message, 503, 'dependency_error', details);
    this.name = 'DependencyError';
  }
}

export class NotImplementedError extends AppError {
  constructor(message = 'Not implemented', details?: Record<string, unknown>) {
    super(message, 501, 'not_implemented', details);
    this.name = 'NotImplementedError';
  }
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message, code: err.code, details: err.details }),
      { status: err.status, headers: { 'Content-Type': CONTENT_TYPE_JSON } }
    );
  }

  const message = err instanceof Error ? err.message : 'Internal server error';
  return new Response(
    JSON.stringify({ ok: false, error: message, code: 'internal_error' }),
    { status: 500, headers: { 'Content-Type': CONTENT_TYPE_JSON } }
  );
}
