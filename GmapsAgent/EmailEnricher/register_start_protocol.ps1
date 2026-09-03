#Requires -Version 5.1
<#
  Registers HKCU URL protocol gmapsagent-enrich:// so the extension Start button
  can launch start_from_protocol.bat without Native Messaging.
#>
$ErrorActionPreference = "Stop"
$enricherRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$bat = Join-Path $enricherRoot "start_from_protocol.bat"
if (-not (Test-Path -LiteralPath $bat)) {
  throw "Missing $bat"
}
$batFull = [System.IO.Path]::GetFullPath($bat)
$cmd = '"{0}" "%1"' -f $batFull
$root = "HKCU:\Software\Classes\gmapsagent-enrich"

if (-not (Test-Path -LiteralPath $root)) {
  New-Item -Path $root -Force | Out-Null
}
Set-ItemProperty -LiteralPath $root -Name "(default)" -Value "URL:GmapsAgent Enrich Protocol"
New-ItemProperty -LiteralPath $root -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null

$open = Join-Path $root "shell\open\command"
if (-not (Test-Path -LiteralPath $open)) {
  New-Item -Path $open -Force | Out-Null
}
Set-ItemProperty -LiteralPath $open -Name "(default)" -Value $cmd

Write-Host "Registered gmapsagent-enrich:// -> $batFull"
