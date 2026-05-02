/**
 * Tests — renderer dot-notation interpolation
 *
 * Covers:
 *   - Flat `{{key}}` interpolation still works
 *   - `{{nested.key}}` resolves via dot-path
 *   - Missing paths render as empty string (not "undefined")
 *   - Null/undefined variables render as empty
 *   - HTML merge-field token (capabilityHookBlock) embeds raw HTML as-is
 */

import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../../src/lib/email/renderer';

function mockEnv(templates: Record<string, string> = {}) {
    return {
        R2_ASSETS: {
            get: async (key: string) => {
                const k = key.replace(/^templates\//, '').replace(/\.html$/, '');
                if (templates[k] != null) {
                    const body = templates[k];
                    return { text: async () => body };
                }
                return null;
            },
        },
        APP_BASE_URL: 'https://test.dev',
    } as unknown as Parameters<typeof renderTemplate>[0];
}

describe('renderer — dot-notation interpolation', () => {
    it('resolves flat {{key}}', async () => {
        const env = mockEnv({ 'dot-test': '<p>Hello {{name}}</p>' });
        const html = await renderTemplate(env, 'dot-test', { name: 'Alice', to: 'a@b.c' });
        expect(html).toContain('Hello Alice');
    });

    it('resolves nested {{capabilityHook.headline}}', async () => {
        const env = mockEnv({
            'hook-test': '<p>{{capabilityHook.headline}} — {{capabilityHook.oneLiner}}</p>',
        });
        const html = await renderTemplate(env, 'hook-test', {
            capabilityHook: { headline: 'Great Hook', oneLiner: 'This one works.' },
            to: 'a@b.c',
        });
        expect(html).toContain('Great Hook');
        expect(html).toContain('This one works.');
    });

    it('renders missing nested paths as empty string', async () => {
        const env = mockEnv({ 'missing-test': '<p>Before[{{capabilityHook.headline}}]After</p>' });
        const html = await renderTemplate(env, 'missing-test', { to: 'a@b.c' });
        expect(html).toContain('Before[]After');
        expect(html).not.toContain('undefined');
    });

    it('renders null values as empty string', async () => {
        const env = mockEnv({ 'null-test': '<p>[{{name}}]</p>' });
        const html = await renderTemplate(env, 'null-test', { name: null, to: 'a@b.c' });
        expect(html).toContain('[]');
        expect(html).not.toContain('null');
    });

    it('embeds HTML block tokens raw (capabilityHookBlock)', async () => {
        const env = mockEnv({ 'block-test': '<p>intro</p>{{capabilityHookBlock}}<p>outro</p>' });
        const block = '<div class="hook"><strong>Headline</strong></div>';
        const html = await renderTemplate(env, 'block-test', { capabilityHookBlock: block, to: 'a@b.c' });
        expect(html).toContain('<div class="hook"><strong>Headline</strong></div>');
    });

    it('deeply nested paths resolve', async () => {
        const env = mockEnv({ 'deep-test': '<p>{{a.b.c}}</p>' });
        const html = await renderTemplate(env, 'deep-test', { a: { b: { c: 'deep' } }, to: 'a@b.c' });
        expect(html).toContain('deep');
    });

    it('unknown top-level token renders empty', async () => {
        const env = mockEnv({ 'unk-test': '<p>[{{missing}}]</p>' });
        const html = await renderTemplate(env, 'unk-test', { to: 'a@b.c' });
        expect(html).toContain('[]');
    });
});
