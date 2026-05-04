/**
 * Outbound Event Handler Tests
 *
 * Tests for handleProspectDiscovered() and handleProspectEnriched() —
 * CRM upsert, KV context storage, sequence enrollment, personal email filtering.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleProspectDiscovered, handleProspectEnriched } from '../../src/events/outbound-events';
import { createMockEnv, type MockEnv } from '../helpers';
import { KV_PREFIX } from '../../src/constants';
import type { OutboundProspectDiscoveredData, OutboundProspectEnrichedData } from '../../src/types';

describe('handleProspectDiscovered()', () => {
  let env: MockEnv;
  const timestamp = new Date().toISOString();

  beforeEach(() => {
    env = createMockEnv();
    // Default: no existing contact (INSERT path)
    env.DB.onQuery(/SELECT.*marketing_contacts.*WHERE email/, () => []);
    // No existing sequence enrollment
    env.DB.onQuery(/SELECT.*email_sends.*contact_email/, () => []);
    // By default, no active sequences for this trigger
    env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => []);
  });

  const baseProspect: OutboundProspectDiscoveredData = {
    prospectId: 42,
    domain: 'acme.com',
    companyName: 'Acme Inc',
    contactEmail: 'john@acme.com',
    contactName: 'John Doe',
    contactTitle: 'CTO',
    source: 'hackernews',
    sourceUrl: 'https://news.ycombinator.com/item?id=123',
    industry: 'SaaS',
    employeeRange: '11-50',
    score: 72,
    description: 'A SaaS company',
  };

  // ─── CRM upsert ─────────────────────────────────────────────────────

  describe('CRM contact upsert', () => {
    it('creates a new contact as "prospect" with source "outbound"', async () => {
      await handleProspectDiscovered(env as any, baseProspect, timestamp);

      const insertQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('INSERT INTO marketing_contacts')
      );
      expect(insertQuery).toBeDefined();
      // Check status = 'prospect' position (idx 1) and source = 'outbound' (idx 2)
      expect(insertQuery!.params[1]).toBe('prospect');
      expect(insertQuery!.params[2]).toBe('outbound');
    });

    it('stores prospect metadata as JSON', async () => {
      await handleProspectDiscovered(env as any, baseProspect, timestamp);

      const insertQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('INSERT INTO marketing_contacts')
      );
      const metadata = JSON.parse(insertQuery!.params[7] as string);
      expect(metadata.prospectId).toBe(42);
      expect(metadata.domain).toBe('acme.com');
      expect(metadata.companyName).toBe('Acme Inc');
      expect(metadata.prospectSource).toBe('hackernews');
    });
  });

  // ─── Personal email filtering ───────────────────────────────────────

  describe('personal email filtering', () => {
    it('skips contacts with gmail.com addresses', async () => {
      await handleProspectDiscovered(
        env as any,
        { ...baseProspect, contactEmail: 'john@gmail.com' },
        timestamp
      );

      const contactQueries = env.DB._queries.filter((q: any) =>
        q.sql.includes('marketing_contacts')
      );
      expect(contactQueries.length).toBe(0);
    });

    it('skips contacts with yahoo.com addresses', async () => {
      await handleProspectDiscovered(
        env as any,
        { ...baseProspect, contactEmail: 'john@yahoo.com' },
        timestamp
      );

      const contactQueries = env.DB._queries.filter((q: any) =>
        q.sql.includes('marketing_contacts')
      );
      expect(contactQueries.length).toBe(0);
    });

    it('skips contacts with hotmail.com addresses', async () => {
      await handleProspectDiscovered(
        env as any,
        { ...baseProspect, contactEmail: 'john@hotmail.com' },
        timestamp
      );

      const contactQueries = env.DB._queries.filter((q: any) =>
        q.sql.includes('marketing_contacts')
      );
      expect(contactQueries.length).toBe(0);
    });

    it('allows business domain emails', async () => {
      await handleProspectDiscovered(env as any, baseProspect, timestamp);

      const contactQueries = env.DB._queries.filter((q: any) =>
        q.sql.includes('marketing_contacts')
      );
      expect(contactQueries.length).toBeGreaterThan(0);
    });
  });

  // ─── No email handling ──────────────────────────────────────────────

  describe('missing email', () => {
    it('skips CRM upsert when no contactEmail', async () => {
      await handleProspectDiscovered(
        env as any,
        { ...baseProspect, contactEmail: null },
        timestamp
      );

      const contactQueries = env.DB._queries.filter((q: any) =>
        q.sql.includes('marketing_contacts')
      );
      expect(contactQueries.length).toBe(0);
    });

    it('does not store KV context when no email', async () => {
      await handleProspectDiscovered(
        env as any,
        { ...baseProspect, contactEmail: null },
        timestamp
      );

      expect(env.KV_MARKETING._store.size).toBe(0);
    });
  });

  // ─── KV context storage ─────────────────────────────────────────────

  describe('KV context storage', () => {
    it('stores prospect context in KV for template rendering', async () => {
      await handleProspectDiscovered(env as any, baseProspect, timestamp);

      const contextKey = `${KV_PREFIX.EMAIL_CONTEXT}john@acme.com:cold-outreach`;
      const stored = await env.KV_MARKETING.get(contextKey);
      expect(stored).toBeTruthy();

      const parsed = JSON.parse(stored!);
      expect(parsed.domain).toBe('acme.com');
      expect(parsed.companyName).toBe('Acme Inc');
      expect(parsed.contactName).toBe('John Doe');
      expect(parsed.score).toBe(72);
    });
  });

  // ─── Sequence enrollment ───────────────────────────────────────────

  describe('sequence enrollment', () => {
    it('enrolls prospects with score >= 40 in cold outreach', async () => {
      env.DB.clearHandlers();
      env.DB.onQuery(/SELECT.*marketing_contacts.*WHERE email/, () => []);
      env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => [
        { id: 10, name: 'Cold Outreach v1', trigger_event: 'outbound.prospect_discovered', is_active: 1 },
      ]);
      env.DB.onQuery(/SELECT.*email_steps.*sequence_id/, () => [
        { id: 20, sequence_id: 10, step_order: 1, delay_seconds: 0, is_active: 1 },
        { id: 21, sequence_id: 10, step_order: 2, delay_seconds: 259200, is_active: 1 },
        { id: 22, sequence_id: 10, step_order: 3, delay_seconds: 604800, is_active: 1 },
      ]);
      env.DB.onQuery(/SELECT.*email_sends.*contact_email/, () => []);

      await handleProspectDiscovered(env as any, baseProspect, timestamp);

      const insertSends = env.DB._queries.filter((q: any) =>
        q.sql.includes('INSERT INTO email_sends')
      );
      expect(insertSends.length).toBe(3);
    });

    it('suppresses cold outreach when a warmer product-user channel is already active', async () => {
      env.DB.clearHandlers();
      env.DB.onQuery(/SELECT.*marketing_contacts.*WHERE email/, () => []);
      env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => [
        { id: 10, name: 'Cold Outreach v1', trigger_event: 'outbound.prospect_discovered', is_active: 1 },
      ]);
      env.DB.onQuery(/FROM contact_channel_identities/i, () => [
        {
          channel: 'push',
          registrationState: 'registered',
          availabilityState: 'available',
          consentState: 'opted_in',
        },
      ]);

      await handleProspectDiscovered(env as any, baseProspect, timestamp);

      const insertSends = env.DB._queries.filter((q: any) =>
        q.sql.includes('INSERT INTO email_sends')
      );
      expect(insertSends.length).toBe(0);
      expect(
        env.DB._queries.some((q: any) => q.sql.includes("UPDATE email_sends SET status = 'cancelled'"))
      ).toBe(true);
    });

    it('does NOT enroll prospects with score < 40', async () => {
      await handleProspectDiscovered(
        env as any,
        { ...baseProspect, score: 25 },
        timestamp
      );

      // Should still upsert contact, but NOT enroll in sequence
      const contactQueries = env.DB._queries.filter((q: any) =>
        q.sql.includes('marketing_contacts')
      );
      expect(contactQueries.length).toBeGreaterThan(0);

      // No sequence queries (enrollInSequences not called)
      const seqQueries = env.DB._queries.filter((q: any) =>
        q.sql.includes('email_sequences')
      );
      expect(seqQueries.length).toBe(0);
    });

    it('does not throw when no active sequences exist', async () => {
      await expect(
        handleProspectDiscovered(env as any, baseProspect, timestamp)
      ).resolves.not.toThrow();
    });
  });
});

describe('handleProspectEnriched()', () => {
  let env: MockEnv;
  const timestamp = new Date().toISOString();

  beforeEach(() => {
    env = createMockEnv();
    // Existing contact (UPDATE path)
    env.DB.onQuery(/SELECT.*marketing_contacts.*WHERE email/, () => [
      { id: 1, email: 'john@acme.com', status: 'prospect', source: 'outbound' },
    ]);
  });

  const baseEnrichment: OutboundProspectEnrichedData = {
    prospectId: 42,
    domain: 'acme.com',
    companyName: 'Acme Inc',
    contactEmail: 'john@acme.com',
    contactName: 'John Doe',
    score: 72,
    auditScore: 45,
    auditGrade: 'D',
    issueCount: 8,
    passCount: 3,
    techStack: ['Next.js', 'Vercel'],
    trafficEstimate: 'medium',
    primaryTopic: 'developer tools',
    angles: [
      { type: 'missing_schema', hook: 'No structured data', detail: 'Add JSON-LD Organization schema' },
    ],
    wordCount: 320,
  };

  // ─── Contact metadata update ────────────────────────────────────────

  describe('contact metadata update', () => {
    it('updates existing contact metadata with enrichment data', async () => {
      await handleProspectEnriched(env as any, baseEnrichment, timestamp);

      const updateQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('UPDATE marketing_contacts')
      );
      expect(updateQuery).toBeDefined();
    });

    it('skips when no contactEmail present', async () => {
      await handleProspectEnriched(
        env as any,
        { ...baseEnrichment, contactEmail: null },
        timestamp
      );

      const contactQueries = env.DB._queries.filter((q: any) =>
        q.sql.includes('marketing_contacts')
      );
      expect(contactQueries.length).toBe(0);
    });

    it('does not downgrade existing "lead" status to "prospect"', async () => {
      env.DB.clearHandlers();
      // Contact already promoted to 'lead'
      env.DB.onQuery(/SELECT.*marketing_contacts.*WHERE email/, () => [
        { id: 1, email: 'john@acme.com', status: 'lead', source: 'outbound' },
      ]);

      await handleProspectEnriched(env as any, baseEnrichment, timestamp);

      const updateQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('UPDATE marketing_contacts')
      );
      expect(updateQuery).toBeDefined();
      // Should NOT contain 'status' in the SET clause (only metadata + updated_at)
      expect(updateQuery!.sql).not.toMatch(/status\s*=/);
    });

    it('sets prospect status when contact does not exist yet (race condition)', async () => {
      env.DB.clearHandlers();
      // No existing contact — enrichment arrives before discovery
      env.DB.onQuery(/SELECT.*marketing_contacts.*WHERE email/, () => []);

      await handleProspectEnriched(env as any, baseEnrichment, timestamp);

      const insertQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('INSERT INTO marketing_contacts')
      );
      expect(insertQuery).toBeDefined();
      // Should create with 'prospect' status and 'outbound' source
      expect(insertQuery!.params[1]).toBe('prospect');
      expect(insertQuery!.params[2]).toBe('outbound');
    });
  });

  // ─── KV context update ──────────────────────────────────────────────

  describe('KV context enrichment', () => {
    it('stores enrichment data in KV for template rendering', async () => {
      await handleProspectEnriched(env as any, baseEnrichment, timestamp);

      const contextKey = `${KV_PREFIX.EMAIL_CONTEXT}john@acme.com:cold-outreach`;
      const stored = await env.KV_MARKETING.get(contextKey);
      expect(stored).toBeTruthy();

      const parsed = JSON.parse(stored!);
      expect(parsed.auditScore).toBe(45);
      expect(parsed.auditGrade).toBe('D');
      expect(parsed.issueCount).toBe(8);
      expect(parsed.passCount).toBe(3);
      expect(parsed.techStack).toEqual(['Next.js', 'Vercel']);
      expect(parsed.primaryTopic).toBe('developer tools');
      expect(parsed.angles).toHaveLength(1);
      expect(parsed.angles[0].type).toBe('missing_schema');
    });

    it('merges with existing KV context (preserves discovery data)', async () => {
      // Pre-populate context from discovery
      const contextKey = `${KV_PREFIX.EMAIL_CONTEXT}john@acme.com:cold-outreach`;
      await env.KV_MARKETING.put(contextKey, JSON.stringify({
        domain: 'acme.com',
        companyName: 'Acme Inc',
        contactName: 'John Doe',
        prospectSource: 'hackernews',
        score: 65,
      }));

      await handleProspectEnriched(env as any, baseEnrichment, timestamp);

      const stored = await env.KV_MARKETING.get(contextKey);
      const parsed = JSON.parse(stored!);

      // Enrichment data present
      expect(parsed.auditScore).toBe(45);
      expect(parsed.auditGrade).toBe('D');
      // Discovery data preserved (from spread)
      expect(parsed.prospectSource).toBe('hackernews');
    });
  });
});
