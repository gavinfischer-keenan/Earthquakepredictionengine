# SHAKE — Earthquake Prediction Engine & Seismic Observatory (`eqengine`)

[![Version](https://img.shields.io/badge/version-0.2.0-0ea5e9.svg)](pyproject.toml)
[![Python](https://img.shields.io/badge/python-3.11%2B-3776ab.svg)](https://www.python.org/downloads/)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Raspberry%20Pi%20%7C%20Windows%20%7C%20macOS-22c55e.svg)](#1-click-quick-start)
[![Hardware](https://img.shields.io/badge/hardware-Raspberry%20Shake%20RS4D%20%2F%20RS3D%20%2F%20RS1D%20%2F%20Boom-f59e0b.svg)](#raspberry-shake-channels--calibration)
[![License: MIT](https://img.shields.io/badge/license-MIT-8b5cf6.svg)](#license)

**Real-time Earthquake Early Warning (EEW) engine, 100 Hz DSP/ML phase-picking pipeline, and Standalone 12-Module Geophysical Web Observatory for Raspberry Shake seismometers.**

Built to run locally on a **Raspberry Pi**, **Linux workstation**, **Windows PC**, or **macOS** right alongside your Raspberry Shake on the same LAN, `eqengine` turns raw sensor streams into an autonomous early-warning hub with physics-informed false-positive rejection, rapid magnitude/distance estimation, USGS regional wavefront correlation, MQTT/webhook alerting, and a full interactive browser observatory on port `8088`.

[Quick Start](#1-click-quick-start) • [Web Observatory](#standalone-geophysical-observatory) • [Architecture](#system-architecture--pipeline) • [Configuration](#configuration-reference-env) • [API & Alerts](#rest-api-websocket--alert-schema) • [Field Manual](docs/SEISMIC_OBSERVATORY_MANUAL.md)

---

## Key Capabilities

- **Low-Latency 100 Hz Ingestion:** Streams all four RS4D channels (`EHZ`, `ENZ`, `ENN`, `ENE`) via **TCP SeedLink** (port `18000`, FDSN miniSEED) or **raw UDP Datacast** (port `8888`) into a thread-safe circular `RingBuffer`.
- **Signal Processing & Triggering (`4 Hz` cadence):** Demeaning/detrending, 5% cosine tapering, 4-pole zero-phase Butterworth bandpass filtering (`1.0–10.0 Hz`), trapezoidal velocity-to-displacement integration, Hilbert envelope extraction, and stateful recursive **STA/LTA** triggering.
- **4-Gate Physics-Informed Validation:** `FalsePositiveFilter` suppresses footsteps, door slams, and cultural transients using independent checks for **duration**, **Welch PSD earthquake frequency band (`1.0–15.0 Hz`)**, **gradual envelope onset ratio (`≤ 0.8`)**, and **site `NoiseModel` SNR bounds (`3× – 1000×`)**.
- **Single-Station Magnitude & Distance Estimation:** Computes predominant P-wave period ($\tau_c$), peak initial displacement ($P_d$), empirical $M_{pd}$ / $M_{\tau_c}$ proxies, triaxial resultant PGA/PGV, and crustal $S - P$ distance estimates.
- **Optional Deep-Learning Phase Picking (`[ml]` extras):** Integrates [SeisBench](https://seisbench.readthedocs.io/) (`PhaseNet`, `EQTransformer`) via PyTorch to validate P- and S-wave arrivals with neural probability scores.
- **USGS GeoJSON Feed Correlation & Wavefront Modeling:** Background `USGSPoller` computes Haversine great-circle distances, 700-mile Raspberry Shake observability filtering, crustal/IASP91 P/S/Surface travel-time countdowns, and disk-cached regional catalogs.
- **Multi-Channel Alert Dispatch & 20-Cell Severity Matrix:** Enforces alert cooldowns (`30s` default), classifies events into `critical`, `warning`, `advisory`, `info`, or `ignore`, generates natural-language TTS alerts, and fans out concurrently to HTTP webhooks, JSONL event logs, structured console logs, WebSocket clients, and **MQTT** home-automation buses.
- **Standalone Geophysical Observatory (`http://localhost:8088`):** Embedded FastAPI + `/ws/live` WebSocket dashboard featuring **12 real-time HTML5 Canvas / Leaflet visualizers**, live Earth Audio sonification, built-in simulation triggers, an interactive **ML Dataset & Annotation Studio**, and a 10-chapter **3-Layer Scientific Field Manual**.

---

## Standalone Geophysical Observatory

When running, `eqengine` serves a self-contained, single-page scientific observatory at **`http://localhost:8088`**, powered by FastAPI and a high-speed `/ws/live` WebSocket stream (`100 Hz` live samples + trigger overlays):

| # | Tab | Module | What It Visualizes & Computes |
|:-:|:----|:-------|:------------------------------|
| 1 | **📈 Seismograms** | `oscilloscope.js` | Live 4-channel oscilloscope (`EHZ` geophone velocity + `ENZ`/`ENN`/`ENE` triaxial accelerometers) with auto-gain, normal baseline corridor, and UTC axis. |
| 2 | **🌈 HD Spectrogram** | `spectrogram.js` | Dual-view `0–50 Hz` STFT frequency waterfall with bilinear interpolation, 256-level Inferno/Magma color scaling, and synchronized ground-velocity trace. |
| 3 | **📜 24h Helicorder** | `helicorder.js` | Classic 24-hour rotating drum seismogram (1 hour per row) with active stylus indicator and live `/api/helicorder/latest` Raspberry Shake drum proxy. |
| 4 | **📊 STA/LTA & RSAM** | `stalta.js` | Real-time recursive STA/LTA characteristic ratio monitor against the trigger threshold alongside a 60-minute demeaned RMS (RSAM) ambient energy trend. |
| 5 | **🌐 3D Orbit** | `hodogram.js` | 3D particle motion hodogram plotting horizontal (N–S vs. E–W) and vertical ground trajectory with real-time back-azimuth and polarization rectilinearity. |
| 6 | **🗺️ Epicenter Radar** | `radar.js` | Interactive Leaflet regional map featuring West Coast fault systems, special seismic/geothermal cluster zones (The Geysers, Long Valley Caldera, Salton Sea, Coso, Parkfield, San Ramon), magnitude-scaled USGS epicenters, and expanding P/S wavefronts. |
| 7 | **🏟️ Urban Profiler** | `urban.js` | 5-band FFT decomposition isolating Wind/Tree Sway (`0.1–0.5 Hz`), Stadium/Crowd Resonance (`2–5 Hz`), Roadway Traffic (`8–14 Hz`), Indoor Footsteps/Impacts (`15–24 Hz`), and Sub-bass Acoustic Coupling (`25–45 Hz`). |
| 8 | **🎯 AI PhaseNet** | `phasenet.js` | Deep-learning P-wave $P(P)$ and S-wave $P(S)$ arrival probability curves with `0.60` pick threshold and Wadati $S - P$ distance derivation. |
| 9 | **🔬 Peterson Noise** | `peterson.js` | 1/3-octave smoothed Welch PSD curve in dB plotted directly against the USGS Global New Low/High Noise Models (**NLNM** / **NHNM**). |
| 10 | **🔊 Earth Audio** | `audio.js` | Real-time Web Audio API seismic frequency modulation and pitch-scaled acoustic sonification + emergency alert sirens. |
| 11 | **📋 Event Log** | `tables.js` | Sortable multi-source catalog unifying local STA/LTA triggers, dispatched alerts, USGS regional earthquakes, and annotated ML events. |
| 12 | **🤖 ML Dataset & Annotations** | `review_studio.js` | Interactive `5–600s` historical buffer scrubber, visual waveform crop labeller, automatic spectral & 3D polarization feature extraction, and `.npz` + `.jsonl` dataset export. |

> **📖 Built-In Field Manual (`http://localhost:8088/manual`):**
> The observatory ships with a complete 10-chapter scientific reference ([`docs/SEISMIC_OBSERVATORY_MANUAL.md`](docs/SEISMIC_OBSERVATORY_MANUAL.md) · [PDF](docs/Seismic_Observatory_Field_Manual.pdf)) organized by the **3-Layer Onion Principle**:
> - 🟢 **Layer 1: The Layperson's Eye** — Plain-English intuition and visual cues
> - 🟡 **Layer 2: The Geophysical Science** — Sensor mechanics, wave physics, and DSP theory
> - 🔴 **Layer 3: Raw Mathematics & Derivations** — Differential equations, filter transfer functions, and discrete formulas

---

## System Architecture & Pipeline

Full subsystem specifications and test coverage mapping are documented in [`ARCHITECTURE.md`](ARCHITECTURE.md).

```text
┌─────────────────────────┐
│     Ingest Layer        │  SeedLinkClient (TCP :18000) or UDPListener (UDP :8888)
└────────────┬────────────┘
             │ 4-Channel Streams (EHZ, ENZ, ENN, ENE @ 100 Hz)
             ▼
┌─────────────────────────┐
│      RingBuffer         │  Thread-safe circular rolling storage (default 120s)
└────────────┬────────────┘
             ├──────────────────────────────────────┐
             ▼                                      ▼
┌─────────────────────────┐            ┌─────────────────────────┐
│     Preprocessing       │            │    WebSocket Live Hub   │  /ws/live @ 4 Hz chunks
│  Demean • Taper • BPF   │            │  (FastAPI + 12 Views)   │  REST API on :8088
└────────────┬────────────┘            └─────────────────────────┘
             ▼
┌─────────────────────────┐
│    Detection Engine     │  Recursive STA/LTA (+ optional SeisBench PhaseNet/EQT)
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│   4-Gate Validation     │  Duration • 1–15 Hz PSD • Envelope Onset • Site NoiseModel
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│    Characterization     │  τ_c Predominant Period • P_d Peak Disp • PGA/PGV • S-P Dist
└────────────┬────────────┘
             ▼
┌─────────────────────────┐            ┌─────────────────────────┐
│  AlertManager & Hooks   │◀───────────│      USGSPoller         │  GeoJSON Poll + Haversine
│  Cooldown & 20-Cell     │            │  Travel Times & Cache   │  700-mi Observability
│     Severity Matrix     │            └─────────────────────────┘
└────────────┬────────────┘
             │
             ├──▶ HTTP Webhook POST (Dashboard / Berkeley Ingest)
             ├──▶ JSONL Event Archive (./events / ./data/events)
             ├──▶ MQTT Message Bus (home/alerts/*, home/status/*, home/events/*)
             └──▶ Live Browser Alerts + TTS Speech Synthesis
```

### Raspberry Shake Channels & Calibration

The engine targets the **Raspberry Shake RS4D** (`100 Hz` across 4 channels) and also supports **RS1D**, **RS3D**, and **Shake & Boom** profiles in the setup wizard:

| Channel | Sensor Type | Axis | Calibration Constant | Primary Role |
|:--------|:------------|:-----|:---------------------|:-------------|
| `EHZ` | Moving-Coil Geophone (`4.5 Hz`) | Vertical | `~0.05 µm/s` per count | Primary P-wave detection, STA/LTA, $\tau_c$, $P_d$, PGV, Spectrogram |
| `ENZ` | MEMS Capacitive Accelerometer | Vertical | `~1.9 µm/s²` per count | Strong-motion vertical PGA & 3D hodogram vertical component |
| `ENN` | MEMS Capacitive Accelerometer | North–South | `~1.9 µm/s²` per count | Horizontal strong-motion & back-azimuth polarization |
| `ENE` | MEMS Capacitive Accelerometer | East–West | `~1.9 µm/s²` per count | Horizontal strong-motion & back-azimuth polarization |
| `EHN` / `EHE` | Geophones *(RS3D)* | N–S / E–W | — | Supported via channel selection in `setup_wizard.py` |
| `HDF` | Infrasound Microphone *(Boom)* | Acoustic | — | Supported via channel selection in `setup_wizard.py` |

---

## 1-Click Quick Start

### Windows (Zero-Configuration Installer)

1. Download this repository (`Code` ➔ `Download ZIP`) and extract it, or clone with Git.
2. Double-click **[`install.bat`](install.bat)**.
3. The script verifies Python `3.11+`, creates `.venv`, installs dependencies, and launches the interactive **[Setup Wizard](scripts/setup_wizard.py)**:
   - Auto-scans your LAN (`SHAKE_IP`, `raspberryshake.local`, `rs.local`) on SeedLink port `18000`
   - Lets you pick your Shake model (`RS4D`, `RS1D`, `RS3D`, or `Shake & Boom`) and station code
   - Geocodes your City/State or ZIP code into decimal coordinates (`STATION_LAT`, `STATION_LON`)
   - Checks port `8088`, generates `.env`, and creates **`Start Earthquake Observatory.bat`** on your Desktop
4. Anytime after setup, double-click **`Start Earthquake Observatory.bat`** (or **[`start_observatory.bat`](start_observatory.bat)** in the repo root) to launch the engine and open `http://localhost:8088` automatically.

### Linux, Raspberry Pi & macOS (1-Click Installer)

```bash
git clone https://github.com/gavinfischer-keenan/Earthquakepredictionengine.git
cd Earthquakepredictionengine
chmod +x install.sh
./install.sh
```

`install.sh` checks for Python `3.11+`, creates `.venv`, installs `eqengine` in editable mode, and runs `scripts/setup_wizard.py` interactively.

---

## Manual Installation (Advanced / Developer)

### Prerequisites

- **Python 3.11, 3.12, or 3.13**
- A **Raspberry Shake** (`RS4D`, `RS3D`, `RS1D`, or `Boom`) reachable on your local network with **SeedLink** (`TCP 18000`) or **UDP Datacast** (`UDP 8888`) enabled

> **Dependency Note:** `pyproject.toml` pins `obspy>=1.4.2,<1.5` and `setuptools<81` to preserve `pkg_resources` and SeedLink timeout compatibility.

### Setup Virtual Environment & Extras

```bash
git clone https://github.com/gavinfischer-keenan/Earthquakepredictionengine.git
cd Earthquakepredictionengine

python3 -m venv .venv
# Linux / macOS:
source .venv/bin/activate
# Windows PowerShell:
# .venv\Scripts\Activate.ps1

# Core engine + FastAPI Web Observatory
pip install -e .

# Optional: Deep-learning phase picking (SeisBench + PyTorch)
pip install -e ".[ml]"

# Optional: MQTT home-automation broker support (paho-mqtt)
pip install -e ".[mqtt]"

# Optional: Development tools (pytest, pytest-asyncio, ruff, mypy)
pip install -e ".[dev]"
```

---

## Configuration Reference (`.env`)

Copy [`.env.example`](.env.example) to `.env` (or generate one via `python scripts/setup_wizard.py`). Settings are validated at startup by `eqengine.config.Settings` (Pydantic v2).

### Station & Ingestion

| Variable | Default | Description |
|:---------|:--------|:------------|
| `SHAKE_IP` | `192.168.4.164` | Hostname or IP address of your Raspberry Shake (e.g. `raspberryshake.local`). |
| `SHAKE_STATION` | `R1A3D` | FDSN station code printed on your Raspberry Shake. |
| `SHAKE_NETWORK` | `AM` | FDSN network code (`AM` = Raspberry Shake citizen network). |
| `SHAKE_CHANNEL` | `EHZ` | Primary channel monitored for STA/LTA event detection. |
| `SHAKE_CHANNELS` | `["EHZ","ENZ","ENN","ENE"]` | Channels buffered (accepts comma-separated string or JSON list). |
| `STATION_LAT` | `37.8696` | Station latitude in decimal degrees (used for radar, Haversine distance, travel times). |
| `STATION_LON` | `-122.2491` | Station longitude in decimal degrees. |
| `STATION_ELEVATION` | `161.1` | Station elevation in meters above sea level. |
| `INGEST_MODE` | `seedlink` | Transport mode: `seedlink` (TCP, preferred) or `udp` (raw Datacast packets). |
| `SEEDLINK_PORT` | `18000` | SeedLink server TCP port on the Shake. |
| `UDP_PORT` | `8888` | Local UDP listen port when `INGEST_MODE=udp`. |

### DSP, Detection, Validation & ML

| Variable | Default | Description |
|:---------|:--------|:------------|
| `STA_SECONDS` | `0.5` | Short-Term Average window in seconds (must be `< LTA_SECONDS`). |
| `LTA_SECONDS` | `20.0` | Long-Term Average window in seconds. |
| `TRIGGER_ON` | `6.5` | STA/LTA characteristic ratio to declare trigger ON (`.env.example` uses `4.0`; `config.py` / wizard defaults to `6.5`). |
| `TRIGGER_OFF` | `2.0` | STA/LTA characteristic ratio to declare trigger OFF (must be `< TRIGGER_ON`). |
| `BANDPASS_LOW` | `1.0` | Butterworth bandpass lower corner frequency in Hz. |
| `BANDPASS_HIGH` | `10.0` | Butterworth bandpass upper corner frequency in Hz. |
| `MIN_TRIGGER_DURATION_SEC` | `1.2` | Minimum trigger duration (seconds) to accept an event (`config.py` default `1.2`; `.env.example` sets `0.5`). |
| `PD_WINDOW_SEC` | `3.0` | Peak displacement ($P_d$) measurement window after P-onset (seconds). |
| `TC_WINDOW_SEC` | `3.0` | Predominant period ($\tau_c$) window after P-onset (seconds). |
| `BUFFER_DURATION_SEC` | `120` | Rolling waveform ring-buffer history per channel in seconds. |
| `SAMPLING_RATE` | `100` | Hardware ADC sampling rate in Hz. |
| `ML_ENABLED` | `false` | Enable SeisBench ML phase picking (`true` requires `.[ml]` extras). |
| `ML_MODEL` | `phasenet` | SeisBench model identifier (`phasenet`, `eqtransformer`, etc.). |
| `ML_P_THRESHOLD` | `0.3` | Minimum P-wave probability threshold (`0.0–1.0`). |

### Web Observatory, USGS Enrichment, Alerting & MQTT

| Variable | Default | Description |
|:---------|:--------|:------------|
| `WEB_ENABLED` | `true` | Enable embedded FastAPI + WebSocket observatory web server. |
| `WEB_HOST` | `0.0.0.0` | Bind host for the embedded web server. |
| `WEB_PORT` | `8088` | HTTP/WebSocket port for the Standalone Observatory. |
| `USGS_ENABLED` | `true` | Poll USGS GeoJSON feed for regional correlation and Epicenter Radar display. |
| `USGS_POLL_INTERVAL_SEC` | `60.0` | Interval between USGS feed polls in seconds. |
| `USGS_FEED_URL` | `.../all_week.geojson` | USGS GeoJSON feed URL (7-day feed in `config.py` for 48h radar window). |
| `USGS_MIN_MAGNITUDE` | `0.5` | Minimum USGS event magnitude to ingest. |
| `DISTANCE_LOCAL_KM` / `DISTANCE_REGIONAL_KM` / `DISTANCE_STATE_KM` | `80.0` / `240.0` / `640.0` | Distance band cutoffs in km (~50 mi / ~150 mi / ~400 mi). |
| `DASHBOARD_URL` / `EQ_DASHBOARD_URL` | `http://localhost:5050/api/ingest/earthquake-engine` | External dashboard webhook endpoint (`config.py` defaults to `:5050/...`; `dispatcher.py` reads `EQ_DASHBOARD_URL` defaulting to `http://localhost:8080/api/events`). |
| `ALERT_COOLDOWN_SEC` | `30.0` | Minimum seconds between successive alerts to prevent flooding. |
| `HEARTBEAT_INTERVAL_SEC` | `60.0` | Telemetry health snapshot and 1-minute ML baseline logging interval. |
| `LOG_LEVEL` | `INFO` | Minimum log level: `DEBUG`, `INFO`, `WARNING`, `ERROR`. |
| `EVENT_LOG_DIR` / `EQ_EVENT_LOG_DIR` | `./events` | Directory for persisted alert/event logs (`dispatcher.py` reads `EQ_EVENT_LOG_DIR`, default `./data/events`). |
| `MQTT_ENABLED` | `false` | Enable MQTT publishing (`home/alerts/earthquake`, `home/status/earthquake-engine`, `home/events/earthquake`, `home/commands/display`, `home/sensors/rsam`). |
| `MQTT_BROKER` / `MQTT_PORT` | `localhost` / `1883` | Mosquitto/MQTT broker connection (`MQTT_USERNAME` / `MQTT_PASSWORD` optional). |

---

## CLI Usage & Operational Scripts

### Running `eqengine`

```bash
# Start live ingestion, processing pipeline, and Web Observatory (http://localhost:8088)
eqengine
# Or directly via module:
python -m eqengine.main

# Inspect resolved configuration as JSON and exit
eqengine --config

# Replay a saved MiniSEED recording through the detection & validation pipeline
eqengine --replay path/to/recording.mseed

# Compute and save a site noise model from a configured calibration file
eqengine --calibrate-noise

# Print installed version
eqengine --version
```

### Interactive Setup Wizard

Re-run configuration discovery and `.env` generation anytime:

```bash
python scripts/setup_wizard.py
```

### Ambient Site Noise Calibration

Record quiet-period background data from your Raspberry Shake and build `noise_model.json` (RMS, mean, std dev, 95th percentile, and Welch PSD per channel) for false-positive SNR gating:

```bash
# SeedLink mode (default: 30 minutes)
python scripts/calibrate_noise.py --host raspberryshake.local --port 18000 --duration 30 --output data/noise_model.json

# UDP Datacast mode
python scripts/calibrate_noise.py --mode udp --port 8888 --duration 30 --output data/noise_model.json
```

---

## REST API, WebSocket & Alert Schema

### HTTP & WebSocket Endpoints (`eqengine.web.server`)

| Method & Path | Description |
|:--------------|:------------|
| `GET /` | Serves the Standalone Geophysical Observatory SPA (`index.html`). |
| `GET /manual` | Serves the interactive 3-Layer Scientific Field Manual (`manual.html`). |
| `WS /ws/live` | High-speed WebSocket streaming `100 Hz` 4-channel waveforms, STA/LTA ratios, triggers, alerts, status heartbeats, and USGS events. |
| `GET /api/status` | Returns station metadata, coordinates, active channels, client count, and per-channel ring-buffer fill ratios. |
| `GET /api/events` | Returns recent STA/LTA triggers, dispatched alerts, and cached USGS events. |
| `GET /api/usgs-events` | Returns observable regional USGS earthquakes from the last 48 hours. |
| `GET /api/buffer/{channel}?duration=60` | Fetches the latest `duration` seconds of raw samples for `EHZ`, `ENZ`, `ENN`, or `ENE`. |
| `GET /api/seismograph/historical?start_time=...&duration_sec=60` | Fetches a `5–600s` synchronized 4-channel historical slice from the ring buffer. |
| `GET /api/helicorder/latest?channel=EHZ&block=0` | Proxies the Raspberry Shake's onboard 24-hour `/heli/` GIF drum plot. |
| `POST /api/simulate-trigger?magnitude=3.5&distance_km=25.0` | Dispatches a simulated local trigger and warning alert to test dashboard symbology and audio. |
| `POST /api/simulate-usgs?magnitude=4.7&distance_km=320.0` | Dispatches a simulated regional USGS event with live incoming P/S/Surface wavefronts. |
| `POST /api/ml/annotate` & `POST /api/ml/annotate_range` | Slices recent or user-selected waveform windows, extracts 11 spectral/polarization features, saves compressed 4-channel `.npz` tensors, and appends to `events.jsonl` / `annotations.jsonl`. |
| `GET /api/ml/events`, `GET /api/ml/snippet/{event_id}`, `DELETE /api/ml/events/{event_id}`, `GET /api/ml/summary` | Inspect, load for audio/visual playback, delete, or summarize the local ML training dataset (`data/ml_dataset/`). |

### 20-Cell Distance × Magnitude Severity Matrix

`EarthquakeAlert.classify_severity()` maps epicentral distance (`LOCAL < 80 km`, `REGIONAL < 240 km`, `STATE < 640 km`, `DISTANT ≥ 640 km`) and magnitude band (`MINOR < 2.5`, `LIGHT < 4.0`, `MODERATE < 5.0`, `STRONG < 6.0`, `MAJOR ≥ 6.0`) to five operational tiers:

| Distance \ Magnitude | `MINOR` (`< 2.5`) | `LIGHT` (`2.5–3.9`) | `MODERATE` (`4.0–4.9`) | `STRONG` (`5.0–5.9`) | `MAJOR` (`≥ 6.0`) |
|:---------------------|:------------------|:--------------------|:-----------------------|:---------------------|:------------------|
| **`LOCAL` (`< 80 km`)** | `info` | `advisory` | `warning` | `critical` | `critical` |
| **`REGIONAL` (`80–239 km`)** | `info` | `info` | `advisory` | `warning` | `critical` |
| **`STATE` (`240–639 km`)** | `ignore` | `info` | `info` | `advisory` | `warning` |
| **`DISTANT` (`≥ 640 km`)** | `ignore` | `ignore` | `ignore` | `info` | `advisory` |

### Canonical `EarthquakeAlert` JSON Payload

Alert hooks (`dashboard_hook`, `log_hook`, `mqtt_alert_hook`, `websocket_alert_hook`) serialize Pydantic v2 `EarthquakeAlert` models:

```json
{
  "alert_id": "a7f3c8d1-2b4e-4c9a-9f12-0123456789ab",
  "alert_type": "earthquake",
  "severity": "warning",
  "timestamp": 1749472496.81,
  "p_wave_time": 1749472496.789,
  "sta_lta_ratio": 8.7,
  "ml_confidence": 0.92,
  "detection_method": "classic_sta_lta",
  "estimated_magnitude": 4.2,
  "estimated_distance_km": 42.5,
  "distance_miles": 26.4,
  "distance_class": "LOCAL",
  "mag_class": "MODERATE",
  "data_source": "rs4d",
  "tts_message": "Earthquake Imminent. magnitude 4.2 earthquake detected nearby.",
  "station": "R1A3D",
  "channel": "EHZ",
  "status": "triggered"
}
```

---

## 24/7 Production Deployment (`systemd` on Linux / Raspberry Pi)

The repository includes an automated service installer ([`scripts/install_service.sh`](scripts/install_service.sh)) and a hardened unit file ([`systemd/eqengine.service`](systemd/eqengine.service)):

```bash
sudo ./scripts/install_service.sh
```

This creates a dedicated `eqengine` system user, installs the project into `/opt/eqengine`, initializes `/opt/eqengine/venv`, provisions `/opt/eqengine/.env` (`chmod 600`), installs `/etc/systemd/system/eqengine.service`, and starts the daemon.

Manage the background service with `systemctl`:

```bash
sudo systemctl status eqengine
sudo journalctl -u eqengine -f      # Stream live structured logs
sudo systemctl restart eqengine
sudo systemctl stop eqengine
```

> **Note:** `systemd/eqengine.service` enables `ProtectSystem=strict` with `ReadWritePaths=/opt/eqengine/events`. If storing `noise_model.json`, `usgs_cache.json`, or `data/ml_dataset` outside `/opt/eqengine/events`, add `/opt/eqengine/data` to `ReadWritePaths` in the unit file.

---

## Repository Structure & Testing

```text
Earthquakepredictionengine/
├── .env.example                       # Annotated environment template
├── ARCHITECTURE.md                    # Pipeline architecture & subsystem specs
├── install.bat / install.sh           # 1-Click installers (Windows / Linux & macOS)
├── start_observatory.bat              # Windows 1-Click launcher (opens :8088)
├── pyproject.toml                     # Package metadata, dependencies & tool config
├── docs/
│   ├── SEISMIC_OBSERVATORY_MANUAL.md  # 10-chapter 3-layer scientific field manual
│   └── Seismic_Observatory_Field_Manual.pdf
├── scripts/
│   ├── setup_wizard.py                # Interactive LAN scanner, geocoder & shortcut builder
│   ├── calibrate_noise.py             # Ambient noise recorder & Welch PSD calibrator
│   └── install_service.sh             # Production Linux/Pi systemd installer
├── systemd/
│   └── eqengine.service               # Hardened systemd unit definition
├── src/eqengine/
│   ├── main.py                        # Engine orchestrator (4 Hz loop, CLI, replay)
│   ├── config.py                      # Pydantic v2 Settings & validation
│   ├── ingest/                        # SeedLinkClient, UDPListener, RingBuffer, USGSPoller
│   ├── processing/                    # Preprocessor, recursive STA/LTA Detector, MagnitudeEstimator
│   ├── validation/                    # FalsePositiveFilter, NoiseModel, SeisBench MLPicker
│   ├── alerts/                        # AlertManager, EarthquakeAlert schema, async Dispatch hooks
│   ├── telemetry/                     # RSAMCalculator & HealthReporter
│   ├── ml/                            # DatasetLogger (JSONL + 4-channel NPZ tensors)
│   └── web/                           # FastAPI server, /ws/live Broadcaster & 12-view SPA
└── tests/                             # 13 unit & integration test suites
```

### Running Tests & Static Checks

Install `[dev]` extras (`pip install -e ".[dev]"`) and run:

```bash
# Run all 13 test suites (config, ingest, ring_buffer, preprocessor, detector,
# magnitude, false_positive, validation, alerts, dispatcher, telemetry, usgs_poller, web)
pytest

# Lint and type-check
ruff check src tests
mypy src
```

---

## Disclaimer

> **⚠️ Single-Station Limitations**
>
> This system analyzes waveform data from a **single seismometer**. It **cannot**:
>
> - Pinpoint earthquake epicenters on its own (triangulation requires $\ge 3$ stations; regional maps rely on USGS feeds)
> - Guarantee separation between local earthquakes and nearby anthropogenic/mechanical vibrations in all environments
> - Provide official seismological magnitudes ($P_d$ and $\tau_c$ are rapid single-station proxies subject to site and clipping effects)
>
> **Do not rely on this software as your sole life-safety earthquake warning system.**
> Always subscribe to official public alerting systems such as **USGS ShakeAlert**, **MyShake**, **EMSC**, or your national geological agency. Provided as-is for citizen seismology, research, and educational use.

---

## License

MIT License — see [`pyproject.toml`](pyproject.toml).

## Acknowledgements

- [ObsPy](https://obspy.org/) — Seismological waveform processing, SeedLink client, and STA/LTA primitives
- [SeisBench](https://seisbench.readthedocs.io/) — Pretrained deep-learning seismic phase pickers (`PhaseNet`, `EQTransformer`)
- [FastAPI](https://fastapi.tiangolo.com/) & [Uvicorn](https://www.uvicorn.org/) — Embedded asynchronous REST & WebSocket observatory server
- [Raspberry Shake](https://raspberryshake.org/) — Citizen science seismograph hardware & FDSN network
- [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/) — Live GeoJSON earthquake feeds & Peterson NLNM/NHNM noise baselines
