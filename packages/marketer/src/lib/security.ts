/**
 * Security helpers for authentication and integrity checks.
 */

const textEncoder = new TextEncoder();

/**
 * Compare two strings in constant time to reduce timing side channels.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = textEncoder.encode(a);
  const bBytes = textEncoder.encode(b);

  let mismatch = aBytes.length ^ bBytes.length;
  const maxLength = Math.max(aBytes.length, bBytes.length);

  for (let i = 0; i < maxLength; i++) {
    const left = aBytes[i] ?? 0;
    const right = bBytes[i] ?? 0;
    mismatch |= left ^ right;
  }

  return mismatch === 0;
}
