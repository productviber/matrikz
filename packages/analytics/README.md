# visibility-analytics

Authenticated product worker for Visibility Cockpit. Serves the complete dashboard experience with authentication, data processing, and user-scoped APIs.

## Architecture

This is a **full-stack monolithic worker** that handles:

- **Backend**: clodo-framework + itty-router with D1 database access
- **Frontend**: React components with SSR support
- **Data Pipeline**: Ingests GSC, Bing, and Cloudflare data
- **API**: User-scoped endpoints for frontend consumption

## Project Structure

```
src/
├── index.ts              # Main itty-router app & routing (via clodo-framework)
├── lib/
│   ├── db.ts            # D1 database utilities
│   ├── cache.ts         # KV cache layer
│   └── render.ts        # SSR utilities
├── routes/
│   ├── pulse.tsx        # /pulse - Dashboard
│   ├── action.tsx       # /action - Action center
│   ├── explore.tsx      # /explore - Deep insights
│   └── ai.tsx           # /ai - AI assistant
├── services/            # Business logic (data pipelines, etc.)
├── components/          # React components
└── pages/              # Full page components
```

## Running Locally

```bash
# Install dependencies
pnpm install

# Development
pnpm dev

# Build
pnpm build

# Deploy
pnpm deploy
```

## Design System Integration

This worker imports `@visibility/design-system` for consistent UI:

```typescript
import { Button, Card, MetricCard } from '@visibility/design-system/components'
import { colors, spacing } from '@visibility/design-system/tokens'
```

All UI uses shared design tokens and components, ensuring the analytics dashboard looks identical to the public reports.

## Database Schema

### Shared Tables
- `users` — Authentication and subscription
- `sites` — Monitored domains and health scores

### Analytics-Specific Tables
- `gsc_data` — Google Search Console metrics
- `bing_data` — Bing Webmaster Tools data
- `cloudflare_data` — CF Analytics metrics

## API Endpoints

### User-Scoped
- `GET /api/auth/me` — Current user
- `GET /api/sites` — User's monitored sites
- `GET /api/metrics/:siteId/:metric` — Performance data

### Internal (for marketer worker)
- `GET /internal/report-data/:domain` — Public report metrics

## Service-to-Service Communication

When `visibility-marketer` needs metrics for public reports, it calls:

```
GET {ANALYTICS_WORKER_URL}/internal/report-data/:domain
```

This allows analytics to apply business logic (permissions, calculations) before exposing data.
