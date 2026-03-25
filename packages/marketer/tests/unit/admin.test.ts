/**
 * Admin Routes Tests
 *
 * Tests for dashboard metrics, MRR history, email management,
 * contacts, and notification log endpoints.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleAdminDashboard,
  handleMrrHistory,
  handleListSequences,
  handleListEmailSends,
  handleProcessEmails,
  handleListContacts,
  handleListNotifications,
  handleListShareLeads,
  handleListShareOwners,
  handleListPQLLeads,
} from '../../src/routes/admin';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';

describe('admin routes', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();

    // Default DB handlers for admin queries
    env.DB.onQuery(/SELECT.*mrr_snapshots/, () => [
      { mrr_cents: 500000, arr_cents: 6000000, snapshot_date: '2025-01-01', total_customers: 100 },
    ]);
    env.DB.onQuery(/SELECT.*COUNT.*marketing_contacts/, () => [
      { total: 250, leads: 100, trials: 50, customers: 80, churned: 20 },
    ]);
    env.DB.onQuery(/SUM\(total_amount_cents\)/, () => [{ total: 15000 }]);
    env.DB.onQuery(/email_sequences WHERE is_active/, () => [{ count: 3 }]);
    env.DB.onQuery(/email_sends WHERE status.*sent/, () => [{ count: 12 }]);
    env.DB.onQuery(/affiliate_notes.*WHERE note_type/, () => [{ count: 5 }]);
    env.DB.onQuery(/SELECT.*email_sequences es/, () => []);
    env.DB.onQuery(/SELECT es\.\*.*email_sends/, () => []);
    env.DB.onQuery(/SELECT \* FROM marketing_contacts/, () => []);
    env.DB.onQuery(/SELECT \* FROM notification_log/, () => []);
  });

  function adminRequest(method: string, path: string, body?: unknown): Request {
    return makeRequest(method, path, body, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
  }

  // Auth is enforced centrally at router level via resolveRouteLane() in index.ts.
  // Handler-level auth tests removed — see route-lanes.test.ts and access.test.ts.

  // ─── Dashboard ─────────────────────────────────────────────────────────

  describe('handleAdminDashboard()', () => {
    it('returns 200 with dashboard metrics', async () => {
      const req = adminRequest('GET', '/api/admin/dashboard');
      const res = await handleAdminDashboard(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.metrics).toBeDefined();
      expect(body.data.metrics.mrr).toBeDefined();
      expect(body.data.contacts).toBeDefined();
    });

    it('includes daily revenue from KV', async () => {
      const today = new Date().toISOString().slice(0, 10);
      await env.KV_MARKETING.put(`daily-conversions:${today}`, '5');
      await env.KV_MARKETING.put(`daily-revenue:${today}`, '14500');

      const req = adminRequest('GET', '/api/admin/dashboard');
      const res = await handleAdminDashboard(req, env as any);
      const body = await res.json() as any;
      expect(body.data.dailyRevenueCents).toBe(14500);
      expect(body.data.dailyRevenueFormatted).toBe('$145.00');
    });

    it('returns 500 on error', async () => {
      // Clear existing handlers so our error handler is the first match
      env.DB.clearHandlers();
      env.DB.onQuery(/SELECT.*mrr_snapshots/, () => { throw new Error('DB down'); });

      const req = adminRequest('GET', '/api/admin/dashboard');
      const res = await handleAdminDashboard(req, env as any);
      expect(res.status).toBe(500);
    });
  });

  // ─── MRR History ──────────────────────────────────────────────────────

  describe('handleMrrHistory()', () => {
    it('returns MRR snapshots with formatted values', async () => {
      const req = adminRequest('GET', '/api/admin/mrr?start=2024-01-01&end=2025-01-01');
      const res = await handleMrrHistory(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.snapshots).toBeDefined();
      expect(body.data.range.start).toBe('2024-01-01');
      expect(body.data.range.end).toBe('2025-01-01');
    });

    it('uses default start date when not provided', async () => {
      const req = adminRequest('GET', '/api/admin/mrr');
      const res = await handleMrrHistory(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.range.start).toBeTruthy();
    });
  });

  // ─── Email Management ─────────────────────────────────────────────────

  describe('handleListSequences()', () => {
    it('returns email sequences', async () => {
      env.DB.onQuery(/SELECT es\.\*.*COUNT.*email_sequences/, () => [
        { id: 1, name: 'Onboarding', trigger_event: 'user.converted', is_active: 1, step_count: 5 },
      ]);

      const req = adminRequest('GET', '/api/admin/emails/sequences');
      const res = await handleListSequences(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.sequences).toBeDefined();
    });
  });

  describe('handleListEmailSends()', () => {
    it('returns email sends with default limit', async () => {
      const req = adminRequest('GET', '/api/admin/emails/sends');
      const res = await handleListEmailSends(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.limit).toBeLessThanOrEqual(200);
    });

    it('filters by status when provided', async () => {
      const req = adminRequest('GET', '/api/admin/emails/sends?status=sent');
      const res = await handleListEmailSends(req, env as any);
      expect(res.status).toBe(200);

      // Check that the status filter was used in the query
      const statusQuery = env.DB._queries.find(q => q.params.includes('sent'));
      expect(statusQuery).toBeDefined();
    });

    it('respects custom limit', async () => {
      const req = adminRequest('GET', '/api/admin/emails/sends?limit=10');
      const res = await handleListEmailSends(req, env as any);
      const body = await res.json() as any;
      expect(body.data.limit).toBe(10);
    });

    it('caps limit at MAX_PAGE_SIZE', async () => {
      const req = adminRequest('GET', '/api/admin/emails/sends?limit=9999');
      const res = await handleListEmailSends(req, env as any);
      const body = await res.json() as any;
      expect(body.data.limit).toBeLessThanOrEqual(200);
    });
  });

  describe('handleProcessEmails()', () => {
    it('processes due emails and returns count', async () => {
      // Mock the due sends query to return empty (no emails to process)
      env.DB.onQuery(/email_sends.*scheduled_at/, () => []);

      const req = adminRequest('POST', '/api/admin/emails/process');
      const res = await handleProcessEmails(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.processed).toBeDefined();
    });
  });

  // ─── Contacts ─────────────────────────────────────────────────────────

  describe('handleListContacts()', () => {
    it('returns contacts list', async () => {
      const req = adminRequest('GET', '/api/admin/contacts');
      const res = await handleListContacts(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.contacts).toBeDefined();
      expect(body.data.page).toBe(1);
    });

    it('supports pagination', async () => {
      const req = adminRequest('GET', '/api/admin/contacts?page=2&limit=25');
      const res = await handleListContacts(req, env as any);
      const body = await res.json() as any;
      expect(body.data.page).toBe(2);
      expect(body.data.limit).toBe(25);
    });

    it('supports status filtering', async () => {
      const req = adminRequest('GET', '/api/admin/contacts?status=customer');
      const res = await handleListContacts(req, env as any);
      expect(res.status).toBe(200);

      const statusQuery = env.DB._queries.find(q => q.params.includes('customer'));
      expect(statusQuery).toBeDefined();
    });
  });

  // ─── Notifications ────────────────────────────────────────────────────

  describe('handleListNotifications()', () => {
    it('returns notification log', async () => {
      const req = adminRequest('GET', '/api/admin/notifications');
      const res = await handleListNotifications(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.notifications).toBeDefined();
    });

    it('respects limit parameter', async () => {
      const req = adminRequest('GET', '/api/admin/notifications?limit=10');
      const res = await handleListNotifications(req, env as any);
      const body = await res.json() as any;
      expect(body.data.limit).toBe(10);
    });
  });

  // ─── Share Admin Endpoints ────────────────────────────────────────────

  describe('handleListShareLeads()', () => {
    beforeEach(() => {
      env.DB.onQuery(/SELECT \* FROM share_leads/, () => [
        { id: 1, token: 'vs_abc', status: 'warm', pql_score: 25, owner_email: 'o@test.com' },
      ]);
      env.DB.onQuery(/SELECT COUNT.*share_leads/, () => [{ count: 1 }]);
    });

    it('returns share leads with pagination', async () => {
      const req = adminRequest('GET', '/api/admin/shares');
      const res = await handleListShareLeads(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.leads).toBeDefined();
      expect(body.data.total).toBe(1);
      expect(body.data.page).toBe(1);
    });

    it('filters by status', async () => {
      const req = adminRequest('GET', '/api/admin/shares?status=warm');
      const res = await handleListShareLeads(req, env as any);
      expect(res.status).toBe(200);
      const statusQuery = env.DB._queries.find(q => q.params.includes('warm'));
      expect(statusQuery).toBeDefined();
    });

    it('filters by owner', async () => {
      const req = adminRequest('GET', '/api/admin/shares?owner=o@test.com');
      const res = await handleListShareLeads(req, env as any);
      expect(res.status).toBe(200);
      const ownerQuery = env.DB._queries.find(q => q.params.includes('o@test.com'));
      expect(ownerQuery).toBeDefined();
    });

    it('supports pagination params', async () => {
      const req = adminRequest('GET', '/api/admin/shares?page=2&limit=10');
      const res = await handleListShareLeads(req, env as any);
      const body = await res.json() as any;
      expect(body.data.page).toBe(2);
      expect(body.data.limit).toBe(10);
    });
  });

  describe('handleListShareOwners()', () => {
    beforeEach(() => {
      env.DB.onQuery(/SELECT \* FROM share_owner_stats/, () => [
        { id: 1, owner_email: 'o@test.com', total_shares: 5, total_views: 100, total_conversions: 3 },
      ]);
      env.DB.onQuery(/SELECT COUNT.*share_owner_stats/, () => [{ count: 1 }]);
    });

    it('returns share owners sorted by conversions', async () => {
      const req = adminRequest('GET', '/api/admin/share-owners');
      const res = await handleListShareOwners(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.owners).toBeDefined();
      expect(body.data.total).toBe(1);
    });

    it('supports pagination', async () => {
      const req = adminRequest('GET', '/api/admin/share-owners?page=3&limit=5');
      const res = await handleListShareOwners(req, env as any);
      const body = await res.json() as any;
      expect(body.data.page).toBe(3);
      expect(body.data.limit).toBe(5);
    });
  });

  describe('handleListPQLLeads()', () => {
    beforeEach(() => {
      env.DB.onQuery(/SELECT \* FROM share_leads WHERE pql_score/, () => [
        { id: 1, token: 'vs_pql', status: 'pql', pql_score: 85, owner_email: 'o@test.com' },
      ]);
      env.DB.onQuery(/SELECT COUNT.*share_leads WHERE pql_score/, () => [{ count: 1 }]);
    });

    it('returns PQL leads with default minScore=50', async () => {
      const req = adminRequest('GET', '/api/admin/pql-leads');
      const res = await handleListPQLLeads(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.leads).toBeDefined();
      expect(body.data.minScore).toBe(50);
    });

    it('supports custom minScore', async () => {
      const req = adminRequest('GET', '/api/admin/pql-leads?minScore=80');
      const res = await handleListPQLLeads(req, env as any);
      const body = await res.json() as any;
      expect(body.data.minScore).toBe(80);
      const scoreQuery = env.DB._queries.find(q => q.params.includes(80));
      expect(scoreQuery).toBeDefined();
    });

    it('supports pagination', async () => {
      const req = adminRequest('GET', '/api/admin/pql-leads?page=2&limit=15');
      const res = await handleListPQLLeads(req, env as any);
      const body = await res.json() as any;
      expect(body.data.page).toBe(2);
      expect(body.data.limit).toBe(15);
    });
  });

  // ─── Dashboard Share Metrics ──────────────────────────────────────────

  describe('dashboard share PLG metrics', () => {
    beforeEach(() => {
      env.DB.onQuery(/share_leads WHERE status = 'pql'/, () => [{ count: 7 }]);
      env.DB.onQuery(/share_leads[\s\S]*WHERE status = 'converted'/, () => [{ count: 2 }]);
    });

    it('includes dailyShareViews from KV', async () => {
      const today = new Date().toISOString().slice(0, 10);
      await env.KV_MARKETING.put(`daily-share-views:${today}`, '42');

      const req = adminRequest('GET', '/api/admin/dashboard');
      const res = await handleAdminDashboard(req, env as any);
      const body = await res.json() as any;
      expect(body.data.metrics.dailyShareViews).toBe(42);
    });

    it('includes totalPQLs from D1', async () => {
      const req = adminRequest('GET', '/api/admin/dashboard');
      const res = await handleAdminDashboard(req, env as any);
      const body = await res.json() as any;
      expect(body.data.metrics.totalPQLs).toBe(7);
    });

    it('includes shareConversionsToday from D1', async () => {
      const req = adminRequest('GET', '/api/admin/dashboard');
      const res = await handleAdminDashboard(req, env as any);
      const body = await res.json() as any;
      expect(body.data.metrics.shareConversionsToday).toBe(2);
    });
  });
});
