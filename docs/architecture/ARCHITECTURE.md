# Architecture Documentation

Detailed architecture and design decisions for Visibility Cockpit.

For the current cross-system north star across Visibility Marketing, Visibility Analytics, and Skrip, see [docs/AGENT_LED_GROWTH_TOUCHSTONE.md](docs/AGENT_LED_GROWTH_TOUCHSTONE.md). That document captures the Four M capability model, identity authority boundaries, agentic growth layer placement, and the plan to extract domain-specific code from Skrip core.

## The Problem We're Solving

Traditional approach (Microservices Nightmare):
```
API Gateway → [10 microservices] → Message queue → Database

Problems:
- Orchestration complexity
- Network latency
- Service discovery issues
- Distributed tracing nightmare
- Debugging is hard
```

Our approach (Parallel Full-Stack Workers):
```
Domain 1: visibility-analytics (Product)
├── Backend: clodo-framework with itty-router
├── Frontend: React components
├── Data: D1 database
└── Caching: KV store

Domain 2: visibility-marketer (Growth)
├── Backend: clodo-framework with itty-router
├── Frontend: React components
├── Data: Shared D1 database
└── Caching: KV store

Shared: @visibility/design-system
└── Visual consistency across both

= Simple, deployable, debuggable
```

## Why This Architecture

### 1. Clarity of Boundaries

Each worker owns specific routes and responsibilities:

**visibility-analytics handles:**
- /pulse - Dashboard
- /action - Action center
- /explore - Deep insights
- /ai - AI assistant
- /api/* - User-scoped endpoints
- /internal/report-data/* - For marketer worker

**visibility-marketing handles:**
- /api/agentic/* — Agentic growth API (growth-agent callable)
- /api/admin/* — Admin management endpoints
- /api/user/* — Subject-scoped user endpoints
- /api/system/* — Internal system endpoints
- /webhooks/* — Webhook ingestion (Skrip outcomes, affiliate, analytics)
- /api/events/* — Event ingestion (email engagement, push receipts)
- Cron pipeline — Email dispatch, reputation, outbox, attribution

No overlap = no confusion.

### 2. Independent Scaling

Traffic doesn't compete:
- Marketing handles agentic API calls, webhook ingestion, and cron-driven orchestration
- Analytics serves authenticated users (lower volume, more expensive operations)
- Separate KV stores allow different caching strategies

### 3. Shared Design System = Visual Consistency

Rather than duplicating UI code, both workers import from `@visibility/design-system`:

```
┌─────────────────────────────┐
│ design-system               │
├─────────────────────────────┤
│ tokens/                     │
│ ├── colors.ts              │
│ ├── typography.ts          │
│ ├── spacing.ts             │
│ └── breakpoints.ts         │
├─────────────────────────────┤
│ components/                │
│ ├── Button.tsx             │
│ ├── Card.tsx               │
│ ├── MetricCard.tsx    ← critical!
│ ├── Badge.tsx              │
│ ├── Input.tsx              │
│ └── Alert.tsx              │
├─────────────────────────────┤
│ styles/                     │
│ └── index.css              │
└─────────────────────────────┘
        ↓         ↓
   analytics   marketer
```

The `MetricCard` component used in:
- ✅ Analytics dashboard (user's own KPIs)
- ✅ Public reports (target domain's metrics)

Same component, different data, consistent UX.

## Data Flow

### Public Report Generation

```
1. User visits: visibility.clodo.dev/report/example.com
   ↓
2. Marketer worker receives request
   ↓
3. Marketer checks KV cache ("report:example.com")
   ├─ Cache hit? Return cached HTML
   └─ Cache miss? Continue...
   ↓
4. Marketer calls analytics: /internal/report-data/example.com
   ↓
5. Analytics calculates metrics:
   - Query GSC data for domain
   - Calculate health score
   - Generate recommendations
   ↓
6. Analytics returns JSON payload
   ↓
7. Marketer renders React component → HTML
   (Uses MetricCard from design-system)
   ↓
8. Marketer caches HTML in KV (6 hours)
   ↓
9. Return HTML to user
```

### User Signup & Conversion

```
1. User on marketer landing page (/features)
   ↓
2. Clicks "Start Free Trial"
   ↓
3. Navigates to signup form (analytics worker)
   ↓
4. User fills form and submits
   ↓
5. Analytics creates user in D1
   ↓
6. Analytics calls marketer: /internal/record-conversion
   ├── user_id
   ├── source (organic, affiliate, etc)
   └── utm params
   ↓
7. Marketer records in conversions table
   ↓
8. Analytics sends welcome email
   ↓
9. User sees dashboard (Pulse tab, analytics worker)
```

## Component Ownership

### Design System (Shared)

Ownership: Product team
```
- Tokens (colors, spacing, etc)
- Reusable components
- Global styles
- CSS animations
```

Changes to design system:
1. Update `packages/design-system`
2. Bump version in package.json
3. Both workers rebuild and pick up changes
4. Deploy both workers

### Analytics Worker (Product)

Ownership: Product & Analytics team
```
- clodo-framework server setup (itty-router based)
- Database queries (GSC, Bing, CF data)
- User authentication
- Dashboard logic
- Data aggregation
- Internal APIs
```

### Marketing Worker (Growth Orchestration)

Ownership: Growth & Marketing team
```
- clodo-framework server setup (itty-router based)
- Agentic API namespace (/api/agentic/*) — callable by growth-agent
- Multi-channel execution via Skrip service binding
- Policy engine: suppression, frequency, risk gating
- Cron pipeline: email dispatch, reputation, outbox, attribution
- Affiliate tracking and payout management
- Widget serving
- Conversion tracking
```

## Database Design Philosophy

**Shared data** (accessible to both workers):
```sql
users
sites
```

**Analytics-owned data** (only analytics writes):
```sql
gsc_data
bing_data
cloudflare_data
```

**Marketer-owned data** (only marketer writes):
```sql
conversions
affiliates
email_campaigns
```

**Why this separation?**
- ✅ Clear ownership boundaries
- ✅ Analytics can calculate and publish metrics
- ✅ Marketer can track conversions independently
- ✅ Both workers access user/site data without duplication

## Caching Strategy

### Analytics Worker

Cache user's personal data:
```typescript
const key = `metrics:${userId}:${siteId}:${metric}`
const ttl = 300 // 5 minutes (fresh dashboard)
```

Why short TTL? User expects real-time data.

### Marketer Worker

Cache public data aggressively:
```typescript
const key = `report:${domain}`
const ttl = 21600 // 6 hours (public data doesn't change often)
```

Why long TTL? Public reports get high traffic, public metrics don't change hourly.

Also cache widget code:
```typescript
const key = `widget:js`
const ttl = 86400 // 24 hours (code doesn't change daily)
```

## Error Handling & Resilience

### Analytics Worker Errors

If analytics has an error rendering the dashboard:
```typescript
return c.json({ error: 'Failed to load dashboard' }, 500)
```

User sees error banner but doesn't lose their session.

### Marketer → Analytics Call Failures

If marketer can't reach analytics for report data:
```typescript
// Return cached version if available
const cached = await cache.get(`report:${domain}`)
if (cached) return c.html(cached) // Serve stale data

// Otherwise, error page
return c.html('Report temporarily unavailable', 503)
```

Services degrade gracefully.

## Security Considerations

### Authentication

Analytics worker needs auth:
```typescript
// Check user session/token before allowing /api/* or dashboard access
// Marketer can skip auth (public pages)
```

### Service-to-Service

Marketer calling analytics internal APIs:
```typescript
// Option 1: Rely on Cloudflare network (same account, same zone)
// Option 2: Sign requests with API key
// Option 3: IP whitelist (if Cloudflare supports)
```

### Public Data

Marketer serves public reports for ANY domain:
```typescript
GET /report/competitor.com  ← Anyone can request
```

No auth needed, data is aggregated (doesn't reveal individual keywords).

## Performance Characteristics

### Analytics Worker

- Average request: 200-500ms
  - Auth check: ~10ms
  - DB query: ~50-200ms
  - React render: ~50-100ms
  - Response: ~10-100ms

- Cache hit: ~20ms (KV lookup)

### Marketer Worker

- Cold report: 300-700ms
  - Analytics call (network): ~100-300ms
  - React render: ~100-200ms
  - Cache write (KV): ~50-100ms

- Cache hit: ~50ms (KV + response)

### Mobile/Slow Connection

Both workers serve HTML (not SPA), so:
- Initial load: ~1-2s (typical broadband)
- Metrics displayed while JS loads
- Progressive enhancement

## Monitoring & Observability

### Key Metrics

Analytics worker:
```
- Requests per minute (should track user sessions)
- Error rate (should be <0.1%)
- P95 latency (dashboard should load <500ms)
- DB connection errors
```

Marketer worker:
```
- Requests per minute (can be high for reports)
- Error rate (should be <0.1%)
- Cache hit rate (should be >80%)
- Analytics call latency (should be <300ms)
```

### Logging

Both workers implement:
```typescript
console.error() // Errors go to Cloudflare Logpush
console.log()   // Info logs
console.warn()  // Warnings
```

Use Wrangler tail for local development:
```bash
wrangler tail visibility-analytics
wrangler tail visibility-marketer
```

## Upgrade & Deployment Strategy

### Design System Changes

```
1. Update design-system package
2. Test in both workers locally
3. Bump version
4. Deploy both workers together
```

### Analytics-Only Changes

```
1. Update analytics worker
2. Test locally
3. Deploy analytics only
4. Marketer unaffected (internal API contract unchanged)
```

### Marketer-Only Changes

```
1. Update marketer worker
2. Test locally
3. Deploy marketer only
4. Analytics unaffected
```

## Future Enhancements

### Potential additions without rearchitecting:

1. **AI Worker**: `visibility-ai`
   - Receives metrics from analytics
   - Returns insights via API
   - Separate worker for compute-heavy operations

2. **Email Worker**: `visibility-email`
   - Listens to conversion events
   - Sends onboarding sequences
   - Separate worker for async operations

3. **Webhook Worker**: `visibility-webhooks`
   - Listens to analytics updates
   - Calls customer webhooks
   - Separate worker for external integrations

Each would follow the same pattern:
- Full-stack Monolithic Worker
- Imports design-system for UI
- Accesses shared D1 database
- Makes service-to-service calls as needed

## Decision Log

### Why Not Microservices?
- Complexity not justified by current scale
- Network latency between services
- Harder to debug and monitor
- More expensive (more cold starts)

### Why Full-Stack Workers?
- Single deployment unit per domain
- No server management
- Automatic scaling
- Better latency (co-located compute & DB)

### Why Shared Design System?
- Prevent visual drift
- Reduce code duplication
- Easier to maintain consistency
- Simple dependency management

### Why Separate Workers (Not One Monolith)?
- Independent scaling (marketer handles more traffic)
- Clear organizational boundaries
- Easier to understand code (each has single purpose)
- Can deploy independently (faster iteration)

## Conclusion

This architecture provides:
- ✅ Simplicity (each worker is ~1000-2000 LOC)
- ✅ Clarity (boundaries are explicit)
- ✅ Consistency (shared design system)
- ✅ Scalability (workers scale independently)
- ✅ Reliability (services degrade gracefully)
- ✅ Debuggability (small, focused codebases)
