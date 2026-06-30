#Requires -Version 5.1
<#
.SYNOPSIS
  Writes com.gmapsagent.enrich.installed.json and registers Native Messaging hives for Chromium-based browsers.

  Registry default value MUST be the full path to com.gmapsagent.enrich.installed.json (not the template com.gmapsagent.enrich.json).
#>
param(
  [Parameter(Mandatory = $true)]
  [string] $ExtensionId,

  [Parameter(Mandatory = $false)]
  [ValidateSet('Chrome', 'ChromeBeta', 'ChromeDev', 'ChromeCanary', 'Chromium', 'Brave', 'All')]
  [string] $Browser = 'Chrome',

  [Parameter(Mandatory = $false)]
  [string] $NativeHostDir
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($NativeHostDir)) {
  $NativeHostDir = $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($NativeHostDir) -and $PSCommandPath) {
  $NativeHostDir = Split-Path -Parent $PSCommandPath
}
if ([string]::IsNullOrWhiteSpace($NativeHostDir)) {
  throw "Could not resolve the native host folder. Re-run via register_native_host.bat or pass -NativeHostDir."
}

function Get-FullPathLiteral([string] $Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

$ext = $ExtensionId.Trim()
if (-not $ext) {
  throw "ExtensionId is empty."
}

$hostDir = Get-FullPathLiteral $NativeHostDir
$launcherExe = Join-Path $hostDir 'GmapsAgentEnrichLauncher.exe'
$manifestPath = Join-Path $hostDir 'com.gmapsagent.enrich.installed.json'

if (-not (Test-Path -LiteralPath $launcherExe)) {
  Write-Host ""
  Write-Host "Launcher missing. Running build_launcher.bat ..."
  $buildBat = Join-Path $hostDir 'build_launcher.bat'
  & cmd.exe /c "`"$buildBat`""
  if ($LASTEXITCODE -ne 0) {
    throw "build_launcher.bat failed (exit $LASTEXITCODE)."
  }
}

$launcherFull = Get-FullPathLiteral $launcherExe
if (-not (Test-Path -LiteralPath $launcherFull)) {
  throw "Launcher still missing after build: $launcherFull"
}

# Chrome/Edge forbid wildcards in allowed_origins — use origin with trailing slash only (docs: chrome-extension://<id>/).
$ordered = [ordered]@{
  name            = 'com.gmapsagent.enrich'
  path            = $launcherFull
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ext/")
}
$json = $ordered | ConvertTo-Json -Depth 10
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Get-FullPathLiteral $manifestPath), $json, $utf8NoBom)

$manifestFull = Get-FullPathLiteral $manifestPath
if (-not (Test-Path -LiteralPath $manifestFull)) {
  throw "Failed to write manifest: $manifestFull"
}

$hiveMap = [ordered]@{
  Chrome       = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.gmapsagent.enrich'
  ChromeBeta   = 'HKCU:\Software\Google\Chrome Beta\NativeMessagingHosts\com.gmapsagent.enrich'
  ChromeDev    = 'HKCU:\Software\Google\Chrome Dev\NativeMessagingHosts\com.gmapsagent.enrich'
  ChromeCanary = 'HKCU:\Software\Google\Chrome SxS\NativeMessagingHosts\com.gmapsagent.enrich'
  Chromium     = 'HKCU:\Software\Chromium\NativeMessagingHosts\com.gmapsagent.enrich'
  Brave        = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.gmapsagent.enrich'
  # Edge Chromium uses HKCU hive; unpacked Edge uses chrome-extension:// same ID as Chrome IF you loaded the same folder (verify on edge://extensions).
  Edge         = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.gmapsagent.enrich'
}

$hives = @(switch ($Browser) {
    'Chrome' { $hiveMap['Chrome'] }
    'ChromeBeta' { $hiveMap['ChromeBeta'] }
    'ChromeDev' { $hiveMap['ChromeDev'] }
    'ChromeCanary' { $hiveMap['ChromeCanary'] }
    'Chromium' { $hiveMap['Chromium'] }
    'Brave' { $hiveMap['Brave'] }
    'All' { $hiveMap.Values }
  })

Write-Host ""
Write-Host "Native Messaging host: com.gmapsagent.enrich"
Write-Host "Manifest (for registry): $manifestFull"
Write-Host "Launcher EXE:            $launcherFull"
Write-Host ""

foreach ($regPath in $hives) {
  if (-not (Test-Path -LiteralPath $regPath)) {
    New-Item -Path $regPath -Force | Out-Null
  }
  Set-ItemProperty -LiteralPath $regPath -Name '(default)' -Value $manifestFull -Type String
  $val = (Get-ItemProperty -LiteralPath $regPath -ErrorAction Stop).'(default)'
  Write-Host "OK: $regPath"
  Write-Host "  (default) = $val"
}

Write-Host ""
Write-Host "Next: fully quit your browser (all windows). On Windows, also end background processes in Task Manager if needed."
Write-Host "Then reopen the browser, reload the unpacked extension, and use Start enrich server (native)."
