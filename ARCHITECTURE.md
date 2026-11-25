# EarthquakePredictionEngine Architecture Document

## Overview

**EarthquakePredictionEngine (`eqengine`)** is a low-latency, real-time seismic monitoring and earthquake early warning (EEW) system designed for Raspberry Shake RS4D stations (100 Hz geophone and triaxial accelerometer channels). The system continuously buffers waveform streams, applies digital signal processing, triggers on candidate seismic phase arrivals, filters false positives using physical and statistical checks, estimates earthquake magnitude and distance, fuses local picks with USGS feed data, correlates ambient vibrations against NOAA buoys and Berkeley-local external events, and dispatches structured alerts to dashboards, MQTT, and an embedded web observatory.

---

## System Architecture Pipeline

The runtime pipeline is driven by `SeismicEngine` (`eqengine.engine`) on a 4 Hz cadence with concurrent telemetry, USGS, environmental intelligence, external events, and web sidecars:

```
┌─────────────────┐
│ Ingest Layer    │  (SeedLinkClient / UDPListener)
└────────┬────────┘
         │ Waveform Streams (EHZ, ENZ, ENN, ENE @ 100 Hz)
         ▼
┌─────────────────┐
│ Ring Buffer     │  (Thread-Safe Rolling Waveform Storage)
└────────┬────────┘
         │ Raw Waveform Windows
         ▼
┌─────────────────┐
│ Preprocessing   │  (Demean, Cosine Taper, Butterworth Bandpass)
└────────┬────────┘
         │ Filtered Traces
         ▼
┌─────────────────┐
│ Detection       │  (Recursive STA/LTA Triggering + optional SeisBench ML Picker)
└────────┬────────┘
         │ Candidate Trigger Events
         ▼
┌─────────────────┐
│ Validation      │  (Duration, 1–15 Hz PSD Band, Envelope Onset, Site NoiseModel)
└────────┬────────┘
         │ Verified Seismic Triggers
         ▼
┌─────────────────┐
│ Characterization│  (τ_c Predominant Period, P_d Peak Displacement, PGA/PGV, S-P)
│ & USGS Fusion   │  (Correlates with USGSPoller for fused magnitude & distance)
└────────┬────────┘
         │ Fused Event Parameters
         ▼
┌─────────────────┐
│ Alert Dispatch  │  (AlertManager Cooldown + Async Webhooks, JSONL, WS, MQTT)
└─────────────────┘
         ▲
         │ Sidecars (Background Poll & 1-Minute Telemetry)
┌────────┴────────┬───────────────────────────┬──────────────────────────┐
│ USGS Poller     │ Environmental Intelligence│ External Events Manager  │
│ (GeoJSON Feed)  │ (NDBC Buoys, Quiet Hunter,│ (Cal Football, Greek     │
│                 │  Forensics CSV/JSONL)     │  Theatre, Wind, BART)    │
└─────────────────┘───────────────────────────┴──────────────────────────┘
```

---

## Subsystem Details

### 1. Core Orchestration & Configuration (`eqengine`)
- **`eqengine.constants`**: Single source of truth for RS4D channel lists (`RS4D_CHANNELS`), sampling rate (`DEFAULT_SAMPLING_RATE`), calibration factors (`COUNTS_TO_ACCEL`, `COUNTS_TO_VELOCITY_M_S`, `COUNTS_TO_VELOCITY_UM_S`), and geodesy/compass utilities (`KM_TO_MILES`, `EARTH_RADIUS_KM`, `deg_to_cardinal`).
- **`eqengine.config.Settings`**: Pydantic v2 typed configuration loaded from `.env` with cross-field validation (station, ingest, STA/LTA, bandpass, ML, web server, USGS, External Events, dashboard webhook, and MQTT).
- **`eqengine.engine.SeismicEngine`**: Async 4 Hz orchestrator coordinating ring buffering, WebSocket waveform streaming, STA/LTA trigger evaluation, USGS–RS4D trigger fusion, 1-minute heartbeat logging, and graceful shutdown.
- **`eqengine.cli`**: CLI entry point (`eqengine`) supporting live mode, `--replay <file.mseed>`, `--calibrate-noise`, `--config`, and `--version`.
- **`eqengine.main`**: Thin entry-point facade exposing `cli`, `run_engine`, and `SeismicEngine`.

### 2. Ingestion Layer (`eqengine.ingest`)
- **`UDPListener`**: Binds to a local UDP socket (default port `8888`) to receive raw Raspberry Shake Datacast packets formatted as `{'CHANNEL', timestamp, s1, s2, ..., s25}`.
- **`SeedLinkClient`**: Connects via TCP to a SeedLink server (default port `18000`) for standard FDSN miniSEED streaming with exponential backoff reconnect.
- **`RingBuffer`**: Thread-safe circular buffer holding configurable durations (default `120s`) across `EHZ`, `ENZ`, `ENN`, `ENE` with gap zero-filling and monotonic sample-offset streaming (`get_samples_since`).
- **`MiniSeedArchiver` (`ingest/archive.py`)**: Writes rotating 1-hour Steim2/FLOAT32 MiniSEED chunks (`./data/archive/YYYYMMDD_HH.mseed`) with configurable 48-hour retention, powering retrospective USGS earthquake replay (`analyze_quake_replay`) with theoretical P/S/Surface arrival cursors and SNR verdicts (`CLEARLY RECORDED`, `WEAKLY DETECTED`, `BELOW NOISE FLOOR`).
- **`USGSPoller`**: Polls USGS GeoJSON feeds, computes Haversine distances, classifies events (`earthquake`, `quarry blast`, etc.), enforces 700-mile Shake observability filtering, calculates theoretical P/S/Surface arrival timestamps, persists `./data/usgs_cache.json`, and correlates regional events with local triggers (`correlate_with_trigger`).

### 3. Preprocessing (`eqengine.processing.preprocessor`)
- **Demean & Detrend**: Removes DC bias and baseline drift from raw ADC counts.
- **Cosine Tapering**: Tapers edge samples (5%) to eliminate spectral leakage.
- **Butterworth Bandpass**: 4-pole zero-phase Butterworth filter (default `1.0–10.0 Hz`) targeting P-wave SNR.
- **Displacement Integration & Envelopes**: `preprocess_for_displacement` and `compute_envelope` (Hilbert analytic signal) utilities.

### 4. Detection & Characterization (`eqengine.processing`)
- **`Detector`**: Stateful ObsPy `recursive_sta_lta` + `trigger_onset` detector with minimum trigger duration filtering (`1.2s` default).
- **`MagnitudeEstimator` & `intensity.py`**: Computes predominant period ($\tau_c$), peak initial displacement ($P_d$), 3-component accelerometer PGA, geophone PGV, empirical $M_{\tau_c}$ / $M_{P_d}$ magnitude estimates, $S-P$ distance / S-arrival countdowns, and USGS Worden et al. (2012) Modified Mercalli Intensity (**MMI `I–X`**, ShakeMap label, and hex color).

### 5. Validation, Multi-Station Witness & ML Picking (`eqengine.validation`)
- **`FalsePositiveFilter`**: Four physics-informed gates:
  1. *Signal Duration*: Rejects micro-spikes shorter than minimum duration.
  2. *Frequency Band*: Welch PSD dominant frequency must lie in the earthquake band ($1.0 - 15.0\text{ Hz}$).
  3. *Envelope Onset*: Enforces gradual earthquake onset (first-quarter amplitude < `0.8` × peak amplitude).
  4. *Noise Floor & SNR*: Waveform RMS must fall within `3× – 1000×` of site baseline noise floor.
- **`NoiseModel`**: Site background noise characterization (RMS, 95th percentile, Welch PSD) with JSON save/load persistence.
- **`MLPicker` (`validation/ml_picker.py`)**: Supports lightweight `onnxruntime` PhaseNet inference (`[onnx]` extra) alongside SeisBench PyTorch (`[ml]` extra), exposing honest active picker metadata (`PhaseNet ONNX AI`, `SeisBench PhaseNet AI`, or `Z/H Polarization Heuristic`) and live `/ws/live` `ml_pick` broadcasts.
- **`MultiStationWitness` (`validation/witness.py`)**: Non-blocking FDSN coincidence cross-check against UC Berkeley's Byerly Vault (`BK.BKS..BHZ` via NCEDC) emitting `CONFIRMED_TECTONIC`, `LOCAL_ONLY`, or `UNAVAILABLE` verdicts over WebSocket and REST.

### 6. Alert Management & Dispatch (`eqengine.alerts`)
- **`AlertManager`**: Enforces alert cooldowns (`30s` default), builds `EarthquakeAlert` models (with `rs4d`, `usgs`, or `fused` data source), and tracks active/historical alerts.
- **20-Cell Severity Matrix**: Maps `distance_class` × `mag_class` to `critical`, `warning`, `advisory`, `info`, or `ignore`, and synthesizes natural-language `tts_message`.
- **`dispatcher`**: Async hook registry (`dashboard_hook`, `log_hook`, `console_hook`, `websocket_alert_hook`, and optional `mqtt_*` hooks for alerts, confirmed events, display commands, status, and RSAM).

### 7. Modular Telemetry & Environmental Intelligence (`eqengine.telemetry`)
- **`RSAMCalculator`**: Tracks 1-minute RMS amplitudes and 60-minute rolling trends.
- **`HealthReporter`**: Emits periodic `EngineStatus` snapshots (`buffer_health`, RSAM, trigger counts, uptime).
- **`eqengine.telemetry.environmental`** (with `environmental_intelligence.py` compatibility facade):
  - **`ndbc.py`**: Polls NOAA NDBC buoys `46026` (San Francisco Bar) and `46012` (Half Moon Bay) and computes $2f$ ocean microseism correlation (`LOCKED`, `PARTIAL`, `WIND_DOMINANT`).
  - **`forensics.py`**: Computes 1-minute physical spectral bands (`wind`, `stadium`, `rail`, `traffic`, `human`, `concert`), block excess kurtosis ($\kappa$), 3-axis PGA, and Nakamura $H/V$ site resonance.
  - **`quiet_hunter.py`**: Builds 24-hour station-local diurnal noise profiles, discovers the quietest 2-hour nocturnal window, and auto-calibrates `data/noise_model.json` and `data/quiet_baseline.json`.
  - **`storage.py`**: Persists 1-minute forensics snapshots (including external-event attribution, weather wind/gusts, active BART trains, and overhead aircraft count/altitude) to `data/forensics_history.jsonl` and `data/forensics_history.csv`.
  - **`trends.py`**: Computes multi-day (`24H`/`7D`/`30D`) **Berkeley Pulse** analytics: empirical site percentiles (**Light** `<=p25`, **Normal** `p25–p75`, **Heavy** `p75–p95`, **Extreme** `>p95`), NOAA Buoy `46026` $\rightarrow$ microseism linear transfer regression ($R^2$, anomaly z-score), Weekday vs. Weekend cultural diurnal models + next-24h forecast ($\pm 1\sigma$), and blind + scheduled game/concert surge day separation.
- **`HighlightsRecorder` (`telemetry/highlights.py`)**: Automatically saves compressed 60-second `.npz` clips under `data/highlights/` on earthquake triggers, live Cal home football `2–5 Hz` surges, and live Greek Theatre `25–45 Hz` encores.

### 8. External Events Correlation (`eqengine.external_events`)
- **Plugin Provider Architecture (`base.py`, `schema.py`, `manager.py`, `correlator.py`)**:
  - **`CalFootballProvider` (`providers/cal_football.py`)**: Polls ESPN College Football schedule for Cal Golden Bears home games at California Memorial Stadium (`2–5 Hz` crowd/stomp resonance).
  - **`GreekTheatreProvider` (`providers/greek_theatre.py`)**: Parses `MusicEvent` JSON-LD schedules from `thegreekberkeley.com` with 2-hour pre-show soundcheck detection (`25–45 Hz` acoustic sub-bass coupling).
  - **`BerkeleyWeatherProvider` (`providers/berkeley_weather.py`)**: Polls Open-Meteo current wind speed, gusts, pressure, and precipitation for station coordinates (`0.38–0.85 Hz` tree-canopy sway).
  - **`BartTransitProvider` (`providers/bart_transit.py`)**: Polls live BART ETD arrivals at `DBRK` (Downtown Berkeley) and `ROCK` (Rockridge) to flag trains transiting the Berkeley Hills Tunnel (`4–8 Hz` rail harmonics).
  - **`AircraftProvider` (`providers/aircraft.py`)**: Polls free `airplanes.live` ADS-B airspace around the station to detect low helicopters and aircraft (`10–35 Hz` acoustic Doppler combs) and display a live HUD badge on HD Spectrogram & Urban Profiler.
- Persists cache to `data/external_events_cache.json` and correlates live scheduled/environmental phenomena with live RS4D spectral bands.

### 9. ML Dataset & Annotation Engine (`eqengine.ml.dataset_logger`)
- Captures 4-channel waveform windows (`EHZ`, `ENZ`, `ENN`, `ENE`), computes 11 spectral and 3D polarization features (dominant frequency, spectral centroid, spectral ratio, apparent azimuth, rectilinearity, triaxial PGA, RSAM), saves compressed `.npz` tensors under `data/ml_dataset/snippets/`, and logs JSONL metadata + 1-minute baseline telemetry.

### 10. Standalone Geophysical Observatory Web App (`eqengine.web`)
- **Modular FastAPI Server (`server.py` + `routes/`)**:
  - `routes/telemetry.py`: `GET /api/status`, `/api/events`, `/api/usgs-events`, `/api/buffer/{channel}`, `/api/seismograph/historical`, `/api/helicorder/latest`.
  - `routes/simulation.py`: `POST /api/simulate-trigger`, `/api/simulate-usgs`.
  - `routes/ml.py`: `POST /api/ml/annotate`, `POST /api/ml/annotate_range`, `GET /api/ml/events`, `GET /api/ml/snippet/{event_id}`, `DELETE /api/ml/events/{event_id}`, `GET /api/ml/summary`.
  - `routes/environmental.py`: `GET /api/environmental-intelligence`, `POST /api/environmental/calibrate`, `GET /api/forensics/export.csv`, `GET /api/forensics/trends?days=7`.
  - `routes/external_events.py`: `GET /api/external-events`, `POST /api/external-events/refresh`.
  - `routes/observatory.py`: `GET /api/witness/status`, `POST /api/witness/check`, `GET /api/archive/status`, `GET /api/archive/quake-replay`, `GET /api/highlights`, `GET /api/highlights/{highlight_id}`.
- **High-Speed WebSocket (`/ws/live`)**: Streams contiguous 100 Hz 4-channel samples, STA/LTA ratios, triggers, MMI-enriched alerts, `ml_pick` events, `witness_verdict` events, status snapshots, and USGS events.
- **Frontend SPA (`eqengine.web.static`)**:
  - Shared client utilities (`station.js`, `intensity.js`, `external_events_client.js`) and extracted geo catalogs under `js/data/` (`clusters.js`, `historic_quakes.js`, `faults.js`).
  - Interactive visualizers (`oscilloscope.js`, `spectrogram.js`, `helicorder.js`, `stalta.js`, `hodogram.js`, `radar.js`, `urban.js`, `trends.js`, `highlights.js`, `phasenet.js`, `peterson.js`, `audio.js`, `tables.js`, `review_studio.js`) plus the embedded 13-chapter **Field Manual** (`manual.html`).

---

## Automated Test Coverage

Test suites under `tests/` cover all subsystems:
- `tests/test_alerts.py`: Alert lifecycle, cooldowns, updates, cancellations, severity schema.
- `tests/test_cli.py`: Synthetic MiniSEED replay pipeline verification.
- `tests/test_config.py`: Settings validation, channel parsing, cross-field constraints.
- `tests/test_detector.py`: Recursive STA/LTA detection, thresholding, duration filtering.
- `tests/test_dispatcher.py`: Hook registration, HTTP POST, file logging, isolation.
- `tests/test_environmental_intelligence.py`: NOAA NDBC parser, $2f$ microseism correlation, block kurtosis, Quiet-Window Hunter calibration, CSV persistence.
- `tests/test_external_events.py`: ESPN Cal Football, Greek Theatre JSON-LD, Open-Meteo wind, BART ETD tunnel detection, airplanes.live ADS-B aircraft, external correlation, and cache persistence.
- `tests/test_false_positive.py`: Duration, frequency band, envelope onset, noise-floor SNR checks.
- `tests/test_ingest.py`: UDP Datacast packet parsing and ring-buffer storage.
- `tests/test_intensity.py`: Worden et al. (2012) MMI equations and `MagnitudeEstimator` MMI integration.
- `tests/test_magnitude.py`: $\tau_c$, $P_d$, PGA, empirical magnitude, S-P travel times.
- `tests/test_observatory_features.py`: `BK.BKS` witness verdicts, rolling MiniSEED archive + replay SNR analysis, Shake Highlights capture/playback, and ONNX `MLPicker` mock inference.
- `tests/test_preprocessor.py`: Demeaning, bandpass filtering, displacement integration, Hilbert envelopes.
- `tests/test_ring_buffer.py`: Multi-channel ring buffer concurrency, wrap-around, trace extraction.
- `tests/test_telemetry.py`: RSAM calculations, rolling history, health reporter status snapshots.
- `tests/test_trends.py`: Empirical percentile thresholds, ocean buoy regression, diurnal curves, and blind + tagged event day detection.
- `tests/test_usgs_poller.py`: USGS GeoJSON polling, Haversine distance, severity matrix (20 cells).
- `tests/test_validation.py`: `NoiseModel` serialization, `MLPicker` fallbacks, validation results.
- `tests/test_web.py`: FastAPI REST endpoints (telemetry, environmental, trends, external events, witness, archive, highlights), static JS/data asset delivery, HTML DOM integrity, and `WaveformBroadcaster`.
