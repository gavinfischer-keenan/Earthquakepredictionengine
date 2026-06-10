# EarthquakePredictionEngine

Real-time earthquake early warning system for [Raspberry Shake RS4D](https://raspberryshake.org/) seismometers.

EarthquakePredictionEngine continuously ingests seismic waveform data from a single RS4D station, applies signal processing and ML-based phase detection, and issues rapid alerts when earthquake-like events are detected. Designed for deployment on a local network alongside your Shake, it complements the Raspberry Shake global network with configurable, low-latency local alerting.

---

## Architecture

The processing pipeline is structured as five discrete stages:

```
┌──────────┐    ┌──────────────┐    ┌──────────┐    ┌──────────┐    ┌─────────┐
│  Ingest  │───▶│  Preprocess  │───▶│  Detect  │───▶│ Validate │───▶│  Alert  │
└──────────┘    └──────────────┘    └──────────┘    └──────────┘    └─────────┘
```

| Stage        | Description |
|:-------------|:------------|
| **Ingest**   | Connects to the RS4D via SeedLink (TCP) or raw UDP and fills a rolling waveform buffer. |
| **Preprocess** | Applies a Butterworth bandpass filter (default 1–10 Hz) and demeans/detrends the trace. |
| **Detect**   | Runs recursive STA/LTA on the filtered stream; optionally runs a SeisBench ML model (PhaseNet, EQTransformer) for P/S phase picking. |
| **Validate** | Checks trigger duration, computes Pd (predominant period) and τ_c (period parameter) within configurable windows to reject false triggers (e.g., door slams, footsteps). |
| **Alert**    | Sends event metadata (magnitude estimate, P-arrival time) via HTTP POST to a dashboard endpoint; enforces a cooldown to prevent alert floods. |

A **Telemetry** subsystem runs alongside the pipeline, emitting periodic heartbeats and station health metrics.

---

## Raspberry Shake RS4D Channels

The RS4D provides four data channels at **100 Hz** sampling:

| Channel | Sensor         | Axis     | Typical Use |
|:--------|:---------------|:---------|:------------|
| `EHZ`   | Geophone       | Vertical | Primary detection channel — sensitive to P-wave arrivals |
| `ENZ`   | Accelerometer  | Vertical | Strong-motion; PGA measurement |
| `ENN`   | Accelerometer  | North    | 3-component ground motion |
| `ENE`   | Accelerometer  | East     | 3-component ground motion |

By default, the engine monitors **EHZ** for event detection, but all four channels are buffered for post-event analysis and archival.

---

## Installation

### Prerequisites

- Python **3.11+**
- A Raspberry Shake RS4D on your local network with SeedLink or UDP forwarding enabled

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/youruser/EarthquakePredictionEngine.git
cd EarthquakePredictionEngine

# 2. Create and activate a virtual environment
python -m venv .venv
# Windows:
.venv\Scripts\activate
# Linux/macOS:
source .venv/bin/activate

# 3a. Install (core only)
pip install -e .

# 3b. Install with ML support (PhaseNet / EQTransformer)
pip install -e ".[ml]"

# 3c. Install with dev tools
pip install -e ".[dev]"
```

---

## Configuration

Copy the example environment file and edit it for your station:

```bash
cp .env.example .env
```

Key settings to change:

| Variable | What to set |
|:---------|:------------|
| `SHAKE_IP` | IP address or hostname of your Shake (e.g., `192.168.1.50`) |
| `SHAKE_STATION` | Your station code (printed on the Shake, e.g., `R1A2B`) |
| `INGEST_MODE` | `seedlink` (recommended) or `udp` |
| `ML_ENABLED` | `true` to enable ML phase picking (requires `[ml]` extras) |

All parameters have sensible defaults — see [`.env.example`](.env.example) for the complete list with inline documentation.

---

## Usage

### Run as CLI

```bash
# Uses the [project.scripts] entry point
eqengine

# Or run as a Python module
python -m eqengine
```

### Common flags (planned)

```bash
eqengine --config /path/to/.env     # Custom config path
eqengine --dry-run                  # Process data but don't send alerts
eqengine --replay event.mseed       # Replay a saved miniSEED for testing
```

---

## Dashboard Integration

EarthquakePredictionEngine posts event detections to a configurable HTTP endpoint (default: `http://localhost:5050/api/ingest/earthquake-engine`).

The POST payload follows a Berkeley-style schema:

```json
{
  "station": "AM.R1A3D",
  "channel": "EHZ",
  "p_arrival": "2025-06-09T12:34:56.789Z",
  "magnitude_estimate": 3.2,
  "pd_cm": 0.045,
  "tau_c_sec": 1.12,
  "peak_sta_lta": 8.7,
  "ml_confidence": 0.92,
  "trigger_duration_sec": 4.5
}
```

Point `DASHBOARD_URL` at your dashboard's ingest API to receive real-time alerts.

---

## Deployment with systemd (Linux)

For headless 24/7 operation on a Raspberry Pi or server:

```ini
# /etc/systemd/system/eqengine.service
[Unit]
Description=EarthquakePredictionEngine — Seismic Early Warning
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=shake
WorkingDirectory=/home/shake/EarthquakePredictionEngine
EnvironmentFile=/home/shake/EarthquakePredictionEngine/.env
ExecStart=/home/shake/EarthquakePredictionEngine/.venv/bin/eqengine
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eqengine
sudo journalctl -u eqengine -f   # Follow logs
```

---

## Disclaimer

> **⚠️ Single-Station Limitations**
>
> This system operates on data from a **single seismometer**. It **cannot**:
>
> - Accurately locate earthquake epicenters (requires ≥3 stations)
> - Distinguish between local earthquakes and nearby anthropogenic sources with certainty
> - Provide official magnitude estimates (Pd/τ_c are rapid proxies only)
>
> **Do not rely on this system as your sole source of earthquake alerting.**
> Always cross-reference with official sources such as the USGS ShakeAlert,
> EMSC, or your national seismological agency.
>
> This software is provided as-is for research and educational purposes.

---

## License

MIT

---

## Acknowledgements

- [ObsPy](https://obspy.org/) — Seismological data processing
- [SeisBench](https://seisbench.readthedocs.io/) — ML earthquake models
- [Raspberry Shake](https://raspberryshake.org/) — Citizen seismology hardware
