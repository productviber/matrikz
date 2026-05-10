param(
  [ValidateSet('development', 'staging', 'production')]
  [string]$Environment = 'staging',

  [ValidateSet('off', 'observe', 'enforce')]
  [string]$Mode = 'observe',

  [string]$DatabaseName = 'visibility-marketing-db',

  [switch]$ApplyMigration,
  [switch]$SetMode
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
  Write-Host "[GovernanceRollout] $Message"
}

Write-Step "Environment: $Environment"
Write-Step "Target mode: $Mode"

if (-not $ApplyMigration -and -not $SetMode) {
  Write-Step "Dry guidance mode (no remote mutations). Use -ApplyMigration and/or -SetMode to execute."
}

Push-Location "$(Split-Path -Parent $PSScriptRoot)\packages\marketer"
try {
  if ($ApplyMigration) {
    Write-Step "Applying marketer D1 migrations (includes governance ingress migration)."
    corepack pnpm exec wrangler d1 migrations apply $DatabaseName --env $Environment
  } else {
    Write-Step "Migration command preview: corepack pnpm exec wrangler d1 migrations apply $DatabaseName --env $Environment"
  }

  if ($SetMode) {
    Write-Step "Setting GOVERNANCE_INGRESS_MODE secret for fail-safe rollout."
    $Mode | corepack pnpm exec wrangler secret put GOVERNANCE_INGRESS_MODE --env $Environment
  } else {
    Write-Step "Mode command preview: echo $Mode | corepack pnpm exec wrangler secret put GOVERNANCE_INGRESS_MODE --env $Environment"
  }

  Write-Step "Post-deploy verification endpoints:"
  Write-Step "  GET /api/admin/governance/ingress-slo?hours=24"
  Write-Step "  GET /api/admin/governance/ingress-slo?hours=24&reason=authority_context_untrusted_source"
} finally {
  Pop-Location
}
