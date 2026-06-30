@echo off

setlocal EnableExtensions



cd /d "%~dp0" || exit /b 1



echo.

echo ===== GmapsAgent native-host diagnostics =====

echo Working directory (native_host folder):

echo   %CD%

echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose_native_host.ps1"

set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (

  echo.

  echo [ERROR] Diagnostics script exited with code %EXITCODE%

  echo If ExecutionPolicy blocked: powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose_native_host.ps1"

)

exit /b %EXITCODE%

