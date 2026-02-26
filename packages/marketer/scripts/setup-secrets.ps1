#!/usr/bin/env pwsh
<#
  setup-secrets.ps1 — Configure Cloudflare Worker secrets for visibility-marketing

  Usage:
    .\scripts\setup-secrets.ps1 [-Environment production|development]

  This script interactively prompts for each secret and stores it via
  `wrangler secret put`. Secrets are never written to disk or committed.

  Required secrets:
    ADMIN_TOKEN          — Bearer token for admin API endpoints
    EMAIL_API_KEY        — Brevo or SendGrid transactional email API key
    EMAIL_PROVIDER       — Email provider name: 'brevo' or 'sendgrid'

  Optional secrets:
    SLACK_WEBHOOK_URL    — Slack incoming webhook URL for notifications
    DISCORD_WEBHOOK_URL  — Discord webhook URL for notifications
#>

param(
  [ValidateSet("production", "development")]
  [string]$Environment = "production"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root\packages\marketer

$envFlag = if ($Environment -eq "development") { "--env development" } else { "" }

Write-Host "`n=== Visibility Marketing — Secrets Setup ($Environment) ===" -ForegroundColor Cyan
Write-Host "Secrets are stored in Cloudflare and never written to disk.`n"

# ── Required Secrets ─────────────────────────────────────────────────────────

$required = @(
  @{ Name = "ADMIN_TOKEN";    Desc = "Admin bearer token for API auth" },
  @{ Name = "EMAIL_API_KEY";  Desc = "Brevo or SendGrid API key" },
  @{ Name = "EMAIL_PROVIDER"; Desc = "Email provider ('brevo' or 'sendgrid')" }
)

foreach ($secret in $required) {
  Write-Host "[Required] $($secret.Name) — $($secret.Desc)" -ForegroundColor Yellow
  $value = Read-Host "  Enter value"
  if (-not $value) {
    Write-Host "  Skipped (empty). This secret is REQUIRED for production." -ForegroundColor Red
    continue
  }
  $value | pnpm exec wrangler secret put $secret.Name $envFlag
  Write-Host "  Set successfully.`n" -ForegroundColor Green
}

# ── Optional Secrets ─────────────────────────────────────────────────────────

$optional = @(
  @{ Name = "SLACK_WEBHOOK_URL";   Desc = "Slack incoming webhook URL" },
  @{ Name = "DISCORD_WEBHOOK_URL"; Desc = "Discord webhook URL" }
)

foreach ($secret in $optional) {
  Write-Host "[Optional] $($secret.Name) — $($secret.Desc)" -ForegroundColor Gray
  $value = Read-Host "  Enter value (press Enter to skip)"
  if (-not $value) {
    Write-Host "  Skipped.`n"
    continue
  }
  $value | pnpm exec wrangler secret put $secret.Name $envFlag
  Write-Host "  Set successfully.`n" -ForegroundColor Green
}

Write-Host "=== Secrets setup complete ===" -ForegroundColor Cyan
Write-Host "Verify with: pnpm exec wrangler secret list $envFlag"
