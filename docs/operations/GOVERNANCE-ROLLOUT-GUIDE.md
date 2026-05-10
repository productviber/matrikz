# Governance Ingress — Staged Rollout Execution Guide

> **Purpose:** Step-by-step commands and gate criteria for safely rolling out governance ingress
> enforcement from `off` → `observe` → `enforce` across development, staging, and production.
>
> **Pre-requisite:** Migration `0020_governance_ingress_hardening.sql` must be applied to each environment's D1 instance before any mode change.

---

## Stage 0: Apply Migration

Run once per environment before enabling any mode beyond `off`.

```powershell
# Development
wrangler d1 migrations apply marketer-dev `
  --config packages/marketer/wrangler.toml `
  --env development

# Staging
wrangler d1 migrations apply marketer-staging `
  --config packages/marketer/wrangler.toml `
  --env staging

# Production (only after staging gate passes)
wrangler d1 migrations apply marketer-db `
  --config packages/marketer/wrangler.toml `
  --env production
```

Verify migration applied:
```powershell
wrangler d1 execute marketer-dev `
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name='governance_ingress_decisions';" `
  --config packages/marketer/wrangler.toml `
  --env development
# Expected: 1 row with name = governance_ingress_decisions
```

---

## Stage 1: Enable Observe Mode (Development)

### 1a. Set via wrangler secret (persists across redeployments)
```powershell
echo "observe" | wrangler secret put GOVERNANCE_INGRESS_MODE `
  --config packages/marketer/wrangler.toml `
  --env development
```

### 1b. Or: use KV override for instant change without redeploy
```powershell
$token = $env:MARKETER_ADMIN_TOKEN_DEV
$base  = "https://marketer-dev.clodo.dev"   # replace with actual dev URL

Invoke-RestMethod `
  -Method POST `
  -Uri "$base/api/admin/governance/mode-override" `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body '{"mode":"observe"}'
```

### 1c. Verify active mode
```powershell
Invoke-RestMethod `
  -Method GET `
  -Uri "$base/api/admin/governance/enforcement-status" `
  -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 5
# Expected: activeMode = "observe"
```

### 1d. Gate: Soak for 24h, then check
```powershell
Invoke-RestMethod `
  -Method GET `
  -Uri "$base/api/admin/governance/ingress-slo?hours=24" `
  -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 5
```
- `totals.events > 0` — traffic is flowing through governance gate
- `reasonDistribution.authority_context_untrusted_source` is absent or 0
- `rates.violationRate` is being tracked (any value is ok in dev)

---

## Stage 2: Enable Observe Mode (Staging)

### 2a. Set observe mode
```powershell
echo "observe" | wrangler secret put GOVERNANCE_INGRESS_MODE `
  --config packages/marketer/wrangler.toml `
  --env staging
```

Redeploy staging worker:
```powershell
wrangler deploy `
  --config packages/marketer/wrangler.toml `
  --env staging
```

### 2b. Verify
```powershell
$token = $env:MARKETER_ADMIN_TOKEN_STAGING
$base  = "https://marketer-staging.clodo.dev"

Invoke-RestMethod `
  -Method GET `
  -Uri "$base/api/admin/governance/enforcement-status" `
  -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 5
```

### 2c. Soak period: 7 days minimum

Run the staging gate check at the end of the soak:
```powershell
$slo = Invoke-RestMethod `
  -Method GET `
  -Uri "$base/api/admin/governance/ingress-slo?hours=168" `
  -Headers @{ Authorization = "Bearer $token" }

$data = $slo.data ?? $slo
$ok = $true

if ($data.rates.violationRate -gt 0.02) {
  Write-Warning "GATE FAIL: violationRate = $($data.rates.violationRate) (threshold: 0.02)"
  $ok = $false
}
if (($data.reasonDistribution.authority_context_untrusted_source ?? 0) -gt 0) {
  Write-Warning "GATE FAIL: untrusted_source incidents found"
  $ok = $false
}
if (($data.reasonDistribution.authority_context_target_tenant_mismatch ?? 0) / [Math]::Max(1, $data.totals.events) -gt 0.005) {
  Write-Warning "GATE FAIL: target_tenant_mismatch rate too high"
  $ok = $false
}

if ($ok) { Write-Host "Staging gate PASSED — ready for observe → production" -ForegroundColor Green }
else      { Write-Host "Staging gate FAILED — do not proceed" -ForegroundColor Red }
```

---

## Stage 3: Enable Observe Mode (Production)

### 3a. Pre-flight
- [ ] Staging gate passed (Section 2c)
- [ ] No open incidents on visibility-analytics or marketer
- [ ] At least one engineer available for 30 min after deployment
- [ ] Runbook link bookmarked: `docs/operations/GOVERNANCE-SLO-RUNBOOK.md`

### 3b. Deploy
```powershell
echo "observe" | wrangler secret put GOVERNANCE_INGRESS_MODE `
  --config packages/marketer/wrangler.toml `
  --env production

wrangler deploy `
  --config packages/marketer/wrangler.toml `
  --env production
```

### 3c. Verify immediately after deploy
```powershell
$token = $env:MARKETER_ADMIN_TOKEN_PROD
$base  = "https://marketer.clodo.dev"

Invoke-RestMethod `
  -Method GET `
  -Uri "$base/api/admin/governance/enforcement-status" `
  -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 5
# Expected: activeMode = "observe", overrideActive = false
```

### 3d. Check first-hour SLO
```powershell
Invoke-RestMethod `
  -Method GET `
  -Uri "$base/api/admin/governance/ingress-slo?hours=1" `
  -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 5
```
- `totals.events > 0` — traffic is flowing
- `rates.blockedRate = 0` — no blocking in observe mode (expected)
- No `authority_context_untrusted_source` reason

### 3e. Emergency rollback (if needed)
```powershell
# Instant fail-open via KV (no redeploy required)
Invoke-RestMethod `
  -Method POST `
  -Uri "$base/api/admin/governance/mode-override" `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body '{"mode":"off"}'
```

---

## Stage 4: Enable Selective Enforce Mode (Staging first)

Enforce only on high-risk action types. Set `GOVERNANCE_ENFORCE_ACTIONS` first.

### 4a. Configure action scope (staging)
```powershell
$enforceActions = "enroll_sequence,send_via_skrip,campaign.start,campaign.pause"
echo $enforceActions | wrangler secret put GOVERNANCE_ENFORCE_ACTIONS `
  --config packages/marketer/wrangler.toml `
  --env staging

echo "enforce" | wrangler secret put GOVERNANCE_INGRESS_MODE `
  --config packages/marketer/wrangler.toml `
  --env staging

wrangler deploy `
  --config packages/marketer/wrangler.toml `
  --env staging
```

### 4b. Verify enforce configuration
```powershell
$status = Invoke-RestMethod `
  -Method GET `
  -Uri "https://marketer-staging.clodo.dev/api/admin/governance/enforcement-status" `
  -Headers @{ Authorization = "Bearer $env:MARKETER_ADMIN_TOKEN_STAGING" }

$data = $status.data ?? $status
Write-Host "Active mode: $($data.activeMode)"
Write-Host "Enforce action types: $($data.policy.enforceActionTypes -join ', ')"
# Expected: activeMode = enforce, enforceActionTypes lists the actions above
```

### 4c. Gate: 24h enforce soak on staging
```powershell
$slo = Invoke-RestMethod `
  -Method GET `
  -Uri "https://marketer-staging.clodo.dev/api/admin/governance/ingress-slo?hours=24&mode=enforce" `
  -Headers @{ Authorization = "Bearer $env:MARKETER_ADMIN_TOKEN_STAGING" }

$data = $slo.data ?? $slo
# Accept ONLY if blockedRate is explainable (should be near zero if upstream attaches context)
Write-Host "Blocked: $($data.totals.blocked) / $($data.totals.events) = $($data.rates.blockedRate)"
```
- `rates.blockedRate < 0.02` for the enforce-scoped action types
- Zero `authority_context_untrusted_source`

---

## Stage 5: Enable Enforce Mode (Production)

### 5a. Pre-flight
- [ ] Stage 4 staging gate passed
- [ ] `rates.violationRate` trending down over 7 days in production observe mode
- [ ] `authority_context_absent` rate < 2% in production observe mode
- [ ] Confirm `GOVERNANCE_ENFORCE_ACTIONS` scope is acceptable with product team
- [ ] Two engineers available during deploy window

### 5b. Set enforce mode
```powershell
$enforceActions = "enroll_sequence,send_via_skrip,campaign.start,campaign.pause"
echo $enforceActions | wrangler secret put GOVERNANCE_ENFORCE_ACTIONS `
  --config packages/marketer/wrangler.toml `
  --env production

echo "enforce" | wrangler secret put GOVERNANCE_INGRESS_MODE `
  --config packages/marketer/wrangler.toml `
  --env production

wrangler deploy `
  --config packages/marketer/wrangler.toml `
  --env production
```

### 5c. Post-deploy verification (first 15 minutes)
```powershell
$token = $env:MARKETER_ADMIN_TOKEN_PROD
$base  = "https://marketer.clodo.dev"

# Check mode
Invoke-RestMethod -Method GET -Uri "$base/api/admin/governance/enforcement-status" `
  -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 3

# Check 15m SLO
Invoke-RestMethod -Method GET -Uri "$base/api/admin/governance/ingress-slo?hours=1" `
  -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 5
```
- `activeMode = enforce`
- `rates.blockedRate < 0.02`
- No unexpected `authority_context_untrusted_source`

### 5d. Emergency rollback
```powershell
# Step 1: KV instant revert to observe (no redeploy)
Invoke-RestMethod -Method POST `
  -Uri "$base/api/admin/governance/mode-override" `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body '{"mode":"observe"}'

# Step 2 (if step 1 insufficient): full rollback
echo "off" | wrangler secret put GOVERNANCE_INGRESS_MODE `
  --config packages/marketer/wrangler.toml `
  --env production

wrangler deploy `
  --config packages/marketer/wrangler.toml `
  --env production

# Step 3: Clear any KV override (now that env var controls it)
Invoke-RestMethod -Method DELETE `
  -Uri "$base/api/admin/governance/mode-override" `
  -Headers @{ Authorization = "Bearer $token" }
```

---

## Automation Script

The `scripts/governance-ingress-rollout.ps1` script automates migration application and mode setting:

```powershell
# Apply migration to development
.\scripts\governance-ingress-rollout.ps1 -Environment development -ApplyMigration

# Set observe mode on staging
.\scripts\governance-ingress-rollout.ps1 -Environment staging -Mode observe -SetMode

# Apply migration AND set enforce on production (with confirmation prompt)
.\scripts\governance-ingress-rollout.ps1 -Environment production -Mode enforce -ApplyMigration -SetMode
```

---

## Summary Timeline

| Day | Action |
|---|---|
| D+0 | Apply migration to all envs; set observe in dev |
| D+1 | Confirm dev observe traffic flowing; set observe in staging |
| D+8 | Run staging gate check (7-day soak) |
| D+9 | Deploy observe mode to production |
| D+10 | Monitor first 24h production observe SLO |
| D+17 | Run production 7-day gate check |
| D+18 | Deploy selective enforce (staging) for 24h soak |
| D+19 | Deploy selective enforce to production with 15-min watch |
| D+26 | Evaluate broadening enforce action scope (optional) |
