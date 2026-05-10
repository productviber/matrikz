# Governance Ingress SLO — Monitoring Runbook

> **Scope:** `packages/marketer` — governance ingress hardening for forwarded authority context validation.
> **Table:** `governance_ingress_decisions`
> **Endpoint:** `GET /api/admin/governance/ingress-slo`
> **Status endpoint:** `GET /api/admin/governance/enforcement-status`

---

## 1. SLO Definitions

| Metric | Target | Critical Threshold |
|---|---|---|
| **Pass rate** (`allowed / total`) | ≥ 98% in observe mode | < 90% triggers investigation |
| **Violation rate** (`violations / total`) | ≤ 5% in observe mode | > 15% blocks promote-to-enforce |
| **Block rate** in enforce mode | < 2% for `authority_context_valid` violations | > 5% warrants rollback |
| **Duplicate suppression rate** | < 1% | > 5% may indicate upstream retry storms |
| **Source absent rate** (`authority_context_absent / total`) | Decreasing week-over-week | Flat or rising blocks graduation |

---

## 2. Standard Check Commands

### Current active mode and policy
```powershell
$token = $env:MARKETER_ADMIN_TOKEN
$base  = $env:MARKETER_BASE_URL   # e.g. https://marketer.clodo.dev

Invoke-RestMethod `
  -Method GET `
  -Uri "$base/api/admin/governance/enforcement-status" `
  -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 5
```

### Last 24h SLO summary
```powershell
Invoke-RestMethod `
  -Method GET `
  -Uri "$base/api/admin/governance/ingress-slo?hours=24" `
  -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 5
```

### Filter to a specific tenant in the last 7 days
```powershell
Invoke-RestMethod `
  -Method GET `
  -Uri "$base/api/admin/governance/ingress-slo?hours=168&tenantId=<TENANT_ID>" `
  -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 5
```

### Filter to a specific source
```powershell
Invoke-RestMethod `
  -Method GET `
  -Uri "$base/api/admin/governance/ingress-slo?hours=24&source=visibility-analytics" `
  -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 5
```

### Filter to violations only (any reason other than valid/bypassed/suppressed)
```powershell
Invoke-RestMethod `
  -Method GET `
  -Uri "$base/api/admin/governance/ingress-slo?hours=24&reason=authority_context_absent" `
  -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 5
```

---

## 3. Alert Criteria

Run these checks every 15 minutes via a cron or uptime monitor.

### Alert: High violation rate (observe mode)
```
IF rates.violationRate > 0.15 AND activeMode == "observe"
THEN: Page on-call — likely upstream producing invalid authority context
     Investigation: check sourceDistribution for unknown sources
```

### Alert: Unexpected block rate spike (enforce mode)
```
IF rates.blockedRate > 0.05 AND activeMode == "enforce"
THEN: Escalate immediately — events are being dropped
     Mitigation: emergency revert (see Section 5)
```

### Alert: source absent rate > 10%
```
IF (reasonDistribution.authority_context_absent / totals.events) > 0.10
THEN: Check visibility-analytics deployment — may not be attaching authority context
     Investigation: verify GOVERNANCE_ALLOWED_AUTHORITY_SOURCES env var
```

### Alert: Untrusted source appearing
```
IF reasonDistribution.authority_context_untrusted_source > 0
THEN: Investigate ingress for spoofing attempts
     Action: check ingressSource distribution in D1 directly
```

### D1 direct query for untrusted source incidents (last 1 hour)
```sql
SELECT ingress_source, authority_source, COUNT(*) AS cnt, MAX(recorded_at) AS last_seen
FROM governance_ingress_decisions
WHERE reason = 'authority_context_untrusted_source'
  AND recorded_at >= strftime('%s', 'now', '-1 hour')
GROUP BY ingress_source, authority_source
ORDER BY cnt DESC;
```

---

## 4. Staging Gate: Criteria to Promote from Observe → Enforce

All of the following must hold over a **7-day rolling window** in staging/production observe mode before promoting:

| Gate | Requirement |
|---|---|
| `rates.violationRate` | ≤ 2% per 24h window for 7 consecutive days |
| `authority_context_absent` reasons | Decreasing week-over-week (upstream is attaching context) |
| `authority_context_untrusted_source` | Zero occurrences |
| `authority_context_target_tenant_mismatch` | < 0.5% |
| Duplicate suppression rate | < 0.5% |
| Enforce action scope (`GOVERNANCE_ENFORCE_ACTIONS`) | Confirm list covers only intended high-risk actions |
| Test run | `vitest run tests/unit/governance-ingress.test.ts tests/integration/event-router.test.ts` — all pass |

Check script (run before promoting):
```powershell
# Run against production with hours=168 (7 days)
$slo = Invoke-RestMethod `
  -Method GET `
  -Uri "$base/api/admin/governance/ingress-slo?hours=168" `
  -Headers @{ Authorization = "Bearer $token" }

$data = $slo.data ?? $slo
$ok = $true
if ($data.rates.violationRate -gt 0.02) { Write-Warning "GATE FAIL: violationRate $($data.rates.violationRate)"; $ok = $false }
if ($data.reasonDistribution.authority_context_untrusted_source -gt 0) { Write-Warning "GATE FAIL: untrusted source incidents exist"; $ok = $false }
if ($ok) { Write-Host "All gates PASS — safe to promote to enforce" -ForegroundColor Green }
else      { Write-Host "GATES FAILED — do not promote" -ForegroundColor Red }
```

---

## 5. Emergency Controls

### Fail-open: revert to observe without redeployment
```powershell
# Override to observe (KV, takes effect within one request)
Invoke-RestMethod `
  -Method POST `
  -Uri "$base/api/admin/governance/mode-override" `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body '{"mode":"observe"}'

# Verify
Invoke-RestMethod `
  -Method GET `
  -Uri "$base/api/admin/governance/enforcement-status" `
  -Headers @{ Authorization = "Bearer $token" }
```

### Fail-open: disable governance entirely (emergency)
```powershell
Invoke-RestMethod `
  -Method POST `
  -Uri "$base/api/admin/governance/mode-override" `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body '{"mode":"off"}'
```

### Clear KV override (restore env var control)
```powershell
Invoke-RestMethod `
  -Method DELETE `
  -Uri "$base/api/admin/governance/mode-override" `
  -Headers @{ Authorization = "Bearer $token" }
```

> **Note:** KV override TTL is 7 days. It auto-expires to prevent forgotten overrides. Re-confirm the correct mode with `enforcement-status` after any override operation.

---

## 6. Incident Response Checklist

**Symptom: Events being unexpectedly blocked (enforce mode)**
1. Check `enforcement-status` — confirm `activeMode` is `enforce` and `overrideActive`
2. Query `ingress-slo?hours=1` — identify `blockedRate` and dominant `reasonDistribution`
3. If `authority_context_absent`: upstream not attaching context → set KV override to `observe`
4. If `authority_context_denied`: upstream is explicitly denying — investigate analytics-side policy
5. If `authority_context_target_tenant_mismatch`: tenant header mismatch — check client headers
6. If `authority_context_untrusted_source`: spoofed source — do NOT flip to off; alert security

**Symptom: Violation rate spiking in observe mode**
1. Check `sourceDistribution` for unexpected sources
2. Check `reasonDistribution` — identify dominant violation reason
3. Cross-reference with analytics deployment (did a new version ship without attaching context?)
4. Check `GOVERNANCE_ALLOWED_AUTHORITY_SOURCES` is correctly set

**Symptom: Duplicate suppression rate > 5%**
1. Check upstream for retry storms
2. Verify `EVENT_SECURITY.REPLAY_TTL_SECS` KV TTL is sufficient
3. Check `KV_MARKETING` health

---

## 7. Key Env Vars Reference

| Var | Purpose | Default |
|---|---|---|
| `GOVERNANCE_INGRESS_MODE` | Progressive mode: `off`, `observe`, `enforce` | `off` |
| `GOVERNANCE_ALLOWED_AUTHORITY_SOURCES` | CSV of trusted source names | `visibility-analytics` |
| `GOVERNANCE_ENFORCE_ACTIONS` | CSV of action types to enforce; empty = all | `""` (all) |
| `GOVERNANCE_REQUIRE_TARGET_TENANT_ACTIONS` | CSV of action types requiring targetTenantId | see wrangler.toml |

Env vars take effect after redeployment. Use KV override (`mode-override` endpoint) for immediate changes without redeploy.
