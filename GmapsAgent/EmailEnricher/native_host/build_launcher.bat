@echo off
setlocal EnableExtensions

cd /d "%~dp0"
if errorlevel 1 (
  exit /b 1
)

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [ERROR] Could not find csc.exe for .NET Framework 4.x dev pack ^(or MSVC Build Tools^).
  exit /b 1
)

echo Building GmapsAgentEnrichLauncher.exe ...
"%CSC%" /nologo /optimize+ /target:exe /out:"%~dp0GmapsAgentEnrichLauncher.exe" "%~dp0stdio_launcher.cs"
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo [ERROR] CSC failed with code %EXITCODE%.
  exit /b %EXITCODE%
)

echo OK: "%~dp0GmapsAgentEnrichLauncher.exe"
exit /b 0
