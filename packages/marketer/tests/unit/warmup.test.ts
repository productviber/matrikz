/**
 * Warmup & Throttling Tests
 *
 * Tests for the warmup scheduler, daily throttle counter,
 * domain gap enforcement, and processDueEmails throttling integration.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getWarmupLimit,
  getWarmupState,
  getSentToday,
  incrementSendCounter,
  checkDomainGap,
  recordDomainSend,
  checkThrottle,
  todayDateKey,
  WARMUP_SCHEDULE,
  COMPLIANCE,
  MAX_DAILY_SENDS,
  _test,
} from '../../src/lib/warmup';
import type { KV } from '../../src/lib/warmup';
import { createMockKV } from '../helpers';

// ─── getWarmupLimit() ──────────────────────────────────────────────────────

describe('getWarmupLimit()', () => {
  it('returns 50 for day 1', () => {
    expect(getWarmupLimit(1)).toBe(50);
  });

  it('returns 50 for day 2 (between steps)', () => {
    expect(getWarmupLimit(2)).toBe(50);
  });

  it('returns 75 for day 3', () => {
    expect(getWarmupLimit(3)).toBe(75);
  });

  it('returns 100 for day 7', () => {
    expect(getWarmupLimit(7)).toBe(100);
  });

  it('returns 150 for day 14', () => {
    expect(getWarmupLimit(14)).toBe(150);
  });

  it('returns 200 for day 21', () => {
    expect(getWarmupLimit(21)).toBe(200);
  });

  it('returns 300 for day 30', () => {
    expect(getWarmupLimit(30)).toBe(300);
  });

  it('returns 300 for day 60 (past warmup period)', () => {
    expect(getWarmupLimit(60)).toBe(300);
  });

  it('returns 75 for day 5 (between day 3 and day 7)', () => {
    expect(getWarmupLimit(5)).toBe(75);
  });
});

// ─── getWarmupState() ──────────────────────────────────────────────────────

describe('getWarmupState()', () => {
  let kv: KV & { _store: Map<string, string> };

  beforeEach(() => {
    kv = createMockKV() as unknown as KV & { _store: Map<string, string> };
  });

  it('initialises warmup state on first call', async () => {
    const epoch = 1700000000;
    const state = await getWarmupState(kv, 'test-campaign', epoch);

    expect(state.startedAt).toBe(epoch);
    expect(state.warmupDay).toBe(1);
  });

  it('persists state to KV on first call', async () => {
    const epoch = 1700000000;
    await getWarmupState(kv, 'test-campaign', epoch);

    const stored = kv._store.get('outbound:warmup:test-campaign');
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(parsed.startedAt).toBe(epoch);
  });

  it('reads existing state from KV', async () => {
    kv._store.set('outbound:warmup:test-campaign', JSON.stringify({
      startedAt: 1700000000,
      warmupDay: 1,
    }));

    // 5 days later
    const epoch = 1700000000 + (5 * 86400);
    const state = await getWarmupState(kv, 'test-campaign', epoch);

    expect(state.startedAt).toBe(1700000000);
    expect(state.warmupDay).toBe(6); // 5 full days + 1
  });

  it('recalculates warmup day from startedAt', async () => {
    kv._store.set('outbound:warmup:my-campaign', JSON.stringify({
      startedAt: 1700000000,
      warmupDay: 1, // stale
    }));

    // 15 days later
    const epoch = 1700000000 + (15 * 86400);
    const state = await getWarmupState(kv, 'my-campaign', epoch);

    expect(state.warmupDay).toBe(16);
  });
});

// ─── getSentToday() / incrementSendCounter() ───────────────────────────────

describe('daily send counter', () => {
  let kv: KV & { _store: Map<string, string> };

  beforeEach(() => {
    kv = createMockKV() as unknown as KV & { _store: Map<string, string> };
  });

  it('returns 0 for a fresh day', async () => {
    const count = await getSentToday(kv, '2025-01-28');
    expect(count).toBe(0);
  });

  it('increments counter and returns new value', async () => {
    const c1 = await incrementSendCounter(kv, '2025-01-28');
    expect(c1).toBe(1);

    const c2 = await incrementSendCounter(kv, '2025-01-28');
    expect(c2).toBe(2);
  });

  it('stores counter in KV', async () => {
    await incrementSendCounter(kv, '2025-01-28');
    await incrementSendCounter(kv, '2025-01-28');

    const raw = kv._store.get('outbound:throttle:2025-01-28');
    expect(raw).toBe('2');
  });
});

// ─── checkDomainGap() / recordDomainSend() ─────────────────────────────────

describe('domain gap enforcement', () => {
  let kv: KV & { _store: Map<string, string> };

  beforeEach(() => {
    kv = createMockKV() as unknown as KV & { _store: Map<string, string> };
  });

  it('allows send to a new domain', async () => {
    const ok = await checkDomainGap(kv, 'acme.com', 1700000000);
    expect(ok).toBe(true);
  });

  it('blocks send within MIN_DOMAIN_GAP_HOURS', async () => {
    await recordDomainSend(kv, 'acme.com', 1700000000);

    // 24 hours later (less than 72h gap)
    const ok = await checkDomainGap(kv, 'acme.com', 1700000000 + 86400);
    expect(ok).toBe(false);
  });

  it('allows send after MIN_DOMAIN_GAP_HOURS', async () => {
    await recordDomainSend(kv, 'acme.com', 1700000000);

    // 73 hours later
    const gapSeconds = (COMPLIANCE.MIN_DOMAIN_GAP_HOURS + 1) * 3600;
    const ok = await checkDomainGap(kv, 'acme.com', 1700000000 + gapSeconds);
    expect(ok).toBe(true);
  });

  it('allows send at exactly MIN_DOMAIN_GAP_HOURS', async () => {
    await recordDomainSend(kv, 'acme.com', 1700000000);

    const gapSeconds = COMPLIANCE.MIN_DOMAIN_GAP_HOURS * 3600;
    const ok = await checkDomainGap(kv, 'acme.com', 1700000000 + gapSeconds);
    expect(ok).toBe(true);
  });

  it('tracks different domains independently', async () => {
    await recordDomainSend(kv, 'acme.com', 1700000000);

    // Other domain should be fine
    const ok = await checkDomainGap(kv, 'other.com', 1700000000 + 3600);
    expect(ok).toBe(true);
  });
});

// ─── checkThrottle() ───────────────────────────────────────────────────────

describe('checkThrottle()', () => {
  let kv: KV & { _store: Map<string, string> };

  beforeEach(() => {
    kv = createMockKV() as unknown as KV & { _store: Map<string, string> };
  });

  it('allows sending when under budget (fresh campaign)', async () => {
    const result = await checkThrottle(kv, 'my-campaign', '2025-01-28', 1700000000);

    expect(result.allowed).toBe(true);
    expect(result.dailyLimit).toBe(50); // Day 1
    expect(result.sentToday).toBe(0);
    expect(result.remaining).toBe(50);
  });

  it('blocks sending when daily limit reached', async () => {
    // Pre-fill counter to 50 (day 1 limit)
    kv._store.set('outbound:throttle:2025-01-28', '50');

    const result = await checkThrottle(kv, 'my-campaign', '2025-01-28', 1700000000);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.reason).toContain('Daily limit reached');
  });

  it('calculates remaining budget correctly', async () => {
    // 3 sent today, day 1 limit = 50
    kv._store.set('outbound:throttle:2025-01-28', '3');

    const result = await checkThrottle(kv, 'my-campaign', '2025-01-28', 1700000000);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(47);
    expect(result.sentToday).toBe(3);
  });

  it('uses warmup day limit for older campaigns', async () => {
    // Campaign started 14 days ago
    kv._store.set('outbound:warmup:old-campaign', JSON.stringify({
      startedAt: 1700000000 - (14 * 86400),
      warmupDay: 1,
    }));

    const result = await checkThrottle(kv, 'old-campaign', '2025-01-28', 1700000000);

    expect(result.dailyLimit).toBe(150); // Day 15 → 150 (step 14)
    expect(result.allowed).toBe(true);
  });
});

// ─── todayDateKey() ────────────────────────────────────────────────────────

describe('todayDateKey()', () => {
  it('returns a YYYY-MM-DD format string', () => {
    const key = todayDateKey();
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─── WARMUP_SCHEDULE constant ──────────────────────────────────────────────

describe('WARMUP_SCHEDULE', () => {
  it('has 6 entries', () => {
    expect(WARMUP_SCHEDULE).toHaveLength(6);
  });

  it('is in ascending order by day', () => {
    for (let i = 1; i < WARMUP_SCHEDULE.length; i++) {
      expect(WARMUP_SCHEDULE[i].day).toBeGreaterThan(WARMUP_SCHEDULE[i - 1].day);
    }
  });

  it('has increasing daily limits', () => {
    for (let i = 1; i < WARMUP_SCHEDULE.length; i++) {
      expect(WARMUP_SCHEDULE[i].dailyLimit).toBeGreaterThan(WARMUP_SCHEDULE[i - 1].dailyLimit);
    }
  });

  it('maximum daily limit matches MAX_DAILY_SENDS', () => {
    const maxLimit = WARMUP_SCHEDULE[WARMUP_SCHEDULE.length - 1].dailyLimit;
    expect(maxLimit).toBe(MAX_DAILY_SENDS);
  });
});

// ─── COMPLIANCE constant ───────────────────────────────────────────────────

describe('COMPLIANCE', () => {
  it('has bounce rate at 5%', () => {
    expect(COMPLIANCE.MAX_BOUNCE_RATE).toBe(0.05);
  });

  it('has complaint rate at 0.1%', () => {
    expect(COMPLIANCE.MAX_COMPLAINT_RATE).toBe(0.001);
  });

  it('has 72-hour domain gap', () => {
    expect(COMPLIANCE.MIN_DOMAIN_GAP_HOURS).toBe(72);
  });
});
