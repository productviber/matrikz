/**
 * Analytics Client Tests
 *
 * Tests for internal service binding client to visibility-analytics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  healthCheck,
  createAffiliate,
  listAffiliates,
  getAffiliateByCode,
} from '../../src/lib/analytics-client';
import { createMockEnv, createMockFetcher, type MockEnv } from '../helpers';

describe('analytics-client', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv({
      ANALYTICS: createMockFetcher({
        '/health': { body: { status: 'ok' } },
        '/admin/affiliates': { body: { affiliates: [] } },
      }) as any,
    });
  });

  describe('healthCheck()', () => {
    it('fetches health from analytics service', async () => {
      const result = await healthCheck(env as any);
      expect(result).toEqual({ status: 'ok' });
    });
  });

  describe('createAffiliate()', () => {
    it('creates an affiliate via admin endpoint', async () => {
      const result = await createAffiliate(env as any, {
        code: 'aff-123',
        name: 'Jane',
        email: 'jane@test.com',
        commissionRate: 0.25,
      });
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ affiliates: [] });
    });
  });

  describe('listAffiliates()', () => {
    it('lists affiliates via admin endpoint', async () => {
      const result = await listAffiliates(env as any);
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ affiliates: [] });
    });
  });

  describe('getAffiliateByCode()', () => {
    it('fetches affiliate by code', async () => {
      // The URL will be /admin/affiliates?code=test-code, mock matches /admin/affiliates
      const result = await getAffiliateByCode(env as any, 'test-code');
      // Route matches /admin/affiliates path
      expect(result).toBeDefined();
    });
  });

});

