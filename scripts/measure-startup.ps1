<#
.SYNOPSIS
Measure CryoClaw startup: process start -> gateway HTTP 200 -> main window shown (app.log timestamp).
#>
param(
  [string]$ExePath = "$env:LOCALAPPDATA\Programs\CryoClaw\CryoClaw.exe",
  [int]$GatewayPort = 18789
)

$log = "$env:USERPROFILE\.openclaw\app.log"
$beforeLen = if (Test-Path $log) { (Get-Item $log).Length } else { 0 }
$t0 = [DateTime]::UtcNow

$proc = Start-Process -FilePath $ExePath -PassThru
Write-Host "launched pid=$($proc.Id) at $($t0.ToString('o'))"

$gwMs = $null
for ($i = 0; $i -lt 240; $i++) {
  Start-Sleep -Milliseconds 250
  if ($proc.HasExited) { Write-Host "process exited early code=$($proc.ExitCode)"; break }
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$GatewayPort/" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($r.StatusCode -eq 200) {
      $gwMs = [math]::Round(([DateTime]::UtcNow - $t0).TotalMilliseconds)
      break
    }
  } catch { }
}

$winMs = $null
$appStartMs = $null
for ($i = 0; $i -lt 240; $i++) {
  Start-Sleep -Milliseconds 250
  if (-not (Test-Path $log)) { continue }
  if ((Get-Item $log).Length -le $beforeLen) { continue }
  $new = Get-Content -LiteralPath $log -Tail 120
  foreach ($line in $new) {
    if (-not $line -match '\[([\d\-T:\.]+Z)\]') { continue }
    $ts = [DateTime]::Parse($matches[1]).ToUniversalTime()
    $rel = [math]::Round(($ts - $t0).TotalMilliseconds)
    if ($rel -lt 0) { continue }
    if ($line -match "主窗口显示") { if ($null -eq $winMs) { $winMs = $rel } }
    if ($line -match "app ready" -and $null -eq $appStartMs) { $appStartMs = $rel }
  }
  if ($null -ne $winMs) { break }
}

Write-Host "RESULT gateway200Ms=$gwMs windowShownMs=$winMs appReadyMs=$appStartMs"

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Get-Process -Name "CryoClaw" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue