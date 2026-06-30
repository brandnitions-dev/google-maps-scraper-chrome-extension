@echo off
setlocal EnableExtensions
title EmailEnricher — local API (extension)

cd /d "%~dp0" || exit /b 1

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo  [ERROR] No virtual environment found.
  echo          Run setup.bat once in this folder first:
  echo            %cd%\setup.bat
  echo.
  pause
  exit /b 1
)

echo.
echo  Email enrich server: http://127.0.0.1:18765  (Ctrl+C to stop)
echo.

".venv\Scripts\python.exe" -m email_enricher.local_server
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" pause
exit /b %EXITCODE%
