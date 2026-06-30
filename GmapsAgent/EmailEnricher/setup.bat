@echo off
setlocal EnableExtensions EnableDelayedExpansion
title EmailEnricher — Setup

cd /d "%~dp0" || exit /b 1

echo.
echo  ============================================================
echo   EmailEnricher — first-time setup
echo   %cd%
echo  ============================================================
echo.

set "PY_EXE="

call :resolve_python
if defined PY_EXE goto :python_ok

echo  [i] Python not found. Trying winget ^(Windows Package Manager^) ...
call :install_python_winget
if errorlevel 1 goto :no_winget

rem PATH may not refresh until a new shell; probe common paths + launcher again
call :resolve_python
if defined PY_EXE goto :python_ok

echo.
echo  [WARN] Python was installed but is not visible in this window yet.
echo         Close this window, open a NEW Command Prompt or PowerShell,
echo         cd to this folder, and run setup.bat again.
echo.
echo         Or install manually: https://www.python.org/downloads/
echo         ^(enable "Add python.exe to PATH"^)
echo.
pause
exit /b 1

:no_winget
echo.
echo  [ERROR] Could not install Python automatically ^(winget missing or failed^).
echo          Install Python 3.10 or newer from:
echo          https://www.python.org/downloads/
echo          Then run setup.bat again.
echo.
pause
exit /b 1

:python_ok
echo  [ok] Using Python:
"%PY_EXE%" --version
if errorlevel 1 (
  echo  [ERROR] Python launcher failed.
  pause
  exit /b 1
)
echo.

if not exist ".venv\Scripts\python.exe" (
  echo  [i] Creating virtual environment .venv ...
  "%PY_EXE%" -m venv .venv
  if errorlevel 1 (
    echo  [ERROR] Could not create .venv
    pause
    exit /b 1
  )
) else (
  echo  [i] Virtual environment .venv exists — updating packages.
)
echo.

set "VPY=%~dp0.venv\Scripts\python.exe"
set "VPIP=%~dp0.venv\Scripts\pip.exe"

if not exist "%VPY%" (
  echo  [ERROR] Missing "%VPY%"
  pause
  exit /b 1
)

echo  [i] Upgrading pip, setuptools, wheel ...
"%VPY%" -m pip install --upgrade pip setuptools wheel --quiet
if errorlevel 1 (
  echo  [ERROR] pip upgrade failed
  pause
  exit /b 1
)

if not exist "requirements.txt" (
  echo  [ERROR] requirements.txt not found in:
  echo          %cd%
  pause
  exit /b 1
)

if not exist "pyproject.toml" (
  echo  [ERROR] pyproject.toml not found in:
  echo          %cd%
  pause
  exit /b 1
)

echo  [i] Installing dependencies from requirements.txt ...
"%VPIP%" install -r requirements.txt
if errorlevel 1 (
  echo  [ERROR] pip install -r requirements.txt failed
  pause
  exit /b 1
)

echo  [i] Installing package ^(pip install -e .^) ...
"%VPIP%" install -e .
if errorlevel 1 (
  echo  [ERROR] pip install -e . failed
  pause
  exit /b 1
)

echo.
echo  [i] Installing Playwright Chromium ^(may download ~100–300 MB^) ...
"%VPY%" -m playwright install chromium
if errorlevel 1 (
  echo.
  echo  [WARN] playwright install failed. Retry later:
  echo          "%VPY%" -m playwright install chromium
  echo.
) else (
  echo  [ok] Chromium installed.
)

echo.
echo  ============================================================
echo   Setup finished successfully.
echo.
echo   Input CSV folder:  %cd%\data
echo   Output folder:     %cd%\enriched_data
echo.
echo   Next step:         Double-click run.bat
echo                     ^(or: .venv\Scripts\python.exe -m email_enricher^)
echo  ============================================================
echo.
pause
exit /b 0

rem ---------------------------------------------------------------------------
rem  Subroutines
rem ---------------------------------------------------------------------------
:resolve_python
set "PY_EXE="
call :try_py_launcher
if defined PY_EXE exit /b 0
call :try_python_path
if defined PY_EXE exit /b 0
call :try_well_known
if defined PY_EXE exit /b 0
exit /b 1

:try_py_launcher
where py >nul 2>&1 || exit /b 1
for %%V in (3.12 3.11 3.10 3) do (
  if not defined PY_EXE (
    for /f "delims=" %%I in ('py -%%V -c "import sys; print(sys.executable)" 2^>nul') do (
      if exist "%%I" set "PY_EXE=%%I"
    )
  )
)
if defined PY_EXE exit /b 0
exit /b 1

:try_python_path
where python >nul 2>&1 || exit /b 1
for /f "delims=" %%I in ('where python 2^>nul') do (
  set "CAND=%%I"
  echo !CAND! | findstr /I "WindowsApps" >nul
  if errorlevel 1 (
    if exist "!CAND!" (
      set "PY_EXE=!CAND!"
      exit /b 0
    )
  )
)
for /f "delims=" %%I in ('where python 2^>nul') do (
  set "PY_EXE=%%I"
  exit /b 0
)
exit /b 1

:try_well_known
for %%P in (
  "%LocalAppData%\Programs\Python\Python312\python.exe"
  "%LocalAppData%\Programs\Python\Python311\python.exe"
  "%LocalAppData%\Programs\Python\Python310\python.exe"
  "%ProgramFiles%\Python312\python.exe"
  "%ProgramFiles%\Python311\python.exe"
  "%ProgramFiles%\Python310\python.exe"
) do (
  if not defined PY_EXE if exist %%P set "PY_EXE=%%~P"
)
if defined PY_EXE exit /b 0
exit /b 1

:install_python_winget
where winget >nul 2>&1 || exit /b 1
echo  [i] winget: Python.Python.3.12
winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
if not errorlevel 1 exit /b 0
echo  [i] winget: Python.Python.3.11
winget install -e --id Python.Python.3.11 --accept-package-agreements --accept-source-agreements
if not errorlevel 1 exit /b 0
exit /b 1
