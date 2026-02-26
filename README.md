# Visibility Cockpit Platform

Full-stack platform built with **parallel monolithic Cloudflare Workers** sharing a unified design system and database.

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│  @visibility/design-system (Shared)         │
│  • Design tokens (colors, spacing, etc)     │
│  • Reusable components (Button, Card, etc)  │
│  • Global styles                             │
└────────────────┬────────────────────────────┘
                 │
         ┌───────┴───────┐
         │               │
    ┌────▼──────────┐   ┌──────▼──────────┐
    │ visibility-  │   │ visibility-     │
    │ analytics    │   │ marketer        │
    │              │   │                 │
    │ • Dashboard  │   │ • Landing pages │
    │ • Auth       │   │ • Public reports│
    │ • Data ingestion  │ • Widget      │
    │ • User APIs  │   │ • Affiliate    │
    └────┬─────────┘   └──────┬─────────┘
         │                     │
         └────────┬────────────┘
                  │
         ┌────────▼────────┐
         │  Shared D1 DB   │
         │                 │
         │ • users         │
         │ • sites         │
         │ • gsc_data      │
         │ • conversions   │
         └─────────────────┘
```

## The Key Insight

This is **NOT** a microservices architecture. Instead, it's:

1. **Two full-stack workers** that operate independently
2. **One shared design system** that ensures visual consistency
3. **One shared database** that enables data synchronization
4. **Explicit service-to-service calls** for data that crosses boundaries

This approach avoids the orchestration nightmare of true microservices while maintaining architectural clarity.

## Monorepo Structure

```
visibility-platform/
├── packages/
│   ├── design-system/              # Shared design tokens & components
│   │   ├── src/
│   │   │   ├── tokens/             # Colors, typography, spacing, breakpoints
│   │   │   ├── components/         # Reusable UI components
│   │   │   └── styles/             # Global CSS
│   │   └── package.json
│   │
│   ├── analytics/                  # Authenticated product experience
│   │   ├── src/
│   │   │   ├── index.ts            # itty-router app & routing (via clodo-framework)
│   │   │   ├── lib/
│   │   │   │   ├── db.ts           # D1 utilities
│   │   │   │   ├── cache.ts        # KV cache
│   │   │   │   └── render.ts       # SSR
│   │   │   ├── routes/             # Page handlers (Pulse, Action, Explore, AI)
│   │   │   ├── services/           # Business logic
│   │   │   ├── components/         # React components
│   │   │   └── pages/              # Full page components
│   │   ├── wrangler.toml
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   └── marketer/                   # Public-facing growth experience
│       ├── src/
│       │   ├── index.ts            # itty-router app & routing (via clodo-framework)
│       │   ├── routes/             # Landing pages, reports, widget
│       │   ├── services/           # Analytics calls, email, attribution
│       │   ├── components/         # Marketer-specific components
│       │   └── pages/              # Full page components
│       ├── wrangler.toml
│       ├── vite.config.ts
│       └── package.json
│
├── pnpm-workspace.yaml             # Monorepo configuration
├── package.json                    # Root scripts
├── tsconfig.json                   # Shared TypeScript config
└── README.md
```

## Getting Started

### Prerequisites
- Node.js 18+
- pnpm (or npm/yarn)
- Wrangler CLI for Cloudflare Workers
- Cloudflare account

### Installation

Install all dependencies (required before first use):

```bash
pnpm install
```

Then verify the installation:

```bash
pnpm typecheck
```

For detailed setup instructions, see [SETUP_INSTRUCTIONS.md](./SETUP_INSTRUCTIONS.md)

### Installation

```bash
# Clone and install
git clone <repo>
cd visibility-platform
pnpm install

# Build design system first (other packages depend on it)
pnpm -r build

# Typecheck everything
pnpm typecheck
```

### Development

```bash
# Run all workers in development mode
pnpm dev

# Or run individual workers
cd packages/analytics && pnpm dev
cd packages/marketer && pnpm dev
```

Visit:
- Analytics: `http://localhost:8787` (or designated port)
- Marketer: `http://localhost:8788` (or designated port)

### Deployment

```bash
# Build all packages
pnpm build

# Deploy each worker
cd packages/analytics && pnpm deploy
cd packages/marketer && pnpm deploy

# Or deploy all at once
pnpm deploy
```

## Design System: The Connective Tissue

The magic of this architecture is the **shared design system**. Both workers use:

- **Same colors**: `colors.brand.primary`, `colors.status.critical`, etc.
- **Same typography**: `typography.fontSize.lg`, `typography.fontWeight.bold`, etc.
- **Same spacing**: `spacing[4]`, `spacing[8]`, etc.
- **Same components**: `Button`, `Card`, `MetricCard`, `Badge`, `Input`, `Alert`

### Critical Pattern: MetricCard

The `MetricCard` component appears in **both workers**:

**In analytics dashboard:**
```typescript
<MetricCard
  label="People Who Chose You"
  value={1250}
  delta="↓ 28%"
  trend="down"
  subtitle="Clicks from search results"
/>
```

**In public report:**
```typescript
<MetricCard
  label="Domain Authority"
  value="68/100"
  subtitle="Backlink profile strength"
/>
```

Same component, different data, identical visual language. User feels they never left the product.

## Data Synchronization

### Shared Tables (Both workers read)
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  subscription_tier TEXT,
  trial_ends_at INTEGER,
  created_at INTEGER
);

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  domain TEXT,
  health_score INTEGER,
  domain_authority INTEGER,
  last_analyzed_at INTEGER
);
```

### Analytics-Only Tables
```sql
CREATE TABLE gsc_data (
  site_id TEXT REFERENCES sites(id),
  date TEXT,
  keyword TEXT,
  position REAL,
  clicks INTEGER,
  impressions INTEGER,
  PRIMARY KEY (site_id, date, keyword)
);
```

### Marketer-Only Tables
```sql
CREATE TABLE conversions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  source TEXT,          -- 'organic', 'affiliate', 'referral'
  affiliate_id TEXT,
  created_at INTEGER
);
```

## Service-to-Service Communication

When marketer needs data that analytics owns, it calls analytics:

```typescript
const analyticsUrl = `${ANALYTICS_WORKER_URL}/internal/report-data/${domain}`
const response = await fetch(analyticsUrl)
const data = await response.json()
// { healthScore, domainAuthority, contentStrength, ... }
```

This pattern:
- ✅ Keeps each worker independent
- ✅ Allows analytics to apply business logic
- ✅ Enables caching of public data
- ✅ Prevents direct database access from crossing boundaries

## Routing Strategy

Configured at Cloudflare level (wrangler.toml routes):

```toml
# All public paths go to marketer
[[routes]]
pattern = "visibility.clodo.dev/report/*"
service = "visibility-marketer"

[[routes]]
pattern = "visibility.clodo.dev/features"
service = "visibility-marketer"

[[routes]]
pattern = "visibility.clodo.dev/pricing"
service = "visibility-marketer"

# Everything else goes to analytics (with auth check)
[[routes]]
pattern = "visibility.clodo.dev/*"
service = "visibility-analytics"
```

Traffic is split at the routing level, not in application code. Clear boundaries = no ambiguity.

## Development Workflow

### Adding a Feature to Design System

1. Create component in `packages/design-system/src/components/`
2. Export from `packages/design-system/src/components/index.tsx`
3. Both workers automatically import on next build

### Adding a Page to Analytics

1. Create route handler in `packages/analytics/src/routes/`
2. Register in `packages/analytics/src/index.ts`
3. Use design system components for consistency

### Adding a Public Page to Marketer

1. Create route handler in `packages/marketer/src/routes/`
2. Register in `packages/marketer/src/index.ts`
3. Use design system components for consistency

### Cross-Worker Data

If marketer needs analytics data:
1. Add internal API endpoint in analytics
2. Call from marketer with `fetch(analyticsUrl)`
3. Cache response in KV for performance

## Environment Variables

### Analytics (wrangler.toml)
```toml
[env.development]
vars = { ENVIRONMENT = "development" }

[env.production]
vars = { ENVIRONMENT = "production" }
```

### Marketer (wrangler.toml)
```toml
[env.development]
vars = { ENVIRONMENT = "development", ANALYTICS_WORKER_URL = "http://localhost:8787" }

[env.production]
vars = { ENVIRONMENT = "production", ANALYTICS_WORKER_URL = "https://visibility.clodo.dev" }
```

## Database Migrations

```bash
# Run migrations in analytics package
cd packages/analytics
wrangler d1 migrations create visibility-db create-tables
wrangler d1 migrations apply visibility-db
```

Migrations run against the shared database, both workers access updated schema.

## Performance Optimization

### Caching Strategy
- **Public reports**: Cached in KV for 6 hours (high traffic)
- **Dashboard data**: Cached for 5 minutes (user-specific)
- **Design system**: Bundled, browser-cached per version

### Asset Delivery
- **Fonts**: Served from CDN, cached globally
- **Logo**: Single source of truth, both workers reference
- **Styles**: Included in design-system package

### Worker Separation Benefits
- Analytics worker (internal users): Lower QPS, optimized for accuracy
- Marketer worker (public): Higher QPS, optimized for speed & caching
- No competition for resources

## Testing

```bash
# Type checking
pnpm typecheck

# Run tests (add as needed)
pnpm -r test

# Load testing on public endpoints
# (marketer worker should handle high traffic)
```

## Troubleshooting

### Design System Changes Not Appearing
```bash
# Reinstall and rebuild
pnpm install
pnpm -r build
```

### Database Connection Issues
```bash
# Check bindings in wrangler.toml
# Verify D1_DATABASE_ID in environment
```

### Service-to-Service Call Failures
```bash
# Check ANALYTICS_WORKER_URL is correct
# Verify internal endpoints are not auth-gated
# Check network connectivity (if on same server)
```

## Contributing

1. Design system changes should be tested in both workers
2. Route patterns must be clear and non-overlapping
3. Component props should support className for customization
4. All shared code goes in design-system package
5. Worker-specific logic stays in worker packages

## Production Deployment Checklist

- [ ] All environment variables configured
- [ ] D1 migrations applied
- [ ] Design system version bumped
- [ ] Analytics worker deployed
- [ ] Marketer worker deployed
- [ ] Routes configured at Cloudflare
- [ ] Health checks passing
- [ ] Analytics-to-marketer calls working
- [ ] Public reports rendering
- [ ] Dashboard accessible with auth

## Support & Documentation

- Design System: [packages/design-system/README.md](packages/design-system/README.md)
- Analytics: [packages/analytics/README.md](packages/analytics/README.md)
- Marketer: [packages/marketer/README.md](packages/marketer/README.md)
