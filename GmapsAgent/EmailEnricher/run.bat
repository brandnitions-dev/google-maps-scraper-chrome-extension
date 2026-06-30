@echo off
setlocal EnableExtensions EnableDelayedExpansion
title EmailEnricher — Maps CSV email enrichment

cd /d "%~dp0" || exit /b 1

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo   Virtual environment not found — running setup.bat...
  echo.
  call "%~dp0setup.bat"
  if not exist ".venv\Scripts\python.exe" (
    echo.
    echo  ============================================================
    echo   SETUP FAILED
    echo  ============================================================
    echo   .venv\Scripts\python.exe is still missing after setup.bat.
    echo   Review messages above ^(rerun setup.bat if needed^).
    echo  ============================================================
    echo.
    pause
    exit /b 1
  )
)

if not exist "data" mkdir "data" 2>nul
if not exist "enriched_data" mkdir "enriched_data" 2>nul

echo.
echo  ============================================================
echo   EmailEnricher
echo   Working directory: %cd%
echo  ============================================================
echo   Started: %date%  %time%
if not "%~1"=="" (
  echo   Extra args: %*
) else (
  echo   Processing all *.csv in .\data\  — outputs in .\enriched_data\
)
echo  ------------------------------------------------------------
echo.

rem UTF-8 console + unbuffered logs for live Rich output
chcp 65001 >nul 2>&1
set "PYTHONUTF8=1"
set "PYTHONUNBUFFERED=1"

".venv\Scripts\python.exe" -m email_enricher %*
set "_EXIT=!ERRORLEVEL!"

echo.
echo  ------------------------------------------------------------
if !_EXIT! equ 0 (
  echo   Status: SUCCESS
  echo   Outputs: %cd%\enriched_data\
) else (
  echo   Status: FAILED ^(exit code !_EXIT!^)
  echo   Fix any errors above, or run setup.bat again if packages are missing.
)
echo   Finished: %date%  %time%
echo  ============================================================
echo.
pause
exit /b !_EXIT!
