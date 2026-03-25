/**
 * GDPR Routes Tests
 *
 * Validates that data export and deletion cover both
 * affiliate data and share PLG data (share_leads, share_owner_stats).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGdprExport, handleGdprDelete, handleUnsubscribe } from '../../src/routes/gdpr';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';
import { KV_PREFIX, KV_UNSUBSCRIBE_PREFIX } from '../../src/constants';

describe('GDPR routes', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();

    // Default handlers — affiliate tables return empty
    env.DB.onQuery(/affiliate_notes/, () => []);
    env.DB.onQuery(/payout_items/, () => []);
    // Share tables default to empty (overridden in specific tests via clearHandlers + re-register)
    env.DB.onQuery(/share_leads/, () => []);
    env.DB.onQuery(/share_owner_stats/, () => []);
    env.DB.onQuery(/marketing_contacts.*WHERE email/, () => [
      { email: 'test@test.com', affiliate_code: 'TEST123' },
    ]);

    // Store affiliate email for verification
    env.KV_MARKETING.put(`${KV_PREFIX.AFFILIATE_EMAIL}TEST123`, 'test@test.com');
  });

  function gdprRequest(method: string, path: string): Request {
    return makeRequest(method, `${path}?code=TEST123&email=test@test.com`);
  }

  describe('handleGdprExport()', () => {
    it('returns 400 without code/email', async () => {
      const req = makeRequest('GET', '/api/affiliate/gdpr/export');
      const res = await handleGdprExport(req, env as any);
      expect(res.status).toBe(400);
    });

    it('includes share_leads in export', async () => {
      // Re-register handlers with share data appearing before generic empty fallback
      env.DB.clearHandlers();
      env.DB.onQuery(/affiliate_notes/, () => []);
      env.DB.onQuery(/payout_items/, () => []);
      env.DB.onQuery(/share_leads/, () => [
        { id: 1, token: 'vs_abc', status: 'warm', pql_score: 25 },
      ]);
      env.DB.onQuery(/share_owner_stats/, () => []);
      env.DB.onQuery(/marketing_contacts.*WHERE email/, () => [
        { email: 'test@test.com', affiliate_code: 'TEST123' },
      ]);

      const req = gdprRequest('GET', '/api/affiliate/gdpr/export');
      const res = await handleGdprExport(req, env as any);
      const body = await res.json() as any;

      expect(res.status).toBe(200);
      expect(body.data.shareLeads).toBeDefined();
      expect(body.data.shareLeads).toHaveLength(1);
    });

    it('includes share_owner_stats in export', async () => {
      // Re-register handlers with owner stats data
      env.DB.clearHandlers();
      env.DB.onQuery(/affiliate_notes/, () => []);
      env.DB.onQuery(/payout_items/, () => []);
      env.DB.onQuery(/share_leads/, () => []);
      env.DB.onQuery(/share_owner_stats/, () => [
        { id: 1, owner_email: 'test@test.com', total_shares: 5 },
      ]);
      env.DB.onQuery(/marketing_contacts.*WHERE email/, () => [
        { email: 'test@test.com', affiliate_code: 'TEST123' },
      ]);

      const req = gdprRequest('GET', '/api/affiliate/gdpr/export');
      const res = await handleGdprExport(req, env as any);
      const body = await res.json() as any;

      expect(res.status).toBe(200);
      expect(body.data.shareOwnerStats).toBeDefined();
      expect(body.data.shareOwnerStats).toHaveLength(1);
    });

    it('includes exportedAt timestamp', async () => {
      const req = gdprRequest('GET', '/api/affiliate/gdpr/export');
      const res = await handleGdprExport(req, env as any);
      const body = await res.json() as any;
      expect(body.data.exportedAt).toBeDefined();
    });
  });

  describe('handleGdprDelete()', () => {
    it('deletes share_leads for user', async () => {
      const req = gdprRequest('DELETE', '/api/affiliate/gdpr/delete');
      const res = await handleGdprDelete(req, env as any);
      expect(res.status).toBe(200);

      const deleteQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('DELETE FROM share_leads')
      );
      expect(deleteQuery).toBeDefined();
      expect(deleteQuery!.params).toContain('test@test.com');
    });

    it('deletes share_owner_stats for user', async () => {
      const req = gdprRequest('DELETE', '/api/affiliate/gdpr/delete');
      const res = await handleGdprDelete(req, env as any);

      const deleteQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('DELETE FROM share_owner_stats')
      );
      expect(deleteQuery).toBeDefined();
      expect(deleteQuery!.params).toContain('test@test.com');
    });

    it('deletes share_owner KV cache', async () => {
      const kvKey = `${KV_PREFIX.SHARE_OWNER_STATS}test@test.com`;
      await env.KV_MARKETING.put(kvKey, '{"totalShares":5}');

      const req = gdprRequest('DELETE', '/api/affiliate/gdpr/delete');
      await handleGdprDelete(req, env as any);

      const value = await env.KV_MARKETING.get(kvKey);
      expect(value).toBeNull();
    });
  });

  describe('handleUnsubscribe()', () => {
    it('updates email_sends using contact_email and stores unsubscribe flag', async () => {
      const email = 'person@example.com';
      const req = makeRequest('POST', '/api/unsubscribe', { email });

      const res = await handleUnsubscribe(req, env as any);

      expect(res.status).toBe(200);

      const unsubscribeQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('UPDATE email_sends SET status = \'cancelled\'')
      );

      expect(unsubscribeQuery).toBeDefined();
      expect(unsubscribeQuery!.sql).toContain('contact_email');
      expect(unsubscribeQuery!.sql).not.toContain('to_email');
      expect(unsubscribeQuery!.params).toEqual([email]);

      const kvValue = await env.KV_MARKETING.get(`${KV_UNSUBSCRIBE_PREFIX}${email}`);
      expect(kvValue).toBe('1');
    });
  });
});
