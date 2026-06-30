@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0" || exit /b 1

set "EXT_ID=%~1"
set "CHANNEL_RAW=%~2"
set "PS_BROWSER=Chrome"

if "!EXT_ID!"=="" (
  echo.
  echo Paste your unpacked extension ID from chrome://extensions ^(Developer mode^) then press Enter.
  set /p "EXT_ID=Extension ID: "
)

if "!EXT_ID!"=="" (
  echo [ERROR] Extension ID required. Pass as first argument OR enter when prompted.
  echo Example: register_native_host.bat abcdefghijklmnop beta
  echo Second arg ^(optional^): chrome ^| beta ^| dev ^| canary ^| chromium ^| brave ^| all
  exit /b 1
)

if /I "!CHANNEL_RAW!"=="chrome" set "PS_BROWSER=Chrome"
if /I "!CHANNEL_RAW!"=="stable" set "PS_BROWSER=Chrome"
if /I "!CHANNEL_RAW!"=="beta" set "PS_BROWSER=ChromeBeta"
if /I "!CHANNEL_RAW!"=="dev" set "PS_BROWSER=ChromeDev"
if /I "!CHANNEL_RAW!"=="canary" set "PS_BROWSER=ChromeCanary"
if /I "!CHANNEL_RAW!"=="chromium" set "PS_BROWSER=Chromium"
if /I "!CHANNEL_RAW!"=="brave" set "PS_BROWSER=Brave"
if /I "!CHANNEL_RAW!"=="all" set "PS_BROWSER=All"

if "!CHANNEL_RAW!"=="" (
  echo.
  echo Which Chromium-based browser will load this unpacked extension?
  echo   1^) Google Chrome ^(stable^)  [default]
  echo   2^) Chrome Beta
  echo   3^) Chrome Dev
  echo   4^) Chrome Canary
  echo   5^) Chromium
  echo   6^) Brave
  echo   7^) All of the above ^(Chrome Beta/Dev/Canary + Chromium + Brave + Edge HKCU registrations^)
  set /p "CHNUM=Enter 1-7 [1]: "
  if "!CHNUM!"=="" set "CHNUM=1"
  if "!CHNUM!"=="1" set "PS_BROWSER=Chrome"
  if "!CHNUM!"=="2" set "PS_BROWSER=ChromeBeta"
  if "!CHNUM!"=="3" set "PS_BROWSER=ChromeDev"
  if "!CHNUM!"=="4" set "PS_BROWSER=ChromeCanary"
  if "!CHNUM!"=="5" set "PS_BROWSER=Chromium"
  if "!CHNUM!"=="6" set "PS_BROWSER=Brave"
  if "!CHNUM!"=="7" set "PS_BROWSER=All"
)

set "PS1=%~dp0register_native_host.ps1"
if not exist "!PS1!" (
  echo [ERROR] Missing register_native_host.ps1 beside this batch file.
  exit /b 1
)

rem IMPORTANT: %~dp0 ends with \ — inside "..." final \" escapes the closing quote and breaks paths with spaces (e.g. OneDrive). Use .\ to anchor without a trailing backslash escape.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "!PS1!" -ExtensionId "!EXT_ID!" -Browser "!PS_BROWSER!" -NativeHostDir "%~dp0."
if errorlevel 1 (
  echo [ERROR] Native host registration PowerShell script failed — see messages above.
  echo If ExecutionPolicy blocked the script despite Bypass, fix policy or run: powershell.exe -NoProfile -ExecutionPolicy Bypass -File "!PS1!" -ExtensionId "YOUR_EXTENSION_ID" -Browser "Chrome" -NativeHostDir "%~dp0."
  exit /b 1
)

exit /b 0
