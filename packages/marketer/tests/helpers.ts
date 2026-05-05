/**
 * Test Helpers — Mock factories for D1, KV, and Env.
 *
 * Provides lightweight in-memory mocks that mirror the Cloudflare
 * Workers runtime APIs without requiring Miniflare.
 */

// ─── Mock KV Namespace ─────────────────────────────────────────────────────

export interface MockKVNamespace {
  _store: Map<string, string>;
  get(key: string, format?: 'json'): Promise<any>;
  put(key: string, value: string, opts?: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: unknown): Promise<{ keys: { name: string }[] }>;
}

export function createMockKV(): MockKVNamespace {
  const store = new Map<string, string>();
  return {
    _store: store,
    async get(key: string, format?: 'json'): Promise<unknown | null> {
      const raw = store.get(key) ?? null;
      if (raw !== null && format === 'json') {
        return JSON.parse(raw);
      }
      return raw;
    },
    async put(key: string, value: string, _opts?: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(_opts?: unknown): Promise<{ keys: { name: string }[] }> {
      return { keys: Array.from(store.keys()).map((name) => ({ name })) };
    },
  };
}

// ─── Mock D1 Database ──────────────────────────────────────────────────────

interface MockD1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export class MockD1Statement {
  private _sql: string;
  private _params: unknown[];
  private _db: MockD1Database;

  constructor(db: MockD1Database, sql: string) {
    this._db = db;
    this._sql = sql;
    this._params = [];
  }

  bind(...params: unknown[]): MockD1Statement {
    this._params = params;
    return this;
  }

  async all<T = Record<string, unknown>>(): Promise<MockD1Result<T>> {
    this._db._queries.push({ sql: this._sql, params: this._params });
    const handler = this._db._findHandler(this._sql);
    const results = handler ? handler(this._params) : [];
    return { results: results as T[], success: true, meta: {} };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const { results } = await this.all<T>();
    return results[0] ?? null;
  }

  async run(): Promise<{ success: boolean; meta: Record<string, unknown> }> {
    this._db._queries.push({ sql: this._sql, params: this._params });
    const handler = this._db._findHandler(this._sql);
    if (handler) handler(this._params);
    return { success: true, meta: { changes: 1, duration: 0 } };
  }
}

interface QueryHandler {
  pattern: RegExp;
  handler: (params: unknown[]) => unknown[];
}

export class MockD1Database {
  _queries: { sql: string; params: unknown[] }[] = [];
  private _handlers: QueryHandler[] = [];

  prepare(sql: string): MockD1Statement {
    return new MockD1Statement(this, sql);
  }

  async batch(stmts: MockD1Statement[]): Promise<unknown[]> {
    const results = [];
    for (const stmt of stmts) {
      results.push(await stmt.run());
    }
    return results;
  }

  /** Register a handler for queries matching a regex pattern */
  onQuery(pattern: RegExp, handler: (params: unknown[]) => unknown[]): void {
    this._handlers.push({ pattern, handler });
  }

  /** Clear all recorded queries */
  clearQueries(): void {
    this._queries = [];
  }

  /** Clear all registered query handlers */
  clearHandlers(): void {
    this._handlers = [];
  }

  _findHandler(sql: string): ((params: unknown[]) => unknown[]) | undefined {
    for (const { pattern, handler } of this._handlers) {
      if (pattern.test(sql)) return handler;
    }
    return undefined;
  }
}

// ─── Mock Fetcher (Service Binding) ────────────────────────────────────────

export function createMockFetcher(
  responses: Record<string, { status?: number; body: unknown }>
): Record<string, any> {
  return {
    async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const path = new URL(urlStr).pathname;
      const response = responses[path];
      if (response) {
        return new Response(JSON.stringify(response.body), {
          status: response.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}

// ─── Mock R2 Bucket ────────────────────────────────────────────────────────

export function createMockR2(): Record<string, any> & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    async get(key: string) {
      const value = store.get(key);
      if (!value) return null;
      return {
        text: async () => value,
        blob: async () => new Blob([value]),
      };
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
  };
}

// ─── Mock Env Factory ──────────────────────────────────────────────────────

export interface MockEnv {
  DB: MockD1Database;
  KV_MARKETING: ReturnType<typeof createMockKV>;
  R2_ASSETS: ReturnType<typeof createMockR2>;
  ANALYTICS: ReturnType<typeof createMockFetcher>;
  AI_ENGINE?: ReturnType<typeof createMockFetcher>;
  SKRIP_SERVICE?: ReturnType<typeof createMockFetcher>;
  FROM_EMAIL: string;
  FROM_NAME: string;
  ADMIN_TOKEN: string;
  EMAIL_API_KEY: string;
  EMAIL_PROVIDER: 'brevo' | 'sendgrid';
  SLACK_WEBHOOK_URL: string;
  DISCORD_WEBHOOK_URL: string;
  ENVIRONMENT: 'development' | 'production';
  ADMIN_TOKEN_ROLLOVER?: string;
  SYSTEM_TOKEN?: string;
  SYSTEM_TOKEN_ROLLOVER?: string;
  AGENT_TOKEN?: string;
  AGENT_TOKEN_ROLLOVER?: string;
  AGENT_TOKEN_SCOPES?: string;
  AGENT_TOKEN_ROLLOVER_SCOPES?: string;
  AGENT_EXECUTION_DISABLED?: string;
  WEBHOOK_TOKEN?: string;
  WEBHOOK_TOKEN_ROLLOVER?: string;
  AFFILIATE_AUTH_SECRET?: string;
  WEBHOOK_SIGNING_SECRET?: string;
  SKRIP_BASE_URL?: string;
  SKRIP_SERVICE_TOKEN?: string;
  SKRIP_SIGNING_SECRET?: string;
  SKRIP_WEBHOOK_SIGNING_SECRET?: string;
  SKRIP_DEFAULT_ENABLEMENT?: string;
  SKRIP_TIMEOUT_MS?: string;
  AI_ENGINE_TIMEOUT_MS?: string;
  INTERNAL_SECRET?: string;
  INTERNAL_SECRET_ROLLOVER?: string;
  GROWTH_AGENT_TIMEOUT_MS?: string;
}

export function createMockEnv(overrides: Partial<MockEnv> = {}): MockEnv {
  return {
    DB: new MockD1Database(),
    KV_MARKETING: createMockKV(),
    R2_ASSETS: createMockR2(),
    ANALYTICS: createMockFetcher({}),
    FROM_EMAIL: 'test@clodo.dev',
    FROM_NAME: 'Test',
    ADMIN_TOKEN: 'test-admin-token',
    EMAIL_API_KEY: 'test-api-key',
    EMAIL_PROVIDER: 'brevo',
    SLACK_WEBHOOK_URL: '',
    DISCORD_WEBHOOK_URL: '',
    ENVIRONMENT: 'development',
    ...overrides,
  };
}

// ─── Request Factory ───────────────────────────────────────────────────────

export function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Request {
  const url = `https://test.workers.dev${path}`;
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body) init.body = JSON.stringify(body);
  return new Request(url, init);
}

// ─── Mock ExecutionContext ──────────────────────────────────────────────────

// Cloudflare Workers execution context type (minimal subset used by tests)
declare global {
  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }
}

export function createMockCtx(): ExecutionContext {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil(promise: Promise<unknown>) { promises.push(promise); },
    passThroughOnException() {},
    // Helper to flush all waitUntil promises
    _flush: () => Promise.all(promises),
  } as ExecutionContext & { _flush: () => Promise<unknown[]> };
}
