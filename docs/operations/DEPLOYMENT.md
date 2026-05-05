# Deployment Guide

Complete walkthrough for deploying Visibility Cockpit to production.

For security/auth hardening progression, capability deltas, and external secret ownership/flow, see `CAPABILITY_PROGRESSION.md`.
For copy/paste secret provisioning commands per worker and environment, see `SECRETS_RUNBOOK.md`.

## Prerequisites

1. Cloudflare account with Workers enabled
2. Domain registered and DNS managed by Cloudflare
3. Wrangler CLI installed: `npm install -g wrangler`
4. Authenticated with Cloudflare: `wrangler login`

## Step 1: Create D1 Database

```bash
# Create shared database
wrangler d1 create visibility-db

# You'll get an ID like:
# Created database successfully with ID: abc123def456

# Export this ID
export D1_DATABASE_ID=abc123def456
```

## Step 2: Create KV Namespaces

```bash
# Create analytics cache
wrangler kv:namespace create "ANALYTICS_CACHE"
wrangler kv:namespace create "ANALYTICS_CACHE" --preview

# Create marketer cache  
wrangler kv:namespace create "MARKETER_CACHE"
wrangler kv:namespace create "MARKETER_CACHE" --preview

# You'll get IDs, update wrangler.toml files with these
```

## Step 3: Configure Workers

### Update packages/analytics/wrangler.toml

```toml
name = "visibility-analytics"
main = "dist/index.js"
compatibility_date = "2024-01-15"

[[d1_databases]]
binding = "VISIBILITY_DB"
id = "YOUR_D1_ID"

[[kv_namespaces]]
binding = "ANALYTICS_CACHE"
id = "YOUR_ANALYTICS_KV_ID"
preview_id = "YOUR_ANALYTICS_KV_PREVIEW_ID"

[env.production]
name = "visibility-analytics"
vars = { ENVIRONMENT = "production" }

[env.development]
name = "visibility-analytics-dev"
vars = { ENVIRONMENT = "development" }
```

### Update packages/marketer/wrangler.toml

```toml
name = "visibility-marketer"
main = "dist/index.js"
compatibility_date = "2024-01-15"

[[d1_databases]]
binding = "VISIBILITY_DB"
id = "YOUR_D1_ID"

[[kv_namespaces]]
binding = "MARKETER_CACHE"
id = "YOUR_MARKETER_KV_ID"
preview_id = "YOUR_MARKETER_KV_PREVIEW_ID"

[env.production]
name = "visibility-marketer"
vars = { 
  ENVIRONMENT = "production"
  ANALYTICS_WORKER_URL = "https://visibility.clodo.dev"
}

[env.development]
name = "visibility-marketer-dev"
vars = { 
  ENVIRONMENT = "development"
  ANALYTICS_WORKER_URL = "http://localhost:8787"
}
```

## Step 4: Run Database Migrations

```bash
cd packages/analytics

# Apply migrations
wrangler d1 migrations apply visibility-db --remote

# Verify schema
wrangler d1 execute visibility-db --command "SELECT name FROM sqlite_master WHERE type='table';"
```

## Step 5: Deploy Workers

```bash
# Build all packages
pnpm build

# Deploy analytics worker
cd packages/analytics
wrangler deploy --env production

# Deploy marketer worker (in new terminal)
cd packages/marketer
wrangler deploy --env production

# You'll get URLs like:
# https://visibility-analytics.yourname.workers.dev
# https://visibility-marketer.yourname.workers.dev
```

## Step 6: Configure Cloudflare Routing

### Create Custom Domain with Routes

In Cloudflare Dashboard:

1. Go to your domain → Workers → Routes
2. Create routes with pattern matching:

```
Pattern: visibility.clodo.dev/api/agentic/*
Worker: visibility-marketing

Pattern: visibility.clodo.dev/api/admin/*
Worker: visibility-marketing

Pattern: visibility.clodo.dev/api/system/*
Worker: visibility-marketing

Pattern: visibility.clodo.dev/webhooks/*
Worker: visibility-marketing

Pattern: visibility.clodo.dev/affiliate/*
Worker: visibility-marketing

Pattern: visibility.clodo.dev/*
Worker: visibility-analytics
```

### Or Use Wrangler Routes (wrangler.toml)

Create a `wrangler.toml` in root:

```toml
# This would require a proper workers monorepo setup
# For now, use Cloudflare Dashboard manual configuration
```

## Step 7: Verify Deployment

```bash
# Test analytics worker
curl https://visibility.clodo.dev/health

# Test marketing worker - health
curl https://visibility.clodo.dev/health

# Test marketing worker - agentic API (requires AGENT_TOKEN)
curl -H "Authorization: Bearer $AGENT_TOKEN" https://visibility.clodo.dev/api/agentic/growth-signals

# Test marketing worker - admin (requires ADMIN_TOKEN)
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://visibility.clodo.dev/api/admin/subjects
```

All should return 200 OK.

## Step 8: Domain Configuration

### DNS Setup

Your domain should already be on Cloudflare. No DNS changes needed.

### SSL/TLS

Cloudflare automatically provides SSL certificates.
- Go to domain → SSL/TLS → Overview
- Ensure "Flexible" or "Full" mode is enabled

### Security Rules

Recommend:
- Enable DDoS protection (standard is free)
- Configure WAF rules for public endpoints
- Rate limit public report endpoints

## Step 9: Environment-Specific Configuration

### Production Environment Variables

```bash
# In Cloudflare Dashboard → Workers → Settings

# For visibility-analytics:
ENVIRONMENT=production

# For visibility-marketer:
ENVIRONMENT=production
ANALYTICS_WORKER_URL=https://visibility.clodo.dev
```

### Development Environment

For local development:

```bash
# From root
pnpm install
pnpm build

# In one terminal
cd packages/analytics && pnpm dev

# In another terminal  
cd packages/marketer && pnpm dev

# Visit
# http://localhost:8787 (analytics)
# http://localhost:8788 (marketer)
```

## Service-to-Service Authentication (Optional)

For production, add auth between workers:

```typescript
// In analytics worker
app.use('/internal/*', async (c, next) => {
  const apiKey = c.req.header('x-internal-api-key')
  if (apiKey !== c.env.INTERNAL_API_KEY) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
})

// In marketer worker
const response = await fetch(`${ANALYTICS_WORKER_URL}/internal/report-data/${domain}`, {
  headers: {
    'x-internal-api-key': INTERNAL_API_KEY
  }
})
```

Store `INTERNAL_API_KEY` in Cloudflare Workers Secrets.

## Monitoring & Observability

### Enable Logpush

In Cloudflare Dashboard:
1. Analytics → Logs → Configure Logpush
2. Select "Workers Trace Events"
3. Export to your logging service

### View Logs

```bash
# Local development logs
pnpm dev  # Shows real-time logs

# Production logs
wrangler tail visibility-analytics
wrangler tail visibility-marketer
```

## Rollback Procedure

```bash
# If deployment breaks, rollback previous version:

# View deployment history
wrangler deployments list

# Get previous version
wrangler rollback DEPLOYMENT_ID
```

## Troubleshooting

### Workers Not Communicating

```
Error: fetch failed from marketer to analytics
```

**Fix**: Verify `ANALYTICS_WORKER_URL` is correct in marketer's env vars

### Database Connection Errors

```
Error: VISIBILITY_DB not defined
```

**Fix**: Ensure D1 database ID is in wrangler.toml for both workers

### Routes Not Working

```
404 Not Found
```

**Fix**: Verify routes are configured in Cloudflare Dashboard (Workers → Routes), not just wrangler.toml

### Performance Issues

Monitor in Analytics Dashboard:
- CPU time per request
- Memory usage
- Requests per minute
- Error rate

If marketer worker is slow, increase KV cache TTL:

```typescript
await cache.set(key, value, { ttl: 21600 }) // 6 hours
```

## Production Checklist

- [ ] D1 database created and verified
- [ ] Migrations applied successfully
- [ ] KV namespaces created for both workers
- [ ] All wrangler.toml files updated with correct IDs
- [ ] Both workers deployed and accessible
- [ ] Routes configured in Cloudflare Dashboard
- [ ] Analytics-to-marketer calls working
- [ ] Health checks passing for both workers
- [ ] Domain SSL/TLS configured
- [ ] DDoS protection enabled
- [ ] Monitoring/logging enabled
- [ ] Backup strategy in place (D1 backups)

## Marketer D1 Migration Runbook

Apply all pending migrations to the marketer D1 database. Run staging first, then production.

### Prerequisites

Ensure Wrangler is authenticated and the D1 database binding name matches `wrangler.toml`:

```powershell
# Confirm binding name in packages/marketer/wrangler.toml:
# [[d1_databases]]
# binding = "DB"
# database_name = "visibility-marketing"
# database_id = "<your-d1-id>"
```

### Apply to Staging

```powershell
Set-Location packages/marketer
# Dry-run first — lists pending migrations without applying
wrangler d1 migrations apply visibility-marketing --env staging --dry-run

# Apply after confirming dry-run output
wrangler d1 migrations apply visibility-marketing --env staging
```

### Verify Migration State

```powershell
# List applied migrations
wrangler d1 execute visibility-marketing --env staging --command "SELECT * FROM d1_migrations ORDER BY applied_at DESC LIMIT 20;"

# Verify key tables exist
wrangler d1 execute visibility-marketing --env staging --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Expected tables after all migrations (0001–0014):
`outbound_campaigns`, `outbound_prospects`, `cold_outreach_sequences`, `warmup_schedule`,
`prospect_channels`, `follow_up_sequences`, `suppression_list`, `email_sends`,
`email_sends_engagement`, `contact_channel_identities`, `channel_authorities`,
`channel_execution_outbox`, `channel_message_lineage`, `skrip_outbound_events`,
`growth_signals`, `agent_actions`, `agent_action_events`, `agent_action_outcomes`.

### Verify Channel Authority Rows (dry_run gate)

Before enabling live Skrip sends, insert `dry_run` authority rows for each non-email channel
and confirm the policy engine sees them:

```sql
-- Insert dry_run authority for push (repeat for sms, whatsapp, telegram)
INSERT INTO channel_authorities (tenant_id, campaign_id, channel, authority, rollout_state)
VALUES ('default', NULL, 'push', 'skrip', 'dry_run')
ON CONFLICT DO UPDATE SET rollout_state = 'dry_run', authority = 'skrip';

INSERT INTO channel_authorities (tenant_id, campaign_id, channel, authority, rollout_state)
VALUES ('default', NULL, 'sms', 'skrip', 'dry_run')
ON CONFLICT DO UPDATE SET rollout_state = 'dry_run', authority = 'skrip';

INSERT INTO channel_authorities (tenant_id, campaign_id, channel, authority, rollout_state)
VALUES ('default', NULL, 'whatsapp', 'skrip', 'dry_run')
ON CONFLICT DO UPDATE SET rollout_state = 'dry_run', authority = 'skrip';

INSERT INTO channel_authorities (tenant_id, campaign_id, channel, authority, rollout_state)
VALUES ('default', NULL, 'telegram', 'skrip', 'dry_run')
ON CONFLICT DO UPDATE SET rollout_state = 'dry_run', authority = 'skrip';
```

Verify rows:
```sql
SELECT tenant_id, channel, authority, rollout_state FROM channel_authorities ORDER BY channel;
```

### Apply to Production

Only after staging dry-run checks pass:

```powershell
wrangler d1 migrations apply visibility-marketing --env production --dry-run
wrangler d1 migrations apply visibility-marketing --env production
```

### Rollback a Migration

D1 migrations are append-only by convention. To roll back, apply the inverse SQL manually:

```powershell
wrangler d1 execute visibility-marketing --env staging --command "DROP TABLE IF EXISTS growth_signals;"
# Then remove the migration file from d1_migrations tracking if needed
```

For full rollback scripts, see the comments at the top of each migration file in `packages/marketer/migrations/`.

## Ongoing Maintenance

### Weekly
- Monitor worker error rates
- Check database query performance

### Monthly
- Review security logs
- Update dependencies: `pnpm update`
- Test disaster recovery

### Quarterly
- Review design system version, update if needed
- Analyze user metrics from analytics worker
- Conversion tracking from marketer worker
