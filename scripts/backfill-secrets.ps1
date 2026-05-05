#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Backfills Cloudflare Worker secrets from local .dev.vars files.

.DESCRIPTION
  Reads values from local .dev.vars files and pushes them to the specified
  worker/environment using `wrangler secret put`.

  This script only handles secrets whose values ARE KNOWN locally.
  For secrets that are UNKNOWN or need to be generated, see the UNKNOWN section
  at the bottom of this file and the gap checklist in docs/setup/SECRETS_RUNBOOK.md.

.USAGE
  # From workspace root:
  $env:CLOUDFLARE_API_TOKEN = "<your-token>"
  .\scripts\backfill-secrets.ps1

.NOTES
  - Never commit this script with real tokens hardcoded.
  - CLOUDFLARE_API_TOKEN must be set as env var to avoid OAuth browser popup.
  - Run from: D:\coding\clodo-dev-site\visibility-marketing
#>

Set-StrictMode -Version Latest

# ── Config ────────────────────────────────────────────────────────────────────

$MARKETER_VARS = Join-Path $PSScriptRoot "..\packages\marketer\.dev.vars"
$SKRIP_VARS    = "D:\coding\skrip\.dev.vars"

if (-not $env:CLOUDFLARE_API_TOKEN) {
  Write-Error "CLOUDFLARE_API_TOKEN is not set. Export it first."
  exit 1
}

# ── Helpers ───────────────────────────────────────────────────────────────────

function Read-DotEnv {
  param([string]$Path)
  $map = @{}
  if (-not (Test-Path $Path)) { return $map }
  foreach ($line in (Get-Content -Path $Path -Encoding UTF8)) {
    if ($line -match '^\s*#') { continue }
    if ($line -match '^\s*$') { continue }
    if ($line -match '^([^=]+)=(.*)$') {
      $map[$Matches[1].Trim()] = $Matches[2].Trim()
    }
  }
  return $map
}

function Put-Secret {
  param(
    [string]$Key,
    [string]$Value,
    [string]$WorkerName
  )
  if ([string]::IsNullOrEmpty($Value)) {
    Write-Warning "  SKIP $Key → empty value; set manually."
    return
  }
  Write-Host "  PUT $Key → $WorkerName" -ForegroundColor Cyan
  $result = $Value | npx wrangler secret put $Key --name $WorkerName 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Error "  FAILED $Key: $result"
  } else {
    Write-Host "  OK  $Key" -ForegroundColor Green
  }
}

# ── Load local values ─────────────────────────────────────────────────────────

$mkt  = Read-DotEnv $MARKETER_VARS
$skip = Read-DotEnv $SKRIP_VARS

# ── visibility-marketing (production) ─────────────────────────────────────────
# GAP: ADMIN_TOKEN, ADMIN_TOKEN_ROLLOVER not set in production

Write-Host "`n=== visibility-marketing (production) ===" -ForegroundColor Yellow
Put-Secret "ADMIN_TOKEN"          $mkt["ADMIN_TOKEN"]          "visibility-marketing"
Put-Secret "ADMIN_TOKEN_ROLLOVER" $mkt["ADMIN_TOKEN_ROLLOVER"] "visibility-marketing"

# ── visibility-marketing-dev ──────────────────────────────────────────────────
# GAP: SKRIP_SERVICE_TOKEN not set in dev (known from skrip .dev.vars)

Write-Host "`n=== visibility-marketing-dev ===" -ForegroundColor Yellow
Put-Secret "SKRIP_SERVICE_TOKEN" $skip["SKRIP_SERVICE_TOKEN"] "visibility-marketing-dev"

# ── visibility-marketing-staging ─────────────────────────────────────────────
# GAP: SKRIP_BASE_URL, SKRIP_SERVICE_TOKEN not set in staging

Write-Host "`n=== visibility-marketing-staging ===" -ForegroundColor Yellow
Put-Secret "SKRIP_BASE_URL"      $mkt["SKRIP_BASE_URL"]        "visibility-marketing-staging"
Put-Secret "SKRIP_SERVICE_TOKEN" $skip["SKRIP_SERVICE_TOKEN"]  "visibility-marketing-staging"

# ── message-manufacturer-platform (skrip production) ─────────────────────────
# GAP: BREVO_API_KEY, ANTHROPIC_API_KEY not set in production

Write-Host "`n=== message-manufacturer-platform (production) ===" -ForegroundColor Yellow
Put-Secret "BREVO_API_KEY"    $skip["BREVO_API_KEY"]    "message-manufacturer-platform"
Put-Secret "ANTHROPIC_API_KEY" $skip["ANTHROPIC_API_KEY"] "message-manufacturer-platform"

# ── Summary: UNKNOWN values (must be sourced externally) ─────────────────────
Write-Host @"

=== UNKNOWN SECRETS — must be set manually (wrangler secret put <KEY> --name <WORKER>) ===

# Rollover tokens — generate with: openssl rand -base64 32
#   INTERNAL_SECRET_ROLLOVER  → visibility-marketing, visibility-marketing-dev, visibility-marketing-staging
#   AGENT_TOKEN_ROLLOVER      → visibility-marketing, visibility-marketing-dev, visibility-marketing-staging
#   WEBHOOK_TOKEN_ROLLOVER    → visibility-marketing, visibility-marketing-dev, visibility-marketing-staging

# Skrip webhook signing secret — must match skrip INBOUND_WEBHOOK_SECRET
#   SKRIP_WEBHOOK_SIGNING_SECRET  → visibility-marketing, visibility-marketing-staging
#     (already set in visibility-marketing-dev — source value from skrip config or regenerate both sides)

# Analytics workers — ANALYTICS_USER_AUTH_SECRET (generate: openssl rand -base64 32)
#   → visibility-analytics, visibility-analytics-dev, visibility-analytics-prod

# Skrip staging — all secrets missing (clone from production or generate fresh)
#   → message-manufacturer-platform (--env staging)

# Channel secrets (WhatsApp, Telegram, SMS, OpenAI) — see skrip .dev.vars.fill-template
#   → message-manufacturer-platform (production + staging)
"@ -ForegroundColor Magenta
