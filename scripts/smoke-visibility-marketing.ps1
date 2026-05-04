param([string]$Url = 'https://visibility-marketing-dev.wetechfounders.workers.dev',
      [string]$Token = 'tss2T_rXGS5-xEY4E6q6GogNa-sLx8DLvikdTTpjGPk')

$p = 0; $f = 0

Write-Host "`n=== Marketing Smoke Tests ===" -ForegroundColor Magenta

# 1. Health
Write-Host "[1] Health" -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod "$Url/api/health" -H @{Authorization="Bearer $Token"} -EA 0 -UseBasicParsing
  if ($r.ok) { $p++ } else { $f++ }
  Write-Host "$(if ($r.ok) {'✓'} else {'✗'})" -ForegroundColor $(if ($r.ok) {'Green'} else {'Red'})
} catch { Write-Host "✗" -ForegroundColor Red; $f++ }

# 2. Mint
Write-Host "[2] Mint" -ForegroundColor Cyan
$tok = $null
try {
  $r = Invoke-RestMethod "$Url/api/identity/mint" -Method POST -H @{Authorization="Bearer $Token";"Content-Type"="application/json"} -Body '{"contactId":"test@test.com","tenantId":"default","purpose":"subscribe"}' -EA 0 -UseBasicParsing
  if ($r.ok) { $p++; $tok = $r.data.token } else { $f++ }
  Write-Host "$(if ($r.ok) {'✓'} else {'✗'})" -ForegroundColor $(if ($r.ok) {'Green'} else {'Red'})
} catch { Write-Host "✗" -ForegroundColor Red; $f++ }

# 3. Verify
Write-Host "[3] Verify" -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod "$Url/api/identity/verify" -Method POST -H @{"Content-Type"="application/json"} -Body "{`"token`":`"$tok`"}" -EA 0 -UseBasicParsing
  if ($r.ok) { $p++ } else { $f++ }
  Write-Host "$(if ($r.ok) {'✓'} else {'✗'})" -ForegroundColor $(if ($r.ok) {'Green'} else {'Red'})
} catch { Write-Host "✗" -ForegroundColor Red; $f++ }

# 4. Flags
Write-Host "[4] Flags" -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod "$Url/api/admin/skrip/flags" -Method POST -H @{Authorization="Bearer $Token";"Content-Type"="application/json"} -Body '{"key":"tenant:default","value":true}' -EA 0 -UseBasicParsing
  if ($r.ok) { $p++ } else { $f++ }
  Write-Host "$(if ($r.ok) {'✓'} else {'✗'})" -ForegroundColor $(if ($r.ok) {'Green'} else {'Red'})
} catch { Write-Host "✗" -ForegroundColor Red; $f++ }

# 5. Policy
Write-Host "[5] Policy" -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod "$Url/api/admin/skrip/policy-state?tenantId=default" -H @{Authorization="Bearer $Token"} -EA 0 -UseBasicParsing
  if ($r.ok) { $p++ } else { $f++ }
  Write-Host "$(if ($r.ok) {'✓'} else {'✗'})" -ForegroundColor $(if ($r.ok) {'Green'} else {'Red'})
} catch { Write-Host "✗" -ForegroundColor Red; $f++ }

# 6. Drill
Write-Host "[6] Drill" -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod "$Url/api/admin/skrip/killswitch/drill" -Method POST -H @{Authorization="Bearer $Token";"Content-Type"="application/json"} -Body '{"scope":"global"}' -EA 0 -UseBasicParsing
  if ($r.ok) { $p++ } else { $f++ }
  Write-Host "$(if ($r.ok) {'✓'} else {'✗'})" -ForegroundColor $(if ($r.ok) {'Green'} else {'Red'})
} catch { Write-Host "✗" -ForegroundColor Red; $f++ }

# 7. DLQ
Write-Host "[7] DLQ" -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod "$Url/api/admin/skrip/dlq/replay" -Method POST -H @{Authorization="Bearer $Token";"Content-Type"="application/json"} -Body '{"limit":5}' -EA 0 -UseBasicParsing
  if ($r.ok) { $p++ } else { $f++ }
  Write-Host "$(if ($r.ok) {'✓'} else {'✗'})" -ForegroundColor $(if ($r.ok) {'Green'} else {'Red'})
} catch { Write-Host "✗" -ForegroundColor Red; $f++ }

Write-Host "`nResults: $p pass, $f fail" -ForegroundColor $(if ($f -gt 0) {'Red'} else {'Green'})
exit $(if ($f -gt 0) {1} else {0})
