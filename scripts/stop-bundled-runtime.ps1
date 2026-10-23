$ErrorActionPreference = 'Stop'
# Resolve only this installation's Node; unrelated Node processes are excluded.
$bundledNode = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'resources\runtime\node.exe'))
$owned = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
  $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $bundledNode, [StringComparison]::OrdinalIgnoreCase)
})
if ($owned.Count -eq 0) { exit 0 }
$deadline = [DateTime]::UtcNow.AddSeconds(15)
do {
  $remaining = @($owned | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
  if ($remaining.Count -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
foreach ($entry in $remaining) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.ProcessId)"
  if ($current -and $current.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($current.ExecutablePath), $bundledNode, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Process -Id $entry.ProcessId -Force -ErrorAction Stop
  }
}
