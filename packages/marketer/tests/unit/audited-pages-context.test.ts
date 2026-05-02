import { describe, expect, it } from 'vitest';
import { prepareTemplateContext } from '../../src/lib/email/context';

const baseContext = {
    domain: 'acme.com',
    companyName: 'Acme',
    contactEmail: 'ceo@acme.com',
    contactName: 'Jane',
    auditScore: 72,
    auditGrade: 'B',
    issueCount: 5,
    passCount: 10,
    primaryTopic: 'SaaS',
    techStack: ['Next.js'],
    angles: [{ type: 'critical-seo', hook: 'Missing metadata', detail: 'Add unique meta descriptions' }],
};

describe('prepareTemplateContext audited pages fields', () => {
    it('normalizes and summarizes audited pages from enrichment context', () => {
        const result = prepareTemplateContext(
            {
                ...baseContext,
                auditedPages: ['https://acme.com/', '/pricing', 'https://acme.com/docs'],
            },
            'cold-outreach-step1',
        );

        expect(result.auditedPages).toEqual(['/', '/pricing', '/docs']);
        expect(result.auditedPagesCount).toBe(3);
        expect(result.auditedPagesSummary).toBe('/, /pricing (+1 more)');
        expect(String(result.auditedPagesHeadline)).toContain('We audited 3 pages');
    });

    it('falls back to homepage when audited pages are missing', () => {
        const result = prepareTemplateContext({ ...baseContext }, 'cold-outreach-step1');

        expect(result.auditedPages).toEqual(['/']);
        expect(result.auditedPagesCount).toBe(1);
        expect(result.auditedPagesSummary).toBe('/');
        expect(result.auditedPagesHeadline).toBe('We audited 1 page: /.');
    });
});
