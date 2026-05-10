import type { Env } from '../../types';
import { KV_PREFIX, TTL } from '../../constants';

export interface DispatchCorrelationRecord {
  tenantId: string;
  subjectId: string;
  correlationId: string;
  actionType: string;
  campaignId: string;
  stepId: string;
  channel: string;
  contactId: string;
  createdAt: number;
}

export interface DispatchIngressPayload {
  tenantId: string;
  subjectId: string;
  correlationId: string;
  actionType: string;
  campaignId: string;
  stepId: string;
  channel: string;
  contactId: string;
  journeyId?: string | null;
  scheduleAt?: number;
  metadata?: Record<string, unknown>;
}

export interface FeedbackMetricsSnapshot {
  tenantId: string;
  count: number;
  avgLatencyMs: number;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_CHANNELS = new Set(['push', 'sms', 'whatsapp', 'telegram']);

function toTenantScope(tenantId?: string | null): string {
  const value = (tenantId ?? '').trim();
  return value.length > 0 ? value.toLowerCase() : 'all';
}

function parseInteger(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function incrementCounter(env: Env, key: string, ttl: number): Promise<number> {
  const current = parseInteger(await env.KV_MARKETING.get(key));
  const next = current + 1;
  await env.KV_MARKETING.put(key, String(next), { expirationTtl: ttl });
  return next;
}

async function addToCounter(env: Env, key: string, amount: number, ttl: number): Promise<number> {
  const current = parseInteger(await env.KV_MARKETING.get(key));
  const next = current + amount;
  await env.KV_MARKETING.put(key, String(next), { expirationTtl: ttl });
  return next;
}

export function isUuidV4(value: string): boolean {
  return UUID_V4.test(value);
}

export function normalizeOutcomeMetric(eventType: string): 'delivered' | 'opened' | 'clicked' | 'converted' | 'no_response' | 'unsubscribed' {
  const normalized = eventType.trim().toLowerCase();
  if (normalized.includes('convert')) return 'converted';
  if (normalized.includes('unsub')) return 'unsubscribed';
  if (normalized.includes('click')) return 'clicked';
  if (normalized.includes('open') || normalized.includes('reply')) return 'opened';
  if (normalized.includes('deliver') || normalized.includes('accept')) return 'delivered';
  return 'no_response';
}

export function validateDispatchIngressPayload(payload: unknown): { ok: true; value: DispatchIngressPayload } | { ok: false; error: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, error: 'Payload must be a JSON object' };
  }

  const body = payload as Record<string, unknown>;
  const required = ['tenantId', 'subjectId', 'correlationId', 'actionType', 'campaignId', 'stepId', 'channel', 'contactId'] as const;
  for (const key of required) {
    if (typeof body[key] !== 'string' || body[key]!.trim().length === 0) {
      return { ok: false, error: `Invalid ${key}` };
    }
  }

  const channel = String(body.channel).trim().toLowerCase();
  if (!ALLOWED_CHANNELS.has(channel)) {
    return { ok: false, error: 'Invalid channel' };
  }

  const scheduleAt = typeof body.scheduleAt === 'number' && Number.isFinite(body.scheduleAt)
    ? Math.floor(body.scheduleAt)
    : undefined;

  const metadata = typeof body.metadata === 'object' && body.metadata !== null && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : undefined;

  return {
    ok: true,
    value: {
      tenantId: String(body.tenantId).trim(),
      subjectId: String(body.subjectId).trim(),
      correlationId: String(body.correlationId).trim(),
      actionType: String(body.actionType).trim(),
      campaignId: String(body.campaignId).trim(),
      stepId: String(body.stepId).trim(),
      channel,
      contactId: String(body.contactId).trim(),
      journeyId: typeof body.journeyId === 'string' ? body.journeyId : null,
      scheduleAt,
      metadata,
    },
  };
}

export async function saveDispatchCorrelation(env: Env, record: DispatchCorrelationRecord): Promise<void> {
  const key = `${KV_PREFIX.OUTCOME_DISPATCH_MAP}${record.correlationId}`;
  await env.KV_MARKETING.put(key, JSON.stringify(record), { expirationTtl: TTL.DAYS_30 });
}

export async function getDispatchCorrelation(env: Env, correlationId: string): Promise<DispatchCorrelationRecord | null> {
  if (!correlationId) return null;
  const key = `${KV_PREFIX.OUTCOME_DISPATCH_MAP}${correlationId}`;
  return await env.KV_MARKETING.get(key, 'json') as DispatchCorrelationRecord | null;
}

export async function markDispatchAccepted(env: Env, tenantId: string): Promise<void> {
  const scope = toTenantScope(tenantId);
  await Promise.all([
    incrementCounter(env, `${KV_PREFIX.OUTCOME_DISPATCH_ACCEPTED}${scope}`, TTL.DAYS_30),
    incrementCounter(env, `${KV_PREFIX.OUTCOME_DISPATCH_ACCEPTED}all`, TTL.DAYS_30),
  ]);
}

export async function markDispatchRejected(env: Env, tenantId?: string): Promise<void> {
  const scope = toTenantScope(tenantId);
  await Promise.all([
    incrementCounter(env, `${KV_PREFIX.OUTCOME_DISPATCH_REJECTED}${scope}`, TTL.DAYS_30),
    incrementCounter(env, `${KV_PREFIX.OUTCOME_DISPATCH_REJECTED}all`, TTL.DAYS_30),
  ]);
}

export async function markOutcomeFeedbackSuccess(env: Env, tenantId: string, latencyMs: number): Promise<void> {
  const scope = toTenantScope(tenantId);
  await Promise.all([
    incrementCounter(env, `${KV_PREFIX.OUTCOME_FEEDBACK_SENT}${scope}`, TTL.DAYS_30),
    incrementCounter(env, `${KV_PREFIX.OUTCOME_FEEDBACK_SENT}all`, TTL.DAYS_30),
    incrementCounter(env, `${KV_PREFIX.OUTCOME_FEEDBACK_LATENCY_COUNT}${scope}`, TTL.DAYS_30),
    incrementCounter(env, `${KV_PREFIX.OUTCOME_FEEDBACK_LATENCY_COUNT}all`, TTL.DAYS_30),
    addToCounter(env, `${KV_PREFIX.OUTCOME_FEEDBACK_LATENCY_SUM}${scope}`, Math.max(0, Math.floor(latencyMs)), TTL.DAYS_30),
    addToCounter(env, `${KV_PREFIX.OUTCOME_FEEDBACK_LATENCY_SUM}all`, Math.max(0, Math.floor(latencyMs)), TTL.DAYS_30),
  ]);
}

export async function markOutcomeFeedbackFailure(env: Env, tenantId: string): Promise<void> {
  const scope = toTenantScope(tenantId);
  await Promise.all([
    incrementCounter(env, `${KV_PREFIX.OUTCOME_FEEDBACK_FAILED}${scope}`, TTL.DAYS_30),
    incrementCounter(env, `${KV_PREFIX.OUTCOME_FEEDBACK_FAILED}all`, TTL.DAYS_30),
  ]);
}

export async function readDispatchSuccessRate(env: Env, tenantId?: string): Promise<{ tenantId: string; accepted: number; rejected: number; total: number; successRate: number }> {
  const scope = toTenantScope(tenantId);
  const [acceptedRaw, rejectedRaw] = await Promise.all([
    env.KV_MARKETING.get(`${KV_PREFIX.OUTCOME_DISPATCH_ACCEPTED}${scope}`),
    env.KV_MARKETING.get(`${KV_PREFIX.OUTCOME_DISPATCH_REJECTED}${scope}`),
  ]);

  const accepted = parseInteger(acceptedRaw);
  const rejected = parseInteger(rejectedRaw);
  const total = accepted + rejected;
  const successRate = total > 0 ? accepted / total : 0;
  return { tenantId: scope, accepted, rejected, total, successRate };
}

export async function readOutcomeFeedbackFailures(env: Env, tenantId?: string): Promise<{ tenantId: string; failures: number }> {
  const scope = toTenantScope(tenantId);
  const failures = parseInteger(await env.KV_MARKETING.get(`${KV_PREFIX.OUTCOME_FEEDBACK_FAILED}${scope}`));
  return { tenantId: scope, failures };
}

export async function readOutcomeFeedbackLatency(env: Env, tenantId?: string): Promise<FeedbackMetricsSnapshot> {
  const scope = toTenantScope(tenantId);
  const [sumRaw, countRaw] = await Promise.all([
    env.KV_MARKETING.get(`${KV_PREFIX.OUTCOME_FEEDBACK_LATENCY_SUM}${scope}`),
    env.KV_MARKETING.get(`${KV_PREFIX.OUTCOME_FEEDBACK_LATENCY_COUNT}${scope}`),
  ]);
  const sum = parseInteger(sumRaw);
  const count = parseInteger(countRaw);
  return {
    tenantId: scope,
    count,
    avgLatencyMs: count > 0 ? Number((sum / count).toFixed(2)) : 0,
  };
}

export async function markFeedbackIdempotentKeySeen(env: Env, idempotencyFingerprint: string): Promise<boolean> {
  const key = `${KV_PREFIX.OUTCOME_FEEDBACK_IDEMPOTENCY}${idempotencyFingerprint}`;
  const existing = await env.KV_MARKETING.get(key);
  if (existing) {
    return false;
  }
  await env.KV_MARKETING.put(key, '1', { expirationTtl: TTL.DAYS_30 });
  return true;
}
