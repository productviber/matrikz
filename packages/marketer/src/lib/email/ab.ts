export function pickWeightedIndex(poolSize: number, weights?: number[] | null): number {
  if (!weights || weights.length !== poolSize) {
    return Math.floor(Math.random() * poolSize);
  }
  // A weight of 0 (or any non-positive value) marks a variant as disabled —
  // used by the prune-weakest admin endpoint to retire underperformers without
  // shifting indices (which would break KV weight-array alignment and D1
  // subject_variant_idx persistence for historical rows).
  const clamped = weights.map((w) => (typeof w === 'number' && w > 0 ? w : 0));
  const total = clamped.reduce((sum, w) => sum + w, 0);
  if (total <= 0) {
    // All variants disabled (should not happen in normal ops) — fall back to
    // uniform random so we never block a send.
    return Math.floor(Math.random() * poolSize);
  }
  let rnd = Math.random() * total;
  for (let i = 0; i < clamped.length; i++) {
    rnd -= clamped[i];
    if (rnd <= 0) {
      return i;
    }
  }
  return poolSize - 1;
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
  // When a tier is provided, weights are scoped per tier so each score-band
  // learns its own best variant independently. Legacy un-tiered rows fall
  // through to the non-tier key for backward compatibility.
  const poolKey = tier ? `${variantType}:${templateKey}:${tier}` : `${variantType}:${templateKey}`;

  if (!data[poolKey]) {
    data[poolKey] = [];
  }

  while (data[poolKey].length <= variantIdx) {
    data[poolKey].push(1);
  }

  const bump = event === 'reply' ? 10 : event === 'click' ? 5 : event === 'open' ? 2 : 0;
  data[poolKey][variantIdx] += bump;

  await kv.put(key, JSON.stringify(data), { expirationTtl: 86400 * 90 });
}

export async function loadVariantWeights(
  kv: { get(key: string): Promise<string | null> },
  templateKey: string,
): Promise<Record<string, number[]> | null> {
  const raw = await kv.get(`ab:variants:${templateKey}`);
  return raw ? JSON.parse(raw) : null;
}
