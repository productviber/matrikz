/**
 * Tests — Email Domain Verification (MX check via DNS-over-HTTPS)
 *
 * Covers verifyEmailDomain() — MX record checking, disposable domain blocking,
 * KV caching, and graceful fallback on DNS errors.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { verifyEmailDomain } from '../../src/lib/email/verify';
import { createMockKV, type MockKVNamespace } from '../helpers';
import { KV_PREFIX } from '../../src/constants';

// Mock the global fetch for DNS-over-HTTPS calls
const fetchSpy = vi.fn();
vi.stubGlobal('fetch', fetchSpy);

describe('verifyEmailDomain()', () => {
  let kv: MockKVNamespace;

  beforeEach(() => {
    kv = createMockKV();
    fetchSpy.mockReset();
  });

  // ── Valid domains ─────────────────────────────────────────────────

  it('returns valid for domains with MX records', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      Answer: [{ type: 15, data: '10 mx.acme.com.' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await verifyEmailDomain(kv, 'john@acme.com');
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  // ── Invalid domains ───────────────────────────────────────────────

  it('returns invalid for domains with no MX records', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      Answer: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await verifyEmailDomain(kv, 'user@no-mail.example');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('no_mx_records');
  });

  it('returns invalid for domains with only non-MX DNS records', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      Answer: [{ type: 1, data: '1.2.3.4' }], // A record, not MX
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await verifyEmailDomain(kv, 'user@no-mx.example');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('no_mx_records');
  });

  it('returns invalid for missing Answer field', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));

    const result = await verifyEmailDomain(kv, 'user@empty-answer.example');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('no_mx_records');
  });

  // ── Disposable domain blocking ────────────────────────────────────

  it('blocks known disposable email domains', async () => {
    const result = await verifyEmailDomain(kv, 'spam@mailinator.com');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('disposable_domain');
    // Should NOT have made a DNS request
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks guerrillamail.com', async () => {
    const result = await verifyEmailDomain(kv, 'temp@guerrillamail.com');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('disposable_domain');
  });

  it('blocks yopmail.com', async () => {
    const result = await verifyEmailDomain(kv, 'x@yopmail.com');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('disposable_domain');
  });

  // ── Edge: malformed input ─────────────────────────────────────────

  it('returns invalid for email without @', async () => {
    const result = await verifyEmailDomain(kv, 'nodomain');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_format');
  });

  it('returns invalid for email with empty domain', async () => {
    const result = await verifyEmailDomain(kv, 'user@');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_format');
  });

  // ── KV caching ────────────────────────────────────────────────────

  it('returns cached valid result without calling fetch', async () => {
    const cacheKey = `${KV_PREFIX.OUTBOUND_DELIVERABILITY}mx:cached.com`;
    await kv.put(cacheKey, JSON.stringify({ valid: true }));

    const result = await verifyEmailDomain(kv, 'user@cached.com');
    expect(result.valid).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns cached invalid result without calling fetch', async () => {
    const cacheKey = `${KV_PREFIX.OUTBOUND_DELIVERABILITY}mx:bad.com`;
    await kv.put(cacheKey, JSON.stringify({ valid: false, reason: 'no_mx_records' }));

    const result = await verifyEmailDomain(kv, 'user@bad.com');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('no_mx_records');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('caches valid results after DNS lookup', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      Answer: [{ type: 15, data: '10 mx.fresh.com.' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await verifyEmailDomain(kv, 'user@fresh.com');

    const cacheKey = `${KV_PREFIX.OUTBOUND_DELIVERABILITY}mx:fresh.com`;
    const cached = await kv.get(cacheKey);
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached!).valid).toBe(true);
  });

  it('caches invalid results after DNS lookup', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      Answer: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await verifyEmailDomain(kv, 'user@nomail.com');

    const cacheKey = `${KV_PREFIX.OUTBOUND_DELIVERABILITY}mx:nomail.com`;
    const cached = await kv.get(cacheKey);
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached!).valid).toBe(false);
  });

  // ── Graceful degradation on errors ────────────────────────────────

  it('returns valid on DNS HTTP error (does not block sending)', async () => {
    fetchSpy.mockResolvedValue(new Response('Server Error', { status: 500 }));

    const result = await verifyEmailDomain(kv, 'user@error-domain.com');
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('dns_lookup_error');
  });

  it('returns valid on network/timeout error (does not block sending)', async () => {
    fetchSpy.mockRejectedValue(new Error('AbortError: The operation was aborted'));

    const result = await verifyEmailDomain(kv, 'user@timeout-domain.com');
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('dns_timeout');
  });

  it('does NOT cache DNS error results (allows retry next time)', async () => {
    fetchSpy.mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

    await verifyEmailDomain(kv, 'user@transient.com');

    const cacheKey = `${KV_PREFIX.OUTBOUND_DELIVERABILITY}mx:transient.com`;
    const cached = await kv.get(cacheKey);
    expect(cached).toBeNull();
  });

  it('does NOT cache timeout results', async () => {
    fetchSpy.mockRejectedValue(new Error('timeout'));

    await verifyEmailDomain(kv, 'user@slow.com');

    const cacheKey = `${KV_PREFIX.OUTBOUND_DELIVERABILITY}mx:slow.com`;
    const cached = await kv.get(cacheKey);
    expect(cached).toBeNull();
  });

  // ── DNS request correctness ───────────────────────────────────────

  it('queries Cloudflare DoH with correct MX type', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ Answer: [{ type: 15, data: 'mx' }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));

    await verifyEmailDomain(kv, 'test@query-check.com');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain('cloudflare-dns.com/dns-query');
    expect(url).toContain('name=query-check.com');
    expect(url).toContain('type=MX');
    expect(init.headers.Accept).toBe('application/dns-json');
  });
});
