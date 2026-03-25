export function pickWeightedIndex(poolSize: number, weights?: number[] | null): number {
  if (!weights || weights.length !== poolSize) {
    return Math.floor(Math.random() * poolSize);
  }
  const total = weights.reduce((sum, w) => sum + Math.max(w, 1), 0);
  let rnd = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    rnd -= Math.max(weights[i], 1);
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
): Promise<void> {
  const key = `ab:variants:${templateKey}`;
  const raw = await kv.get(key);
  const data: Record<string, number[]> = raw ? JSON.parse(raw) : {};
  const poolKey = `${variantType}:${templateKey}`;

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
