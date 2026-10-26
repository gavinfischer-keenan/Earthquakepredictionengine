#!/usr/bin/env bash
# Earthquake Prediction Engine — 1-Click Installer for Linux & macOS
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$DIR"

echo "========================================================================"
echo "      EARTHQUAKE PREDICTION ENGINE — INSTALLER & SETUP"
echo "========================================================================"
echo ""

# 1. Check Python
if command -v python3 >/dev/null 2>&1; then
    PY_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PY_CMD="python"
else
    echo "[!] Python 3 is not installed. Please install Python 3.11+."
    exit 1
fi

# 2. Check version >= 3.11
$PY_CMD -c "import sys; assert sys.version_info >= (3, 11), 'Python 3.11+ required'" || {
    echo "[!] Python 3.11 or newer is required."
    exit 1
}

# 3. Create venv
if [ ! -d ".venv" ]; then
    echo "[*] Creating virtual environment (.venv)..."
    $PY_CMD -m venv .venv
fi

# 4. Install dependencies
echo "[*] Installing dependencies..."
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet -e .

echo "[✓] Dependencies installed."
echo ""

# 5. Run Wizard
.venv/bin/python scripts/setup_wizard.py
