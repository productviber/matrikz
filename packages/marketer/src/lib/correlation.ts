/**
 * Structured logging with correlation IDs.
 *
 * Creates a scoped logger that prefixes all log lines with a correlation ID.
 * The ID flows across service bindings via the `x-correlation-id` header,
 * enabling end-to-end tracing of prospect: discovery → enrichment → email.
 */

let _currentCorrelationId: string | null = null;

/** Generate a short unique correlation ID (12 chars). */
function generateCorrelationId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}

/** Set the current correlation ID for this request/cron cycle. */
export function setCorrelationId(id?: string): string {
  _currentCorrelationId = id || generateCorrelationId();
  return _currentCorrelationId;
}

/** Get the current correlation ID (or generate one if not set). */
export function getCorrelationId(): string {
  if (!_currentCorrelationId) {
    _currentCorrelationId = generateCorrelationId();
  }
  return _currentCorrelationId;
}

/** Clear the correlation ID (call at end of request). */
export function clearCorrelationId(): void {
  _currentCorrelationId = null;
}

/**
 * Extract or create a correlation ID from an incoming request.
 * Checks `x-correlation-id` header (from service binding calls),
 * then falls back to generating a new one.
 */
export function correlationIdFromRequest(request: Request): string {
  const existing = request.headers.get('x-correlation-id');
  return setCorrelationId(existing || undefined);
}

/**
 * Create headers object that includes the correlation ID for cross-service calls.
 */
export function correlationHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
  return {
    'x-correlation-id': getCorrelationId(),
    ...extraHeaders,
  };
}

/**
 * Structured log helper — creates consistently formatted log entries.
 * Format: `[<module>] <cid:abc123> <message>`
 */
export function structuredLog(
  module: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  const cid = getCorrelationId();
  const payload = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${module}] cid:${cid} ${message}${payload}`);
}

export function structuredWarn(
  module: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  const cid = getCorrelationId();
  const payload = data ? ` ${JSON.stringify(data)}` : '';
  console.warn(`[${module}] cid:${cid} ${message}${payload}`);
}

export function structuredError(
  module: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  const cid = getCorrelationId();
  const payload = data ? ` ${JSON.stringify(data)}` : '';
  console.error(`[${module}] cid:${cid} ${message}${payload}`);
}
