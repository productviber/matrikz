/**
 * Analytics Client Tests
 *
 * Tests for internal service binding client to visibility-analytics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  healthCheck,
  getBillingTiers,
  getCockpitData,
  getBillingStatus,
  createAffiliate,
  listAffiliates,
  getAffiliateByCode,
  getMigrationStatus,
  runMigrations,
} from '../../src/lib/analytics-client';
import { createMockEnv, createMockFetcher, type MockEnv } from '../helpers';

describe('analytics-client', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv({
      ANALYTICS: createMockFetcher({
        '/health': { body: { status: 'ok' } },
        '/api/v1/billing/tiers': { body: { tiers: ['free', 'pro'] } },
        '/api/v1/cockpit': { body: { dashboard: 'data' } },
        '/api/v1/billing/status': { body: { active: true } },
        '/admin/affiliates': { body: { affiliates: [] } },
        '/admin/migrations': { body: { pending: 0 } },
        '/admin/migrations/run': { body: { applied: 0 } },
      }) as any,
    });
  });

  describe('healthCheck()', () => {
    it('fetches health from analytics service', async () => {
      const result = await healthCheck(env as any);
      expect(result).toEqual({ status: 'ok' });
    });
  });

  describe('getBillingTiers()', () => {
    it('fetches billing tiers', async () => {
      const result = await getBillingTiers(env as any);
      expect(result).toEqual({ tiers: ['free', 'pro'] });
    });
  });

  describe('getCockpitData()', () => {
    it('fetches cockpit data with session token', async () => {
      const result = await getCockpitData(env as any, 'session-123');
      expect(result).toEqual({ dashboard: 'data' });
    });
  });

  describe('getBillingStatus()', () => {
    it('fetches billing status with session token', async () => {
      const result = await getBillingStatus(env as any, 'session-123');
      expect(result).toEqual({ active: true });
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
      expect(result).toEqual({ affiliates: [] });
    });
  });

  describe('listAffiliates()', () => {
    it('lists affiliates via admin endpoint', async () => {
      const result = await listAffiliates(env as any);
      expect(result).toEqual({ affiliates: [] });
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

  describe('getMigrationStatus()', () => {
    it('fetches migration status', async () => {
      const result = await getMigrationStatus(env as any);
      expect(result).toEqual({ pending: 0 });
    });
  });

  describe('runMigrations()', () => {
    it('triggers migration run', async () => {
      const result = await runMigrations(env as any);
      expect(result).toEqual({ applied: 0 });
    });
  });
});
