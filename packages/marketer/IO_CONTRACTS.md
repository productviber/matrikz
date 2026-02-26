# Visibility Marketing Worker — I/O Contracts

Complete specification of all input expectations and output formats for upstream and downstream integration.

---

## 1. Event Ingestion (Upstream: visibility-analytics → marketing)

The analytics worker calls the marketing worker via **Cloudflare Service Binding** at:

```
POST /events
Content-Type: application/json
```

### Event Envelope (all events)

```jsonc
{
  "event": "<event_type>",          // Required — string
  "source": "visibility-analytics", // Required — must be exactly this value
  "timestamp": "2024-01-15T10:30:00.000Z", // Required — ISO 8601
  "data": { /* event-specific payload */ }  // Required — object
}
```

**Validation rules:**
- `source` must be `"visibility-analytics"` (rejects with 400 otherwise)
- All four fields (`event`, `source`, `timestamp`, `data`) are required
- Unknown event types are accepted (logged, not rejected) for forward compatibility

### Event: `affiliate.conversion`

Triggered when a user *referred by an affiliate* completes a purchase.

```jsonc
{
  "event": "affiliate.conversion",
  "source": "visibility-analytics",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "data": {
    "affiliateCode": "jane-a1b2",       // string — affiliate's unique code
    "userId": "buyer@example.com",       // string — buyer email
    "eventType": "purchase",             // string — event descriptor
    "amountCents": 2900,                 // integer — sale amount in cents
    "commissionCents": 580,              // integer — commission in cents
    "plan": "pro"                        // string — purchased plan name
  }
}
```

**Side effects:**
1. Records conversion note in `affiliate_notes` table
2. Updates CRM contact → `customer` status
3. Updates affiliate cumulative stats in KV (`affiliate-stats:<code>`)
4. Checks for tier upgrade (Starter→Silver→Gold→Platinum)
5. Checks for earnings milestone ($100/$500/$1K/$5K)
6. Enrolls affiliate in commission notification email sequence
7. Sends Slack/Discord notification

### Event: `user.converted`

Triggered when *any* user completes a purchase (regardless of affiliate).

```jsonc
{
  "event": "user.converted",
  "source": "visibility-analytics",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "data": {
    "userId": "user@example.com",        // string — buyer email
    "purchaseType": "base",              // string — 'base'|'pro'|'enterprise'|'credits'
    "plan": "monthly",                   // string — 'monthly'|'yearly'|'pro'|'credits'
    "amountCents": 2900,                 // integer — payment amount in cents
    "gateway": "stripe"                  // string — 'stripe'|'razorpay'
  }
}
```

**Side effects:**
1. Moves contact to `customer` in CRM
2. Cancels pending trial-expiry emails (if was trial)
3. Enrolls in post-purchase onboarding sequence (4 emails over 7 days)
4. Updates MRR/ARR snapshot
5. Stores conversion metadata in KV
6. Increments daily conversion counter + revenue tracker
7. Sends Slack/Discord notification

### Future Events (stub handlers)

These events are accepted and logged but have minimal processing today:

| Event | Expected Data |
|---|---|
| `user.signup` | `{ userId, provider, referrer?, affiliateCode? }` |
| `user.churned` | `{ userId, previousPlan, daysActive, lastActivity }` |
| `user.milestone` | `{ userId, milestoneType, milestoneValue }` |
| `affiliate.click` | `{ affiliateCode, landingPage, referrer, country }` |
| `insight.generated` | `{ userId, headlineType, insightCategory }` |

### Event Ingestion Response

```jsonc
// Success (200)
{ "ok": true, "event": "affiliate.conversion" }

// Bad source (400)
{ "ok": false, "error": "Unknown source" }

// Invalid envelope (400)
{ "ok": false, "error": "Invalid event envelope" }

// Processing error (500)
{ "ok": false, "error": "Event processing error" }
```

---

## 2. API Endpoints (Downstream consumers)

All API responses follow this envelope:

```jsonc
{
  "ok": true,        // boolean — success indicator
  "data": { ... },   // T | undefined — response payload
  "error": "...",     // string | undefined — error message on failure
  "meta": { ... }     // object | undefined — pagination, counts, etc.
}
```

CORS headers are included on all responses:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
```

### Authentication

Admin endpoints require:
```
Authorization: Bearer <ADMIN_TOKEN>
```

Returns `401 { ok: false, error: "Unauthorized" }` on failure.

---

### `GET /health`
Quick health probe.

**Response (200):**
```jsonc
{ "ok": true, "data": { "worker": "visibility-marketing", "version": "1.0.0" } }
```

### `GET /api/health`
Detailed health with binding checks.

**Response (200):**
```jsonc
{
  "ok": true,
  "data": {
    "worker": "visibility-marketing",
    "version": "1.0.0",
    "database": "connected",
    "kv": "connected",
    "analytics": "connected",
    "environment": "production"
  }
}
```

---

### `POST /api/affiliate/apply`
Public endpoint — submit affiliate application.

**Request body:**
```jsonc
{
  "email": "affiliate@example.com",     // Required — valid email format
  "name": "Jane Doe",                   // Required — applicant name
  "website": "https://jane.dev",        // Optional
  "audience": "SEO professionals",      // Optional
  "promotionPlan": "Blog reviews"       // Optional
}
```

**Response (201):**
```jsonc
{
  "ok": true,
  "data": {
    "code": "jane-doe-a1b2",
    "status": "pending",
    "message": "Application received! We'll review it within 48 hours."
  }
}
```

**Error responses:**
- `400` — Missing `email` or `name`, invalid email format, or duplicate application

---

### `POST /api/affiliate/approve` 🔒 Admin
Approve a pending affiliate application.

**Request body:**
```jsonc
{
  "code": "jane-doe-a1b2",       // Required — affiliate code from application
  "commissionRate": 0.20          // Optional — default 0.20 (20%)
}
```

**Response (200):**
```jsonc
{
  "ok": true,
  "data": {
    "code": "jane-doe-a1b2",
    "email": "affiliate@example.com",
    "name": "Jane Doe",
    "commissionRate": 0.20,
    "status": "approved"
  }
}
```

**Side effect:** Creates affiliate in visibility-analytics via service binding.

---

### `GET /api/affiliate/applications` 🔒 Admin
List pending affiliate applications.

**Response (200):**
```jsonc
{
  "ok": true,
  "data": {
    "applications": [
      {
        "code": "jane-doe-a1b2",
        "email": "affiliate@example.com",
        "name": "Jane Doe",
        "website": "https://jane.dev",
        "status": "pending",
        "appliedAt": "2024-01-15T10:30:00.000Z"
      }
    ],
    "count": 1
  }
}
```

---

### `GET /api/affiliate/portal?code=<affiliate_code>`
Affiliate self-service dashboard.

**Query params:**
- `code` (required) — affiliate code

**Response (200):**
```jsonc
{
  "ok": true,
  "data": {
    "code": "jane-doe-a1b2",
    "label": "Jane Doe",
    "tier": "Silver (25%)",
    "commissionRate": 0.25,
    "totalClicks": 450,
    "totalConversions": 15,
    "totalEarnedCents": 25000,
    "unpaidEarningsCents": 8000,
    "recentConversions": [
      {
        "userId": "a1b2c3d4e5f67890",
        "plan": "pro",
        "amountCents": 2900,
        "commissionCents": 725,
        "convertedAt": "2024-01-15"
      }
    ],
    "payoutHistory": [
      {
        "amountCents": 17000,
        "method": "paypal",
        "reference": "PP-12345",
        "createdAt": "2024-01-01"
      }
    ]
  }
}
```

---

### `GET /api/affiliate/stats?code=<affiliate_code>`
Quick affiliate stats (KV-backed, fast).

**Response (200):**
```jsonc
{
  "ok": true,
  "data": {
    "totalConversions": 15,
    "totalEarnedCents": 25000,
    "lastConversionAt": "2024-01-15T10:30:00.000Z"
  }
}
```

---

### `POST /api/campaigns` 🔒 Admin
Create a new campaign/referral link.

**Request body:**
```jsonc
{
  "name": "Blog Launch Q1",              // Required
  "affiliateCode": "jane-doe-a1b2",      // Optional — links campaign to affiliate
  "utmSource": "affiliate",              // Optional — default "affiliate"
  "utmMedium": "referral",               // Optional — default "referral"
  "utmCampaign": "blog-launch-q1",       // Optional — default: generated slug
  "utmContent": "sidebar-banner",        // Optional
  "utmTerm": "seo tools",               // Optional
  "destinationUrl": "https://visibility.clodo.dev"  // Optional — default value shown
}
```

**Response (201):**
```jsonc
{
  "ok": true,
  "data": {
    "id": 1,
    "name": "Blog Launch Q1",
    "slug": "blog-launch-q1",
    "affiliate_code": "jane-doe-a1b2",
    "utm_source": "affiliate",
    "utm_medium": "referral",
    "utm_campaign": "blog-launch-q1",
    "destination_url": "https://visibility.clodo.dev",
    "clicks": 0,
    "conversions": 0,
    "is_active": 1,
    "referralUrl": "https://visibility.clodo.dev/?utm_source=affiliate&utm_medium=referral&utm_campaign=blog-launch-q1&ref=jane-doe-a1b2"
  }
}
```

---

### `GET /api/campaigns?affiliate=<code>&page=<n>&limit=<n>`
List campaigns, optionally filtered.

**Query params:**
- `affiliate` (optional) — filter by affiliate code
- `page` (optional, default 1) — page number
- `limit` (optional, default 50, max 100) — items per page

**Response (200):**
```jsonc
{
  "ok": true,
  "data": {
    "campaigns": [ /* CampaignRow objects with referralUrl */ ],
    "total": 42,
    "page": 1,
    "limit": 50
  }
}
```

---

### `GET /api/campaigns/:slug`
Get campaign details by slug.

**Response (200):**
```jsonc
{
  "ok": true,
  "data": {
    "id": 1,
    "slug": "blog-launch-q1",
    "name": "Blog Launch Q1",
    "clicks": 120,
    "conversions": 8,
    "conversionRate": "6.7%",
    "referralUrl": "https://...",
    "...": "full CampaignRow fields"
  }
}
```

---

### `PUT /api/campaigns/:slug` 🔒 Admin
Update a campaign.

**Request body (all optional):**
```jsonc
{
  "name": "Updated Name",
  "isActive": false,
  "destinationUrl": "https://new-url.com",
  "utmContent": "new-content",
  "utmTerm": "new-term"
}
```

**Response (200):**
```jsonc
{ "ok": true, "data": { "slug": "blog-launch-q1", "updated": true } }
```

---

### `GET /r/:slug`
Referral link redirect. **Not a JSON API — returns 302 redirect.**

**Behavior:**
1. Looks up campaign by slug
2. Increments click counter
3. Sets `__aff` cookie (30-day, Secure, SameSite=Lax) if affiliate-linked
4. Redirects to destination URL with UTM params
5. Falls back to `https://visibility.clodo.dev/?ref=<slug>` if not found

---

### `POST /api/payouts/batch` 🔒 Admin
Create a payout batch.

**Request body:**
```jsonc
{
  "affiliates": [
    {
      "code": "jane-doe-a1b2",
      "email": "jane@example.com",
      "amountCents": 5000,
      "method": "paypal"
    }
  ],
  "notes": "January 2024 payouts"  // Optional
}
```

**Response (201):**
```jsonc
{
  "ok": true,
  "data": {
    "batchId": 1,
    "status": "pending",
    "totalAmountCents": 5000,
    "affiliateCount": 1
  }
}
```

---

### `POST /api/payouts/batch/:id/process` 🔒 Admin
Process (execute) a pending payout batch.

**Response (200):**
```jsonc
{
  "ok": true,
  "data": {
    "batchId": 1,
    "status": "completed",
    "processedItems": 1
  }
}
```

---

### `GET /api/payouts?page=<n>&limit=<n>` 🔒 Admin
List payout batches.

### `GET /api/payouts/:id` 🔒 Admin
Get a specific payout batch with its items.

---

### `GET /api/admin/dashboard` 🔒 Admin
Marketing dashboard metrics.

**Response (200):**
```jsonc
{
  "ok": true,
  "data": {
    "mrr": 15000,
    "arr": 180000,
    "totalCustomers": 42,
    "newCustomersToday": 3,
    "affiliateConversionsToday": 2,
    "pendingPayoutsCents": 12500,
    "activeSequences": 4,
    "emailsSentToday": 15
  }
}
```

---

### `GET /api/admin/mrr?days=<n>` 🔒 Admin
MRR/ARR history (default 30 days).

**Response (200):**
```jsonc
{
  "ok": true,
  "data": {
    "snapshots": [
      {
        "date_key": "2024-01-15",
        "mrr_cents": 15000,
        "arr_cents": 180000,
        "total_customers": 42,
        "new_customers": 3,
        "churned_customers": 1
      }
    ]
  }
}
```

---

### `GET /api/admin/emails/sequences` 🔒 Admin
List email sequences with step counts.

### `GET /api/admin/emails/sends?status=<s>&page=<n>&limit=<n>` 🔒 Admin
List email send history, filterable by status (`scheduled|sent|failed|cancelled`).

### `POST /api/admin/emails/process` 🔒 Admin
Manually trigger email processing (same as cron).

**Response (200):**
```jsonc
{ "ok": true, "data": { "processed": 12 } }
```

---

### `GET /api/admin/contacts?status=<s>&page=<n>&limit=<n>` 🔒 Admin
List CRM contacts, filterable by status (`lead|trial|customer|churned`).

### `GET /api/admin/notifications?page=<n>&limit=<n>` 🔒 Admin
Notification log (Slack/Discord/email delivery history).

---

## 3. Outbound Integrations (Marketing → External)

### Visibility-Analytics Service Binding

Used for:
- Creating affiliates on approval (`POST /admin/affiliates`)
- Updating commission rates on tier upgrade
- Fetching affiliate data (`GET /admin/affiliates?code=...`)
- Health checks (`GET /health`)

### Email Providers

**Brevo (default):**
```
POST https://api.brevo.com/v3/smtp/email
Headers: { api-key: <EMAIL_API_KEY> }
Body: { sender, to, subject, htmlContent }
```

**SendGrid:**
```
POST https://api.sendgrid.com/v3/mail/send
Headers: { Authorization: Bearer <EMAIL_API_KEY> }
Body: { personalizations, from, subject, content }
```

**Development fallback:** When `ENVIRONMENT=development` and no API key, emails are logged to console.

### Slack Webhooks
```
POST <SLACK_WEBHOOK_URL>
Body: { text, blocks? }
```

### Discord Webhooks
```
POST <DISCORD_WEBHOOK_URL>
Body: { content, embeds? }
```

---

## 4. Cron Trigger

```
Schedule: */5 * * * *  (every 5 minutes)
```

Processes up to 100 due email sends per invocation. Sends via configured provider, updates `email_sends` status to `sent` or `failed`.

---

## 5. KV Namespace Keys

| Key Pattern | Value | TTL |
|---|---|---|
| `affiliate-stats:<code>` | `{totalConversions, totalEarnedCents, lastConversionAt}` | 365 days |
| `affiliate-email:<code>` | email string | 365 days |
| `affiliate-application:<code>` | full application JSON | 90 days |
| `affiliate-applications:pending` | `string[]` of codes | none |
| `email-ctx:<email>:<seqId>` | context data JSON | 30 days |
| `user-conversion:<email>` | conversion metadata JSON | 365 days |
| `daily-conversions:<YYYY-MM-DD>` | count string | 90 days |
| `daily-revenue:<YYYY-MM-DD>` | cents string | 90 days |

---

## 6. D1 Database Tables

| Table | Purpose |
|---|---|
| `marketing_contacts` | CRM contacts with lifecycle status |
| `email_sequences` | Drip sequence definitions |
| `email_steps` | Individual steps within sequences |
| `email_sends` | Scheduled/sent/failed email records |
| `affiliate_notes` | Activity log per affiliate |
| `campaigns` | UTM-tagged referral link campaigns |
| `payout_batches` | Payout batch headers |
| `payout_items` | Individual payout line items |
| `notification_log` | Slack/Discord/email delivery log |
| `mrr_snapshots` | Daily MRR/ARR tracking |

---

## 7. Environment Variables & Secrets

### wrangler.toml `[vars]` (non-sensitive)

| Variable | Value | Description |
|---|---|---|
| `FROM_EMAIL` | `product@clodo.dev` | Sender email for outbound mail |
| `FROM_NAME` | `Clodo SEO` | Sender display name |
| `ENVIRONMENT` | `production` | Runtime environment flag |

### Secrets (via `wrangler secret put`)

| Secret | Required | Description |
|---|---|---|
| `ADMIN_TOKEN` | Yes | Bearer token for all admin API endpoints |
| `EMAIL_API_KEY` | Yes (prod) | Brevo or SendGrid API key |
| `EMAIL_PROVIDER` | Yes (prod) | `brevo` or `sendgrid` |
| `SLACK_WEBHOOK_URL` | No | Slack incoming webhook for notifications |
| `DISCORD_WEBHOOK_URL` | No | Discord webhook for notifications |
