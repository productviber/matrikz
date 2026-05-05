import type { Env, GrowthSkripStrategicRequest } from '../../types';
import { KV_PREFIX } from '../../constants';
import { getCorrelationId } from '../correlation';
import { now } from '../db';
import { computeSkripSignature } from '../skrip/signing';
import { stableJsonStringify } from './shared';

export interface AllowedHoursWindow {
  startHour: number;
  endHour: number;
  timezone: string;
}

export interface StrategicSignatureEnvelope {
  timestamp: string;
  nonce: string;
  signature: string;
}

export function validateAllowedHours(value: unknown): { value: AllowedHoursWindow | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (typeof value !== 'object' || value === null) {
    return { value: null, errors: { allowedHours: 'Allowed hours are required.' } };
  }

  const record = value as Record<string, unknown>;
  const startHour = Number(record.startHour);
  const endHour = Number(record.endHour);
  const timezone = typeof record.timezone === 'string' ? record.timezone.trim() : '';

  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
    errors.startHour = 'Start hour must be an integer between 0 and 23.';
  }
  if (!Number.isInteger(endHour) || endHour < 0 || endHour > 23) {
    errors.endHour = 'End hour must be an integer between 0 and 23.';
  }
  if (!errors.startHour && !errors.endHour && startHour === endHour) {
    errors.endHour = 'End hour must differ from start hour.';
  }
  if (!timezone) {
    errors.timezone = 'Timezone is required.';
  }

  if (Object.keys(errors).length > 0) {
    return { value: null, errors };
  }

  return {
    value: { startHour, endHour, timezone },
    errors: {},
  };
}

export async function buildStrategicSignatureEnvelope(input: {
  method: 'POST';
  path: string;
  rawBody: string;
  secret: string;
  nonce: string;
}): Promise<StrategicSignatureEnvelope> {
  const timestamp = new Date().toISOString();
  const signature = await computeSkripSignature({
    method: input.method,
    path: input.path,
    timestamp,
    nonce: input.nonce,
    rawBody: input.rawBody,
    secret: input.secret,
  });

  return {
    timestamp,
    nonce: input.nonce,
    signature,
  };
}

export async function ensureStrategyNonceUnused(env: Env, nonce: string): Promise<boolean> {
  const key = `${KV_PREFIX.AUTH_NONCE}strategy:${nonce}`;
  const existing = await env.KV_MARKETING.get(key);
  if (existing) return false;
  await env.KV_MARKETING.put(key, String(now()), { expirationTtl: 15 * 60 });
  return true;
}

export async function sendStrategicRequestToSkrip<T>(env: Env, input: {
  tenantId: string;
  requestBody: GrowthSkripStrategicRequest;
  nonce: string;
}): Promise<{ response: T; signature: StrategicSignatureEnvelope }> {
  const serviceToken = env.SKRIP_SERVICE_TOKEN ?? env.SYSTEM_TOKEN ?? null;
  const signingSecret = env.SKRIP_SIGNING_SECRET ?? null;
  const rawBody = stableJsonStringify(input.requestBody);
  const path = '/internal/strategy/send';

  if (!(env.SKRIP_SERVICE || env.SKRIP_BASE_URL) || !serviceToken || !signingSecret) {
    throw new Error('Strategic send is not fully configured');
  }

  const signature = await buildStrategicSignatureEnvelope({
    method: 'POST',
    path,
    rawBody,
    secret: signingSecret,
    nonce: input.nonce,
  });

  const headers: Record<string, string> = {
    Authorization: `Bearer ${serviceToken}`,
    'Content-Type': 'application/json',
    'x-vm-tenant-id': input.tenantId,
    'x-skrip-correlation-id': getCorrelationId(),
    'x-strategy-timestamp': signature.timestamp,
    'x-strategy-nonce': signature.nonce,
    'x-strategy-signature': signature.signature,
  };

  const requestInit: RequestInit = {
    method: 'POST',
    headers,
    body: rawBody,
  };

  const response = env.SKRIP_SERVICE
    ? await env.SKRIP_SERVICE.fetch(`https://skrip.internal${path}`, requestInit as any)
    : await fetch(new URL(path, env.SKRIP_BASE_URL!).toString(), requestInit);

  if (!response.ok) {
    throw new Error(`Strategic send failed [${response.status}]: ${await response.text()}`);
  }

  return {
    response: await response.json() as T,
    signature,
  };
}
