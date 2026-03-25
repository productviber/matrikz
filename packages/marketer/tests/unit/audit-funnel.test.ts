/**
 * Tests — Audit Funnel Event Handlers
 *
 * Covers handleAuditCompleted() and handleLeadCaptured():
 * domain-level intent tracking, CRM upsert as 'lead', KV context storage,
 * cold sequence cancellation on warm promotion, and warm sequence enrollment.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleAuditCompleted, handleLeadCaptured } from '../../src/events/audit-funnel';
import { createMockEnv, type MockEnv } from '../helpers';
import { KV_PREFIX, EMAIL_STATUS } from '../../src/constants';
import type { AuditCompletedData, LeadCapturedData } from '../../src/types';

describe('handleAuditCompleted()', () => {
    let env: MockEnv;
    const timestamp = new Date().toISOString();

    beforeEach(() => {
        env = createMockEnv();
        vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    const baseData: AuditCompletedData = {
        domain: 'example.com',
        score: 65,
        grade: 'C',
        url: 'https://example.com',
    };

    it('stores domain-level intent signal in KV', async () => {
        await handleAuditCompleted(env as any, baseData, timestamp);

        const raw = await env.KV_MARKETING.get('intent:audit:example.com');
        expect(raw).not.toBeNull();
        const data = JSON.parse(raw!);
        expect(data.score).toBe(65);
        expect(data.grade).toBe('C');
        expect(data.url).toBe('https://example.com');
        expect(data.completedAt).toBe(timestamp);
    });

    it('logs the audit completion', async () => {
        await handleAuditCompleted(env as any, baseData, timestamp);
        expect(console.log).toHaveBeenCalledWith(
            expect.stringContaining('Audit completed for example.com')
        );
    });
});

describe('handleLeadCaptured()', () => {
    let env: MockEnv;
    const timestamp = new Date().toISOString();

    beforeEach(() => {
        env = createMockEnv();
        // Default: no existing contact
        env.DB.onQuery(/SELECT.*marketing_contacts.*WHERE email/, () => []);
        // No existing sequence enrollment
        env.DB.onQuery(/SELECT.*email_sends.*contact_email/, () => []);
        // No active sequences for this trigger
        env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => []);
        vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    const baseData: LeadCapturedData = {
        email: 'jane@example.com',
        domain: 'example.com',
        source: 'free-audit',
        score: 72,
        grade: 'B',
        url: 'https://example.com',
    };

    // ── CRM Upsert ────────────────────────────────────────────────────────

    describe('CRM contact upsert', () => {
        it('creates contact as "lead" status', async () => {
            await handleLeadCaptured(env as any, baseData, timestamp);

            const insert = env.DB._queries.find((q: any) =>
                q.sql.includes('INSERT INTO marketing_contacts')
            );
            expect(insert).toBeDefined();
            // status = 'lead'
            expect(insert!.params[1]).toBe('lead');
        });

        it('sets source to "organic" for free-audit leads', async () => {
            await handleLeadCaptured(env as any, baseData, timestamp);

            const insert = env.DB._queries.find((q: any) =>
                q.sql.includes('INSERT INTO marketing_contacts')
            );
            expect(insert!.params[2]).toBe('organic');
        });

        it('stores audit metadata as JSON', async () => {
            await handleLeadCaptured(env as any, baseData, timestamp);

            const insert = env.DB._queries.find((q: any) =>
                q.sql.includes('INSERT INTO marketing_contacts')
            );
            const metadata = JSON.parse(insert!.params[7] as string);
            expect(metadata.domain).toBe('example.com');
            expect(metadata.auditScore).toBe(72);
            expect(metadata.auditGrade).toBe('B');
            expect(metadata.intentSource).toBe('free-audit');
        });
    });

    // ── KV Context ─────────────────────────────────────────────────────────

    describe('KV context storage', () => {
        it('stores warm context under audit-followup key', async () => {
            await handleLeadCaptured(env as any, baseData, timestamp);

            const key = `${KV_PREFIX.EMAIL_CONTEXT}jane@example.com:audit-followup`;
            const raw = await env.KV_MARKETING.get(key);
            expect(raw).not.toBeNull();
            const ctx = JSON.parse(raw!);
            expect(ctx.domain).toBe('example.com');
            expect(ctx.score).toBe(72);
            expect(ctx.grade).toBe('B');
            expect(ctx.email).toBe('jane@example.com');
        });
    });

    // ── Edge Cases ─────────────────────────────────────────────────────────

    describe('edge cases', () => {
        it('skips processing when email is missing', async () => {
            await handleLeadCaptured(
                env as any,
                { ...baseData, email: '' } as any,
                timestamp
            );

            const insert = env.DB._queries.find((q: any) =>
                q.sql.includes('INSERT INTO marketing_contacts')
            );
            expect(insert).toBeUndefined();
        });

        it('logs the lead capture event', async () => {
            await handleLeadCaptured(env as any, baseData, timestamp);
            expect(console.log).toHaveBeenCalledWith(
                expect.stringContaining('Lead captured: jane@example.com')
            );
        });
    });

    // ── Cold Sequence Cancellation ─────────────────────────────────────────

    describe('cold→warm promotion', () => {
        it('cancels scheduled cold outreach emails for the contact', async () => {
            await handleLeadCaptured(env as any, baseData, timestamp);

            const cancelQuery = env.DB._queries.find((q: any) =>
                q.sql.includes('UPDATE email_sends') &&
                q.sql.includes('cancelled') &&
                q.sql.includes('trigger_event')
            );
            expect(cancelQuery).toBeDefined();
            expect(cancelQuery!.params).toContain('jane@example.com');
            // trigger_event filter is passed as a parameter
            expect(cancelQuery!.params).toContain('outbound.prospect_discovered');
        });

        it('only cancels cold outreach, not other sequences', async () => {
            await handleLeadCaptured(env as any, baseData, timestamp);

            const cancelQuery = env.DB._queries.find((q: any) =>
                q.sql.includes('UPDATE email_sends') &&
                q.sql.includes('cancelled')
            );
            // Must filter by trigger_event via subquery
            expect(cancelQuery!.sql).toContain('trigger_event');
            expect(cancelQuery!.params).toContain('outbound.prospect_discovered');
        });

        it('logs cancellation count when cold emails existed', async () => {
            // MockD1Statement.run() returns { meta: { changes: 1 } } by default,
            // so cancelPendingEmails returns 1 → triggers the promotion log
            await handleLeadCaptured(env as any, baseData, timestamp);

            expect(console.log).toHaveBeenCalledWith(
                expect.stringContaining('Cancelled 1 cold outreach email(s)')
            );
            expect(console.log).toHaveBeenCalledWith(
                expect.stringContaining('promoting to warm')
            );
        });

        it('still processes lead even if no cold emails exist', async () => {
            // No special mock — cancelPendingEmails returns 0
            env.DB.onQuery(/UPDATE email_sends SET status.*cancelled/s, () => []);

            await handleLeadCaptured(env as any, baseData, timestamp);

            // Should still upsert contact
            const insert = env.DB._queries.find((q: any) =>
                q.sql.includes('INSERT INTO marketing_contacts')
            );
            expect(insert).toBeDefined();
            expect(insert!.params[1]).toBe('lead');
        });
    });

    // ── Warm Sequence Enrollment ───────────────────────────────────────────

    describe('warm sequence enrollment', () => {
        it('enrolls in lead.captured sequences when they exist', async () => {
            // Clear default handlers and set up complete mock chain
            env.DB.clearHandlers();
            // Default query handlers
            env.DB.onQuery(/SELECT.*marketing_contacts.*WHERE email/, () => []);
            env.DB.onQuery(/UPDATE email_sends SET status/s, () => []);
            env.DB.onQuery(/UPDATE marketing_contacts/, () => []);
            // Warm sequence mock chain
            env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => [
                { id: 10, name: 'Audit Followup v1' }
            ]);
            env.DB.onQuery(/SELECT.*FROM email_sends.*contact_email.*sequence_id/s, () => []);
            env.DB.onQuery(/SELECT.*email_steps.*sequence_id/, () => [
                { id: 101, step_order: 1, delay_seconds: 0 },
                { id: 102, step_order: 2, delay_seconds: 172800 },
                { id: 103, step_order: 3, delay_seconds: 432000 },
            ]);
            env.DB.onQuery(/INSERT INTO email_sends/, () => []);
            env.DB.onQuery(/INSERT INTO marketing_contacts/, () => []);

            await handleLeadCaptured(env as any, baseData, timestamp);

            // 3 scheduled emails should be inserted
            const inserts = env.DB._queries.filter((q: any) =>
                q.sql.includes('INSERT INTO email_sends')
            );
            expect(inserts.length).toBe(3);
            expect(inserts[0].params).toContain('jane@example.com');
            expect(inserts[0].params).toContain(10); // sequence_id
        });

        it('stores sequence context in KV for template rendering', async () => {
            env.DB.clearHandlers();
            env.DB.onQuery(/SELECT.*marketing_contacts.*WHERE email/, () => []);
            env.DB.onQuery(/UPDATE email_sends SET status/s, () => []);
            env.DB.onQuery(/UPDATE marketing_contacts/, () => []);
            env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => [
                { id: 10, name: 'Audit Followup v1' }
            ]);
            env.DB.onQuery(/SELECT.*FROM email_sends.*contact_email.*sequence_id/s, () => []);
            env.DB.onQuery(/SELECT.*email_steps.*sequence_id/, () => [
                { id: 101, step_order: 1, delay_seconds: 0 },
            ]);
            env.DB.onQuery(/INSERT INTO email_sends/, () => []);
            env.DB.onQuery(/INSERT INTO marketing_contacts/, () => []);

            await handleLeadCaptured(env as any, baseData, timestamp);

            // enrollInSequences stores context under email-ctx:{email}:{seqId}
            const seqCtx = await env.KV_MARKETING.get(`${KV_PREFIX.EMAIL_CONTEXT}jane@example.com:10`);
            expect(seqCtx).not.toBeNull();
            const parsed = JSON.parse(seqCtx!);
            expect(parsed.domain).toBe('example.com');
            expect(parsed.score).toBe(72);
        });

        it('logs enrolled step count', async () => {
            env.DB.clearHandlers();
            env.DB.onQuery(/SELECT.*marketing_contacts.*WHERE email/, () => []);
            env.DB.onQuery(/UPDATE email_sends SET status/s, () => []);
            env.DB.onQuery(/UPDATE marketing_contacts/, () => []);
            env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => [
                { id: 10, name: 'Audit Followup v1' }
            ]);
            env.DB.onQuery(/SELECT.*FROM email_sends.*contact_email.*sequence_id/s, () => []);
            env.DB.onQuery(/SELECT.*email_steps.*sequence_id/, () => [
                { id: 101, step_order: 1, delay_seconds: 0 },
                { id: 102, step_order: 2, delay_seconds: 172800 },
                { id: 103, step_order: 3, delay_seconds: 432000 },
            ]);
            env.DB.onQuery(/INSERT INTO email_sends/, () => []);
            env.DB.onQuery(/INSERT INTO marketing_contacts/, () => []);

            await handleLeadCaptured(env as any, baseData, timestamp);

            expect(console.log).toHaveBeenCalledWith(
                expect.stringContaining('Enrolled jane@example.com in 3 audit-followup step(s)')
            );
        });
    });
});
