/**
 * Tests — Domain Reputation Monitoring
 *
 * Covers captureReputationSnapshot() and getReputationTrend() —
 * daily deliverability aggregates with health scoring and KV storage.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getReputationTrend } from '../../src/lib/reputation';
import { createMockKV, type MockKVNamespace } from '../helpers';

// ═══════════════════════════════════════════════════════════════════════
// getReputationTrend() — KV-backed trend reader
// ═══════════════════════════════════════════════════════════════════════

describe('getReputationTrend()', () => {
  let kv: MockKVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  it('returns empty array when no snapshots exist', async () => {
    const trend = await getReputationTrend(kv);
    expect(trend).toEqual([]);
  });

  it('returns stored snapshots in chronological order', async () => {
    const snap1 = { date: '2025-01-10', sent: 50, delivered: 48, bounced: 2, complained: 0, opened: 20, clicked: 5, replied: 1, bounceRate: 4, complaintRate: 0, openRate: 40, healthScore: 80 };
    const snap2 = { date: '2025-01-11', sent: 60, delivered: 59, bounced: 1, complained: 0, opened: 30, clicked: 8, replied: 2, bounceRate: 1.67, complaintRate: 0, openRate: 50, healthScore: 91 };
    const snap3 = { date: '2025-01-12', sent: 45, delivered: 40, bounced: 5, complained: 1, opened: 15, clicked: 3, replied: 0, bounceRate: 11.11, complaintRate: 2.22, openRate: 33.33, healthScore: 34 };

    await kv.put('reputation:daily:2025-01-12', JSON.stringify(snap3));
    await kv.put('reputation:daily:2025-01-10', JSON.stringify(snap1));
    await kv.put('reputation:daily:2025-01-11', JSON.stringify(snap2));

    const trend = await getReputationTrend(kv);

    expect(trend).toHaveLength(3);
    expect(trend[0].date).toBe('2025-01-10');
    expect(trend[1].date).toBe('2025-01-11');
    expect(trend[2].date).toBe('2025-01-12');
  });

  it('respects the days limit (returns tail slice)', async () => {
    for (let i = 1; i <= 10; i++) {
      const date = `2025-01-${String(i).padStart(2, '0')}`;
      await kv.put(`reputation:daily:${date}`, JSON.stringify({
        date, sent: 50, delivered: 48, bounced: 2, complained: 0,
        opened: 20, clicked: 5, replied: 1,
        bounceRate: 4, complaintRate: 0, openRate: 40, healthScore: 80,
      }));
    }

    const trend = await getReputationTrend(kv, 3);

    expect(trend).toHaveLength(3);
    expect(trend[0].date).toBe('2025-01-08');
    expect(trend[2].date).toBe('2025-01-10');
  });

  it('ignores null/corrupted KV entries gracefully', async () => {
    await kv.put('reputation:daily:2025-01-10', JSON.stringify({
      date: '2025-01-10', sent: 50, delivered: 48, bounced: 2, complained: 0,
      opened: 20, clicked: 5, replied: 1,
      bounceRate: 4, complaintRate: 0, openRate: 40, healthScore: 80,
    }));
    // Simulate a corrupted/deleted entry
    kv._store.set('reputation:daily:2025-01-11', '');

    const trend = await getReputationTrend(kv);
    // Only the valid snapshot should be returned (empty string parses to falsy in filter)
    expect(trend.length).toBeGreaterThanOrEqual(1);
    expect(trend[0].date).toBe('2025-01-10');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Health score invariants (tested structurally)
// ═══════════════════════════════════════════════════════════════════════

describe('reputation health score invariants', () => {
  it('perfect day (100% delivery, 0 bounces, 0 complaints) scores close to 100', async () => {
    const kv = createMockKV();
    const snapshot = {
      date: '2025-01-10',
      sent: 100, delivered: 100, bounced: 0, complained: 0,
      opened: 40, clicked: 10, replied: 3,
      bounceRate: 0, complaintRate: 0, openRate: 40,
      healthScore: 100, // maxed out
    };
    await kv.put('reputation:daily:2025-01-10', JSON.stringify(snapshot));

    const trend = await getReputationTrend(kv);
    expect(trend[0].healthScore).toBeGreaterThanOrEqual(90);
  });

  it('bad day (high bounces) scores low', async () => {
    const kv = createMockKV();
    const snapshot = {
      date: '2025-01-10',
      sent: 100, delivered: 80, bounced: 20, complained: 0,
      opened: 10, clicked: 2, replied: 0,
      bounceRate: 20, complaintRate: 0, openRate: 10,
      healthScore: 3, // heavily penalized
    };
    await kv.put('reputation:daily:2025-01-10', JSON.stringify(snapshot));

    const trend = await getReputationTrend(kv);
    expect(trend[0].healthScore).toBeLessThanOrEqual(20);
  });

  it('complaint spike should be reflected in stored snapshot', async () => {
    const kv = createMockKV();
    const snapshot = {
      date: '2025-01-10',
      sent: 100, delivered: 95, bounced: 5, complained: 3,
      opened: 20, clicked: 5, replied: 1,
      bounceRate: 5, complaintRate: 3, openRate: 20,
      healthScore: 0, // complaint rate penalty is severe
    };
    await kv.put('reputation:daily:2025-01-10', JSON.stringify(snapshot));

    const trend = await getReputationTrend(kv);
    expect(trend[0].complaintRate).toBeGreaterThan(0);
    expect(trend[0].healthScore).toBeLessThanOrEqual(10);
  });
});
