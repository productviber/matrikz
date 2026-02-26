/**
 * Payouts Route Tests
 *
 * Tests for payout batch creation, processing, listing, and detail endpoints.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleCreatePayoutBatch,
  handleProcessPayoutBatch,
  handleListPayoutBatches,
  handleGetPayoutBatch,
} from '../../src/routes/payouts';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';
import { PAYOUT_STATUS } from '../../src/constants';

describe('payouts routes', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
    vi.restoreAllMocks();
    // No default handlers — each test registers what it needs.
    // Unmatched queries return [] / null by default in MockD1Database.
  });

  function adminRequest(method: string, path: string, body?: unknown): Request {
    return makeRequest(method, path, body, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
  }

  // ─── Auth ─────────────────────────────────────────────────────────────

  describe('auth requirements', () => {
    it('create batch requires admin auth', async () => {
      const req = makeRequest('POST', '/api/payouts/batch');
      const res = await handleCreatePayoutBatch(req, env as any);
      expect(res.status).toBe(401);
    });

    it('process batch requires admin auth', async () => {
      const req = makeRequest('POST', '/api/payouts/batch/1/process');
      const res = await handleProcessPayoutBatch(req, env as any, 1);
      expect(res.status).toBe(401);
    });

    it('list batches requires admin auth', async () => {
      const req = makeRequest('GET', '/api/payouts');
      const res = await handleListPayoutBatches(req, env as any);
      expect(res.status).toBe(401);
    });

    it('get batch detail requires admin auth', async () => {
      const req = makeRequest('GET', '/api/payouts/1');
      const res = await handleGetPayoutBatch(req, env as any, 1);
      expect(res.status).toBe(401);
    });
  });

  // ─── Create Payout Batch ──────────────────────────────────────────────

  describe('handleCreatePayoutBatch()', () => {
    it('returns message when no affiliates with conversions', async () => {
      const req = adminRequest('POST', '/api/payouts/batch');
      const res = await handleCreatePayoutBatch(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.message).toContain('No affiliates');
      expect(body.data.batch).toBeNull();
    });

    it('creates batch when affiliates have unpaid earnings', async () => {
      // Setup: affiliate with conversions
      env.DB.onQuery(/SELECT DISTINCT affiliate_code/, () => [
        { affiliate_code: 'aff-1' },
      ]);
      env.DB.onQuery(/SUM\(amount_cents\).*total_paid/, () => [{ total_paid: 0 }]);

      // Affiliate stats in KV
      await env.KV_MARKETING.put('affiliate-stats:aff-1', JSON.stringify({
        totalConversions: 10,
        totalEarnedCents: 5000,
      }));
      await env.KV_MARKETING.put('affiliate-email:aff-1', 'aff1@test.com');

      // Mock batch creation - return the batch
      env.DB.onQuery(/SELECT \* FROM payout_batches ORDER BY id DESC/, () => [
        { id: 1, status: 'pending', total_amount_cents: 5000, affiliate_count: 1 },
      ]);

      const req = adminRequest('POST', '/api/payouts/batch');
      const res = await handleCreatePayoutBatch(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.batch).toBeDefined();
      expect(body.data.batch.status).toBe(PAYOUT_STATUS.PENDING);
      expect(body.data.batch.affiliateCount).toBe(1);
    });

    it('skips affiliates with no unpaid earnings', async () => {
      env.DB.onQuery(/SELECT DISTINCT affiliate_code/, () => [
        { affiliate_code: 'aff-paid' },
      ]);

      // Total earned = 5000, total paid = 5000 (all paid)
      await env.KV_MARKETING.put('affiliate-stats:aff-paid', JSON.stringify({
        totalConversions: 5,
        totalEarnedCents: 5000,
      }));
      await env.KV_MARKETING.put('affiliate-email:aff-paid', 'paid@test.com');
      env.DB.onQuery(/SUM\(amount_cents\).*total_paid/, () => [{ total_paid: 5000 }]);

      const req = adminRequest('POST', '/api/payouts/batch');
      const res = await handleCreatePayoutBatch(req, env as any);
      const body = await res.json() as any;
      expect(body.data.message).toContain('No unpaid earnings');
    });

    it('skips affiliates without email', async () => {
      env.DB.onQuery(/SELECT DISTINCT affiliate_code/, () => [
        { affiliate_code: 'aff-noemail' },
      ]);
      env.DB.onQuery(/SUM\(amount_cents\).*total_paid/, () => [{ total_paid: 0 }]);

      await env.KV_MARKETING.put('affiliate-stats:aff-noemail', JSON.stringify({
        totalConversions: 3,
        totalEarnedCents: 3000,
      }));
      // No email cached

      const req = adminRequest('POST', '/api/payouts/batch');
      const res = await handleCreatePayoutBatch(req, env as any);
      const body = await res.json() as any;
      expect(body.data.message).toContain('No unpaid earnings');
    });
  });

  // ─── Process Payout Batch ─────────────────────────────────────────────

  describe('handleProcessPayoutBatch()', () => {
    it('returns 404 for non-existent batch', async () => {
      const req = adminRequest('POST', '/api/payouts/batch/999/process');
      const res = await handleProcessPayoutBatch(req, env as any, 999);
      expect(res.status).toBe(404);
    });

    it('rejects non-pending batches', async () => {
      env.DB.onQuery(/SELECT \* FROM payout_batches WHERE id/, () => [
        { id: 1, status: 'completed', total_amount_cents: 5000, affiliate_count: 1 },
      ]);

      const req = adminRequest('POST', '/api/payouts/batch/1/process');
      const res = await handleProcessPayoutBatch(req, env as any, 1);
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toContain('already');
    });

    it('processes pending batch successfully', async () => {
      env.DB.onQuery(/SELECT \* FROM payout_batches WHERE id/, () => [
        { id: 1, status: PAYOUT_STATUS.PENDING, total_amount_cents: 5000, affiliate_count: 1 },
      ]);
      env.DB.onQuery(/SELECT \* FROM payout_items WHERE batch_id/, () => [
        { id: 1, batch_id: 1, affiliate_code: 'aff-1', affiliate_email: 'aff@test.com', amount_cents: 5000, status: 'pending' },
      ]);

      const req = adminRequest('POST', '/api/payouts/batch/1/process', {
        method: 'paypal',
        references: { 'aff-1': 'PP-12345' },
      });
      const res = await handleProcessPayoutBatch(req, env as any, 1);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.processed).toBe(1);
      expect(body.data.failed).toBe(0);
      expect(body.data.status).toBe(PAYOUT_STATUS.COMPLETED);
    });
  });

  // ─── List Payout Batches ──────────────────────────────────────────────

  describe('handleListPayoutBatches()', () => {
    it('returns batch list', async () => {
      env.DB.onQuery(/SELECT \* FROM payout_batches ORDER/, () => [
        { id: 1, status: 'completed', total_amount_cents: 5000, affiliate_count: 1, initiated_at: 1700000000 },
      ]);

      const req = adminRequest('GET', '/api/payouts');
      const res = await handleListPayoutBatches(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.batches).toHaveLength(1);
      expect(body.data.batches[0].totalFormatted).toBe('$50.00');
    });
  });

  // ─── Get Batch Details ────────────────────────────────────────────────

  describe('handleGetPayoutBatch()', () => {
    it('returns 404 for non-existent batch', async () => {
      const req = adminRequest('GET', '/api/payouts/999');
      const res = await handleGetPayoutBatch(req, env as any, 999);
      expect(res.status).toBe(404);
    });

    it('returns batch with items', async () => {
      env.DB.onQuery(/SELECT \* FROM payout_batches WHERE id/, () => [
        { id: 1, status: 'completed', total_amount_cents: 8000, affiliate_count: 2 },
      ]);
      env.DB.onQuery(/SELECT \* FROM payout_items WHERE batch_id/, () => [
        { id: 1, affiliate_code: 'aff-1', amount_cents: 5000, status: 'sent' },
        { id: 2, affiliate_code: 'aff-2', amount_cents: 3000, status: 'sent' },
      ]);

      const req = adminRequest('GET', '/api/payouts/1');
      const res = await handleGetPayoutBatch(req, env as any, 1);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.batch.totalFormatted).toBe('$80.00');
      expect(body.data.items).toHaveLength(2);
      expect(body.data.items[0].amountFormatted).toBe('$50.00');
    });
  });
});
