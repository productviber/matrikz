import { SKRIP_CONFIG } from '../../constants';

const textEncoder = new TextEncoder();

export function normalizeTenantId(tenantId?: string | null): string {
  const normalized = tenantId?.trim();
  return normalized && normalized.length > 0 ? normalized : SKRIP_CONFIG.DEFAULT_TENANT_ID;
}

export function normalizeSubjectId(subjectId: string): string {
  return subjectId.trim().toLowerCase();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashObject(value: unknown, length = 24): Promise<string> {
  const hash = await sha256Hex(stableStringify(value));
  return hash.slice(0, length);
}

export function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function isoToEpochSeconds(timestamp: string | number | null | undefined): number {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return Math.floor(timestamp);
  }
  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return Math.floor(Date.now() / 1000);
}