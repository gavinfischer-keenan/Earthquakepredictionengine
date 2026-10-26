#!/usr/bin/env python3
"""
EarthquakePredictionEngine — Interactive Terminal Setup Wizard.

Guides users through connecting to their Raspberry Shake, resolving their
station location, setting up local web dashboard ports, and creating a
1-click desktop shortcut.
"""
from __future__ import annotations

import json
import os
import platform
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path


# ANSI Color helpers
GREEN = "\033[92m"
CYAN = "\033[96m"
YELLOW = "\033[93m"
RED = "\033[91m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


def enable_windows_ansi() -> None:
    """Enable ANSI escape sequences on Windows console."""
    if platform.system() == "Windows":
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
        except Exception:
            pass


def print_banner() -> None:
    """Print high-tech welcome banner."""
    print(f"{CYAN}{BOLD}")
    print("=" * 72)
    print("   EARTHQUAKE PREDICTION ENGINE — LOCAL OBSERVATORY INSTALLER")
    print("=" * 72)
    print(f"{RESET}")
    print(f"{DIM}Welcome! This wizard will configure your local seismic observatory{RESET}")
    print(f"{DIM}for your home network in less than 2 minutes.{RESET}\n")


def probe_seedlink(host: str, port: int = 18000, timeout: float = 2.5) -> tuple[bool, str]:
    """Test if SeedLink server responds on host:port."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect((host, port))
        s.sendall(b"HELLO\r\n")
        resp = s.recv(1024).decode("utf-8", errors="ignore")
        s.close()
        if "SeedLink" in resp or "OSOP" in resp:
            return True, resp.strip().split("\n")[0]
        return True, "SeedLink service reachable"
    except Exception as e:
        return False, str(e)


def geocode_location(query: str) -> tuple[float, float, str] | None:
    """Convert city/zip into lat, lon, and display address via OpenStreetMap."""
    clean_q = query.strip()
    if not clean_q:
        return None
    url = f"https://nominatim.openstreetmap.org/search?q={urllib.parse.quote(clean_q)}&format=json&limit=1"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "EarthquakePredictionEngine-Installer/0.2.0"}
    )
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data and len(data) > 0:
                lat = float(data[0]["lat"])
                lon = float(data[0]["lon"])
                display = data[0].get("display_name", clean_q)
                return lat, lon, display
    except Exception as e:
        print(f"  {YELLOW}[!] Geocoding lookup failed: {e}{RESET}")
    return None


def read_existing_env(root_dir: Path) -> dict[str, str]:
    """Parse existing .env file if available."""
    env_path = root_dir / ".env"
    existing: dict[str, str] = {}
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                existing[k.strip()] = v.strip().strip('"').strip("'")
    return existing


def prompt_with_default(prompt_text: str, default: str) -> str:
    """Prompt user for input with a sensible default in brackets."""
    user_input = input(f"{prompt_text} [{CYAN}{default}{RESET}]: ").strip()
    return user_input if user_input else default


def main() -> None:
    enable_windows_ansi()
    print_banner()

    root_dir = Path(__file__).resolve().parent.parent
    existing_env = read_existing_env(root_dir)

    # -------------------------------------------------------------------------
    # STEP 1: Raspberry Shake Connection
    # -------------------------------------------------------------------------
    print(f"{BOLD}[Step 1 of 3] Raspberry Shake Connection{RESET}")
    print(f"{DIM}Connecting to your Raspberry Shake's SeedLink port (18000)...{RESET}")

    detected_host = None
    default_host = existing_env.get("SHAKE_IP", "192.168.4.164")

    # Fast scan candidates
    candidates = [default_host, "raspberryshake.local", "rs.local"]
    for cand in candidates:
        if not cand:
            continue
        print(f"  Checking {cand}...", end="\r", flush=True)
        ok, _ = probe_seedlink(cand, 18000, timeout=1.5)
        if ok:
            detected_host = cand
            break

    if detected_host:
        print(f"  {GREEN}[✓] Found Raspberry Shake at {detected_host}:18000{RESET}")
        use_detected = input(f"  Use this device? [{CYAN}Y/n{RESET}]: ").strip().lower()
        if use_detected not in ("n", "no"):
            shake_ip = detected_host
        else:
            shake_ip = prompt_with_default("  Enter Shake IP address or hostname", default_host)
    else:
        print(f"  {YELLOW}[!] Could not auto-detect Raspberry Shake on standard hostnames.{RESET}")
        shake_ip = prompt_with_default("  Enter your Raspberry Shake IP address (e.g. 192.168.1.50)", default_host)

    # Validate entered IP
    print(f"  Validating connection to {shake_ip}:18000...", end="\r", flush=True)
    ok, info = probe_seedlink(shake_ip, 18000, timeout=3.0)
    if ok:
        print(f"  {GREEN}[✓] Connected successfully to SeedLink server ({info}){RESET}\n")
    else:
        print(f"  {YELLOW}[!] Warning: Could not reach port 18000 on {shake_ip}. Check that the Shake is powered on.{RESET}\n")

    # Station Code
    default_station = existing_env.get("SHAKE_STATION", "R1A3D")
    station_code = prompt_with_default(
        "  Station Code (printed on your Shake, e.g. R1A3D or RA3D)",
        default_station
    ).upper()

    # Shake Model / Channels
    print(f"\n  Select your Raspberry Shake model:")
    print(f"    {CYAN}1){RESET} RS4D (Geophone + 3-Axis Accelerometer: EHZ, ENZ, ENN, ENE) {DIM}[Default]{RESET}")
    print(f"    {CYAN}2){RESET} RS1D (Single Vertical Geophone: EHZ)")
    print(f"    {CYAN}3){RESET} RS3D (3-Axis Geophone: EHZ, EHN, EHE)")
    print(f"    {CYAN}4){RESET} Shake & Boom (Geophone + Infrasound: EHZ, HDF)")
    model_choice = input(f"  Select model [{CYAN}1{RESET}]: ").strip()

    channels_map = {
        "1": '["EHZ", "ENZ", "ENN", "ENE"]',
        "2": '["EHZ"]',
        "3": '["EHZ", "EHN", "EHE"]',
        "4": '["EHZ", "HDF"]',
    }
    selected_channels = channels_map.get(model_choice, '["EHZ", "ENZ", "ENN", "ENE"]')
    print(f"  {GREEN}[✓] Subscribed channels:{RESET} {selected_channels}\n")

    # -------------------------------------------------------------------------
    # STEP 2: Station Geographic Location
    # -------------------------------------------------------------------------
    print(f"{BOLD}[Step 2 of 3] Station Geographic Location{RESET}")
    print(f"{DIM}Needed for the 700-Mile Epicenter Radar, fault distances, and wavefront timing.{RESET}")

    default_lat = existing_env.get("STATION_LAT", "37.8696")
    default_lon = existing_env.get("STATION_LON", "-122.2491")
    default_elev = existing_env.get("STATION_ELEVATION", "161.1")

    location_query = input("  Enter your City, State or ZIP Code [e.g. 'Berkeley, CA' or '94705']: ").strip()
    resolved = geocode_location(location_query) if location_query else None

    if resolved:
        lat, lon, addr = resolved
        print(f"  {GREEN}[✓] Found:{RESET} {addr}")
        print(f"      Coordinates: {lat:.4f}° N, {lon:.4f}° W")
        confirm = input(f"  Use these coordinates? [{CYAN}Y/n{RESET}]: ").strip().lower()
        if confirm not in ("n", "no"):
            station_lat = str(round(lat, 4))
            station_lon = str(round(lon, 4))
        else:
            station_lat = prompt_with_default("  Latitude", default_lat)
            station_lon = prompt_with_default("  Longitude", default_lon)
    else:
        if location_query:
            print(f"  {YELLOW}Could not find '{location_query}'. Please enter manual coordinates:{RESET}")
        station_lat = prompt_with_default("  Latitude (decimal degrees)", default_lat)
        station_lon = prompt_with_default("  Longitude (decimal degrees)", default_lon)

    station_elev = prompt_with_default("  Elevation in meters", default_elev)
    print(f"  {GREEN}[✓] Location set to {station_lat}° N, {station_lon}° W ({station_elev}m){RESET}\n")

    # -------------------------------------------------------------------------
    # STEP 3: Local Dashboard Port
    # -------------------------------------------------------------------------
    print(f"{BOLD}[Step 3 of 3] Local Dashboard Web Port{RESET}")
    default_port = existing_env.get("WEB_PORT", "8088")
    web_port = prompt_with_default("  Local Web Port", default_port)

    # Test port availability
    try:
        test_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        test_sock.bind(("0.0.0.0", int(web_port)))
        test_sock.close()
        print(f"  {GREEN}[✓] Port {web_port} is available.{RESET}\n")
    except Exception:
        print(f"  {YELLOW}[!] Warning: Port {web_port} might already be in use by another service.{RESET}\n")

    # -------------------------------------------------------------------------
    # Generate .env File
    # -------------------------------------------------------------------------
    env_content = f"""# ==============================================================================
# EarthquakePredictionEngine Configuration
# Generated by setup_wizard.py on {time.strftime('%Y-%m-%d %H:%M:%S')}
# ==============================================================================

# -- Raspberry Shake Connection --
SHAKE_IP="{shake_ip}"
SHAKE_STATION="{station_code}"
SHAKE_NETWORK="AM"
SHAKE_CHANNEL="EHZ"
SHAKE_CHANNELS='{selected_channels}'
INGEST_MODE="seedlink"
SEEDLINK_PORT=18000

# -- Station Geographic Coordinates --
STATION_LAT={station_lat}
STATION_LON={station_lon}
STATION_ELEVATION={station_elev}

# -- Local Embedded Web Observatory --
WEB_ENABLED=true
WEB_HOST="0.0.0.0"
WEB_PORT={web_port}

# -- Early Warning & Analysis Settings --
STA_SECONDS=0.5
LTA_SECONDS=20.0
TRIGGER_ON=6.5
TRIGGER_OFF=2.0
BANDPASS_LOW=1.0
BANDPASS_HIGH=10.0
ALERT_COOLDOWN_SEC=30.0

# -- USGS Regional Enrichment --
USGS_ENABLED=true
USGS_POLL_INTERVAL_SEC=60.0
"""
    env_file = root_dir / ".env"
    env_file.write_text(env_content, encoding="utf-8")
    print(f"{GREEN}{BOLD}[✓] Saved configuration to {env_file.resolve()}{RESET}")

    # -------------------------------------------------------------------------
    # Create Desktop Launcher (Windows)
    # -------------------------------------------------------------------------
    if platform.system() == "Windows":
        try:
            desktop = Path(os.environ.get("USERPROFILE", "")) / "Desktop"
            if desktop.exists():
                shortcut_bat = desktop / "Start Earthquake Observatory.bat"
                runner_content = f"""@echo off
cd /d "{root_dir.resolve()}"
title Earthquake Prediction Engine
echo Starting Earthquake Prediction Engine...
start "" "http://localhost:{web_port}"
.venv\\Scripts\\python.exe -m eqengine.main
pause
"""
                shortcut_bat.write_text(runner_content, encoding="utf-8")
                print(f"{GREEN}[✓] Created 1-Click Desktop Shortcut: {shortcut_bat.name}{RESET}")
        except Exception as e:
            print(f"{DIM}Desktop shortcut skipped: {e}{RESET}")

    print("\n" + "=" * 72)
    print(f"{GREEN}{BOLD}🎉 SETUP COMPLETE! Your Seismic Observatory is ready.{RESET}")
    print(f"Local Observatory URL: {CYAN}{BOLD}http://localhost:{web_port}{RESET}")
    print("=" * 72 + "\n")

    # Prompt to launch immediately
    launch_now = input(f"Launch Earthquake Observatory now? [{CYAN}Y/n{RESET}]: ").strip().lower()
    if launch_now not in ("n", "no"):
        url = f"http://localhost:{web_port}"
        print(f"\n{BOLD}Opening {url} in your browser...{RESET}")
        try:
            webbrowser.open(url)
        except Exception:
            pass

        # Execute engine using current python environment
        py_exe = sys.executable
        print(f"{DIM}Starting engine process ({py_exe} -m eqengine.main)...{RESET}\n")
        try:
            subprocess.run([py_exe, "-m", "eqengine.main"], cwd=str(root_dir))
        except KeyboardInterrupt:
            print(f"\n{YELLOW}Observatory stopped by user.{RESET}")


if __name__ == "__main__":
    main()
