@echo off
setlocal enabledelayedexpansion
title Earthquake Prediction Engine — 1-Click Installer
color 0A

echo ========================================================================
echo       EARTHQUAKE PREDICTION ENGINE — WINDOWS INSTALLER ^& SETUP
echo ========================================================================
echo.

cd /d "%~dp0"

:: 1. Check for Python installation
where python >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "PY_CMD=python"
) else (
    where py >nul 2>&1
    if %ERRORLEVEL% equ 0 (
        set "PY_CMD=py -3"
    ) else (
        echo [!] Python is not installed or not in your PATH.
        echo.
        echo Please install Python 3.11 or newer:
        echo   1. Go to: https://www.python.org/downloads/
        echo   2. Run the installer.
        echo   3. CRITICAL: Check the box "Add Python to PATH" on the first screen!
        echo.
        echo Press any key to open the Python download page in your browser...
        pause >nul
        start https://www.python.org/downloads/
        exit /b 1
    )
)

:: 2. Verify Python version >= 3.11
echo [*] Checking Python environment...
%PY_CMD% -c "import sys; assert sys.version_info >= (3, 11), 'Python 3.11+ required'" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [!] Python 3.11 or newer is required.
    echo Detected version:
    %PY_CMD% --version
    echo.
    echo Please install a newer Python version from https://www.python.org/downloads/
    pause
    exit /b 1
)

:: 3. Create Virtual Environment
if not exist ".venv\Scripts\python.exe" (
    echo [*] Creating isolated virtual environment (.venv)...
    %PY_CMD% -m venv .venv
    if %ERRORLEVEL% neq 0 (
        echo [!] Error: Failed to create virtual environment.
        pause
        exit /b 1
    )
)

:: 4. Install Dependencies
echo [*] Installing required dependencies (FastAPI, ObsPy, NumPy, SciPy)...
echo     (This may take 1-2 minutes on first run)...
.venv\Scripts\python.exe -m pip install --quiet --upgrade pip
.venv\Scripts\python.exe -m pip install --quiet -e .
if %ERRORLEVEL% neq 0 (
    echo [!] Standard install encountered an issue. Retrying with full log:
    .venv\Scripts\python.exe -m pip install -e .
    if %ERRORLEVEL% neq 0 (
        echo.
        echo [!] Installation failed. Please check the error messages above.
        pause
        exit /b 1
    )
)

echo [✓] Engine dependencies installed successfully!
echo.

:: 5. Launch Setup Wizard
.venv\Scripts\python.exe scripts\setup_wizard.py

pause
