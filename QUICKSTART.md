# Quick Start Guide

Get Visibility Cockpit running locally in 5 minutes.

## Prerequisites

- Node.js 18+ (download from nodejs.org)
- pnpm (install with: `npm install -g pnpm`)
- Git

## Setup (5 minutes)

### 1. Clone and Install

```bash
git clone <repository-url>
cd visibility-platform
pnpm install
```

### 2. Build Design System

The design system must be built first since both workers depend on it:

```bash
pnpm build
```

This creates dist folders in:
- `packages/design-system/dist`
- `packages/analytics/dist`
- `packages/marketer/dist`

### 3. Run Locally

Open two terminals:

**Terminal 1 - Analytics Worker:**
```bash
cd packages/analytics
pnpm dev
```

You'll see:
```
⛅ wrangler 3.x.x
🌍 Listening on http://localhost:8787
```

**Terminal 2 - Marketer Worker:**
```bash
cd packages/marketer
pnpm dev
```

You'll see:
```
⛅ wrangler 3.x.x
🌍 Listening on http://localhost:8788
```

### 4. Visit the Apps

- **Analytics Dashboard**: http://localhost:8787
- **Marketer Landing**: http://localhost:8788
- **Public Report**: http://localhost:8788/report/example.com

## Common Tasks

### Update Design System

Add a new color to the design system:

```typescript
// packages/design-system/src/tokens/colors.ts
export const colors = {
  // ... existing colors
  newColor: '#ff0000'
}
```

Both workers automatically pick up the change on next build:

```bash
pnpm build
# Restart workers to see changes
```

### Add a New Dashboard Page (Analytics)

Create a new route handler:

```typescript
// packages/analytics/src/routes/new-page.ts
export async function renderNewPage(request: Request, db: any, cache: any) {
  const html = `
    <!DOCTYPE html>
    <html>
      <head><title>New Page</title></head>
      <body>
        <h1>My New Page</h1>
      </body>
    </html>
  `
  return new Response(html, { headers: { 'Content-Type': 'text/html' } })
}
```

Register it:

```typescript
// packages/analytics/src/index.ts
import { Router } from 'itty-router'
import { renderNewPage } from './routes/new-page'

const router = Router()
router.get('/new-page', (request, env) => renderNewPage(request, env.VISIBILITY_DB, env.ANALYTICS_CACHE))
```

Restart analytics worker and visit: http://localhost:8787/new-page

### Add a New Public Page (Marketer)

Same process for marketer worker:

```typescript
// packages/marketer/src/index.ts
router.get('/new-public-page', () => {
  return new Response(`
    <!DOCTYPE html>
    <html>
      <head><title>Public Page</title></head>
      <body><h1>Public Content</h1></body>
    </html>
  `)
})
```

Visit: http://localhost:8788/new-public-page

## Using Design System

### Import Components

```typescript
import { Button, Card, MetricCard } from '@visibility/design-system/components'

// Use them
<Button variant="primary">Click me</Button>
<MetricCard label="Users" value={1250} />
```

### Import Tokens

```typescript
import { colors, typography, spacing } from '@visibility/design-system/tokens'

// Use them in styles
style={{
  color: colors.brand.primary,
  fontSize: typography.fontSize.lg,
  padding: spacing[4]
}}
```

### Import Base Styles

```typescript
import '@visibility/design-system/styles'
```

This gives you animations, resets, and utilities.

## Debugging

### View Worker Logs

In development, you'll see logs in the terminal:

```bash
cd packages/analytics && pnpm dev
# Logs appear here as requests come in
```

### Format & Type Check

```bash
# Check types across all packages
pnpm typecheck

# Format code (add formatting tool as needed)
pnpm -r format
```

### Test a Specific Worker

```bash
# Just development logs for analytics
cd packages/analytics && pnpm dev

# Open new terminal and make requests
curl http://localhost:8787/health
```

## File Structure Reference

```
visibility-platform/
├── packages/
│   ├── design-system/          ← Shared UI, styles, tokens
│   │   └── src/
│   │       ├── components/     ← Button, Card, MetricCard, etc
│   │       ├── tokens/         ← Colors, spacing, typography
│   │       └── styles/         ← Global CSS
│   │
│   ├── analytics/              ← Authenticated dashboard
│   │   └── src/
│   │       ├── index.ts        ← Main Hono app
│   │       ├── routes/         ← Pulse, Action, Explore, AI
│   │       ├── lib/            ← DB, cache, render utilities
│   │       └── services/       ← Business logic
│   │
│   └── marketer/               ← Public pages & growth
│       └── src/
│           ├── index.ts        ← Main Hono app
│           ├── routes/         ← Landing pages, reports, widget
│           └── services/       ← Analytics calls, email, attribution
│
├── README.md                   ← Main documentation
├── ARCHITECTURE.md             ← Design decisions
├── DEPLOYMENT.md               ← Production guide
├── package.json                ← Root scripts
└── pnpm-workspace.yaml         ← Monorepo config
```

## Troubleshooting

### "Cannot find module @visibility/design-system"

The design system might not be built:
```bash
cd /packages/design-system
pnpm build
cd ../.. && pnpm build
```

### Port Already in Use

If port 8787 or 8788 is taken:
```bash
# Use custom port
pnpm dev -- --port 3000
```

### Changes Not Showing Up

Wrangler watches files in development:
```bash
# Just save the file, it should hot-reload
# If not, stop (Ctrl+C) and restart:
pnpm dev
```

### Type Errors in Editor

Make sure you've installed dependencies:
```bash
pnpm install
pnpm build  # Generates TypeScript declarations
```

## Next Steps

1. **Read Architecture**: Open [ARCHITECTURE.md](ARCHITECTURE.md) to understand the design
2. **Explore Workers**: Visit http://localhost:8787 and http://localhost:8788 locally
3. **Understand Data Flow**: Read about database schema in [DEPLOYMENT.md](DEPLOYMENT.md)
4. **Make Changes**: Try updating a component in design-system and rebuilding
5. **Deploy**: Follow [DEPLOYMENT.md](DEPLOYMENT.md) to go to production

## Getting Help

- **Architecture Questions**: See [ARCHITECTURE.md](ARCHITECTURE.md)
- **Deployment Questions**: See [DEPLOYMENT.md](DEPLOYMENT.md)
- **Design System**: See [packages/design-system/README.md](packages/design-system/README.md)
- **Analytics Worker**: See [packages/analytics/README.md](packages/analytics/README.md)
- **Marketer Worker**: See [packages/marketer/README.md](packages/marketer/README.md)

## Key Concepts

### Two Workers, One Product

- **Analytics**: Authenticated dashboard (Pulse, Action, Explore, AI)
- **Marketer**: Public pages & reports (landing, features, pricing, SEO cards)
- **Design System**: Shared visual language (everything looks the same)
- **Database**: Shared data (users, sites, metrics, conversions)

### How They Talk

Marketer calls Analytics when generating public reports:
```
User visits /report/example.com
→ Marketer calls Analytics: /internal/report-data/example.com
→ Analytics calculates metrics
→ Marketer renders report with shared MetricCard component
→ User sees consistent design
```

### Working on Features

- Feature only affects one worker? Update that worker
- Affects design/UI? Update design-system first, then rebuild both workers
- Affects database? Update schema, run migrations, both workers pick it up automatically

## Happy Coding! 🚀

You now have a full-stack platform running locally. Make changes, rebuild, and see them live instantly.
