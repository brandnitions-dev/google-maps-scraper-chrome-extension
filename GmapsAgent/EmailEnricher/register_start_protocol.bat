@echo off
setlocal EnableExtensions
cd /d "%~dp0" || exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0register_start_protocol.ps1"
exit /b %ERRORLEVEL%
