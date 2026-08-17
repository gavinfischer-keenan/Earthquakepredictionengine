# EarthquakePredictionEngine Architecture Document

## Overview

**EarthquakePredictionEngine (`eqengine`)** is a low-latency, real-time seismic monitoring and earthquake early warning (EEW) system designed for Raspberry Shake RS4D stations (100 Hz geophone and triaxial accelerometer channels). The system continuously buffers waveform streams, applies digital signal processing, triggers on candidate seismic phase arrivals, filters false positives using physical and statistical checks, estimates earthquake magnitude and distance, fuses local picks with USGS feed data, and dispatches structured alerts to dashboards and notification endpoints.

---

## System Architecture Pipeline

The runtime pipeline consists of five primary sequential processing stages with concurrent telemetry and enrichment sidecars:

```
┌─────────────────┐
│ Ingest Layer    │  (SeedLink Client / UDP Listener)
└────────┬────────┘
         │ Waveform Streams (EHZ, ENZ, ENN, ENE @ 100 Hz)
         ▼
┌─────────────────┐
│ Ring Buffer     │  (Thread-Safe Rolling Waveform Storage)
└────────┬────────┘
         │ Raw Waveform Windows
         ▼
┌─────────────────┐
│ Preprocessing   │  (Demean, Cosine Taper, Bandpass Filter, Displacement Integration)
└────────┬────────┘
         │ Filtered Traces
         ▼
┌─────────────────┐
│ Detection       │  (Recursive STA/LTA Triggering + ML Picker)
└────────┬────────┘
         │ Candidate Trigger Events
         ▼
┌─────────────────┐
│ Validation      │  (Duration, EQ Frequency Band, Envelope Ratio, Noise Floor SNR)
└────────┬────────┘
         │ Verified Seismic Triggers
         ▼
┌─────────────────┐
│ Characterization│  (τ_c Predominant Period, P_d Peak Displacement, S-P Distance)
└────────┬────────┘
         │ Fused Event Parameters
         ▼
┌─────────────────┐
│ Alert Dispatch  │  (Cooldown Manager, HTTP Webhooks, TTS Synthesis, Event Storage)
└─────────────────┘
         ▲
         │ Polling & Correlation
┌─────────────────┐
│ USGS Poller     │  (GeoJSON Feed Polling & Haversine Distance/Severity Matrix)
└─────────────────┘
```

---

## Subsystem Details

### 1. Ingestion Layer (`eqengine.ingest`)
- **`UDPListener`**: Binds to a local UDP socket (default port `8888`) to receive raw Raspberry Shake Datacast packets formatted as `{'CHANNEL', timestamp, s1, s2, ..., s25}`.
- **`SeedLinkClient`**: Connects via TCP to a SeedLink server (default port `18000`) for standard FDSN miniSEED streaming.
- **`RingBuffer`**: Thread-safe circular buffer holding configurable durations (default 120s–600s) of waveform history across channels `EHZ` (geophone), `ENZ`, `ENN`, `ENE` (accelerometers).

### 2. Preprocessing (`eqengine.processing.preprocessor`)
- **Demean & Detrend**: Removes DC bias and baseline drift from raw ADC counts.
- **Cosine Tapering**: Tapers edge samples (default 5%) to eliminate spectral leakage during filtering.
- **Butterworth Bandpass**: 4-pole zero-phase Butterworth filter (typically 1.0–10.0 Hz) targeting P-wave signal-to-noise ratios.
- **Displacement Integration**: Integrates velocity waveforms to displacement using cumulative trapezoidal integration and highpass drift filtering for peak displacement ($P_d$) calculation.
- **Envelope Computation**: Computes analytic signal envelopes via the Hilbert transform.

### 3. Detection Engine (`eqengine.processing.detector`)
- **Recursive STA/LTA**: Stateful recursive Short-Term Average / Long-Term Average algorithm computing characteristic function ratios ($CFT$).
- **Trigger Logic**: Declares trigger ON when $CFT \ge \text{trigger\_on}$ (default 4.0) and trigger OFF when $CFT \le \text{trigger\_off}$ (default 1.5).
- **Duration Gate**: Enforces minimum trigger duration (default 0.5s) to eliminate transient glitches.

### 4. Validation & False-Positive Rejection (`eqengine.validation`)
- **`FalsePositiveFilter`**: Four physics-informed gates:
  1. *Signal Duration*: Rejects micro-spikes shorter than minimum duration.
  2. *Frequency Band*: Welch PSD dominant frequency must lie in earthquake band ($1.0 - 15.0\text{ Hz}$).
  3. *Envelope Onset*: Enforces gradual earthquake onset (first-quarter amplitude < threshold ratio of peak amplitude).
  4. *Noise Floor & SNR*: Waveform RMS must be within physical multiplier of site baseline noise floor.
- **`NoiseModel`**: Site background noise characterization capturing baseline RMS and PSD with JSON save/load persistence.
- **`MLPicker`**: Optional SeisBench PhaseNet/EQTransformer model integration for ML phase classification.

### 5. Magnitude & Distance Estimation (`eqengine.processing.magnitude`)
- **$\tau_c$ (Predominant Period)**: Computed from the initial $3.0\text{ s}$ window after P-wave onset:
  $$\tau_c = 2\pi \sqrt{\frac{\int \dot{u}^2 dt}{\int \ddot{u}^2 dt}}$$
- **$P_d$ (Peak Displacement)**: Maximum absolute amplitude of displacement in the initial P-wave window.
- **Magnitude Empirical Scaling**: Rapid magnitude estimate proxy based on $\log_{10}(\tau_c)$ and $\log_{10}(P_d)$.
- **$S-P$ Distance Estimation**: Calculates hypocentral distance based on crustal velocities ($V_p \approx 6.0\text{ km/s}$, $V_s \approx 3.5\text{ km/s}$).

### 6. Alert Management & Dispatch (`eqengine.alerts`)
- **`AlertManager`**: Single point of truth enforcing alert cooldowns (default 30s) to prevent notification storms, managing active alerts, updates, and cancellations.
- **Severity Matrix**: 5-tier classification (`critical`, `warning`, `advisory`, `info`, `ignore`) combining magnitude and distance.
- **`AlertDispatcher`**: Async HTTP webhook dispatcher and file archiver with custom hook registration.
- **TTS Synthesis**: Generates clear, distance-qualified natural language speech descriptions.

### 7. Telemetry & Monitoring (`eqengine.telemetry`)
- **`RSAMCalculator`**: Real-time Seismic Amplitude Measurement tracking 1-minute RMS amplitudes and 1-hour historical trends.
- **`HealthReporter`**: Emits periodic health status snapshots containing station uptime, buffer fill ratios, trigger counts, and noise floor metrics.

### 8. Standalone Geophysical Observatory Web App (`eqengine.web`)
- **Embedded Web Server**: FastAPI server (`eqengine.web.server`) providing REST endpoints (`/api/status`, `/api/alerts`, `/api/history`, `/api/waveform`, `/api/config`) on configurable port (default `8088`).
- **High-Speed WebSocket (`/ws/live`)**: Broadcasts real-time 100 Hz 4-channel raw and preprocessed waveform chunks, STA/LTA characteristic ratios, and immediate early warning overlays.
- **Observatory UI (`eqengine.web.static`)**: Single-page high-resolution Canvas waveform visualizer with UTC time-axis ticks, dynamic helicorder-style displays, and interactive telemetry dials.

---

## Configuration & Environment

Configuration is managed through `eqengine.config.Settings` (backed by Pydantic and `.env`):
- Station identifiers: `SHAKE_STATION`, `SHAKE_NETWORK`, `SHAKE_IP`
- Ingest settings: `INGEST_MODE`, `UDP_PORT`, `SEEDLINK_PORT`
- Algorithm parameters: `STA_SECONDS`, `LTA_SECONDS`, `TRIGGER_ON`, `TRIGGER_OFF`, `MIN_TRIGGER_DURATION_SEC`
- Filter bands: `BANDPASS_LOW`, `BANDPASS_HIGH`
- Web server: `WEB_ENABLED`, `WEB_HOST`, `WEB_PORT`
- Alerting: `DASHBOARD_URL`, `ALERT_COOLDOWN_SEC`
- USGS polling: `USGS_ENABLED`, `USGS_POLL_INTERVAL_SEC`, `USGS_FEED_URL`

---

## Automated Test Coverage

The test suite covers 100% of pipeline modules under `tests/`:
- `tests/test_detector.py`: Recursive STA/LTA detection, thresholding, noise rejection.
- `tests/test_magnitude.py`: $\tau_c$, $P_d$, empirical magnitude, and S-P travel times.
- `tests/test_false_positive.py`: False positive filters, out-of-band rejection, SNR gating.
- `tests/test_ring_buffer.py`: Multi-channel ring buffer concurrency, wrap-around, trace extraction.
- `tests/test_usgs_poller.py`: USGS GeoJSON polling, Haversine distance, severity matrix, TTS.
- `tests/test_config.py`: Settings validation, channel parsing, cross-field constraints.
- `tests/test_preprocessor.py`: Demeaning, filtering, displacement integration, Hilbert envelopes.
- `tests/test_alerts.py`: Alert lifecycle, cooldowns, updates, cancellations.
- `tests/test_telemetry.py`: RSAM calculations, rolling history, health reporter status.
- `tests/test_validation.py`: NoiseModel serialization, MLPicker fallbacks, validation results.
- `tests/test_ingest.py`: UDP Datacast packet parsing and storage.
- `tests/test_web.py`: FastAPI server status, config, history, waveform endpoints, and WebSocket broadcaster.
