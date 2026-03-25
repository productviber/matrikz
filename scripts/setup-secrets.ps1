#!/usr/bin/env pwsh
<#!
  setup-secrets.ps1 — Interactive Cloudflare secrets setup for Visibility workers.

  Examples:
    .\scripts\setup-secrets.ps1
    .\scripts\setup-secrets.ps1 -Environment production -Worker both
    .\scripts\setup-secrets.ps1 -Environment development -Worker analytics -ShowPlan
#>

param(
  [ValidateSet("production", "development")]
  [string]$Environment = "production",

  [ValidateSet("analytics", "marketing", "both")]
  [string]$Worker = "both",

  [switch]$ShowPlan
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$analyticsDir = Join-Path $RepoRoot "packages/analytics"
$marketingDir = Join-Path $RepoRoot "packages/marketer"

function Get-EnvArgs {
  param([string]$TargetEnvironment)
  if ($TargetEnvironment -eq "production") {
    return @("--env", "production")
  }
  return @("--env", "development")
}

function Put-Secret {
  param(
    [string]$PackageDir,
    [string]$SecretName,
    [string]$SecretValue,
    [string]$TargetEnvironment
  )

  if ([string]::IsNullOrWhiteSpace($SecretValue)) {
    return
  }

  Push-Location $PackageDir
  try {
    $envArgs = Get-EnvArgs -TargetEnvironment $TargetEnvironment
    $SecretValue | pnpm exec wrangler secret put $SecretName @envArgs | Out-Null
  }
  finally {
    Pop-Location
  }
}

function Prompt-And-Set {
  param(
    [string]$PackageDir,
    [string]$ScopeLabel,
    [hashtable[]]$Secrets,
    [string]$TargetEnvironment,
    [bool]$Required
  )

  foreach ($item in $Secrets) {
    $kind = if ($Required) { "Required" } else { "Optional" }
    Write-Host "[$ScopeLabel][$kind] $($item.Name) - $($item.Desc)" -ForegroundColor Yellow

    $prompt = if ($Required) { "  Enter value" } else { "  Enter value (Enter to skip)" }
    $value = Read-Host $prompt

    if ([string]::IsNullOrWhiteSpace($value)) {
      if ($Required) {
        Write-Host "  Skipped (empty). This secret is required for secure operation." -ForegroundColor Red
      }
      else {
        Write-Host "  Skipped." -ForegroundColor DarkGray
      }
      Write-Host ""
      continue
    }

    Put-Secret -PackageDir $PackageDir -SecretName $item.Name -SecretValue $value -TargetEnvironment $TargetEnvironment
    Write-Host "  Set successfully." -ForegroundColor Green
    Write-Host ""
  }
}

$analyticsRequired = @(
  @{ Name = "SYSTEM_TOKEN"; Desc = "Service token for system lane calls" },
  @{ Name = "ADMIN_TOKEN"; Desc = "Admin token for admin lane calls" },
  @{ Name = "ANALYTICS_USER_AUTH_SECRET"; Desc = "HMAC secret for signed x-user-id headers" }
)

$marketingRequired = @(
  @{ Name = "ADMIN_TOKEN"; Desc = "Primary admin token" },
  @{ Name = "ADMIN_TOKEN_ROLLOVER"; Desc = "Rollover admin token" },
  @{ Name = "SYSTEM_TOKEN"; Desc = "Primary system token" },
  @{ Name = "SYSTEM_TOKEN_ROLLOVER"; Desc = "Rollover system token" },
  @{ Name = "AGENT_TOKEN"; Desc = "Primary agent token" },
  @{ Name = "AGENT_TOKEN_ROLLOVER"; Desc = "Rollover agent token" },
  @{ Name = "WEBHOOK_TOKEN"; Desc = "Primary webhook lane token" },
  @{ Name = "WEBHOOK_TOKEN_ROLLOVER"; Desc = "Rollover webhook lane token" },
  @{ Name = "AFFILIATE_AUTH_SECRET"; Desc = "Affiliate session/auth signing secret" },
  @{ Name = "WEBHOOK_SIGNING_SECRET"; Desc = "Inbound webhook signature validation secret" },
  @{ Name = "EMAIL_API_KEY"; Desc = "Transactional email provider API key" },
  @{ Name = "SLACK_WEBHOOK_URL"; Desc = "Slack alerting webhook URL" },
  @{ Name = "DISCORD_WEBHOOK_URL"; Desc = "Discord alerting webhook URL" }
)

$marketingOptionalPayout = @(
  @{ Name = "RAZORPAY_KEY_ID"; Desc = "Razorpay payout key id" },
  @{ Name = "RAZORPAY_KEY_SECRET"; Desc = "Razorpay payout key secret" },
  @{ Name = "STRIPE_SECRET_KEY"; Desc = "Stripe payout secret key" }
)

Write-Host ""
Write-Host "=== Visibility Secrets Setup ===" -ForegroundColor Cyan
Write-Host "Environment: $Environment"
Write-Host "Scope: $Worker"
Write-Host ""

if ($ShowPlan) {
  if ($Worker -in @("analytics", "both")) {
    Write-Host "Analytics required secrets:" -ForegroundColor Cyan
    $analyticsRequired | ForEach-Object { Write-Host "- $($_.Name)" }
    Write-Host ""
  }

  if ($Worker -in @("marketing", "both")) {
    Write-Host "Marketing required secrets:" -ForegroundColor Cyan
    $marketingRequired | ForEach-Object { Write-Host "- $($_.Name)" }
    Write-Host ""

    Write-Host "Marketing optional payout secrets:" -ForegroundColor Cyan
    $marketingOptionalPayout | ForEach-Object { Write-Host "- $($_.Name)" }
    Write-Host ""
  }

  Write-Host "Plan output only. No secrets were changed." -ForegroundColor Green
  exit 0
}

if ($Worker -in @("analytics", "both")) {
  Prompt-And-Set -PackageDir $analyticsDir -ScopeLabel "analytics" -Secrets $analyticsRequired -TargetEnvironment $Environment -Required $true
}

if ($Worker -in @("marketing", "both")) {
  Prompt-And-Set -PackageDir $marketingDir -ScopeLabel "marketing" -Secrets $marketingRequired -TargetEnvironment $Environment -Required $true

  Write-Host "[marketing][optional] Payout provider keys (set only if used)." -ForegroundColor DarkCyan
  Prompt-And-Set -PackageDir $marketingDir -ScopeLabel "marketing" -Secrets $marketingOptionalPayout -TargetEnvironment $Environment -Required $false
}

Write-Host "=== Secrets setup complete ===" -ForegroundColor Cyan
Write-Host "Tip: verify with 'pnpm exec wrangler secret list --env $Environment' inside each package." -ForegroundColor Green