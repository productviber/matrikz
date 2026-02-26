#!/usr/bin/env pwsh
<#
  validate-local.ps1 — Quick local validation: typecheck + test + build

  Usage:
    .\scripts\validate-local.ps1

  This script runs all checks required before committing code.
  No deployment or remote operations.
#>

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root\packages\marketer

Write-Host "`n=== Local Validation ===" -ForegroundColor Cyan
$failed = @()

# TypeScript
Write-Host "`n[1/3] TypeScript type-check..." -ForegroundColor Yellow
pnpm run typecheck 2>&1
if ($LASTEXITCODE -ne 0) { $failed += "typecheck" } else { Write-Host "  PASS" -ForegroundColor Green }

# Tests
Write-Host "`n[2/3] Unit + integration tests..." -ForegroundColor Yellow
pnpm run test 2>&1
if ($LASTEXITCODE -ne 0) { $failed += "tests" } else { Write-Host "  PASS" -ForegroundColor Green }

# Build
Write-Host "`n[3/3] Vite build..." -ForegroundColor Yellow
pnpm run build 2>&1
if ($LASTEXITCODE -ne 0) { $failed += "build" } else { Write-Host "  PASS" -ForegroundColor Green }

# Summary
Write-Host "`n─────────────────────────────────" -ForegroundColor Gray
if ($failed.Count -gt 0) {
  Write-Host "FAILED: $($failed -join ', ')" -ForegroundColor Red
  exit 1
} else {
  Write-Host "All checks passed — ready to commit/deploy." -ForegroundColor Green
}
