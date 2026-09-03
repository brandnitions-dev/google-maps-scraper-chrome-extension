@echo off
setlocal EnableExtensions
rem Chrome / Windows pass gmapsagent-enrich://start as %1 — ignore it.

cd /d "%~dp0" || exit /b 1

powershell.exe -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:18765/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } ; exit 1 } catch { exit 1 }"
if not errorlevel 1 exit /b 0

if not exist ".venv\Scripts\python.exe" (
  start "EmailEnricher setup needed" cmd.exe /k "echo Run setup.bat in this folder first.& echo %cd%\setup.bat& pause"
  exit /b 1
)

start "Email enrich server" cmd.exe /k "%~dp0start_enrich_server.bat"
exit /b 0
