/**
 * Warmup Scheduler — Controls cold-email send volume ramp-up.
 *
 * New sending domains/campaigns start with low daily limits and
 * gradually increase to build sender reputation. This module:
 *
 *   1) Tracks campaign age via KV (outbound:warmup:{campaign})
 *   2) Returns the daily send budget based on warmup schedule
 *   3) Tracks hourly send counts via KV (outbound:throttle:{hour})
 *   4) Enforces per-domain gap (MIN_DOMAIN_GAP_HOURS)
 *
 * KV Keys (from architecture §5.4):
 *   outbound:warmup:{campaign}   — JSON: { startedAt, warmupDay }   (90d TTL)
 *   outbound:throttle:{YYYY-MM-DD}  — daily send counter            (48h TTL)
 *   outbound:domain-gap:{domain} — last send timestamp              (7d TTL)
 *
 * @module lib/warmup
 */

import type { Env } from '../types';
import { KV_PREFIX, TTL } from '../constants';

/**
 * A minimal KV interface that's compatible with both @cloudflare/workers-types
 * and miniflare's KVNamespace. Avoids type-level conflicts between
 * different versions of the KV type.
 */
export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

// ─── Warmup Schedule ────────────────────────────────────────────────────────

/** A single step in a warmup schedule. */
export interface WarmupStep {
  readonly day: number;
  readonly dailyLimit: number;
}

/**
 * Default (conservative) warmup ramp — 30-day sender reputation build.
 * Used as fallback when a campaign has no custom warmup_schedule.
 */
export const WARMUP_SCHEDULE_DEFAULT = Object.freeze([
  { day:  1, dailyLimit:  50 },
  { day:  3, dailyLimit:  75 },
  { day:  7, dailyLimit: 100 },
  { day: 14, dailyLimit: 150 },
  { day: 21, dailyLimit: 200 },
  { day: 30, dailyLimit: 300 },
]) as ReadonlyArray<WarmupStep>;

/**
 * Named warmup presets — use these when creating campaigns via the API.
 *
 * Usage:  POST /api/admin/campaigns/outbound
 *   body: { ..., "warmup_profile": "aggressive-7day" }
 *
 * Or pass a custom schedule array:
 *   body: { ..., "warmup_schedule": [{ "day": 1, "dailyLimit": 25 }, ...] }
 */
export const WARMUP_PRESETS: Record<string, ReadonlyArray<WarmupStep>> = {
  /** Conservative 30-day ramp (default). */
  'conservative-30day': WARMUP_SCHEDULE_DEFAULT,

  /** Aggressive 7-day test ramp (e.g. clodo.dev domain test). */
  'aggressive-7day': Object.freeze([
    { day: 1, dailyLimit:  50 },
    { day: 3, dailyLimit: 100 },
    { day: 7, dailyLimit: 200 },
  ]),

  /** Flat rate — same volume every day (for established domains). */
  'flat-300': Object.freeze([
    { day: 1, dailyLimit: 300 },
  ]),
};

/**
 * Backward-compatible alias. Old code referencing WARMUP_SCHEDULE still works.
 * @deprecated Use WARMUP_SCHEDULE_DEFAULT or per-campaign schedule from DB.
 */
export const WARMUP_SCHEDULE = WARMUP_SCHEDULE_DEFAULT;

/** Post-warmup steady-state max per day. */
export const MAX_DAILY_SENDS = 300;

// ─── Compliance thresholds (mirrored from analytics) ────────────────────────

export const COMPLIANCE = Object.freeze({
  MAX_BOUNCE_RATE:       0.05,    // 5%
  MAX_COMPLAINT_RATE:    0.001,   // 0.1%
  MIN_DOMAIN_GAP_HOURS:  72,     // 3 days between sends to same domain
});

// ─── KV Key Builders ────────────────────────────────────────────────────────

const OUTBOUND_KV = {
  warmup:     (slug: string) => `outbound:warmup:${slug}`,
  throttle:   (dateKey: string) => `outbound:throttle:${dateKey}`,
  domainGap:  (domain: string) => `outbound:domain-gap:${domain}`,
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WarmupState {
  /** Unix epoch (seconds) when campaign first started sending. */
  startedAt: number;
  /** Cached warmup day (days since startedAt). */
  warmupDay: number;
}

export interface ThrottleResult {
  /** Whether sending is allowed right now. */
  allowed: boolean;
  /** Number of sends remaining in today's budget. */
  remaining: number;
  /** Today's total limit. */
  dailyLimit: number;
  /** Number already sent today. */
  sentToday: number;
  /** Reason if not allowed. */
  reason?: string;
}

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Get the daily send limit for a given warmup day.
 * Accepts an optional schedule — defaults to WARMUP_SCHEDULE_DEFAULT.
 */
export function getWarmupLimit(
  currentDay: number,
  schedule: ReadonlyArray<WarmupStep> = WARMUP_SCHEDULE_DEFAULT
): number {
  let limit = schedule[0].dailyLimit;
  for (const step of schedule) {
    if (currentDay >= step.day) {
      limit = step.dailyLimit;
    } else {
      break;
    }
  }
  return limit;
}

/**
 * Get or initialise warmup state for a campaign from KV.
 * If no state exists, initialises with startedAt = now.
 */
export async function getWarmupState(
  kv: KV,
  campaignSlug: string,
  currentEpoch: number
): Promise<WarmupState> {
  const key = OUTBOUND_KV.warmup(campaignSlug);
  const raw = await kv.get(key);

  if (raw) {
    const state: WarmupState = JSON.parse(raw);
    // Recalculate warmup day from current time
    state.warmupDay = Math.max(1, Math.floor((currentEpoch - state.startedAt) / 86_400) + 1);
    return state;
  }

  // First-time init
  const state: WarmupState = {
    startedAt: currentEpoch,
    warmupDay: 1,
  };
  await kv.put(key, JSON.stringify(state), { expirationTtl: TTL.DAYS_90 });
  return state;
}

/**
 * Get the number of cold emails sent today.
 */
export async function getSentToday(
  kv: KV,
  dateKey: string
): Promise<number> {
  const raw = await kv.get(OUTBOUND_KV.throttle(dateKey));
  return raw ? parseInt(raw, 10) : 0;
}

/**
 * Increment the daily send counter. Called after each successful cold email.
 */
export async function incrementSendCounter(
  kv: KV,
  dateKey: string
): Promise<number> {
  const key = OUTBOUND_KV.throttle(dateKey);
  const current = await getSentToday(kv, dateKey);
  const next = current + 1;
  // 48h TTL so yesterday's counter is still visible for reporting
  await kv.put(key, String(next), { expirationTtl: 172_800 });
  return next;
}

/**
 * Check whether we can send to a given domain (respects MIN_DOMAIN_GAP_HOURS).
 * Returns true if sending is allowed.
 */
export async function checkDomainGap(
  kv: KV,
  domain: string,
  currentEpoch: number
): Promise<boolean> {
  const key = OUTBOUND_KV.domainGap(domain);
  const raw = await kv.get(key);

  if (!raw) return true; // Never sent to this domain before

  const lastSentAt = parseInt(raw, 10);
  const gapSeconds = COMPLIANCE.MIN_DOMAIN_GAP_HOURS * 3600;
  return (currentEpoch - lastSentAt) >= gapSeconds;
}

/**
 * Record a send to a domain (updates the domain gap tracker).
 */
export async function recordDomainSend(
  kv: KV,
  domain: string,
  currentEpoch: number
): Promise<void> {
  const key = OUTBOUND_KV.domainGap(domain);
  // 7-day TTL (gap is 72h, so 7d gives enough runway)
  await kv.put(key, String(currentEpoch), { expirationTtl: TTL.DAYS_7 });
}

/**
 * Full throttle check: combines warmup limit, daily counter, and returns
 * whether a cold email can be sent right now.
 *
 * @param kv        KV namespace
 * @param slug      Campaign slug (for warmup state)
 * @param dateKey   Today's date key (YYYY-MM-DD)
 * @param epoch     Current unix epoch seconds
 * @param schedule  Optional warmup schedule (default: WARMUP_SCHEDULE_DEFAULT)
 */
export async function checkThrottle(
  kv: KV,
  slug: string,
  dateKey: string,
  epoch: number,
  schedule?: ReadonlyArray<WarmupStep>
): Promise<ThrottleResult> {
  const warmup = await getWarmupState(kv, slug, epoch);
  const dailyLimit = getWarmupLimit(warmup.warmupDay, schedule ?? WARMUP_SCHEDULE_DEFAULT);
  const sentToday = await getSentToday(kv, dateKey);
  const remaining = Math.max(0, dailyLimit - sentToday);

  if (remaining <= 0) {
    return {
      allowed: false,
      remaining: 0,
      dailyLimit,
      sentToday,
      reason: `Daily limit reached (${dailyLimit}/day, warmup day ${warmup.warmupDay})`,
    };
  }

  return {
    allowed: true,
    remaining,
    dailyLimit,
    sentToday,
  };
}

/**
 * Get today's date key for throttle counters (YYYY-MM-DD in UTC).
 */
export function todayDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Campaign Schedule Helpers ──────────────────────────────────────────────

/**
 * Parse a warmup schedule from its DB representation (JSON string or null).
 * Returns the parsed schedule, or the default if null/invalid.
 */
export function parseCampaignSchedule(
  raw: string | null | undefined
): ReadonlyArray<WarmupStep> {
  if (!raw) return WARMUP_SCHEDULE_DEFAULT;

  try {
    const parsed = JSON.parse(raw);
    if (isValidSchedule(parsed)) return parsed;
  } catch { /* fall through */ }

  return WARMUP_SCHEDULE_DEFAULT;
}

/**
 * Resolve a warmup profile name to its schedule array.
 * Accepts either a preset name (e.g. "aggressive-7day") or null for default.
 */
export function resolveWarmupProfile(
  profileName: string | null | undefined
): ReadonlyArray<WarmupStep> {
  if (!profileName) return WARMUP_SCHEDULE_DEFAULT;
  return WARMUP_PRESETS[profileName] ?? WARMUP_SCHEDULE_DEFAULT;
}

/**
 * Validate a warmup schedule array.
 * Rules: non-empty array, ascending days, positive dailyLimits.
 */
export function isValidSchedule(
  schedule: unknown
): schedule is WarmupStep[] {
  if (!Array.isArray(schedule) || schedule.length === 0) return false;

  for (let i = 0; i < schedule.length; i++) {
    const step = schedule[i];
    if (typeof step?.day !== 'number' || typeof step?.dailyLimit !== 'number') return false;
    if (step.day < 1 || step.dailyLimit < 1) return false;
    if (i > 0 && step.day <= schedule[i - 1].day) return false;
  }

  return true;
}

// ─── Exports for testing ────────────────────────────────────────────────────

export const _test = {
  OUTBOUND_KV,
};
