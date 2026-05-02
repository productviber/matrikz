/**
 * Tests — A/B Variant Selection & Engagement Recording
 *
 * Covers pickWeightedIndex(), recordVariantEngagement(), and loadVariantWeights().
 * Ensures weighted selection converges to higher-performing variants over time,
 * and that engagement feedback is correctly stored and accumulated.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { pickWeightedIndex, recordVariantEngagement, loadVariantWeights } from '../../src/lib/email/ab';
import { createMockKV, type MockKVNamespace } from '../helpers';

// ═══════════════════════════════════════════════════════════════════════
// pickWeightedIndex()
// ═══════════════════════════════════════════════════════════════════════

describe('pickWeightedIndex()', () => {
  it('returns a valid index within pool size', () => {
    for (let i = 0; i < 100; i++) {
      const idx = pickWeightedIndex(3);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(3);
    }
  });

  it('returns 0 for pool size of 1', () => {
    expect(pickWeightedIndex(1)).toBe(0);
    expect(pickWeightedIndex(1, [100])).toBe(0);
  });

  it('uses uniform distribution when weights are null', () => {
    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i++) {
      counts[pickWeightedIndex(3, null)]++;
    }
    // Each bucket should get roughly 1000 (±300 for statistical noise)
    for (const count of counts) {
      expect(count).toBeGreaterThan(500);
      expect(count).toBeLessThan(1500);
    }
  });

  it('uses uniform distribution when weights length mismatches pool size', () => {
    const counts = [0, 0];
    for (let i = 0; i < 2000; i++) {
      counts[pickWeightedIndex(2, [1, 2, 3])]++; // weights length 3 != pool 2
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(500);
    }
  });

  it('heavily favors the highest-weighted variant', () => {
    const counts = [0, 0, 0];
    // Variant 1 has weight 100, others have weight 1
    const weights = [1, 100, 1];
    for (let i = 0; i < 1000; i++) {
      counts[pickWeightedIndex(3, weights)]++;
    }
    // Variant 1 should dominate (>80% of picks)
    expect(counts[1]).toBeGreaterThan(800);
    // Variant 0 and 2 should be rare
    expect(counts[0]).toBeLessThan(50);
    expect(counts[2]).toBeLessThan(50);
  });

  it('treats weight 0 as disabled (P2b prune semantics)', () => {
    const counts = [0, 0];
    // weight 0 means disabled — variant should never be picked.
    const weights = [0, 100];
    for (let i = 0; i < 1000; i++) {
      counts[pickWeightedIndex(2, weights)]++;
    }
    expect(counts[0]).toBe(0);
    expect(counts[1]).toBe(1000);
  });

  it('falls back to uniform when all weights are 0', () => {
    const counts = [0, 0, 0];
    const weights = [0, 0, 0];
    for (let i = 0; i < 3000; i++) {
      counts[pickWeightedIndex(3, weights)]++;
    }
    // Uniform: each should get ~1000.
    expect(counts[0]).toBeGreaterThan(800);
    expect(counts[1]).toBeGreaterThan(800);
    expect(counts[2]).toBeGreaterThan(800);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// recordVariantEngagement()
// ═══════════════════════════════════════════════════════════════════════

describe('recordVariantEngagement()', () => {
  let kv: MockKVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  it('creates initial tracking data for a new template', async () => {
    await recordVariantEngagement(kv, 'cold-step1', 'subject', 0, 'send');

    const raw = await kv.get('ab:variants:cold-step1');
    expect(raw).not.toBeNull();
    const data = JSON.parse(raw!);
    expect(data['subject:cold-step1']).toBeDefined();
  });

  it('bumps by 0 for send events (baseline tracking)', async () => {
    await recordVariantEngagement(kv, 'cold-step1', 'subject', 0, 'send');

    const data = JSON.parse(await kv.get('ab:variants:cold-step1') ?? '{}');
    // Initial weight is 1, send adds 0
    expect(data['subject:cold-step1'][0]).toBe(1);
  });

  it('bumps by 2 for open events', async () => {
    await recordVariantEngagement(kv, 'cold-step1', 'subject', 0, 'send');
    await recordVariantEngagement(kv, 'cold-step1', 'subject', 0, 'open');

    const data = JSON.parse(await kv.get('ab:variants:cold-step1') ?? '{}');
    expect(data['subject:cold-step1'][0]).toBe(3); // 1 (initial) + 0 (send) + 2 (open)
  });

  it('bumps by 5 for click events', async () => {
    await recordVariantEngagement(kv, 'cold-step1', 'body', 0, 'send');
    await recordVariantEngagement(kv, 'cold-step1', 'body', 0, 'click');

    const data = JSON.parse(await kv.get('ab:variants:cold-step1') ?? '{}');
    expect(data['body:cold-step1'][0]).toBe(6); // 1 + 0 + 5
  });

  it('bumps by 10 for reply events (highest weight)', async () => {
    await recordVariantEngagement(kv, 'cold-step1', 'subject', 0, 'send');
    await recordVariantEngagement(kv, 'cold-step1', 'subject', 0, 'reply');

    const data = JSON.parse(await kv.get('ab:variants:cold-step1') ?? '{}');
    expect(data['subject:cold-step1'][0]).toBe(11); // 1 + 0 + 10
  });

  it('tracks multiple variants independently', async () => {
    await recordVariantEngagement(kv, 'cold-step1', 'subject', 0, 'open');
    await recordVariantEngagement(kv, 'cold-step1', 'subject', 1, 'reply');

    const data = JSON.parse(await kv.get('ab:variants:cold-step1') ?? '{}');
    expect(data['subject:cold-step1'][0]).toBe(3);  // 1 + 2
    expect(data['subject:cold-step1'][1]).toBe(11); // 1 + 10
  });

  it('expands array for out-of-order variant indices', async () => {
    await recordVariantEngagement(kv, 'cold-step1', 'subject', 3, 'open');

    const data = JSON.parse(await kv.get('ab:variants:cold-step1') ?? '{}');
    // Should have slots 0-3, with 0-2 initialized to 1
    expect(data['subject:cold-step1'].length).toBe(4);
    expect(data['subject:cold-step1'][0]).toBe(1); // padding
    expect(data['subject:cold-step1'][3]).toBe(3); // 1 + 2 (open)
  });
});

// ═══════════════════════════════════════════════════════════════════════
// loadVariantWeights()
// ═══════════════════════════════════════════════════════════════════════

describe('loadVariantWeights()', () => {
  let kv: MockKVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  it('returns null when no weights exist', async () => {
    const weights = await loadVariantWeights(kv, 'nonexistent');
    expect(weights).toBeNull();
  });

  it('returns stored weights as parsed object', async () => {
    await kv.put('ab:variants:cold-step1', JSON.stringify({
      'subject:cold-step1': [5, 12, 3],
      'body:cold-step1': [8, 15],
    }));

    const weights = await loadVariantWeights(kv, 'cold-step1');
    expect(weights).not.toBeNull();
    expect(weights!['subject:cold-step1']).toEqual([5, 12, 3]);
    expect(weights!['body:cold-step1']).toEqual([8, 15]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// End-to-end: engagement → weighted selection convergence
// ═══════════════════════════════════════════════════════════════════════

describe('engagement → selection convergence', () => {
  it('variant with more replies gets selected more often', async () => {
    const kv = createMockKV();

    // Simulate variant 0 getting replies, variant 1 getting sends only
    for (let i = 0; i < 5; i++) {
      await recordVariantEngagement(kv, 'test-seq', 'subject', 0, 'reply');
    }
    for (let i = 0; i < 5; i++) {
      await recordVariantEngagement(kv, 'test-seq', 'subject', 1, 'send');
    }

    const weights = await loadVariantWeights(kv, 'test-seq');
    const w = weights!['subject:test-seq'];

    // Variant 0 should have much higher weight
    expect(w[0]).toBeGreaterThan(w[1]);

    // Selection should favor variant 0
    const counts = [0, 0];
    for (let i = 0; i < 1000; i++) {
      counts[pickWeightedIndex(2, w)]++;
    }
    expect(counts[0]).toBeGreaterThan(counts[1]);
  });
});
