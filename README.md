# SHAKE — Earthquake Prediction Engine & Seismic Observatory (`eqengine`)

[![Version](https://img.shields.io/badge/version-0.2.0-0ea5e9.svg)](pyproject.toml)
[![Python](https://img.shields.io/badge/python-3.11%2B-3776ab.svg)](https://www.python.org/downloads/)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Raspberry%20Pi%20%7C%20Windows%20%7C%20macOS-22c55e.svg)](#1-click-quick-start)
[![Hardware](https://img.shields.io/badge/hardware-Raspberry%20Shake%20RS4D%20%2F%20RS3D%20%2F%20RS1D%20%2F%20Boom-f59e0b.svg)](#raspberry-shake-channels--calibration)
[![License: MIT](https://img.shields.io/badge/license-MIT-8b5cf6.svg)](#license)

**Real-time Earthquake Early Warning (EEW) engine, 100 Hz DSP/ML phase-picking pipeline, Environmental Forensics & External Events correlator, and Standalone 12-Module Geophysical Web Observatory for Raspberry Shake seismometers.**

Built to run locally on a **Raspberry Pi**, **Linux workstation**, **Windows PC**, or **macOS** right alongside your Raspberry Shake on the same LAN, `eqengine` turns raw sensor streams into an autonomous early-warning hub with physics-informed false-positive rejection, rapid magnitude/distance estimation, USGS–RS4D trigger fusion, NOAA ocean buoy & Berkeley-local external event correlation, MQTT/webhook alerting, and a full interactive browser observatory on port `8088`.

[Quick Start](#1-click-quick-start) • [Web Observatory](#standalone-geophysical-observatory) • [Architecture](#system-architecture--pipeline) • [Configuration](#configuration-reference-env) • [API & Alerts](#rest-api-websocket--alert-schema) • [Field Manual](docs/SEISMIC_OBSERVATORY_MANUAL.md)

---

## Key Capabilities

- **Low-Latency 100 Hz Ingestion:** Streams all four RS4D channels (`EHZ`, `ENZ`, `ENN`, `ENE`) via **TCP SeedLink** (port `18000`, FDSN miniSEED) or **raw UDP Datacast** (port `8888`) into a thread-safe circular `RingBuffer`.
- **Signal Processing & Triggering (`4 Hz` cadence):** Demeaning/detrending, 5% cosine tapering, 4-pole zero-phase Butterworth bandpass filtering (`1.0–10.0 Hz`), and stateful recursive **STA/LTA** triggering.
- **4-Gate Physics-Informed Validation:** `FalsePositiveFilter` suppresses footsteps, door slams, and cultural transients using independent checks for **duration**, **Welch PSD earthquake frequency band (`1.0–15.0 Hz`)**, **gradual envelope onset ratio (`< 0.8`)**, and **site `NoiseModel` SNR bounds (`3× – 1000×`)**.
- **Single-Station Magnitude, Distance, MMI & USGS Fusion:** Computes predominant P-wave period ($\tau_c$), peak initial displacement ($P_d$), empirical $M_{pd}$ / $M_{\tau_c}$ proxies, triaxial resultant PGA/PGV, real-time **Modified Mercalli Intensity (`MMI I–X`)** via USGS Worden et al. (2012) GMICE, crustal $S - P$ distance estimates, and fuses local triggers with nearby USGS GeoJSON events (`correlate_with_trigger`).
- **UC Berkeley `BK.BKS` Multi-Station Witness:** Cross-checks local triggers asynchronously against UC Berkeley's Byerly Vault broadband channel (`BK.BKS..BHZ`) via NCEDC FDSN (`CONFIRMED_TECTONIC` vs. `LOCAL_ONLY`), eliminating ambiguity between local structural transients and real regional earthquakes.
- **24–48h Rolling MiniSEED Archive & Quake Replay:** Writes compressed hourly MiniSEED chunks (`./data/archive/`) and lets visitors click any recent earthquake on Epicenter Radar (`🔍 Did My Sensor See This?`) to inspect the station's actual recorded trace with theoretical `P`, `S`, and `Surface` arrival cursors and SNR verdict.
- **Automatic Shake Highlights ("Notable Moments"):** Auto-archives 60-second `.npz` clips on confirmed earthquakes, live Cal home football surges (`2–5 Hz`), and Greek Theatre concerts (`25–45 Hz`) for instant replay from a header strip.
- **Optional Deep-Learning Phase Picking (`[onnx]` or `[ml]` extras):** Supports lightweight `onnxruntime` PhaseNet inference (practical on a Raspberry Pi) alongside SeisBench PyTorch (`PhaseNet`, `EQTransformer`), displaying an honest picker mode badge (`Z/H Polarization Heuristic` vs. `PhaseNet ONNX AI` vs. `SeisBench PhaseNet AI`) and streaming real backend `/ws/live` `ml_pick` events.
- **USGS GeoJSON Feed Correlation & Wavefront Modeling:** Background `USGSPoller` computes Haversine great-circle distances, 700-mile Raspberry Shake observability filtering, crustal/IASP91 P/S/Surface travel-time countdowns, event type tagging (`earthquake`, `quarry blast`), and disk-cached regional catalogs.
- **Environmental Intelligence, Quiet-Window Hunter & Berkeley Pulse Trends:** Background NOAA NDBC buoy polling (`46026` SF Bar, `46012` Half Moon Bay) correlates $2f$ ocean microseisms against Pacific swell periods, logs 1-minute forensics (`data/forensics_history.csv` & `.jsonl`), learns the quietest diurnal hours, and powers the **Pulse & Trends** (`24H`/`7D`/`30D`) analytics view with empirical **Light/Normal/Heavy/Extreme** thresholds, buoy-to-microseism regression, Weekday vs. Weekend cultural curves + 24h forecast ($\pm 1\sigma$), and blind/scheduled event-day separation.
- **External Events Correlation (Berkeley Hills Context):** Pluggable `eqengine.external_events` providers monitor **Cal Memorial Stadium** home football games (`2–5 Hz`), **The Greek Theatre Berkeley** concerts & soundchecks (`25–45 Hz`), **Berkeley Hills Wind & Weather** via Open-Meteo (`0.38–0.85 Hz`), live **BART Hills Tunnel** trains at `DBRK`/`ROCK` (`4–8 Hz`), and low-altitude **Helicopters & Aircraft** via `airplanes.live` ADS-B (`10–35 Hz`), attributing real-world spikes across the Urban Profiler, HD Spectrogram, and CSV forensics log.
- **Multi-Channel Alert Dispatch & 20-Cell Severity Matrix:** Enforces alert cooldowns (`30s` default), classifies events into `critical`, `warning`, `advisory`, `info`, or `ignore`, generates natural-language TTS alerts, and fans out concurrently to optional HTTP webhooks, JSONL event logs, structured console logs, WebSocket clients, and **MQTT** home-automation buses.
- **Standalone Geophysical Observatory (`http://localhost:8088`):** Embedded FastAPI + `/ws/live` WebSocket dashboard featuring **12 real-time HTML5 Canvas / Leaflet visualizers**, live Earth Audio sonification, built-in simulation triggers, an interactive **ML Dataset & Annotation Studio**, and a 13-chapter **3-Layer Scientific Field Manual**.

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
| 6 | **🗺️ Epicenter Radar** | `radar.js` | Interactive Leaflet regional map featuring West Coast fault systems (`data/faults.js`), cluster zones (`data/clusters.js`), historic catalog (`data/historic_quakes.js`), expanding P/S wavefronts, dynamic station coords, and `"🔍 Did My Sensor See This?"` archive replay. |
| 7 | **🏟️ Urban Profiler** | `urban.js` | 5-band FFT decomposition, learned **Light/Normal/Heavy** site tiers, NOAA NDBC $2f$ buoy correlation, Quiet-Window Hunter, and 5 **External Events** context cards (Cal Football, Greek Theatre, Open-Meteo Wind, BART Tunnel, Overhead Aircraft). |
| 7b | **📈 Pulse & Trends** | `trends.js` | Multi-day (`24H`/`7D`/`30D`) predictive dashboard: NOAA Buoy `46026` $\rightarrow$ microseism regression fit, Weekday vs. Weekend cultural curves + 24h forecast ($\pm 1\sigma$), Game/Concert day comparison, and learned empirical site percentiles table. |
| 8 | **🎯 AI PhaseNet** | `phasenet.js` | Transparent picker mode badge (`Z/H Polarization Heuristic`, `PhaseNet ONNX AI`, or `SeisBench PhaseNet AI`) with real backend `/ws/live` picks or live $P(P)$/$P(S)$ sliding curves and Wadati $S - P$ distance. |
| 9 | **🔬 Peterson Noise** | `peterson.js` | 1/3-octave smoothed Welch PSD curve in dB plotted directly against the USGS Global New Low/High Noise Models (**NLNM** / **NHNM**). |
| 10 | **🔊 Earth Audio** | `audio.js` | Real-time Web Audio API seismic frequency modulation and pitch-scaled acoustic sonification + emergency alert sirens. |
| 11 | **📋 Event Log** | `tables.js` | Sortable multi-source catalog unifying local STA/LTA triggers, dispatched alerts, USGS regional earthquakes, and annotated ML events. |
| 12 | **🤖 ML Dataset & Annotations** | `review_studio.js` | Interactive `5–600s` historical buffer scrubber, visual waveform crop labeller, automatic spectral & 3D polarization feature extraction, and `.npz` + `.jsonl` dataset export. |

> **📖 Built-In Field Manual (`http://localhost:8088/manual`):**
> The observatory ships with a complete 13-chapter scientific reference ([`docs/SEISMIC_OBSERVATORY_MANUAL.md`](docs/SEISMIC_OBSERVATORY_MANUAL.md) · [PDF](docs/Seismic_Observatory_Field_Manual.pdf)) organized by the **3-Layer Onion Principle**:
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
│  Cooldown & 20-Cell     │  Fused     │  Travel Times & Cache   │  700-mi Observability
│     Severity Matrix     │            └─────────────────────────┘
└────────────┬────────────┘
             │
             ├──▶ Optional HTTP Webhook POST (DASHBOARD_ENABLED=true)
             ├──▶ JSONL Event Archive (./events / EQ_EVENT_LOG_DIR)
             ├──▶ MQTT Message Bus (home/alerts/*, home/status/*, home/events/*, home/sensors/rsam)
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
| `STATION_LAT` | `37.8696` | Station latitude in decimal degrees (used for radar, Haversine distance, travel times, weather). |
| `STATION_LON` | `-122.2491` | Station longitude in decimal degrees. |
| `STATION_ELEVATION` | `161.1` | Station elevation in meters above sea level. |
| `STATION_TZ` | `America/Los_Angeles` | IANA timezone name for Quiet-Window Hunter diurnal hours & local timestamps. |
| `INGEST_MODE` | `seedlink` | Transport mode: `seedlink` (TCP, preferred) or `udp` (raw Datacast packets). |
| `SEEDLINK_PORT` | `18000` | SeedLink server TCP port on the Shake. |
| `UDP_PORT` | `8888` | Local UDP listen port when `INGEST_MODE=udp`. |

### DSP, Detection, Validation & ML

| Variable | Default | Description |
|:---------|:--------|:------------|
| `STA_SECONDS` | `0.5` | Short-Term Average window in seconds (must be `< LTA_SECONDS`). |
| `LTA_SECONDS` | `20.0` | Long-Term Average window in seconds. |
| `TRIGGER_ON` | `6.5` | STA/LTA characteristic ratio to declare trigger ON. |
| `TRIGGER_OFF` | `2.0` | STA/LTA characteristic ratio to declare trigger OFF (must be `< TRIGGER_ON`). |
| `BANDPASS_LOW` | `1.0` | Butterworth bandpass lower corner frequency in Hz. |
| `BANDPASS_HIGH` | `10.0` | Butterworth bandpass upper corner frequency in Hz. |
| `MIN_TRIGGER_DURATION_SEC` | `1.2` | Minimum trigger duration (seconds) to accept an event. |
| `PD_WINDOW_SEC` | `3.0` | Peak displacement ($P_d$) measurement window after P-onset (seconds). |
| `TC_WINDOW_SEC` | `3.0` | Predominant period ($\tau_c$) window after P-onset (seconds). |
| `BUFFER_DURATION_SEC` | `120` | Rolling waveform ring-buffer history per channel in seconds. |
| `SAMPLING_RATE` | `100` | Hardware ADC sampling rate in Hz. |
| `ML_ENABLED` | `false` | Enable ML phase picking (`true` requires `.[onnx]` or `.[ml]` extras). |
| `ML_BACKEND` / `ML_ONNX_MODEL_PATH` | `auto` / `./data/models/phasenet.onnx` | Inference backend (`auto`, `onnx`, `seisbench`, `heuristic`) and ONNX weights path. |
| `ML_MODEL` | `phasenet` | SeisBench model identifier (`phasenet`, `eqtransformer`, etc.). |
| `ML_P_THRESHOLD` | `0.3` | Minimum P-wave probability threshold (`0.0–1.0`). |
| `ML_ANNOTATOR` | `observatory_user` | Default annotator identifier for `/api/ml/annotate` exports. |
| `STATION_NAME` / `PUBLIC_MODE` | `Berkeley Hills` / `false` | Station display name and public showcase mode flag served via `/api/status`. |

### Web Observatory, USGS, External Events, Alerting & MQTT

| Variable | Default | Description |
|:---------|:--------|:------------|
| `WEB_ENABLED` | `true` | Enable embedded FastAPI + WebSocket observatory web server. |
| `WEB_HOST` | `0.0.0.0` | Bind host for the embedded web server. |
| `WEB_PORT` | `8088` | HTTP/WebSocket port for the Standalone Observatory. |
| `USGS_ENABLED` | `true` | Poll USGS GeoJSON feed for regional correlation and Epicenter Radar display. |
| `USGS_POLL_INTERVAL_SEC` | `60.0` | Interval between USGS feed polls in seconds. |
| `USGS_FEED_URL` | `.../all_week.geojson` | USGS GeoJSON feed URL (7-day feed for 48h radar window). |
| `USGS_MIN_MAGNITUDE` | `0.5` | Minimum USGS event magnitude to ingest. |
| `DISTANCE_LOCAL_KM` / `DISTANCE_REGIONAL_KM` / `DISTANCE_STATE_KM` | `80.0` / `240.0` / `640.0` | Distance band cutoffs in km (~50 mi / ~150 mi / ~400 mi). |
| `EXTERNAL_EVENTS_ENABLED` | `true` | Enable Cal Football, Greek Theatre, Open-Meteo wind, and BART ETD polling. |
| `EXTERNAL_EVENTS_SCHEDULE_POLL_SEC` | `3600.0` | Poll interval (seconds) for Cal Football & Greek Theatre calendars. |
| `EXTERNAL_EVENTS_WEATHER_POLL_SEC` | `600.0` | Poll interval (seconds) for Open-Meteo Berkeley Hills weather. |
| `EXTERNAL_EVENTS_BART_POLL_SEC` | `60.0` | Poll interval (seconds) for live BART `DBRK`/`ROCK` train arrivals. |
| `EXTERNAL_EVENTS_AIRCRAFT_POLL_SEC` / `AIRCRAFT_RADIUS_NM` / `AIRCRAFT_MAX_ALT_FT` | `45.0` / `3.0` / `5000` | Poll interval, search radius (nm), and max altitude (ft) for `airplanes.live` overhead helicopters/aircraft. |
| `CAL_FOOTBALL_TEAM_ID` / `GREEK_THEATRE_URL` | `25` / `https://thegreekberkeley.com/events/` | ESPN team ID and Greek Theatre event listing URL. |
| `BART_API_KEY` / `BART_STATIONS` | public key / `["DBRK","ROCK"]` | BART ETD API key and stations bordering the Berkeley Hills Tunnel. |
| `WITNESS_ENABLED` / `WITNESS_STATION` | `true` / `BKS` (`BK.BKS..BHZ`) | Multi-station NCEDC FDSN coincidence verification settings. |
| `ARCHIVE_ENABLED` / `ARCHIVE_RETENTION_HOURS` | `true` / `48` | Rotating hourly MiniSEED archival under `./data/archive`. |
| `HIGHLIGHTS_ENABLED` / `HIGHLIGHTS_COOLDOWN_SEC` | `true` / `180.0` | Automatic 60s `.npz` highlight recording under `./data/highlights`. |
| `DASHBOARD_ENABLED` / `DASHBOARD_URL` | `false` / `http://localhost:5050/api/ingest/earthquake-engine` | Optional outbound HTTP POST webhook to an external dashboard. |
| `ALERT_COOLDOWN_SEC` | `30.0` | Minimum seconds between successive alerts to prevent flooding. |
| `HEARTBEAT_INTERVAL_SEC` | `60.0` | Telemetry health snapshot, environmental 1-min forensics, and ML baseline interval. |
| `LOG_LEVEL` | `INFO` | Minimum log level: `DEBUG`, `INFO`, `WARNING`, `ERROR`. |
| `EVENT_LOG_DIR` / `NOISE_MODEL_PATH` | `./events` / `./data/noise_model.json` | Alert JSONL directory and auto-calibrated site `NoiseModel` path. |
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

# Compute and save a site noise model from NOISE_CALIBRATION_FILE
eqengine --calibrate-noise

# Print installed version
eqengine --version
```

> **Automatic Site Noise Calibration:** During live operation, the **Autonomous Quiet-Window Hunter** continuously learns your station's quietest diurnal hours (typically `02:00–04:00 PST`), rejects impulsive footsteps via excess kurtosis ($|\kappa| < 2.5$), and updates `data/noise_model.json` + `data/quiet_baseline.json` automatically (or on demand via **🎯 Hunt & Calibrate Now** in the Urban Profiler tab).

### Interactive Setup Wizard

Re-run configuration discovery and `.env` generation anytime:

```bash
python scripts/setup_wizard.py
```

---

## REST API, WebSocket & Alert Schema

### HTTP & WebSocket Endpoints (`eqengine.web.routes`)

| Method & Path | Description |
|:--------------|:------------|
| `GET /` | Serves the Standalone Geophysical Observatory SPA (`index.html`). |
| `GET /manual` | Serves the interactive 13-Chapter 3-Layer Scientific Field Manual (`manual.html`). |
| `WS /ws/live` | High-speed WebSocket streaming `100 Hz` 4-channel waveforms, STA/LTA ratios, triggers, alerts, status heartbeats, and USGS events. |
| `GET /api/status` | Returns station metadata, coordinates, active channels, client count, and per-channel ring-buffer fill ratios. |
| `GET /api/events` | Returns recent STA/LTA triggers, dispatched alerts, and cached USGS events. |
| `GET /api/usgs-events` | Returns observable regional USGS earthquakes from the last 48 hours. |
| `GET /api/buffer/{channel}?duration=60` | Fetches the latest `duration` seconds of raw samples for `EHZ`, `ENZ`, `ENN`, or `ENE`. |
| `GET /api/seismograph/historical?start_time=...&duration_sec=60` | Fetches a `5–600s` synchronized 4-channel historical slice from the ring buffer. |
| `GET /api/helicorder/latest?channel=EHZ&block=0` | Proxies the Raspberry Shake's onboard 24-hour `/heli/` GIF drum plot. |
| `GET /api/environmental-intelligence` | Returns NOAA NDBC buoy state (`46026`/`46012`), $2f$ microseism match, Quiet-Window Hunter hourly diurnal profile, and external-event correlation. |
| `POST /api/environmental/calibrate` | Triggers immediate Quiet-Window Hunter noise-floor calibration and updates `data/noise_model.json`. |
| `GET /api/forensics/export.csv` | Downloads continuous 1-minute forensics time series (band powers, $\kappa$, $H/V$, buoy swell, external event attribution) as CSV. |
| `GET /api/forensics/trends?days=7` | Returns Berkeley Pulse analytics: empirical Light/Normal/Heavy/Extreme site thresholds, Buoy `46026` regression, Weekday vs. Weekend diurnal forecasts, and Game/Concert surge profiles. |
| `GET /api/external-events` | Returns Cal Football home games, Greek Theatre concerts, Berkeley Hills wind/weather, BART `DBRK`/`ROCK` train arrivals, overhead `airplanes.live` aircraft, and live correlation. |
| `POST /api/external-events/refresh` | Forces an immediate refresh of all external-event providers. |
| `GET /api/witness/status` & `POST /api/witness/check` | Returns the latest `BK.BKS` FDSN coincidence witness state or manually checks a timestamp. |
| `GET /api/archive/status` & `GET /api/archive/quake-replay` | Returns rolling MiniSEED archive inventory or slices recorded RS4D waveform for a USGS event with theoretical P/S/Surface cursors & SNR verdict. |
| `GET /api/highlights` & `GET /api/highlights/{highlight_id}` | Lists auto-captured Shake Highlights ("Notable Moments") or fetches waveform samples for a specific `.npz` clip. |
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

This creates a dedicated `eqengine` system user, installs the project into `/opt/eqengine`, initializes `/opt/eqengine/venv`, provisions `/opt/eqengine/.env` (`chmod 600`), creates `/opt/eqengine/events` and `/opt/eqengine/data` (both allowed in `ReadWritePaths`), installs `/etc/systemd/system/eqengine.service`, and starts the daemon.

Manage the background service with `systemctl`:

```bash
sudo systemctl status eqengine
sudo journalctl -u eqengine -f      # Stream live structured logs
sudo systemctl restart eqengine
sudo systemctl stop eqengine
```

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
│   ├── SEISMIC_OBSERVATORY_MANUAL.md  # 13-chapter 3-layer scientific field manual
│   └── Seismic_Observatory_Field_Manual.pdf
├── scripts/
│   ├── setup_wizard.py                # Interactive LAN scanner, geocoder & shortcut builder
│   └── install_service.sh             # Production Linux/Pi systemd installer
├── systemd/
│   └── eqengine.service               # Hardened systemd unit definition
├── src/eqengine/
│   ├── constants.py                   # Shared RS4D calibration & geodesy constants
│   ├── config.py                      # Pydantic v2 Settings & validation
│   ├── engine.py                      # SeismicEngine 4 Hz pipeline orchestrator
│   ├── cli.py                         # CLI (--replay, --calibrate-noise, --config)
│   ├── main.py                        # Thin package entry point
│   ├── ingest/                        # SeedLinkClient, UDPListener, RingBuffer, USGSPoller
│   ├── processing/                    # Preprocessor, recursive STA/LTA Detector, MagnitudeEstimator
│   ├── validation/                    # FalsePositiveFilter, NoiseModel, SeisBench MLPicker
│   ├── alerts/                        # AlertManager, EarthquakeAlert schema, async Dispatch hooks
│   ├── telemetry/
│   │   ├── rsam.py / health.py        # RSAMCalculator & HealthReporter
│   │   └── environmental/             # NDBC buoys, 1-min forensics, Quiet Hunter, CSV/JSONL storage
│   ├── external_events/               # Pluggable Cal Football, Greek Theatre, Wind, BART providers
│   ├── ml/                            # DatasetLogger (JSONL + 4-channel NPZ tensors)
│   └── web/
│       ├── server.py / broadcaster.py # FastAPI app factory & /ws/live WebSocket hub
│       ├── routes/                    # Modular REST routers (telemetry, simulation, ml, env, external)
│       └── static/                    # 12-view Canvas/Leaflet SPA, js/data/ catalogs & Field Manual
└── tests/                             # 16 unit & integration test suites
```

### Running Tests & Static Checks

Install `[dev]` extras (`pip install -e ".[dev]"`) and run:

```bash
# Run all 16 test suites
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
- [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/) & [NOAA NDBC](https://www.ndbc.noaa.gov/) — Live earthquake feeds, Peterson noise baselines, and Pacific ocean buoy telemetry
