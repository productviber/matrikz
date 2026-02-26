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
}

const router = Router()

// Health check
router.get('/health', () => {
  return new Response(
    JSON.stringify({ status: 'ok', worker: 'visibility-analytics' }),
    { headers: { 'Content-Type': 'application/json' } }
  )
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
router.get('/internal/report-data/:domain', (request) => {
  const url = new URL(request.url)
  const domain = new URL(request.url).pathname.split('/').pop()
  
  return new Response(
    JSON.stringify({
      domain,
      healthScore: 75,
      domainAuthority: 68,
      contentStrength: 82,
      technicalHealth: 71,
      trafficPotential: 60,
      lastUpdated: new Date().toISOString(),
    }),
    { headers: { 'Content-Type': 'application/json' } }
  )
})

// API endpoints for frontend
router.get('/api/auth/me', () => {
  return new Response(
    JSON.stringify({
      id: 'user-123',
      email: 'user@example.com',
      name: 'John Doe',
      subscriptionTier: 'pro',
    }),
    { headers: { 'Content-Type': 'application/json' } }
  )
})

router.get('/api/sites', () => {
  return new Response(
    JSON.stringify({
      sites: [
        {
          id: 'site-1',
          domain: 'example.com',
          healthScore: 75,
          lastAnalyzed: new Date().toISOString(),
        },
      ],
    }),
    { headers: { 'Content-Type': 'application/json' } }
  )
})

// 404 handler
router.all('*', () => {
  return new Response(
    JSON.stringify({ error: 'Not found' }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  )
})

// Export default handler for Cloudflare Workers
export default {
  fetch: (request: Request, env: any) => router.handle(request, env)
}
