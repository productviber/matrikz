/**
 * Integration Tests — Event Router
 *
 * Tests the full POST /events flow: envelope validation, source
 * checking, and event dispatch to handlers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { routeEvent } from '../../src/events/router';
import { createMockEnv, createMockCtx, type MockEnv } from '../helpers';

describe('event router', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  function makeEventRequest(body: unknown): Request {
    return new Request('https://test.workers.dev/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('rejects events from unknown sources', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'affiliate.conversion',
      source: 'unknown-service',
      timestamp: new Date().toISOString(),
      data: {},
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Unknown source');
  });

  it('rejects invalid envelopes (missing event)', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {},
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('Invalid event envelope');
  });

  it('rejects invalid envelopes (missing data)', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'affiliate.conversion',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(400);
  });

  it('accepts and routes affiliate.conversion events', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'affiliate.conversion',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        affiliateCode: 'test-aff',
        userId: 'user@test.com',
        eventType: 'purchase',
        amountCents: 2900,
        commissionCents: 580,
        plan: 'pro',
      },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.event).toBe('affiliate.conversion');
  });

  it('accepts and routes user.converted events', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'user.converted',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        userId: 'user@test.com',
        purchaseType: 'base',
        plan: 'monthly',
        amountCents: 2900,
        gateway: 'stripe',
      },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.event).toBe('user.converted');
  });

  it('accepts unknown events for forward compatibility', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'some.future.event',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: { foo: 'bar' },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
  });

  it('handles future event stubs (user.signup)', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'user.signup',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: { userId: 'new@test.com', provider: 'google' },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
  });

  it('returns 500 for malformed JSON', async () => {
    const ctx = createMockCtx();
    const req = new Request('https://test.workers.dev/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json{{{',
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(500);
  });
});
