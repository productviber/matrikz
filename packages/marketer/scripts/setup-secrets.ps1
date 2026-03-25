#!/usr/bin/env pwsh
<#
  Wrapper for root secrets orchestrator.

  Keeps existing entrypoint stable while delegating to:
    ..\..\..\scripts\setup-secrets.ps1
#>

param(
  [ValidateSet("production", "development")]
  [string]$Environment = "production",

  [switch]$ShowPlan
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$rootScript = Join-Path $repoRoot "scripts/setup-secrets.ps1"

if (-not (Test-Path $rootScript)) {
  throw "Root setup script not found: $rootScript"
}

& $rootScript -Environment $Environment -Worker marketing -ShowPlan:$ShowPlan
