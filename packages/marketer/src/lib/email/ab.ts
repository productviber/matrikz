import { KV_PREFIX, TTL } from '../../constants';

function clampWeights(poolSize: number, weights?: number[] | null): number[] | null {
  if (!weights || weights.length !== poolSize) return null;
  return weights.map((w) => (typeof w === 'number' && w > 0 ? w : 0));
}

function hashFNV1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function pickWeightedIndex(poolSize: number, weights?: number[] | null): number {
  if (poolSize <= 1) return 0;
  const clamped = clampWeights(poolSize, weights);
  if (!clamped) {
    return Math.floor(Math.random() * poolSize);
  }
  const total = clamped.reduce((sum, w) => sum + w, 0);
  if (total <= 0) {
    return Math.floor(Math.random() * poolSize);
  }
  let rnd = Math.random() * total;
  for (let i = 0; i < clamped.length; i++) {
    rnd -= clamped[i];
    if (rnd <= 0) return i;
  }
  return poolSize - 1;
}

export function pickDeterministicWeightedIndex(
  poolSize: number,
  seed: string,
  weights?: number[] | null,
): number {
  if (poolSize <= 1) return 0;
  const clamped = clampWeights(poolSize, weights);
  const hashed = hashFNV1a32(seed);
  if (!clamped) {
    return hashed % poolSize;
  }
  const total = clamped.reduce((sum, w) => sum + w, 0);
  if (total <= 0) {
    return hashed % poolSize;
  }
  let slot = (hashed % total) + 1;
  for (let i = 0; i < clamped.length; i++) {
    slot -= clamped[i];
    if (slot <= 0) return i;
  }
  return poolSize - 1;
}

export async function resolvePersistentVariantAssignment(
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> },
  input: {
    campaignSlug: string;
    contactEmail: string;
    templateKey: string;
    variantType: 'subject' | 'body';
    poolSize: number;
    weights?: number[] | null;
  },
): Promise<number> {
  if (input.poolSize <= 1) return 0;
  const key = `${KV_PREFIX.AB_ASSIGNMENT}${input.campaignSlug}:${input.contactEmail.toLowerCase()}:${input.templateKey}:${input.variantType}`;
  const existingRaw = await kv.get(key);
  const existing = existingRaw ? Number.parseInt(existingRaw, 10) : Number.NaN;
  if (Number.isFinite(existing) && existing >= 0 && existing < input.poolSize) {
    return existing;
  }

  const seed = `${input.campaignSlug}|${input.contactEmail.toLowerCase()}|${input.templateKey}|${input.variantType}`;
  const idx = pickDeterministicWeightedIndex(input.poolSize, seed, input.weights);
  await kv.put(key, String(idx), { expirationTtl: TTL.DAYS_90 });
  return idx;
}

export async function recordVariantEngagement(
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> },
  templateKey: string,
  variantType: 'subject' | 'body',
  variantIdx: number,
  event: 'send' | 'open' | 'click' | 'reply',
  tier?: string | null,
): Promise<void> {
  const key = `ab:variants:${templateKey}`;
  const raw = await kv.get(key);
  const data: Record<string, number[]> = raw ? JSON.parse(raw) : {};
  const poolKey = tier ? `${variantType}:${templateKey}:${tier}` : `${variantType}:${templateKey}`;

  if (!data[poolKey]) {
    data[poolKey] = [];
  }

  while (data[poolKey].length <= variantIdx) {
    data[poolKey].push(1);
  }

  const bump = event === 'reply' ? 10 : event === 'click' ? 5 : event === 'open' ? 2 : 0;
  data[poolKey][variantIdx] += bump;

  await kv.put(key, JSON.stringify(data), { expirationTtl: TTL.DAYS_90 });
}

export async function loadVariantWeights(
  kv: { get(key: string): Promise<string | null> },
  templateKey: string,
): Promise<Record<string, number[]> | null> {
  const raw = await kv.get(`ab:variants:${templateKey}`);
  return raw ? JSON.parse(raw) : null;
}

export interface VariantPerformanceRow {
  idx: number;
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced?: number;
  unsubscribed?: number;
}

/**
 * Promote the winning variant by amplifying its weight in KV.
 *
 * After calling this, `pickWeightedIndex` will select the winner ~90% of the
 * time while leaving other non-disabled variants at weight 1 so rare exposures
 * continue to arrive (exploration floor). Disabled (weight=0) slots stay at 0.
 */
export async function promoteVariantWinner(
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> },
  templateKey: string,
  variantType: 'subject' | 'body',
  winnerIdx: number,
  poolSize: number,
  tier?: string | null,
): Promise<void> {
  const key = `ab:variants:${templateKey}`;
  const raw = await kv.get(key);
  const data: Record<string, number[]> = raw ? JSON.parse(raw) : {};
  const poolKey = tier ? `${variantType}:${templateKey}:${tier}` : `${variantType}:${templateKey}`;
  const current = data[poolKey] ?? [];
  const size = Math.max(poolSize, winnerIdx + 1);
  const next: number[] = [];
  for (let i = 0; i < size; i++) {
    const existing = current[i] ?? 1;
    if (i === winnerIdx) {
      next.push(9); // ~90% selection share
    } else {
      next.push(existing <= 0 ? 0 : 1); // keep disabled slots disabled
    }
  }
  data[poolKey] = next;
  await kv.put(key, JSON.stringify(data), { expirationTtl: TTL.DAYS_90 });
}

export function evaluateVariantWinner(
  rows: VariantPerformanceRow[],
  options: { confidenceThreshold?: number; minSamples?: number } = {},
): {
  winnerIdx: number | null;
  confidence: number;
  reason: string;
  compared: number;
} {
  const threshold = typeof options.confidenceThreshold === 'number' ? options.confidenceThreshold : 0.8;
  const minSamples = typeof options.minSamples === 'number' ? options.minSamples : 50;
  const eligible = rows.filter((r) => r.sent >= minSamples);
  if (eligible.length < 2) {
    return { winnerIdx: null, confidence: 0, reason: 'insufficient_samples', compared: eligible.length };
  }

  const score = (r: VariantPerformanceRow) => ((r.replied * 10) + (r.clicked * 5) + (r.opened * 2)) / Math.max(1, r.sent);
  const ranked = [...eligible].sort((a, b) => score(b) - score(a));
  const best = ranked[0];
  const second = ranked[1];
  const confidence = Math.max(0, Math.min(1, (score(best) - score(second)) / Math.max(score(best), 0.0001)));

  if (confidence < threshold) {
    return { winnerIdx: null, confidence, reason: 'below_confidence_threshold', compared: eligible.length };
  }

  return { winnerIdx: best.idx, confidence, reason: 'winner_selected', compared: eligible.length };
}
