/**
 * Database helpers — utility functions for D1 queries.
 */

import type { Env } from '../types';

/**
 * Run a single D1 query and return all rows.
 */
export async function query<T = Record<string, unknown>>(
  db: Env['DB'],
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const stmt = db.prepare(sql).bind(...params);
  const result = await stmt.all<T>();
  return result.results ?? [];
}

/**
 * Run a single D1 query and return the first row or null.
 */
export async function queryOne<T = Record<string, unknown>>(
  db: Env['DB'],
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const stmt = db.prepare(sql).bind(...params);
  const result = await stmt.first<T>();
  return result ?? null;
}

/**
 * Run a D1 statement (INSERT/UPDATE/DELETE) and return metadata.
 */
export async function execute(
  db: Env['DB'],
  sql: string,
  params: unknown[] = []
) {
  const stmt = db.prepare(sql).bind(...params);
  return stmt.run();
}

/**
 * Run multiple D1 statements in a batch (transaction-like).
 */
export async function batch(
  db: Env['DB'],
  statements: { sql: string; params?: unknown[] }[]
) {
  const prepared = statements.map((s) =>
    db.prepare(s.sql).bind(...(s.params ?? []))
  );
  return db.batch(prepared);
}

/**
 * Get current unix epoch in seconds.
 */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Hash an email for privacy-safe logging (first 16 hex chars of SHA-256).
 */
export async function hashEmail(email: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(email.toLowerCase().trim());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * Format cents to dollar string (e.g. 2900 → "$29.00").
 */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Get today's date key (YYYY-MM-DD) in UTC.
 */
export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
