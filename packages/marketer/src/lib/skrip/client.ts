import type { Env } from '../../types';
import { KV_PREFIX, SKRIP_CONFIG, TTL } from '../../constants';
import { getCorrelationId } from '../correlation';
import { computeSkripSignature } from './signing';

interface SkripRequestOptions {
  tenantId: string;
  path: string;
  method: 'GET' | 'POST';
  body?: unknown;
}

function getSkripServiceToken(env: Env): string | null {
  return env.SKRIP_SERVICE_TOKEN ?? env.SYSTEM_TOKEN ?? null;
}

function getSkripSigningSecret(env: Env): string | null {
  return env.SKRIP_SIGNING_SECRET ?? env.WEBHOOK_SIGNING_SECRET ?? null;
}

function getConfiguredTimeout(env: Env): number {
  const parsed = Number.parseInt(env.SKRIP_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SKRIP_CONFIG.DEFAULT_TIMEOUT_MS;
}

async function readCircuitOpenUntil(env: Env): Promise<number> {
  const raw = await env.KV_MARKETING.get(`${KV_PREFIX.SKRIP_CIRCUIT}default`);
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

async function recordFailure(env: Env): Promise<void> {
  const key = `${KV_PREFIX.SKRIP_FAILURE}default`;
  const current = Number.parseInt((await env.KV_MARKETING.get(key)) ?? '0', 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  await env.KV_MARKETING.put(key, String(next), { expirationTtl: TTL.DAYS_1 });
  if (next >= SKRIP_CONFIG.CIRCUIT_FAILURE_THRESHOLD) {
    const openUntil = Date.now() + SKRIP_CONFIG.CIRCUIT_OPEN_TTL_SECS * 1000;
    await env.KV_MARKETING.put(
      `${KV_PREFIX.SKRIP_CIRCUIT}default`,
      String(openUntil),
      { expirationTtl: SKRIP_CONFIG.CIRCUIT_OPEN_TTL_SECS },
    );
  }
}

async function clearFailures(env: Env): Promise<void> {
  await env.KV_MARKETING.delete(`${KV_PREFIX.SKRIP_FAILURE}default`);
  await env.KV_MARKETING.delete(`${KV_PREFIX.SKRIP_CIRCUIT}default`);
}

async function performRequest<T>(env: Env, options: SkripRequestOptions): Promise<T> {
  const serviceToken = getSkripServiceToken(env);
  const signingSecret = getSkripSigningSecret(env);
  if (!env.SKRIP_BASE_URL || !serviceToken || !signingSecret) {
    throw new Error('Skrip client is not fully configured');
  }

  const openUntil = await readCircuitOpenUntil(env);
  if (openUntil > Date.now()) {
    throw new Error('Skrip circuit breaker is open');
  }

  const rawBody = options.body ? JSON.stringify(options.body) : '';
  const path = options.path.startsWith('/') ? options.path : `/${options.path}`;
  const timestamp = new Date().toISOString();
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const signature = await computeSkripSignature({
    method: options.method,
    path,
    timestamp,
    nonce,
    rawBody,
    secret: signingSecret,
  });

  const timeoutMs = getConfiguredTimeout(env);
  const url = new URL(path, env.SKRIP_BASE_URL).toString();

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= SKRIP_CONFIG.MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${serviceToken}`,
          'Content-Type': 'application/json',
          [SKRIP_CONFIG.HEADER_TIMESTAMP]: timestamp,
          [SKRIP_CONFIG.HEADER_NONCE]: nonce,
          [SKRIP_CONFIG.HEADER_SIGNATURE]: signature,
          [SKRIP_CONFIG.HEADER_CORRELATION_ID]: getCorrelationId(),
          [SKRIP_CONFIG.HEADER_TENANT_ID]: options.tenantId,
        },
        body: rawBody || undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`Skrip API ${response.status}: ${await response.text()}`);
      }

      await clearFailures(env);
      return await response.json() as T;
    } catch (error) {
      clearTimeout(timer);
      lastError = error instanceof Error ? error : new Error(String(error));
      await recordFailure(env);
      if (attempt === SKRIP_CONFIG.MAX_RETRIES) break;
    }
  }

  throw lastError ?? new Error('Unknown Skrip client error');
}

export function createSkripClient(env: Env) {
  const serviceToken = getSkripServiceToken(env);
  const signingSecret = getSkripSigningSecret(env);
  return {
    configured: Boolean(env.SKRIP_BASE_URL && serviceToken && signingSecret),
    registerContact: <T>(tenantId: string, payload: unknown) =>
      performRequest<T>(env, { tenantId, path: '/v1/contacts/upsert', method: 'POST', body: payload }),
    sendMessage: <T>(tenantId: string, payload: unknown) =>
      performRequest<T>(env, { tenantId, path: '/v1/messages/send', method: 'POST', body: payload }),
    sendBulk: <T>(tenantId: string, payload: unknown) =>
      performRequest<T>(env, { tenantId, path: '/v1/messages/bulk', method: 'POST', body: payload }),
    getMessageStatus: <T>(tenantId: string, messageId: string) =>
      performRequest<T>(env, { tenantId, path: `/v1/messages/${encodeURIComponent(messageId)}`, method: 'GET' }),
  };
}
