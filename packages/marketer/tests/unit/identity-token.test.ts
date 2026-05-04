import { describe, expect, it } from 'vitest';
import { IDENTITY_TOKEN } from '../../src/constants';
import { mintRecipientToken, verifyRecipientToken } from '../../src/lib/identity-token';
import { handleIdentityTokenMint, handleIdentityTokenVerify } from '../../src/routes/identity-token';
import { createMockEnv, makeRequest } from '../helpers';

describe('identity token', () => {
  it('mints a signed token with expiry and SHA-256 hash', async () => {
    const env = createMockEnv({ WEBHOOK_SIGNING_SECRET: 'secret-1' });
    const result = await mintRecipientToken(env as any, {
      contactId: 'lead@acme.com',
      tenantId: 'default',
      purpose: IDENTITY_TOKEN.PURPOSE.SUBSCRIBE,
      ttlSecs: 600,
    });

    expect(result.token.length).toBeGreaterThan(20);
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(result.tokenHash).toMatch(/^[a-f0-9]{64}$/i);
  });

  it('throws when mint is attempted without signing secret', async () => {
    const env = createMockEnv();
    await expect(
      mintRecipientToken(env as any, {
        contactId: 'lead@acme.com',
        tenantId: 'default',
        purpose: IDENTITY_TOKEN.PURPOSE.SUBSCRIBE,
      }),
    ).rejects.toThrow(IDENTITY_TOKEN.REJECT_REASON.MISSING_SECRET);
  });

  it('verifies a valid token', async () => {
    const env = createMockEnv({ WEBHOOK_SIGNING_SECRET: 'secret-2' });
    const minted = await mintRecipientToken(env as any, {
      contactId: 'lead@acme.com',
      tenantId: 'tenant_1',
      purpose: IDENTITY_TOKEN.PURPOSE.REDIRECT,
      ttlSecs: 300,
    });

    const verified = await verifyRecipientToken(env as any, minted.token);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.contactId).toBe('lead@acme.com');
      expect(verified.tenantId).toBe('tenant_1');
      expect(verified.purpose).toBe(IDENTITY_TOKEN.PURPOSE.REDIRECT);
      expect(verified.tokenHash).toMatch(/^[a-f0-9]{64}$/i);
    }
  });

  it('returns malformed for invalid token payload', async () => {
    const env = createMockEnv({ WEBHOOK_SIGNING_SECRET: 'secret-3' });
    const verified = await verifyRecipientToken(env as any, '%%%not-base64%%%');

    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.reason).toBe(IDENTITY_TOKEN.REJECT_REASON.MALFORMED);
    }
  });

  it('returns tampered for modified signature payload', async () => {
    const env = createMockEnv({ WEBHOOK_SIGNING_SECRET: 'secret-4' });
    const minted = await mintRecipientToken(env as any, {
      contactId: 'lead@acme.com',
      tenantId: 'default',
      purpose: IDENTITY_TOKEN.PURPOSE.VERIFY,
      ttlSecs: 300,
    });

    const tamperedToken = `${minted.token.slice(0, -2)}aa`;
    const verified = await verifyRecipientToken(env as any, tamperedToken);

    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.reason).toBe(IDENTITY_TOKEN.REJECT_REASON.TAMPERED);
    }
  });

  it('returns expired for past-expiry token', async () => {
    const env = createMockEnv({ WEBHOOK_SIGNING_SECRET: 'secret-5' });
    const minted = await mintRecipientToken(env as any, {
      contactId: 'lead@acme.com',
      tenantId: 'default',
      purpose: IDENTITY_TOKEN.PURPOSE.VERIFY,
      ttlSecs: -5,
    });

    const verified = await verifyRecipientToken(env as any, minted.token);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.reason).toBe(IDENTITY_TOKEN.REJECT_REASON.EXPIRED);
    }
  });

  it('returns missing-secret when verify is called without signing secret', async () => {
    const envWithSecret = createMockEnv({ WEBHOOK_SIGNING_SECRET: 'secret-6' });
    const minted = await mintRecipientToken(envWithSecret as any, {
      contactId: 'lead@acme.com',
      tenantId: 'default',
      purpose: IDENTITY_TOKEN.PURPOSE.REDIRECT,
    });

    const envWithoutSecret = createMockEnv();
    const verified = await verifyRecipientToken(envWithoutSecret as any, minted.token);

    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.reason).toBe(IDENTITY_TOKEN.REJECT_REASON.MISSING_SECRET);
    }
  });

  it('supports contact IDs containing separator characters', async () => {
    const env = createMockEnv({ WEBHOOK_SIGNING_SECRET: 'secret-7' });
    const minted = await mintRecipientToken(env as any, {
      contactId: 'lead|acme|com',
      tenantId: 'default',
      purpose: IDENTITY_TOKEN.PURPOSE.REDIRECT,
      ttlSecs: 300,
    });

    const verified = await verifyRecipientToken(env as any, minted.token);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.contactId).toBe('lead|acme|com');
    }
  });

  it('returns already-used when token hash is already verified', async () => {
    const env = createMockEnv({ WEBHOOK_SIGNING_SECRET: 'secret-8' });
    env.DB.onQuery(/SELECT verified_at FROM recipient_identity_tokens/i, () => [{ verified_at: 1700000000 }]);
    const minted = await mintRecipientToken(env as any, {
      contactId: 'lead@acme.com',
      tenantId: 'default',
      purpose: IDENTITY_TOKEN.PURPOSE.SUBSCRIBE,
    });

    const response = await handleIdentityTokenVerify(
      makeRequest('POST', '/api/identity/verify', { token: minted.token }),
      env as any,
    );

    expect(response.status).toBe(409);
    const body = await response.json() as { reason: string };
    expect(body.reason).toBe(IDENTITY_TOKEN.REJECT_REASON.ALREADY_USED);
  });

  it('marks subscribe token as used when persist is true', async () => {
    const env = createMockEnv({ WEBHOOK_SIGNING_SECRET: 'secret-9' });
    env.DB.onQuery(/SELECT verified_at FROM recipient_identity_tokens/i, () => [{ verified_at: null }]);
    const minted = await mintRecipientToken(env as any, {
      contactId: 'lead@acme.com',
      tenantId: 'default',
      purpose: IDENTITY_TOKEN.PURPOSE.SUBSCRIBE,
    });

    const response = await handleIdentityTokenVerify(
      makeRequest('POST', '/api/identity/verify', { token: minted.token, persist: true }),
      env as any,
    );

    expect(response.status).toBe(200);
    const update = env.DB._queries.find((query) => query.sql.includes('UPDATE recipient_identity_tokens'));
    expect(update).toBeDefined();
  });

  it('does not mark non-sensitive purpose token as used', async () => {
    const env = createMockEnv({ WEBHOOK_SIGNING_SECRET: 'secret-10' });
    env.DB.onQuery(/SELECT verified_at FROM recipient_identity_tokens/i, () => [{ verified_at: null }]);
    const minted = await mintRecipientToken(env as any, {
      contactId: 'lead@acme.com',
      tenantId: 'default',
      purpose: IDENTITY_TOKEN.PURPOSE.REDIRECT,
    });

    const response = await handleIdentityTokenVerify(
      makeRequest('POST', '/api/identity/verify', { token: minted.token }),
      env as any,
    );

    expect(response.status).toBe(200);
    const update = env.DB._queries.find((query) => query.sql.includes('UPDATE recipient_identity_tokens'));
    expect(update).toBeUndefined();
  });

  it('defaults invalid purpose to redirect and clamps ttl floor in mint route', async () => {
    const env = createMockEnv({ WEBHOOK_SIGNING_SECRET: 'secret-11' });

    const response = await handleIdentityTokenMint(
      makeRequest('POST', '/api/identity/mint', {
        contactId: 'lead@acme.com',
        purpose: 'not-a-purpose',
        ttlSecs: 1,
      }),
      env as any,
    );

    expect(response.status).toBe(201);
    const body = await response.json() as { data: { purpose: string; expiresAt: number } };
    expect(body.data.purpose).toBe(IDENTITY_TOKEN.PURPOSE.REDIRECT);
    expect(body.data.expiresAt).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 60);
  });
});
