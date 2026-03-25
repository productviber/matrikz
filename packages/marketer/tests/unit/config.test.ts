import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../src/lib/config.ts';
import { createMockEnv } from '../helpers';

describe('validateConfig()', () => {
  it('passes with default development config', () => {
    const env = createMockEnv();
    const errors = validateConfig(env as any);
    expect(errors).toEqual([]);
  });

  it('requires webhook and affiliate secrets in production', () => {
    const env = createMockEnv({
      ENVIRONMENT: 'production',
      WEBHOOK_SIGNING_SECRET: undefined,
      AFFILIATE_AUTH_SECRET: undefined,
    });

    const errors = validateConfig(env as any);
    expect(errors).toContain('WEBHOOK_SIGNING_SECRET secret');
    expect(errors).toContain('AFFILIATE_AUTH_SECRET secret');
  });
});
