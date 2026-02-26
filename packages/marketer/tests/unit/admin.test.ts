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

  // ─── Auth Gates ────────────────────────────────────────────────────────

  describe('auth requirements', () => {
    it('dashboard requires admin auth', async () => {
      const req = makeRequest('GET', '/api/admin/dashboard');
      const res = await handleAdminDashboard(req, env as any);
      expect(res.status).toBe(401);
    });

    it('MRR history requires admin auth', async () => {
      const req = makeRequest('GET', '/api/admin/mrr');
      const res = await handleMrrHistory(req, env as any);
      expect(res.status).toBe(401);
    });

    it('list sequences requires admin auth', async () => {
      const req = makeRequest('GET', '/api/admin/emails/sequences');
      const res = await handleListSequences(req, env as any);
      expect(res.status).toBe(401);
    });

    it('list email sends requires admin auth', async () => {
      const req = makeRequest('GET', '/api/admin/emails/sends');
      const res = await handleListEmailSends(req, env as any);
      expect(res.status).toBe(401);
    });

    it('process emails requires admin auth', async () => {
      const req = makeRequest('POST', '/api/admin/emails/process');
      const res = await handleProcessEmails(req, env as any);
      expect(res.status).toBe(401);
    });

    it('list contacts requires admin auth', async () => {
      const req = makeRequest('GET', '/api/admin/contacts');
      const res = await handleListContacts(req, env as any);
      expect(res.status).toBe(401);
    });

    it('list notifications requires admin auth', async () => {
      const req = makeRequest('GET', '/api/admin/notifications');
      const res = await handleListNotifications(req, env as any);
      expect(res.status).toBe(401);
    });
  });

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
});
