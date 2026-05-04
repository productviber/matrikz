import type { Bindings } from '../../src/index';

type QueryHandler = {
  match: RegExp;
  row?: Record<string, unknown> | null;
  rows?: Array<Record<string, unknown>>;
};

export class MockD1 {
  private handlers: QueryHandler[] = [];

  onQuery(match: RegExp, row?: Record<string, unknown> | null, rows?: Array<Record<string, unknown>>) {
    this.handlers.push({ match, row, rows });
  }

  prepare(sql: string) {
    const handler = this.handlers.find((h) => h.match.test(sql));

    return {
      bind: (..._bound: unknown[]) => {
        return {
          first: async <T>() => {
            if (handler && handler.row !== undefined) return handler.row as T;
            if (handler && handler.rows && handler.rows.length > 0) return handler.rows[0] as T;
            return null;
          },
          all: async <T>() => {
            if (handler && handler.rows) return { results: handler.rows as T[] };
            if (handler && handler.row) return { results: [handler.row] as T[] };
            return { results: [] as T[] };
          },
        };
      },
    };
  }
}

export function createEnv(): Bindings {
  return {
    VISIBILITY_DB: new MockD1() as unknown as Bindings['VISIBILITY_DB'],
    ANALYTICS_CACHE: {} as Bindings['ANALYTICS_CACHE'],
    ENVIRONMENT: 'development',
    SYSTEM_TOKEN: 'system-test-token',
    ADMIN_TOKEN: 'admin-test-token',
    ANALYTICS_USER_AUTH_SECRET: 'analytics-user-secret',
  };
}

export async function signUserContext(secret: string, userId: string, ts: number): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${userId}.${ts}`));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function makeRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://analytics.local${path}`, init);
}
