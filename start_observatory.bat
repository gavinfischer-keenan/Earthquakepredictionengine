@echo off
setlocal
cd /d "%~dp0"
title Earthquake Prediction Engine — Seismic Observatory
color 0B

if not exist ".venv\Scripts\python.exe" (
    echo [!] Observatory environment not found. Running installer first...
    call install.bat
    exit /b
)

echo ========================================================================
echo       EARTHQUAKE PREDICTION ENGINE — SEISMIC OBSERVATORY
echo ========================================================================
echo.
echo [*] Starting Seismic Early Warning Hub ^& Live Telemetry Server...
echo [*] Standalone Web Observatory: http://localhost:8088
echo.
echo (Leave this window running while using the observatory. Press Ctrl+C to stop.)
echo ========================================================================
echo.

:: Open browser after 2 seconds in background
start "" /b powershell -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8088'"

.venv\Scripts\python.exe -m eqengine.main
if %ERRORLEVEL% neq 0 (
    echo.
    echo [!] Engine stopped with an error code.
    pause
)
