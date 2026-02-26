/**
 * Unit Tests — Database Helpers
 *
 * Tests utility functions: now(), hashEmail(), formatCents(), todayKey()
 * and D1 query wrappers.
 */

import { describe, it, expect, vi } from 'vitest';
import { now, hashEmail, formatCents, todayKey, query, queryOne, execute, batch } from '../../src/lib/db';
import { MockD1Database } from '../helpers';

describe('db helpers', () => {
  describe('now()', () => {
    it('returns a unix timestamp in seconds', () => {
      const ts = now();
      expect(ts).toBeTypeOf('number');
      // Should be within a few seconds of Date.now() / 1000
      expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(5);
    });

    it('returns an integer', () => {
      expect(Number.isInteger(now())).toBe(true);
    });
  });

  describe('hashEmail()', () => {
    it('returns a 16-character hex string', async () => {
      const hash = await hashEmail('test@example.com');
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('is case-insensitive', async () => {
      const a = await hashEmail('Test@EXAMPLE.com');
      const b = await hashEmail('test@example.com');
      expect(a).toBe(b);
    });

    it('trims whitespace', async () => {
      const a = await hashEmail('  test@example.com  ');
      const b = await hashEmail('test@example.com');
      expect(a).toBe(b);
    });

    it('produces different hashes for different inputs', async () => {
      const a = await hashEmail('alice@example.com');
      const b = await hashEmail('bob@example.com');
      expect(a).not.toBe(b);
    });

    it('is deterministic', async () => {
      const a = await hashEmail('deterministic@test.com');
      const b = await hashEmail('deterministic@test.com');
      expect(a).toBe(b);
    });
  });

  describe('formatCents()', () => {
    it('formats 0 as $0.00', () => {
      expect(formatCents(0)).toBe('$0.00');
    });

    it('formats 100 cents as $1.00', () => {
      expect(formatCents(100)).toBe('$1.00');
    });

    it('formats 2999 cents as $29.99', () => {
      expect(formatCents(2999)).toBe('$29.99');
    });

    it('formats large amounts correctly', () => {
      expect(formatCents(100_000)).toBe('$1000.00');
    });

    it('handles single-cent amounts', () => {
      expect(formatCents(1)).toBe('$0.01');
    });
  });

  describe('todayKey()', () => {
    it('returns a YYYY-MM-DD string', () => {
      const key = todayKey();
      expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('query()', () => {
    it('calls prepare/bind/all and returns results', async () => {
      const db = new MockD1Database();
      db.onQuery(/SELECT/, () => [{ id: 1, name: 'test' }]);

      const results = await query(db as any, 'SELECT * FROM foo WHERE id = ?', [1]);
      expect(results).toEqual([{ id: 1, name: 'test' }]);
      expect(db._queries).toHaveLength(1);
      expect(db._queries[0].params).toEqual([1]);
    });

    it('returns empty array for no results', async () => {
      const db = new MockD1Database();
      const results = await query(db as any, 'SELECT * FROM empty');
      expect(results).toEqual([]);
    });
  });

  describe('queryOne()', () => {
    it('returns first row', async () => {
      const db = new MockD1Database();
      db.onQuery(/SELECT/, () => [{ id: 1, title: 'first' }]);

      const result = await queryOne(db as any, 'SELECT * FROM items LIMIT 1');
      expect(result).toEqual({ id: 1, title: 'first' });
    });

    it('returns null for no results', async () => {
      const db = new MockD1Database();
      const result = await queryOne(db as any, 'SELECT * FROM empty WHERE id = ?', [999]);
      expect(result).toBeNull();
    });
  });

  describe('execute()', () => {
    it('runs an INSERT and returns success metadata', async () => {
      const db = new MockD1Database();
      const result = await execute(db as any, 'INSERT INTO foo (name) VALUES (?)', ['bar']);
      expect(result.success).toBe(true);
      expect(db._queries).toHaveLength(1);
    });
  });

  describe('batch()', () => {
    it('executes multiple statements', async () => {
      const db = new MockD1Database();
      const results = await batch(db as any, [
        { sql: 'INSERT INTO a (x) VALUES (?)', params: [1] },
        { sql: 'INSERT INTO b (y) VALUES (?)', params: [2] },
      ]);
      expect(results).toHaveLength(2);
      expect(db._queries).toHaveLength(2);
    });
  });
});
