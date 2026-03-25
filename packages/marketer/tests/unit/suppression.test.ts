/**
 * Tests — Suppression List (CAN-SPAM compliance)
 *
 * Covers isSuppressed() and addSuppression() — permanent D1-backed
 * email suppression that survives KV TTL expiry.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { isSuppressed, addSuppression } from '../../src/lib/suppression';
import { createMockEnv, type MockEnv } from '../helpers';

describe('isSuppressed()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('returns false when email is not in suppression list', async () => {
    env.DB.onQuery(/SELECT.*suppression_list/, () => []);
    expect(await isSuppressed(env.DB as any, 'clean@acme.com')).toBe(false);
  });

  it('returns true when email is found in suppression list', async () => {
    env.DB.onQuery(/SELECT.*suppression_list/, () => [{ id: 1 }]);
    expect(await isSuppressed(env.DB as any, 'bounced@bad.com')).toBe(true);
  });

  it('normalizes email to lowercase before lookup', async () => {
    env.DB.onQuery(/SELECT.*suppression_list/, (params) => {
      // Verify the param was lowercased
      expect((params[0] as string).toLowerCase()).toBe(params[0]);
      return [];
    });
    await isSuppressed(env.DB as any, 'UPPER@CASE.COM');
  });

  it('trims whitespace from email', async () => {
    env.DB.onQuery(/SELECT.*suppression_list/, (params) => {
      expect(params[0]).not.toMatch(/^\s|\s$/);
      return [];
    });
    await isSuppressed(env.DB as any, '  spaced@test.com  ');
  });
});

describe('addSuppression()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('inserts a suppression record with correct fields', async () => {
    await addSuppression(env.DB as any, 'bounced@test.com', 'hard_bounce', 'brevo_webhook');

    const insertQuery = env.DB._queries.find((q) =>
      q.sql.includes('INSERT OR IGNORE INTO suppression_list')
    );
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.params[0]).toBe('bounced@test.com');
    expect(insertQuery!.params[1]).toBe('hard_bounce');
    expect(insertQuery!.params[2]).toBe('brevo_webhook');
  });

  it('uses INSERT OR IGNORE for idempotency', async () => {
    await addSuppression(env.DB as any, 'dupe@test.com', 'spam_complaint', 'brevo_webhook');

    const insertQuery = env.DB._queries.find((q) =>
      q.sql.includes('INSERT OR IGNORE')
    );
    expect(insertQuery).toBeDefined();
  });

  it('stores optional metadata as JSON', async () => {
    const meta = { webhookId: 'wh-123', timestamp: '2025-01-01' };
    await addSuppression(env.DB as any, 'meta@test.com', 'hard_bounce', 'brevo_webhook', meta);

    const insertQuery = env.DB._queries.find((q) =>
      q.sql.includes('suppression_list')
    );
    expect(insertQuery!.params[3]).toBe(JSON.stringify(meta));
  });

  it('stores null metadata when not provided', async () => {
    await addSuppression(env.DB as any, 'nometa@test.com', 'unsubscribed', 'user_request');

    const insertQuery = env.DB._queries.find((q) =>
      q.sql.includes('suppression_list')
    );
    expect(insertQuery!.params[3]).toBeNull();
  });

  it('does not throw on DB errors (graceful degradation)', async () => {
    env.DB.onQuery(/INSERT OR IGNORE/, () => {
      throw new Error('DB connection lost');
    });

    await expect(
      addSuppression(env.DB as any, 'error@test.com', 'hard_bounce', 'brevo_webhook')
    ).resolves.not.toThrow();
  });

  it('normalizes email to lowercase', async () => {
    await addSuppression(env.DB as any, 'UPPER@TEST.COM', 'manual', 'admin');

    const insertQuery = env.DB._queries.find((q) =>
      q.sql.includes('suppression_list')
    );
    expect(insertQuery!.params[0]).toBe('upper@test.com');
  });
});
