#!/usr/bin/env pwsh
<#
  deploy.ps1 — Deployment script for visibility-marketing worker

  Usage:
    .\scripts\deploy.ps1 [local|staging|production]

  Steps:
    1. TypeScript type-check
    2. Run unit + integration tests
    3. Build with Vite
    4. Apply D1 migrations (if not 'local')
    5. Deploy to Cloudflare (if not 'local')

  Prerequisites:
    - pnpm installed
    - wrangler authenticated (`wrangler login`)
    - Secrets configured (see scripts/setup-secrets.ps1)
#>

param(
  [ValidateSet("local", "staging", "production")]
  [string]$Environment = "local"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root\packages\marketer

Write-Host "`n=== Visibility Marketing Worker — Deploy ($Environment) ===" -ForegroundColor Cyan

# ── 1. TypeScript Check ──────────────────────────────────────────────────────
Write-Host "`n[1/5] Type-checking..." -ForegroundColor Yellow
pnpm run typecheck
if ($LASTEXITCODE -ne 0) {
  Write-Host "Type-check failed. Aborting." -ForegroundColor Red
  exit 1
}
Write-Host "Type-check passed." -ForegroundColor Green

# ── 2. Tests ─────────────────────────────────────────────────────────────────
Write-Host "`n[2/5] Running tests..." -ForegroundColor Yellow
pnpm run test
if ($LASTEXITCODE -ne 0) {
  Write-Host "Tests failed. Aborting." -ForegroundColor Red
  exit 1
}
Write-Host "All tests passed." -ForegroundColor Green

# ── 3. Build ─────────────────────────────────────────────────────────────────
Write-Host "`n[3/5] Building..." -ForegroundColor Yellow
pnpm run build
if ($LASTEXITCODE -ne 0) {
  Write-Host "Build failed. Aborting." -ForegroundColor Red
  exit 1
}
Write-Host "Build succeeded: dist/index.js" -ForegroundColor Green

# ── 4. Migrations ────────────────────────────────────────────────────────────
if ($Environment -eq "local") {
  Write-Host "`n[4/5] Applying D1 migrations (local)..." -ForegroundColor Yellow
  pnpm run db:migrate
} elseif ($Environment -eq "production") {
  Write-Host "`n[4/5] Applying D1 migrations (remote)..." -ForegroundColor Yellow
  pnpm run db:migrate:prod
} else {
  Write-Host "`n[4/5] Skipping migrations for staging" -ForegroundColor Gray
}

# ── 5. Deploy ────────────────────────────────────────────────────────────────
if ($Environment -eq "local") {
  Write-Host "`n[5/5] Local build complete. Run 'pnpm run dev' to start locally." -ForegroundColor Green
} elseif ($Environment -eq "production") {
  Write-Host "`n[5/5] Deploying to production..." -ForegroundColor Yellow
  pnpm exec wrangler deploy
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Deployment failed!" -ForegroundColor Red
    exit 1
  }
  Write-Host "Deployed to production successfully!" -ForegroundColor Green
} else {
  Write-Host "`n[5/5] Deploying to staging..." -ForegroundColor Yellow
  pnpm exec wrangler deploy --env development
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Staging deployment failed!" -ForegroundColor Red
    exit 1
  }
  Write-Host "Deployed to staging (development env)." -ForegroundColor Green
}

Write-Host "`n=== Done ===" -ForegroundColor Cyan
