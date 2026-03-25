/**
 * Tests — Admin Outbound Endpoints (A/B Stats + LinkedIn Queue)
 *
 * Covers handleAbStats() and handleLinkedinQueue():
 * KV-backed A/B variant performance, admin auth guard, and
 * high-score prospect queue for LinkedIn outreach.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleAbStats, handleLinkedinQueue } from '../../src/routes/admin';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';

describe('handleAbStats()', () => {
    let env: MockEnv;

    beforeEach(() => {
        env = createMockEnv();
    });

    it('returns empty stats when no variants exist', async () => {
        const req = makeRequest('GET', '/api/admin/outbound/ab-stats', undefined, {
            Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        });
        const res = await handleAbStats(req, env as any);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        const data = body.data ?? body;
        expect(data.count).toBe(0);
        expect(data.templates).toEqual({});
    });

    it('returns variant performance data from KV', async () => {
        // Pre-populate KV with A/B variant data
        await env.KV_MARKETING.put(
            'ab:variants:cold-outreach-step1',
            JSON.stringify({
                'subject:cold-outreach-step1': [5, 12, 3],
                'body:cold-outreach-step1': [8, 15],
            })
        );

        const req = makeRequest('GET', '/api/admin/outbound/ab-stats', undefined, {
            Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        });
        const res = await handleAbStats(req, env as any);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        const data = body.data ?? body;
        expect(data.count).toBe(1);
        expect(data.templates['cold-outreach-step1']).toBeDefined();
        expect(data.templates['cold-outreach-step1']['subject:cold-outreach-step1']).toEqual([5, 12, 3]);
    });

    it('returns multiple template stats', async () => {
        await env.KV_MARKETING.put(
            'ab:variants:cold-outreach-step1',
            JSON.stringify({ 'subject:cold-outreach-step1': [5, 12] })
        );
        await env.KV_MARKETING.put(
            'ab:variants:cold-outreach-step2',
            JSON.stringify({ 'subject:cold-outreach-step2': [3, 7] })
        );

        const req = makeRequest('GET', '/api/admin/outbound/ab-stats', undefined, {
            Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        });
        const res = await handleAbStats(req, env as any);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        const data = body.data ?? body;
        expect(data.count).toBe(2);
    });
});

describe('handleLinkedinQueue()', () => {
    let env: MockEnv;

    beforeEach(() => {
        env = createMockEnv();
    });

    it('returns empty queue when no prospects exist', async () => {
        env.DB.onQuery(/SELECT.*marketing_contacts/, () => []);

        const req = makeRequest('GET', '/api/admin/outbound/linkedin-queue', undefined, {
            Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        });
        const res = await handleLinkedinQueue(req, env as any);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        const data = body.data ?? body;
        expect(data.queue).toEqual([]);
        expect(data.count).toBe(0);
    });

    it('filters to high-scoring prospects (score >= 60)', async () => {
        env.DB.onQuery(/SELECT.*marketing_contacts/, () => [
            {
                email: 'high@acme.com',
                status: 'prospect',
                metadata: JSON.stringify({ domain: 'acme.com', prospectScore: 80, companyName: 'Acme' }),
            },
            {
                email: 'low@cheap.com',
                status: 'prospect',
                metadata: JSON.stringify({ domain: 'cheap.com', prospectScore: 30, companyName: 'Cheap Co' }),
            },
        ]);

        const req = makeRequest('GET', '/api/admin/outbound/linkedin-queue', undefined, {
            Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        });
        const res = await handleLinkedinQueue(req, env as any);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        const data = body.data ?? body;
        expect(data.count).toBe(1);
        expect(data.queue[0].email).toBe('high@acme.com');
        expect(data.queue[0].score).toBe(80);
    });

    it('sorts prospects by score descending', async () => {
        env.DB.onQuery(/SELECT.*marketing_contacts/, () => [
            {
                email: 'mid@mid.com',
                status: 'prospect',
                metadata: JSON.stringify({ domain: 'mid.com', prospectScore: 65 }),
            },
            {
                email: 'top@top.com',
                status: 'prospect',
                metadata: JSON.stringify({ domain: 'top.com', prospectScore: 90 }),
            },
        ]);

        const req = makeRequest('GET', '/api/admin/outbound/linkedin-queue', undefined, {
            Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        });
        const res = await handleLinkedinQueue(req, env as any);
        const body = await res.json() as any;
        const data = body.data ?? body;
        expect(data.queue[0].score).toBe(90);
        expect(data.queue[1].score).toBe(65);
    });

    it('includes LinkedIn URL from metadata when available', async () => {
        env.DB.onQuery(/SELECT.*marketing_contacts/, () => [
            {
                email: 'test@corp.com',
                status: 'prospect',
                metadata: JSON.stringify({
                    domain: 'corp.com',
                    prospectScore: 75,
                    socialHandles: { linkedin: 'https://linkedin.com/company/corp' },
                }),
            },
        ]);

        const req = makeRequest('GET', '/api/admin/outbound/linkedin-queue', undefined, {
            Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        });
        const res = await handleLinkedinQueue(req, env as any);
        const body = await res.json() as any;
        const data = body.data ?? body;
        expect(data.queue[0].linkedinUrl).toBe('https://linkedin.com/company/corp');
    });
});
