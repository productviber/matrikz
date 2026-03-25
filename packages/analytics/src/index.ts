import { Router } from 'itty-router'
import type { D1Database, KVNamespace } from '@cloudflare/workers-types'
import { renderPulsePage } from './routes/pulse'
import { renderActionPage } from './routes/action'
import { renderExplorePage } from './routes/explore'
import { renderAIPage } from './routes/ai'

// Types for worker environment
export type Bindings = {
  VISIBILITY_DB: D1Database
  ANALYTICS_CACHE: KVNamespace
  ENVIRONMENT: 'development' | 'production'
  ADMIN_TOKEN?: string
  SYSTEM_TOKEN?: string
  ANALYTICS_USER_AUTH_SECRET?: string
}

const USER_AUTH_MAX_SKEW_SECS = 300

type UserRow = {
  id: string
  email: string
  name: string | null
  subscription_tier: string
}

type SiteRow = {
  id: string
  domain: string
  health_score: number
  domain_authority: number
  content_strength: number
  technical_health: number
  traffic_potential: number
  last_analyzed_at: number | null
}

const router = Router()

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function getBearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization')
  if (!auth || !auth.startsWith('Bearer ')) return null
  return auth.slice('Bearer '.length).trim()
}

function hasSystemOrAdminAccess(request: Request, env: Bindings): boolean {
  const bearer = getBearerToken(request)
  const systemHeader = request.headers.get('x-system-token')

  const provided = systemHeader ?? bearer
  if (!provided) return false

  if (env.SYSTEM_TOKEN && provided === env.SYSTEM_TOKEN) return true
  if (env.ADMIN_TOKEN && provided === env.ADMIN_TOKEN) return true
  return false
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a)
  const bBytes = new TextEncoder().encode(b)
  let mismatch = aBytes.length ^ bBytes.length
  const maxLen = Math.max(aBytes.length, bBytes.length)
  for (let i = 0; i < maxLen; i++) {
    mismatch |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0)
  }
  return mismatch === 0
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function getVerifiedUserId(request: Request, env: Bindings): Promise<string | null> {
  const userId = request.headers.get('x-user-id')?.trim()
  const tsRaw = request.headers.get('x-user-ts')?.trim()
  const sig = request.headers.get('x-user-sig')?.trim()?.toLowerCase()
  if (!userId || !tsRaw || !sig) return null

  const ts = Number(tsRaw)
  if (!Number.isFinite(ts)) return null

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > USER_AUTH_MAX_SKEW_SECS) return null

  const secret = env.ANALYTICS_USER_AUTH_SECRET
  if (!secret) return null

  const expected = await hmacSha256Hex(secret, `${userId}.${ts}`)
  if (!timingSafeEqual(expected, sig)) return null

  return userId
}

async function queryOne<T>(db: D1Database, sql: string, params: unknown[] = []): Promise<T | null> {
  const stmt = db.prepare(sql).bind(...params)
  return (await stmt.first<T>()) ?? null
}

async function queryAll<T>(db: D1Database, sql: string, params: unknown[] = []): Promise<T[]> {
  const stmt = db.prepare(sql).bind(...params)
  const res = await stmt.all<T>()
  return (res.results ?? []) as T[]
}

// Health check
router.get('/health', () => {
  return jsonResponse({ status: 'ok', worker: 'visibility-analytics' })
})

// Dashboard pages (authenticated)
router.get('/', () => {
  return new Response('Analytics Dashboard - Redirect to /pulse', { status: 302 })
})

router.get('/pulse', renderPulsePage)
router.get('/pulse/:date', renderPulsePage)

router.get('/action', renderActionPage)

router.get('/explore', renderExplorePage)

router.get('/ai', renderAIPage)

// Internal API endpoints (for marketer worker)
router.get('/internal/report-data/:domain', async (request, env: Bindings) => {
  if (!hasSystemOrAdminAccess(request, env)) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401)
  }

  const domain = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '').trim().toLowerCase()
  if (!domain) {
    return jsonResponse({ ok: false, error: 'Domain is required' }, 400)
  }

  const site = await queryOne<SiteRow>(
    env.VISIBILITY_DB,
    `SELECT domain, health_score, domain_authority, content_strength, technical_health, traffic_potential, last_analyzed_at
     FROM sites
     WHERE LOWER(domain) = ?
     ORDER BY last_analyzed_at DESC
     LIMIT 1`,
    [domain]
  )

  if (!site) {
    return jsonResponse({ ok: false, error: 'Domain not found' }, 404)
  }

  return jsonResponse({
    domain: site.domain,
    healthScore: site.health_score,
    domainAuthority: site.domain_authority,
    contentStrength: site.content_strength,
    technicalHealth: site.technical_health,
    trafficPotential: site.traffic_potential,
    lastUpdated: site.last_analyzed_at
      ? new Date(site.last_analyzed_at * 1000).toISOString()
      : null,
  })
})

// API endpoints (require system/admin access + signed user context)
router.get('/api/auth/me', async (request, env: Bindings) => {
  if (!hasSystemOrAdminAccess(request, env)) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401)
  }

  const userId = await getVerifiedUserId(request, env)
  if (!userId) {
    return jsonResponse({ ok: false, error: 'Signed user context required' }, 401)
  }

  const user = await queryOne<UserRow>(
    env.VISIBILITY_DB,
    `SELECT id, email, name, subscription_tier FROM users WHERE id = ? LIMIT 1`,
    [userId]
  )

  if (!user) {
    return jsonResponse({ ok: false, error: 'User not found' }, 404)
  }

  return jsonResponse({
    id: user.id,
    email: user.email,
    name: user.name,
    subscriptionTier: user.subscription_tier,
  })
})

router.get('/api/sites', async (request, env: Bindings) => {
  if (!hasSystemOrAdminAccess(request, env)) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401)
  }

  const userId = await getVerifiedUserId(request, env)
  if (!userId) {
    return jsonResponse({ ok: false, error: 'Signed user context required' }, 401)
  }

  const sites = await queryAll<SiteRow>(
    env.VISIBILITY_DB,
    `SELECT id, domain, health_score, domain_authority, content_strength, technical_health, traffic_potential, last_analyzed_at
     FROM sites
     WHERE user_id = ?
     ORDER BY COALESCE(last_analyzed_at, 0) DESC, created_at DESC`,
    [userId]
  )

  return jsonResponse({
    sites: sites.map((site) => ({
      id: site.id,
      domain: site.domain,
      healthScore: site.health_score,
      domainAuthority: site.domain_authority,
      contentStrength: site.content_strength,
      technicalHealth: site.technical_health,
      trafficPotential: site.traffic_potential,
      lastAnalyzed: site.last_analyzed_at
        ? new Date(site.last_analyzed_at * 1000).toISOString()
        : null,
    })),
  })
})

// Explicitly mark inbound click event forwarding as not yet implemented in analytics worker.
router.post('/api/v1/events/click', () => {
  return jsonResponse({ ok: false, error: 'Not implemented' }, 501)
})

// 404 handler
router.all('*', () => {
  return jsonResponse({ error: 'Not found' }, 404)
})

// Startup config validation — fail fast on missing bindings
function validateAnalyticsConfig(env: Bindings): string[] {
  const missing: string[] = [];
  if (!env.VISIBILITY_DB) missing.push('D1 database binding (VISIBILITY_DB)');
  if (!env.ANALYTICS_CACHE) missing.push('KV namespace binding (ANALYTICS_CACHE)');

  if (env.ENVIRONMENT === 'production') {
    if (!env.SYSTEM_TOKEN && !env.ADMIN_TOKEN) {
      missing.push('SYSTEM_TOKEN or ADMIN_TOKEN secret');
    }
    if (!env.ANALYTICS_USER_AUTH_SECRET) {
      missing.push('ANALYTICS_USER_AUTH_SECRET secret');
    }
  }

  return missing;
}

// Export default handler for Cloudflare Workers
export default {
  fetch: (request: Request, env: Bindings) => {
    const configErrors = validateAnalyticsConfig(env);
    if (configErrors.length > 0) {
      console.error(`[Analytics] Missing required config: ${configErrors.join(', ')}`);
      return new Response(
        JSON.stringify({ ok: false, error: 'Worker misconfigured' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return router.handle(request, env);
  }
}
