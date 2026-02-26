/**
 * Unit Tests — CRM Module
 *
 * Tests contact lifecycle: upsert, markAsCustomer, markAsChurned, getContact.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { upsertContact, getContact, markAsCustomer, markAsChurned } from '../../src/lib/crm';
import { createMockEnv, type MockEnv } from '../helpers';

describe('crm', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  describe('upsertContact()', () => {
    it('inserts a new contact when none exists', async () => {
      // No handler registered → queryOne returns null → triggers INSERT
      await upsertContact(env as any, 'alice@example.com', {
        status: 'lead',
        source: 'organic',
      });

      const queries = env.DB._queries;
      expect(queries.length).toBeGreaterThanOrEqual(2);

      // First query: SELECT to check existence
      expect(queries[0].sql).toContain('SELECT');
      expect(queries[0].params).toContain('alice@example.com');

      // Second query: INSERT
      expect(queries[1].sql).toContain('INSERT INTO marketing_contacts');
    });

    it('updates an existing contact', async () => {
      // Register a handler so queryOne finds an existing contact
      env.DB.onQuery(/SELECT \* FROM marketing_contacts/, () => [
        {
          id: 1,
          email: 'bob@example.com',
          status: 'lead',
          source: 'organic',
          total_spent_cents: 0,
        },
      ]);

      await upsertContact(env as any, 'bob@example.com', {
        status: 'customer',
        plan: 'pro',
      });

      const updateQuery = env.DB._queries.find((q) => q.sql.includes('UPDATE'));
      expect(updateQuery).toBeTruthy();
      expect(updateQuery!.sql).toContain('marketing_contacts');
    });
  });

  describe('markAsCustomer()', () => {
    it('calls upsertContact with customer status', async () => {
      await markAsCustomer(env as any, 'buyer@test.com', 'pro', 'stripe', 2900);

      // Should have SELECT + INSERT (since no existing)
      expect(env.DB._queries.some((q) => q.sql.includes('marketing_contacts'))).toBe(true);
    });

    it('includes affiliate code when provided', async () => {
      await markAsCustomer(env as any, 'buyer@test.com', 'pro', 'stripe', 2900, 'aff-123');

      const insertQuery = env.DB._queries.find((q) => q.sql.includes('INSERT'));
      expect(insertQuery).toBeTruthy();
      // affiliate_code should be in the params
      expect(insertQuery!.params).toContain('aff-123');
    });
  });

  describe('markAsChurned()', () => {
    it('calls upsertContact with churned status', async () => {
      await markAsChurned(env as any, 'churning@test.com');
      expect(env.DB._queries.some((q) => q.sql.includes('marketing_contacts'))).toBe(true);
    });
  });

  describe('getContact()', () => {
    it('returns a contact when found', async () => {
      env.DB.onQuery(/SELECT \* FROM marketing_contacts/, () => [
        { id: 1, email: 'found@test.com', status: 'customer' },
      ]);

      const contact = await getContact(env as any, 'found@test.com');
      expect(contact).not.toBeNull();
      expect(contact!.email).toBe('found@test.com');
    });

    it('returns null when not found', async () => {
      const contact = await getContact(env as any, 'missing@test.com');
      expect(contact).toBeNull();
    });
  });
});
