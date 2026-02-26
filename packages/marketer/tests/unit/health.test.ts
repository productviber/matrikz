/**
 * Health Route Tests
 *
 * Tests for basic and detailed health check endpoints.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleHealthCheck, handleDetailedHealth } from '../../src/routes/health';
import { createMockEnv, createMockFetcher, makeRequest, type MockEnv } from '../helpers';
import { WORKER_NAME } from '../../src/constants';

describe('health routes', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  describe('handleHealthCheck()', () => {
    it('returns 200 with ok status', async () => {
      const res = handleHealthCheck();
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.status).toBe('ok');
    });

    it('includes worker name and version', async () => {
      const res = handleHealthCheck();
      const body = await res.json() as any;
      expect(body.data.worker).toBe(WORKER_NAME);
      expect(body.data.version).toBeDefined();
    });

    it('includes a timestamp', async () => {
      const res = handleHealthCheck();
      const body = await res.json() as any;
      expect(body.data.timestamp).toBeTruthy();
      // Should be a valid ISO date
      expect(() => new Date(body.data.timestamp)).not.toThrow();
    });
  });

  describe('handleDetailedHealth()', () => {
    it('returns healthy when all checks pass', async () => {
      // Mock analytics to return healthy
      env = createMockEnv({
        ANALYTICS: createMockFetcher({
          '/health': { body: { status: 'ok' } },
        }) as any,
      });

      const res = await handleDetailedHealth(
        makeRequest('GET', '/health/detailed', undefined, { Authorization: 'Bearer test-admin-token' }),
        env as any
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.status).toBe('healthy');
      expect(body.data.checks.d1).toBe('ok');
      expect(body.data.checks.kv).toBe('ok');
      expect(body.data.checks.analytics).toBe('ok');
    });

    it('returns degraded when D1 fails', async () => {
      // Make D1 fail
      env.DB.prepare = () => {
        throw new Error('D1 down');
      };

      env = createMockEnv({
        ...env,
        DB: env.DB as any,
        ANALYTICS: createMockFetcher({
          '/health': { body: { status: 'ok' } },
        }) as any,
      });

      const res = await handleDetailedHealth(
        makeRequest('GET', '/health/detailed', undefined, { Authorization: 'Bearer test-admin-token' }),
        env as any
      );
      const body = await res.json() as any;
      expect(body.data.status).toBe('degraded');
      expect(body.data.checks.d1).toBe('error');
    });

    it('returns degraded when analytics service is unavailable', async () => {
      env = createMockEnv({
        ANALYTICS: createMockFetcher({}) as any, // no /health route → 404
      });

      const res = await handleDetailedHealth(
        makeRequest('GET', '/health/detailed', undefined, { Authorization: 'Bearer test-admin-token' }),
        env as any
      );
      const body = await res.json() as any;
      // Analytics returns 404 (not ok), so shows error:404
      expect(body.data.checks.analytics).toMatch(/error|unavailable/);
    });

    it('includes worker name', async () => {
      env = createMockEnv({
        ANALYTICS: createMockFetcher({
          '/health': { body: { status: 'ok' } },
        }) as any,
      });

      const res = await handleDetailedHealth(
        makeRequest('GET', '/health/detailed', undefined, { Authorization: 'Bearer test-admin-token' }),
        env as any
      );
      const body = await res.json() as any;
      expect(body.data.worker).toBe(WORKER_NAME);
    });
  });
});
