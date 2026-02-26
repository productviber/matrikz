# visibility-marketer

Public-facing growth and marketing worker for Visibility Cockpit. Handles landing pages, public reports, affiliate tracking, and conversion attribution.

## Architecture

This is a **full-stack monolithic worker** that handles:

- **Backend**: clodo-framework + itty-router with database and caching
- **Frontend**: Public landing pages and report pages
- **Growth Mechanics**: Affiliate tracking, widget serving, email campaigns
- **Conversion Attribution**: Tracks signups from various sources

## Project Structure

```
src/
├── index.ts              # Main itty-router app & routing (via clodo-framework)
├── routes/
│   ├── landing-pages.ts  # /features, /pricing, /about
│   ├── public-reports.ts # /report/:domain
│   ├── widget.ts         # /widget.js serving
│   └── affiliate.ts      # /affiliate/:code
├── services/
│   ├── analytics-client.ts    # Calls analytics worker
│   ├── email-sender.ts        # SendGrid integration
│   └── attribution.ts         # Cookie/UTM tracking
├── components/           # Marketer-specific components
└── pages/               # Full page components
```

## Running Locally

```bash
# Install dependencies
pnpm install

# Development (set ANALYTICS_WORKER_URL=http://localhost:8787)
pnpm dev

# Build
pnpm build

# Deploy
pnpm deploy
```

## Design System Integration

Uses the **exact same design system** as analytics for visual consistency:

```typescript
import { Button, Card, MetricCard } from '@visibility/design-system/components'
import { colors } from '@visibility/design-system/tokens'
```

**Critical Design Pattern**: The `MetricCard` component is used in:
- ✅ Analytics dashboard (shows user's own KPIs)
- ✅ Public reports (shows target domain's metrics)

Visually identical, functionally different = cohesive product experience.

## Routes

### Public Pages
- `GET /` — Home page
- `GET /features` — Features page
- `GET /pricing` — Pricing page
- `GET /about` — About page

### Public Reports (No Auth)
- `GET /report/:domain` — SEO report card for any domain

### Growth Mechanics
- `GET /widget.js?domain=example.com` — Embeddable widget code
- `GET /affiliate/:code` — Affiliate tracking & redirect

### Internal (Called by signup flow)
- `POST /internal/record-conversion` — Record conversions

## Calling Analytics Worker

When rendering public reports, marketer calls analytics:

```typescript
const response = await fetch(`${ANALYTICS_WORKER_URL}/internal/report-data/:domain`)
const data = await response.json()
// data: { healthScore, domainAuthority, contentStrength, ... }
```

Then renders the same `MetricCard` component that appears in the dashboard.

## Database Schema

### Shared Tables (read-only)
- `users` — For subscription checks in emails
- `sites` — For report generation

### Marketer-Specific Tables
- `conversions` — Signup attribution tracking
- `affiliates` — Partner program data
- `email_campaigns` — Campaign records

## Widget Embedding

Website owners can embed the widget:

```html
<div id="visibility-widget"></div>
<script src="https://visibility.clodo.dev/widget.js?domain=example.com"></script>
```

This displays an iframe with the public report for their domain.
