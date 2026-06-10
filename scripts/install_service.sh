#!/usr/bin/env bash
# install_service.sh — Install EarthquakePredictionEngine as a systemd service.
#
# Usage:
#   sudo ./scripts/install_service.sh
#
# This script:
#   1. Creates the 'eqengine' system user (if not exists)
#   2. Copies the project to /opt/eqengine
#   3. Creates a Python virtualenv and installs dependencies
#   4. Creates .env from .env.example (if not exists)
#   5. Creates the events directory for alert logging
#   6. Installs the systemd unit file
#   7. Enables and starts the service
#   8. Shows status
#
# Requires: root privileges, Python 3.11+, systemd
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
INSTALL_DIR="/opt/eqengine"
SERVICE_USER="eqengine"
SERVICE_GROUP="eqengine"
UNIT_FILE="eqengine.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
ok()    { echo -e "\033[1;32m[OK]\033[0m    $*"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m  $*"; }
fail()  { echo -e "\033[1;31m[FAIL]\033[0m  $*"; exit 1; }

require_root() {
    if [[ $EUID -ne 0 ]]; then
        fail "This script must be run as root (try: sudo $0)"
    fi
}

# ---------------------------------------------------------------------------
# 1. Create system user
# ---------------------------------------------------------------------------
create_user() {
    info "Checking for system user '${SERVICE_USER}'..."
    if id "$SERVICE_USER" &>/dev/null; then
        ok "User '${SERVICE_USER}' already exists."
    else
        info "Creating system user '${SERVICE_USER}'..."
        useradd \
            --system \
            --shell /usr/sbin/nologin \
            --home-dir "$INSTALL_DIR" \
            --create-home \
            "$SERVICE_USER"
        ok "User '${SERVICE_USER}' created."
    fi
}

# ---------------------------------------------------------------------------
# 2. Copy project
# ---------------------------------------------------------------------------
copy_project() {
    info "Copying project to ${INSTALL_DIR}..."
    mkdir -p "$INSTALL_DIR"

    # rsync if available, else cp
    if command -v rsync &>/dev/null; then
        rsync -a --delete \
            --exclude='.git' \
            --exclude='__pycache__' \
            --exclude='.venv' \
            --exclude='venv' \
            --exclude='.mypy_cache' \
            --exclude='.pytest_cache' \
            --exclude='*.egg-info' \
            "${PROJECT_DIR}/" "${INSTALL_DIR}/"
    else
        cp -a "${PROJECT_DIR}/." "${INSTALL_DIR}/"
    fi

    chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$INSTALL_DIR"
    ok "Project copied to ${INSTALL_DIR}."
}

# ---------------------------------------------------------------------------
# 3. Virtual environment + dependencies
# ---------------------------------------------------------------------------
create_venv() {
    info "Creating Python virtual environment..."
    local PYTHON
    PYTHON="$(command -v python3.11 || command -v python3 || echo python3)"

    if [[ ! -x "$PYTHON" ]]; then
        fail "Python 3 not found. Install Python 3.11+ first."
    fi

    sudo -u "$SERVICE_USER" "$PYTHON" -m venv "${INSTALL_DIR}/venv"
    ok "Virtual environment created at ${INSTALL_DIR}/venv."

    info "Installing dependencies..."
    sudo -u "$SERVICE_USER" "${INSTALL_DIR}/venv/bin/pip" install --upgrade pip setuptools wheel
    if [[ -f "${INSTALL_DIR}/requirements.txt" ]]; then
        sudo -u "$SERVICE_USER" "${INSTALL_DIR}/venv/bin/pip" install -r "${INSTALL_DIR}/requirements.txt"
        ok "Dependencies installed from requirements.txt."
    elif [[ -f "${INSTALL_DIR}/pyproject.toml" ]]; then
        sudo -u "$SERVICE_USER" "${INSTALL_DIR}/venv/bin/pip" install -e "${INSTALL_DIR}"
        ok "Package installed from pyproject.toml."
    else
        warn "No requirements.txt or pyproject.toml found — skipping pip install."
    fi
}

# ---------------------------------------------------------------------------
# 4. Environment file
# ---------------------------------------------------------------------------
setup_env() {
    info "Setting up environment file..."
    if [[ -f "${INSTALL_DIR}/.env" ]]; then
        ok ".env already exists — skipping."
    elif [[ -f "${INSTALL_DIR}/.env.example" ]]; then
        cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
        chown "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_DIR}/.env"
        chmod 600 "${INSTALL_DIR}/.env"
        ok ".env created from .env.example (mode 600)."
        warn "Review and edit ${INSTALL_DIR}/.env with your settings."
    else
        warn "No .env.example found — creating minimal .env."
        cat > "${INSTALL_DIR}/.env" <<'EOF'
# EarthquakePredictionEngine configuration
# Raspberry Shake RS4D settings
SHAKE_STATION=R1A3D
SHAKE_NETWORK=AM
SHAKE_PORT=8888
SHAKE_HOST=0.0.0.0

# Alert settings
DASHBOARD_URL=http://localhost:8080/api/alerts
EVENTS_DIR=/opt/eqengine/events

# Detector thresholds
STA_WINDOW=1.0
LTA_WINDOW=30.0
TRIGGER_ON=3.5
TRIGGER_OFF=1.5
EOF
        chown "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_DIR}/.env"
        chmod 600 "${INSTALL_DIR}/.env"
        ok "Minimal .env created."
    fi
}

# ---------------------------------------------------------------------------
# 5. Events directory
# ---------------------------------------------------------------------------
create_events_dir() {
    info "Creating events directory..."
    mkdir -p "${INSTALL_DIR}/events"
    chown "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_DIR}/events"
    chmod 755 "${INSTALL_DIR}/events"
    ok "Events directory ready at ${INSTALL_DIR}/events."
}

# ---------------------------------------------------------------------------
# 6. Install systemd unit
# ---------------------------------------------------------------------------
install_unit() {
    info "Installing systemd unit file..."
    local SRC="${INSTALL_DIR}/systemd/${UNIT_FILE}"
    local DST="/etc/systemd/system/${UNIT_FILE}"

    if [[ ! -f "$SRC" ]]; then
        fail "Unit file not found at ${SRC}"
    fi

    cp "$SRC" "$DST"
    chmod 644 "$DST"
    systemctl daemon-reload
    ok "Systemd unit installed at ${DST}."
}

# ---------------------------------------------------------------------------
# 7. Enable & start
# ---------------------------------------------------------------------------
enable_and_start() {
    info "Enabling and starting eqengine service..."
    systemctl enable --now "$UNIT_FILE"
    ok "Service enabled and started."
}

# ---------------------------------------------------------------------------
# 8. Show status
# ---------------------------------------------------------------------------
show_status() {
    echo ""
    echo "=========================================="
    echo "  EarthquakePredictionEngine — Status"
    echo "=========================================="
    systemctl status "$UNIT_FILE" --no-pager || true
    echo ""
    info "Logs:   journalctl -u eqengine -f"
    info "Stop:   sudo systemctl stop eqengine"
    info "Config: ${INSTALL_DIR}/.env"
    info "Events: ${INSTALL_DIR}/events/"
    echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    require_root
    info "Installing EarthquakePredictionEngine..."
    echo ""

    create_user
    copy_project
    create_venv
    setup_env
    create_events_dir
    install_unit
    enable_and_start
    show_status

    ok "Installation complete!"
}

main "$@"
