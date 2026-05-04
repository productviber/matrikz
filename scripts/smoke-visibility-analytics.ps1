param(
  [string]$Url = 'http://127.0.0.1:8787',
  [string]$SystemToken = 'system-test-token'
)

$passed = 0
$failed = 0

function Invoke-SmokeCheck {
  param(
    [string]$Name,
    [scriptblock]$Action
  )

  Write-Host "[CHECK] $Name" -ForegroundColor Cyan
  try {
    & $Action
    Write-Host "[PASS] $Name" -ForegroundColor Green
    $script:passed++
  } catch {
    Write-Host "[FAIL] $Name :: $($_.Exception.Message)" -ForegroundColor Red
    $script:failed++
  }
}

Write-Host "`n=== Visibility Analytics Smoke ===" -ForegroundColor Magenta
Write-Host "Target URL: $Url"

Invoke-SmokeCheck -Name 'Health endpoint responds 200' -Action {
  $res = Invoke-RestMethod "$Url/health" -Method GET -UseBasicParsing -ErrorAction Stop
  if ($res.status -ne 'ok') {
    throw 'Unexpected health payload'
  }
}

Invoke-SmokeCheck -Name 'Click ingest route returns 501 (explicit not implemented)' -Action {
  try {
    Invoke-RestMethod "$Url/api/v1/events/click" -Method POST -Body '{}' -ContentType 'application/json' -UseBasicParsing -ErrorAction Stop | Out-Null
    throw 'Expected non-2xx response'
  } catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -ne 501) {
      throw "Expected 501 but got $statusCode"
    }
  }
}

Invoke-SmokeCheck -Name 'Internal report endpoint authorizes system token' -Action {
  try {
    Invoke-RestMethod "$Url/internal/report-data/example.com" -Method GET -Headers @{ 'x-system-token' = $SystemToken } -UseBasicParsing -ErrorAction Stop | Out-Null
  } catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -ne 404) {
      throw "Expected 404 for missing domain row or 200 for present row; got $statusCode"
    }
  }
}

Write-Host "`nResults: $passed passed, $failed failed" -ForegroundColor $(if ($failed -eq 0) { 'Green' } else { 'Red' })
exit $(if ($failed -eq 0) { 0 } else { 1 })
