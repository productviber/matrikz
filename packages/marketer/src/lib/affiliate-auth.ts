import type { Env } from '../types';
import { KV_PREFIX, TTL } from '../constants';
import { timingSafeEqual } from './security.ts';

interface VerifyAffiliateOptions {
  allowAnalyticsFallback?: boolean;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? normalize(value) : null;
}

function extractOwnerEmail(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;

  const direct =
    pickString(record.owner_email) ??
    pickString(record.ownerEmail) ??
    pickString(record.email);
  if (direct) return direct;

  const nestedData = record.data;
  if (nestedData && typeof nestedData === 'object') {
    const fromData = extractOwnerEmail(nestedData);
    if (fromData) return fromData;
  }

  const affiliate = record.affiliate;
  if (affiliate && typeof affiliate === 'object') {
    const fromAffiliate = extractOwnerEmail(affiliate);
    if (fromAffiliate) return fromAffiliate;
  }

  return null;
}

export async function verifyAffiliateCredentials(
  env: Env,
  code: string,
  email: string,
  options: VerifyAffiliateOptions = {}
): Promise<boolean> {
  const normalizedCode = code.trim();
  const normalizedEmail = normalize(email);
  const allowAnalyticsFallback = options.allowAnalyticsFallback ?? true;

  if (!normalizedCode || !normalizedEmail) return false;

  const kvKey = `${KV_PREFIX.AFFILIATE_EMAIL}${normalizedCode}`;
  const cachedEmail = await env.KV_MARKETING.get(kvKey);
  if (cachedEmail && timingSafeEqual(normalize(cachedEmail), normalizedEmail)) {
    return true;
  }

  if (!allowAnalyticsFallback) return false;

  try {
    const { getAffiliateByCode } = await import('./analytics-client');
    const response = await getAffiliateByCode(env, normalizedCode);
    const ownerEmail = extractOwnerEmail(response);
    if (!ownerEmail || !timingSafeEqual(ownerEmail, normalizedEmail)) {
      return false;
    }

    await env.KV_MARKETING.put(kvKey, normalizedEmail, {
      expirationTtl: TTL.DAYS_30,
    });
    return true;
  } catch {
    return false;
  }
}
