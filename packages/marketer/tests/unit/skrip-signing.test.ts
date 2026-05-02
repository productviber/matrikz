import { describe, expect, it } from 'vitest';
import { computeSkripSignature, verifySkripSignature } from '../../src/lib/skrip/signing';

describe('skrip signing', () => {
  it('computes deterministic signatures for the same canonical request', async () => {
    const input = {
      method: 'POST',
      path: '/webhooks/skrip/v1/outcomes',
      timestamp: '2026-05-02T12:00:00.000Z',
      nonce: 'nonce_123',
      rawBody: JSON.stringify({ ok: true }),
      secret: 'skrip-secret',
    };

    const first = await computeSkripSignature(input);
    const second = await computeSkripSignature(input);

    expect(first).toBe(second);
    expect(first.startsWith('sha256=')).toBe(true);
  });

  it('verifies a valid signature envelope', async () => {
    const rawBody = JSON.stringify({ ok: true });
    const timestamp = new Date().toISOString();
    const signature = await computeSkripSignature({
      method: 'POST',
      path: '/webhooks/skrip/v1/outcomes',
      timestamp,
      nonce: 'nonce_456',
      rawBody,
      secret: 'skrip-secret',
    });

    const result = await verifySkripSignature({
      method: 'POST',
      path: '/webhooks/skrip/v1/outcomes',
      timestamp,
      nonce: 'nonce_456',
      signature,
      rawBody,
      secret: 'skrip-secret',
    });

    expect(result.ok).toBe(true);
  });
});