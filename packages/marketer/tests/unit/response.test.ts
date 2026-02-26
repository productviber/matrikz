/**
 * Unit Tests — Response Helpers
 *
 * Validates all HTTP response factory functions, CORS headers, and JSON format.
 */

import { describe, it, expect } from 'vitest';
import { json, ok, created, badRequest, unauthorized, notFound, serverError, corsPreflightResponse } from '../../src/lib/response';

describe('response helpers', () => {
  describe('json()', () => {
    it('returns a Response with JSON content type', () => {
      const res = json({ test: true });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json');
    });

    it('accepts a custom status code', () => {
      const res = json({ error: 'bad' }, 400);
      expect(res.status).toBe(400);
    });

    it('includes CORS headers', () => {
      const res = json({});
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://visibility.clodo.dev');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    });

    it('serializes data correctly', async () => {
      const res = json({ key: 'value', num: 42 });
      const body = await res.json();
      expect(body).toEqual({ key: 'value', num: 42 });
    });
  });

  describe('ok()', () => {
    it('returns 200 with ok:true', async () => {
      const res = ok({ items: [1, 2, 3] });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data).toEqual({ items: [1, 2, 3] });
    });

    it('supports meta field', async () => {
      const res = ok(null, { page: 1, total: 50 });
      const body = await res.json() as any;
      expect(body.meta).toEqual({ page: 1, total: 50 });
    });

    it('works without data', async () => {
      const res = ok();
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
    });
  });

  describe('created()', () => {
    it('returns 201 with ok:true', async () => {
      const res = created({ id: 1 });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data).toEqual({ id: 1 });
    });
  });

  describe('badRequest()', () => {
    it('returns 400 with error message', async () => {
      const res = badRequest('Missing field: email');
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.error).toBe('Missing field: email');
    });
  });

  describe('unauthorized()', () => {
    it('returns 401 with default message', async () => {
      const res = unauthorized();
      expect(res.status).toBe(401);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.error).toBe('Unauthorized');
    });

    it('accepts custom message', async () => {
      const res = unauthorized('Token expired');
      const body = await res.json() as any;
      expect(body.error).toBe('Token expired');
    });
  });

  describe('notFound()', () => {
    it('returns 404 with default message', async () => {
      const res = notFound();
      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.error).toBe('Not found');
    });
  });

  describe('serverError()', () => {
    it('returns 500 with default message', async () => {
      const res = serverError();
      expect(res.status).toBe(500);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  describe('corsPreflightResponse()', () => {
    it('returns 204 with CORS headers', () => {
      const res = corsPreflightResponse();
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://visibility.clodo.dev');
      expect(res.headers.get('Access-Control-Allow-Methods')).toBeTruthy();
    });
  });
});
