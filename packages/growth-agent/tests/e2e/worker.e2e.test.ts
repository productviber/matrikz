import { describe, expect, it } from 'vitest';
import { ACTION_TYPE_WHITELIST } from '@matrikz/growth-agent-contracts';

const WORKER_URL = process.env.GROWTH_AGENT_URL ?? '';
const SECRET = process.env.GROWTH_AGENT_INTERNAL_SECRET ?? '';

const describeE2E = WORKER_URL && SECRET ? describe : describe.skip;

describeE2E('growth-agent live e2e', () => {
  const baseHeaders = {
    'x-tenant-id': 'e2e-tenant',
    'x-correlation-id': 'lq3abc-xy12',
    'content-type': 'application/json',
  };

  it('returns health ok', async () => {
    const res = await fetch(`${WORKER_URL}/health`);
    expect(res.status).toBe(200);

    const payload = (await res.json()) as {
      ok: boolean;
      data?: { status?: string };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data?.status).toBe('ok');
  });

  it('accepts valid secret and returns a whitelisted action without fallback', async () => {
    const requestBody = {
      subjectId: 'e2e-subject-001',
      signals: [{ kind: 'number', name: 'intent', value: 9 }],
      context: {},
    };

    // Workers AI cold starts can occasionally timeout; retry a few times.
    let payload: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${WORKER_URL}/internal/growth-next-action`, {
        method: 'POST',
        headers: {
          ...baseHeaders,
          'x-internal-secret': SECRET,
          'x-idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify(requestBody),
      });

      expect([200, 429, 500, 504]).toContain(res.status);
      payload = await res.json();
      if (payload?.ok === true && payload?.metadata?.fallback === false) {
        break;
      }
    }

    expect(payload?.ok).toBe(true);
    expect(payload?.metadata?.capability).toBe('growth-next-action');
    expect(payload?.metadata?.fallback).toBe(false);
    expect((ACTION_TYPE_WHITELIST as readonly string[])).toContain(payload?.data?.action?.type);
  });

  it('rejects wrong secret with 401', async () => {
    const res = await fetch(`${WORKER_URL}/internal/growth-next-action`, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'x-internal-secret': 'wrong-secret',
        'x-idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        subjectId: 'e2e-subject-unauthorized',
        signals: [{ kind: 'number', name: 'intent', value: 9 }],
        context: {},
      }),
    });

    expect(res.status).toBe(401);
    const payload = (await res.json()) as { ok: boolean; error?: { code?: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe('UNAUTHORIZED');
  });
});

if (!WORKER_URL || !SECRET) {
  describe.skip('growth-agent live e2e (env missing)', () => {
    it('E2E skipped: GROWTH_AGENT_URL and GROWTH_AGENT_INTERNAL_SECRET required', () => {
      expect(true).toBe(true);
    });
  });
}
