/**
 * Tests — Correlation ID System
 *
 * Covers setCorrelationId(), getCorrelationId(), clearCorrelationId(),
 * correlationIdFromRequest(), correlationHeaders(), and structuredLog/Warn/Error().
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setCorrelationId,
  getCorrelationId,
  clearCorrelationId,
  correlationIdFromRequest,
  correlationHeaders,
  structuredLog,
  structuredWarn,
  structuredError,
} from '../../src/lib/correlation';

describe('Correlation ID lifecycle', () => {
  beforeEach(() => {
    clearCorrelationId();
  });

  it('setCorrelationId() with explicit ID stores and returns it', () => {
    const id = setCorrelationId('test-abc-123');
    expect(id).toBe('test-abc-123');
    expect(getCorrelationId()).toBe('test-abc-123');
  });

  it('setCorrelationId() without argument generates a unique ID', () => {
    const id = setCorrelationId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(5);
  });

  it('generates different IDs on successive calls', () => {
    const id1 = setCorrelationId();
    clearCorrelationId();
    const id2 = setCorrelationId();
    expect(id1).not.toBe(id2);
  });

  it('getCorrelationId() auto-generates if not set', () => {
    const id = getCorrelationId();
    expect(id).toBeTruthy();
    // Subsequent calls return the same id
    expect(getCorrelationId()).toBe(id);
  });

  it('clearCorrelationId() resets the state', () => {
    setCorrelationId('will-be-cleared');
    clearCorrelationId();
    // Next get should generate a new one
    const newId = getCorrelationId();
    expect(newId).not.toBe('will-be-cleared');
  });
});

describe('correlationIdFromRequest()', () => {
  beforeEach(() => {
    clearCorrelationId();
  });

  it('extracts existing x-correlation-id from request headers', () => {
    const req = new Request('https://test.workers.dev/events', {
      headers: { 'x-correlation-id': 'from-analytics-xyz' },
    });
    const id = correlationIdFromRequest(req);
    expect(id).toBe('from-analytics-xyz');
    expect(getCorrelationId()).toBe('from-analytics-xyz');
  });

  it('generates new ID when header is not present', () => {
    const req = new Request('https://test.workers.dev/events');
    const id = correlationIdFromRequest(req);
    expect(id).toBeTruthy();
    expect(id.length).toBeGreaterThan(5);
  });

  it('generates new ID when header is empty string', () => {
    const req = new Request('https://test.workers.dev/events', {
      headers: { 'x-correlation-id': '' },
    });
    const id = correlationIdFromRequest(req);
    expect(id).toBeTruthy();
    expect(id.length).toBeGreaterThan(5);
  });
});

describe('correlationHeaders()', () => {
  beforeEach(() => {
    clearCorrelationId();
  });

  it('includes x-correlation-id in the returned headers', () => {
    setCorrelationId('header-test-123');
    const headers = correlationHeaders();
    expect(headers['x-correlation-id']).toBe('header-test-123');
  });

  it('merges extra headers', () => {
    setCorrelationId('merge-test');
    const headers = correlationHeaders({ 'Content-Type': 'application/json' });
    expect(headers['x-correlation-id']).toBe('merge-test');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('extra headers override correlation if explicitly passed (unlikely edge)', () => {
    setCorrelationId('default');
    const headers = correlationHeaders({ 'x-correlation-id': 'override' });
    expect(headers['x-correlation-id']).toBe('override');
  });
});

describe('structured logging', () => {
  beforeEach(() => {
    clearCorrelationId();
    vi.restoreAllMocks();
  });

  it('structuredLog formats as [module] cid:... message', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setCorrelationId('log-test');

    structuredLog('Email', 'Sent cold outreach');

    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('[Email]');
    expect(output).toContain('cid:log-test');
    expect(output).toContain('Sent cold outreach');
  });

  it('structuredLog appends JSON data when provided', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setCorrelationId('data-test');

    structuredLog('CRM', 'Upserted contact', { email: 'test@acme.com', status: 'prospect' });

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('"email":"test@acme.com"');
    expect(output).toContain('"status":"prospect"');
  });

  it('structuredWarn uses console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setCorrelationId('warn-test');

    structuredWarn('Verify', 'DNS lookup slow');

    expect(warnSpy).toHaveBeenCalledOnce();
    const output = warnSpy.mock.calls[0][0] as string;
    expect(output).toContain('[Verify]');
    expect(output).toContain('cid:warn-test');
  });

  it('structuredError uses console.error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setCorrelationId('err-test');

    structuredError('Scheduler', 'Cron failed', { step: 'enrichment' });

    expect(errorSpy).toHaveBeenCalledOnce();
    const output = errorSpy.mock.calls[0][0] as string;
    expect(output).toContain('[Scheduler]');
    expect(output).toContain('cid:err-test');
    expect(output).toContain('"step":"enrichment"');
  });
});
