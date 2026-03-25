import { describe, it, expect } from 'vitest'
import worker, { type Bindings } from '../../src/index'

type QueryHandler = {
  match: RegExp
  row?: Record<string, unknown> | null
  rows?: Array<Record<string, unknown>>
}

class MockD1 {
  private handlers: QueryHandler[] = []

  onQuery(match: RegExp, row?: Record<string, unknown> | null, rows?: Array<Record<string, unknown>>) {
    this.handlers.push({ match, row, rows })
  }

  prepare(sql: string) {
    let params: unknown[] = []
    const handler = this.handlers.find((h) => h.match.test(sql))

    return {
      bind: (...bound: unknown[]) => {
        params = bound
        return {
          first: async <T>() => {
            if (handler && handler.row !== undefined) return handler.row as T
            if (handler && handler.rows && handler.rows.length > 0) return handler.rows[0] as T
            return null
          },
          all: async <T>() => {
            if (handler && handler.rows) return { results: handler.rows as T[] }
            if (handler && handler.row) return { results: [handler.row] as T[] }
            return { results: [] as T[] }
          },
          _params: params,
        }
      },
    }
  }
}

function createEnv(): Bindings {
  return {
    VISIBILITY_DB: new MockD1() as unknown as Bindings['VISIBILITY_DB'],
    ANALYTICS_CACHE: {} as Bindings['ANALYTICS_CACHE'],
    ENVIRONMENT: 'development',
    SYSTEM_TOKEN: 'system-test-token',
    ADMIN_TOKEN: 'admin-test-token',
    ANALYTICS_USER_AUTH_SECRET: 'analytics-user-secret',
  }
}

async function signUserContext(secret: string, userId: string, ts: number): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${userId}.${ts}`))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function makeRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://analytics.local${path}`, init)
}

describe('analytics API auth and data', () => {
  it('returns 401 for /api/auth/me without user context', async () => {
    const env = createEnv()
    const res = await worker.fetch(makeRequest('/api/auth/me'), env)
    expect(res.status).toBe(401)
  })

  it('returns DB-backed /api/auth/me payload', async () => {
    const env = createEnv()
    const userId = 'u-1'
    const ts = Math.floor(Date.now() / 1000)
    const sig = await signUserContext(env.ANALYTICS_USER_AUTH_SECRET as string, userId, ts)
    ;(env.VISIBILITY_DB as unknown as MockD1).onQuery(
      /SELECT id, email, name, subscription_tier FROM users/,
      { id: 'u-1', email: 'u1@test.com', name: 'User One', subscription_tier: 'pro' }
    )

    const res = await worker.fetch(
      makeRequest('/api/auth/me', {
        headers: {
          Authorization: 'Bearer admin-test-token',
          'x-user-id': userId,
          'x-user-ts': String(ts),
          'x-user-sig': sig,
        },
      }),
      env
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toBe('u-1')
    expect(body.email).toBe('u1@test.com')
    expect(body.subscriptionTier).toBe('pro')
  })

  it('returns DB-backed /api/sites payload', async () => {
    const env = createEnv()
    const userId = 'u-1'
    const ts = Math.floor(Date.now() / 1000)
    const sig = await signUserContext(env.ANALYTICS_USER_AUTH_SECRET as string, userId, ts)
    ;(env.VISIBILITY_DB as unknown as MockD1).onQuery(
      /SELECT id, domain, health_score, domain_authority, content_strength, technical_health, traffic_potential, last_analyzed_at/,
      undefined,
      [
        {
          id: 's-1',
          domain: 'example.com',
          health_score: 81,
          domain_authority: 55,
          content_strength: 79,
          technical_health: 83,
          traffic_potential: 62,
          last_analyzed_at: 1735689600,
        },
      ]
    )

    const res = await worker.fetch(
      makeRequest('/api/sites', {
        headers: {
          Authorization: 'Bearer admin-test-token',
          'x-user-id': userId,
          'x-user-ts': String(ts),
          'x-user-sig': sig,
        },
      }),
      env
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as { sites: Array<Record<string, unknown>> }
    expect(body.sites).toHaveLength(1)
    expect(body.sites[0].domain).toBe('example.com')
    expect(body.sites[0].healthScore).toBe(81)
  })

  it('requires auth for /internal/report-data/:domain', async () => {
    const env = createEnv()
    const res = await worker.fetch(makeRequest('/internal/report-data/example.com'), env)
    expect(res.status).toBe(401)
  })

  it('returns DB-backed /internal/report-data/:domain with system token', async () => {
    const env = createEnv()
    ;(env.VISIBILITY_DB as unknown as MockD1).onQuery(
      /SELECT domain, health_score, domain_authority, content_strength, technical_health, traffic_potential, last_analyzed_at/,
      {
        domain: 'example.com',
        health_score: 75,
        domain_authority: 68,
        content_strength: 82,
        technical_health: 71,
        traffic_potential: 60,
        last_analyzed_at: 1735689600,
      }
    )

    const res = await worker.fetch(
      makeRequest('/internal/report-data/example.com', {
        headers: { 'x-system-token': 'system-test-token' },
      }),
      env
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as Record<string, unknown>
    expect(body.domain).toBe('example.com')
    expect(body.healthScore).toBe(75)
    expect(body.domainAuthority).toBe(68)
  })

  it('returns 501 for unimplemented click event ingest route', async () => {
    const env = createEnv()
    const res = await worker.fetch(
      makeRequest('/api/v1/events/click', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      env
    )
    expect(res.status).toBe(501)
  })
})
