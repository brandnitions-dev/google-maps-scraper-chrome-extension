#Requires -Version 5.1

$ErrorActionPreference = 'Continue'



function Normalize-FullPath([string] $p) {

  try { return [System.IO.Path]::GetFullPath($p) } catch { return $p }

}



function Read-ManifestObject([string] $ManifestPath) {

  try {

    $encoding = New-Object System.Text.UTF8Encoding $false

    $raw = [System.IO.File]::ReadAllText($ManifestPath, $encoding).TrimStart([char]0xfeff).Trim()

    $obj = $raw | ConvertFrom-Json -ErrorAction Stop

    return @{ ok = $true ; obj = $obj ; raw = $raw ; err = '' }

  }

  catch {

    return @{ ok = $false ; obj = $null ; raw = '' ; err = $_.Exception.Message }

  }

}



$dir = Normalize-FullPath $PSScriptRoot



$manifestInstalled = Join-Path $dir 'com.gmapsagent.enrich.installed.json'

$manifestTemplate = Join-Path $dir 'com.gmapsagent.enrich.json'

$launcher = Join-Path $dir 'GmapsAgentEnrichLauncher.exe'

$scriptPy = Join-Path $dir 'gmapsagent_enrich_host.py'



$keys = @(

  @{ Label = 'Chrome stable' ; Path = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.gmapsagent.enrich' }

  @{ Label = 'Chrome Beta'   ; Path = 'HKCU:\Software\Google\Chrome Beta\NativeMessagingHosts\com.gmapsagent.enrich' }

  @{ Label = 'Chrome Dev'    ; Path = 'HKCU:\Software\Google\Chrome Dev\NativeMessagingHosts\com.gmapsagent.enrich' }

  @{ Label = 'Chrome Canary' ; Path = 'HKCU:\Software\Google\Chrome SxS\NativeMessagingHosts\com.gmapsagent.enrich' }

  @{ Label = 'Chromium'      ; Path = 'HKCU:\Software\Chromium\NativeMessagingHosts\com.gmapsagent.enrich' }

  @{ Label = 'Brave'         ; Path = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.gmapsagent.enrich' }

  @{ Label = 'Edge'          ; Path = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.gmapsagent.enrich' }

)



Write-Host "=== GmapsAgent native host: com.gmapsagent.enrich ==="

Write-Host "Native host directory: $dir"

$p64 = [Environment]::Is64BitOperatingSystem

$pPs = [Environment]::Is64BitProcess

Write-Host ('Process env arch {0}: 64-bit OS={1}, 64-bit PS={2}. HKCU is shared across 32/64-bit Chromium checks.' -f $env:PROCESSOR_ARCHITECTURE, $p64, $pPs)



Write-Host ''

Write-Host '--- Files near native_host ---'

foreach ($p in @($launcher, $scriptPy, $manifestTemplate, $manifestInstalled)) {

  $mark = if (Test-Path -LiteralPath $p) { 'OK' } else { 'MISSING' }

  Write-Host "[${mark}] ${p}"

}



Write-Host ''

Write-Host '--- Template manifest first line ---'

if (Test-Path -LiteralPath $manifestTemplate) {

  $firstTpl = '(empty)'

  try {

    $line = Get-Content -LiteralPath $manifestTemplate -TotalCount 1 -Encoding UTF8 -ErrorAction Stop

    if ([string]::IsNullOrWhiteSpace([string]$line)) { $firstTpl = '(empty)' } else { $firstTpl = [string]$line }

  }

  catch {

    $firstTpl = '(could not read)'

  }

  $nPreview = [Math]::Min([Math]::Max($firstTpl.Length, 0), 160)

  if ($nPreview -le 0) {

    Write-Host '  preview: (empty line)'

  }

  else {

    $snippet = $firstTpl.Substring(0, $nPreview)

    Write-Host ('  preview starts: {0}' -f $snippet)

    if ($firstTpl.Length -gt $nPreview) {

      Write-Host '  ... (truncated; see file)'

    }

  }

}



Write-Host ''

Write-Host '--- Per-browser registry defaults (expect .installed.json) ---'

foreach ($k in $keys) {

  Write-Host ''

  Write-Host ('[{0}] {1}' -f $k.Label, $k.Path)

  if (-not (Test-Path -LiteralPath $k.Path)) {

    Write-Host '  KEY MISSING -> run register_native_host.bat / pick Chrome or All (choice 7)'

    continue

  }



  $val = ''

  try {

    $val = [string](Get-ItemProperty -LiteralPath $k.Path -ErrorAction Stop).'(default)'

  }

  catch {

    Write-Host '  (could not read default value)'

    continue

  }

  $val = ($val.Trim())

  if (-not $val) {

    Write-Host '  (default value EMPTY)'

    continue

  }



  Write-Host ('  Registry (default): {0}' -f $val)

  Write-Host ('  Manifest on disk exists: {0}' -f (Test-Path -LiteralPath $val))



  if ($val -notmatch '\.installed\.json\s*$') {

    Write-Host '  WARNING: expected path ending in com.gmapsagent.enrich.installed.json (not template com.gmapsagent.enrich.json)'

  }



  $mfPath = Normalize-FullPath $val

  $mfExists = Test-Path -LiteralPath $mfPath

  if (-not $mfExists) {

    Write-Host '  DIAGNOSIS: missing manifest at registry path -> Chrome shows native messaging host not found'

    continue

  }



  $firstLineInstalled = '(n/a)'

  try {

    $l1 = Get-Content -LiteralPath $mfPath -TotalCount 1 -Encoding UTF8 -ErrorAction Stop

    if (-not [string]::IsNullOrWhiteSpace([string]$l1)) { $firstLineInstalled = [string]$l1 }

  }

  catch { }



  Write-Host ('  Manifest line 1: {0}' -f $firstLineInstalled)



  $parsed = Read-ManifestObject $mfPath

  if (-not $parsed.ok) {

    Write-Host ('  JSON parse FAILED: {0}' -f $parsed.err)

    continue

  }



  $j = $parsed.obj



  $parsedName = ''

  try {

    $parsedName = [string]$j.name

  }

  catch { }



  Write-Host ('  Parsed manifest [name]: {0}' -f $parsedName)

  if ($parsedName -ne 'com.gmapsagent.enrich') {

    Write-Host '  WARNING: name must equal com.gmapsagent.enrich (must match chrome.runtime.sendNativeMessage).'

  }



  $parsedPathExe = ''

  try {

    $parsedPathExe = [string]$j.path

  }

  catch { }



  Write-Host ('  Parsed manifest [path]: {0}' -f $parsedPathExe)



  $pathNorm = Normalize-FullPath $parsedPathExe

  $exeOk = if ($parsedPathExe) { Test-Path -LiteralPath $pathNorm } else { $false }

  Write-Host ('  Host launcher exists: {0}' -f $exeOk)



  Write-Host '  Parsed manifest [allowed_origins]:'

  try {

    foreach ($o in @($j.allowed_origins)) {

      $s = [string]$o

      Write-Host ('      - {0}' -f $s)

      if ($s.IndexOf('*', [System.StringComparison]::Ordinal) -ge 0) {

        Write-Host '        WARNING: wildcards (*) are not allowed -> use chrome-extension://<YOUR_ID>/'

      }

    }

  }

  catch {

    Write-Host ('      (could not enumerate: {0})' -f $_.Exception.Message)

  }

}



Write-Host ''

Write-Host 'Chrome stable registry key hint: HKCU\Software\Google\Chrome\NativeMessagingHosts\com.gmapsagent.enrich'

Write-Host 'Edge registry key hint: HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.gmapsagent.enrich'

Write-Host ('If unpack folder moves, rerun register_native_host.bat with today''s ID from chrome://extensions .')

Write-Host 'After edits: quit chrome.exe/msedge.exe, reopen browser, reload extension.'

