"""Main entry point — async engine orchestrator and CLI.

``run_engine`` is the core event loop that wires up every subsystem (ingest,
detection, validation, alerting, telemetry) and pumps data through the
pipeline at 4 Hz (every 0.25 s).

CLI modes
---------
* ``python -m eqengine.main``         — run the live engine
* ``python -m eqengine.main --replay <file.mseed>``  — replay a MiniSEED file
* ``python -m eqengine.main --calibrate-noise``       — compute & save a noise model
* ``python -m eqengine.main --config``                 — dump the resolved config
* ``python -m eqengine.main --version``                — print version and exit
"""
from __future__ import annotations

import argparse
import asyncio
import signal
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import structlog

from eqengine import __version__

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Graceful shutdown helper
# ---------------------------------------------------------------------------
_shutdown_event: asyncio.Event | None = None


def _request_shutdown(signum: int, _frame: Any) -> None:
    """Signal handler — sets the shutdown event."""
    sig_name = signal.Signals(signum).name
    log.info("engine.shutdown_requested", signal=sig_name)
    if _shutdown_event is not None:
        _shutdown_event.set()


# ---------------------------------------------------------------------------
# Core engine loop
# ---------------------------------------------------------------------------
async def run_engine(config: Any) -> None:  # noqa: C901 — intentionally a long orchestrator
    """Main async loop that drives the entire detection pipeline.

    Parameters
    ----------
    config:
        Resolved engine configuration object (duck-typed or Pydantic model).
        Expected attributes: ``station``, ``channels``, ``ingest_mode``,
        ``detection_method``, ``buffer_duration_sec``, ``sta_window``,
        ``lta_window``, ``trigger_on``, ``trigger_off``,
        ``heartbeat_interval_sec``, ``noise_model_path``,
        ``ml_enabled``, ``ml_model_name``, ``ml_p_threshold``,
        ``alert_cooldown_sec``.
    """
    global _shutdown_event  # noqa: PLW0603
    _shutdown_event = asyncio.Event()

    # Install signal handlers (Unix / Windows compatible)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _shutdown_event.set)
        except NotImplementedError:
            # Windows doesn't support add_signal_handler — fall back
            signal.signal(sig, _request_shutdown)

    log.info(
        "engine.starting",
        version=__version__,
        station=getattr(config, "station", "?"),
        mode=getattr(config, "ingest_mode", "udp"),
    )

    # ---------------------------------------------------------------
    # 1–2.  Ring buffer & ingest
    # ---------------------------------------------------------------
    from eqengine.ingest.ring_buffer import RingBuffer
    from eqengine.ingest import create_ingest

    channels: list[str] = list(getattr(config, "shake_channels", getattr(config, "channels", ["EHZ", "ENZ", "ENN", "ENE"])))
    buf_duration = float(getattr(config, "buffer_duration_sec", 300))
    sampling_rate = int(getattr(config, "sampling_rate", 100))
    ring_buffer = RingBuffer(
        channels=channels,
        buffer_duration_sec=int(buf_duration),
        sampling_rate=sampling_rate,
        network=getattr(config, "shake_network", getattr(config, "network", "AM")),
        station=getattr(config, "shake_station", getattr(config, "station", "R1A3D")),
        lta_seconds=int(getattr(config, "lta_seconds", getattr(config, "lta_window", 20))),
    )

    ingest = create_ingest(config, ring_buffer)

    # ---------------------------------------------------------------
    # 3.  Detector, preprocessor, magnitude estimator
    # ---------------------------------------------------------------
    from eqengine.processing.detector import Detector
    from eqengine.processing.preprocessor import preprocess
    from eqengine.processing.magnitude import MagnitudeEstimator

    detector = Detector(
        sta_seconds=float(getattr(config, "sta_seconds", getattr(config, "sta_window", 0.5))),
        lta_seconds=float(getattr(config, "lta_seconds", getattr(config, "lta_window", 20.0))),
        trigger_on=float(getattr(config, "trigger_on", 4.0)),
        trigger_off=float(getattr(config, "trigger_off", 1.5)),
        sampling_rate=float(sampling_rate),
    )

    magnitude_estimator = MagnitudeEstimator(
        p_window_sec=float(getattr(config, "pd_window_sec", 3.0)),
    )

    # ---------------------------------------------------------------
    # 4.  Validation layer
    # ---------------------------------------------------------------
    from eqengine.validation.false_positive import FalsePositiveFilter
    from eqengine.validation.noise_model import NoiseModel

    fp_filter = FalsePositiveFilter()

    noise_model: NoiseModel | None = None
    noise_path = str(getattr(config, "noise_model_path", "./data/noise_model.json"))
    if Path(noise_path).exists():
        try:
            noise_model = NoiseModel.load(noise_path)
        except Exception:
            log.exception("engine.noise_model_load_failed", path=noise_path)

    # ---------------------------------------------------------------
    # 5.  Alert system
    # ---------------------------------------------------------------
    from eqengine.alerts.manager import AlertManager
    from eqengine.alerts.dispatcher import send_alert  # hooks auto-registered

    alert_cooldown = float(getattr(config, "alert_cooldown_sec", 30.0))
    alert_manager = AlertManager(cooldown_sec=alert_cooldown)

    # ---------------------------------------------------------------
    # 6.  ML picker (optional)
    # ---------------------------------------------------------------
    from eqengine.validation.ml_picker import MLPicker

    ml_picker: MLPicker | None = None
    ml_loaded = False
    if getattr(config, "ml_enabled", False):
        ml_picker = MLPicker(
            model_name=str(getattr(config, "ml_model_name", "PhaseNet")),
            p_threshold=float(getattr(config, "ml_p_threshold", 0.3)),
        )
        if ml_picker.is_available():
            try:
                ml_picker.load_model()
                ml_loaded = True
            except Exception:
                log.exception("engine.ml_model_load_failed")
                ml_picker = None
        else:
            log.warning("engine.ml_unavailable", reason="seisbench/torch not installed")
            ml_picker = None

    # ---------------------------------------------------------------
    # 7.  Telemetry
    # ---------------------------------------------------------------
    from eqengine.telemetry.rsam import RSAMCalculator
    from eqengine.telemetry.health import HealthReporter

    rsam = RSAMCalculator()
    health = HealthReporter(
        config=config,
        ring_buffer=ring_buffer,
        detector=detector,
        rsam_calculator=rsam,
        ml_loaded=ml_loaded,
    )

    # ---------------------------------------------------------------
    # 8.  Start ingest & Web Server
    # ---------------------------------------------------------------
    ingest.start()
    log.info("engine.ingest_started", mode=getattr(config, "ingest_mode", "udp"))

    web_server_task = None
    if getattr(config, "web_enabled", True):
        try:
            import uvicorn
            from eqengine.web.server import create_app
            app = create_app(ring_buffer=ring_buffer, detector=detector)
            server_config = uvicorn.Config(
                app=app,
                host=str(getattr(config, "web_host", "0.0.0.0")),
                port=int(getattr(config, "web_port", 8088)),
                log_level="warning",
            )
            server = uvicorn.Server(server_config)
            web_server_task = asyncio.create_task(server.serve())
            log.info("engine.web_server_started", host=config.web_host, port=config.web_port)
        except Exception:
            log.exception("engine.web_server_start_failed")

    # Start USGS External Earthquake Monitor
    usgs_poller = None
    if getattr(config, "usgs_enabled", True):
        try:
            from eqengine.ingest.usgs_poller import USGSPoller
            usgs_poller = USGSPoller(
                station_lat=float(getattr(config, "station_lat", 37.8696)),
                station_lon=float(getattr(config, "station_lon", -122.2491)),
                feed_url=str(getattr(config, "usgs_feed_url", "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson")),
                poll_interval_sec=float(getattr(config, "usgs_poll_interval_sec", 60.0)),
                min_magnitude=float(getattr(config, "usgs_min_magnitude", 1.0)),
            )
            await usgs_poller.start()
            log.info("engine.usgs_poller_started")
        except Exception:
            log.exception("engine.usgs_poller_start_failed")

    # ---------------------------------------------------------------
    # 9.  Main processing loop (4 Hz cadence)
    # ---------------------------------------------------------------
    heartbeat_interval = float(getattr(config, "heartbeat_interval_sec", 60.0))
    last_heartbeat = time.time()
    primary_channel = channels[0] if channels else "EHZ"
    window_sec = float(getattr(config, "lta_window", 30.0))

    from eqengine.web.broadcaster import get_broadcaster
    broadcaster = get_broadcaster()
    broadcaster.set_ring_buffer(ring_buffer)

    log.info("engine.loop_starting", cadence_hz=4, primary_channel=primary_channel)

    try:
        while not _shutdown_event.is_set():
            cycle_start = time.time()

            # a) Buffer readiness
            if not ring_buffer.is_ready(primary_channel):
                await asyncio.sleep(0.25)
                continue

            # b) Stream latest waveform slice to web clients
            if broadcaster.client_count > 0:
                channel_slices: dict[str, Any] = {}
                latest_ts = 0.0
                for ch in channels:
                    t_slice = ring_buffer.get_latest(ch, duration_sec=0.25)
                    if t_slice is not None and len(t_slice.data) > 0:
                        channel_slices[ch] = t_slice.data
                        slice_end = float(t_slice.stats.endtime.timestamp)
                        if slice_end > latest_ts:
                            latest_ts = slice_end
                if channel_slices:
                    await broadcaster.broadcast_waveform(
                        timestamp=latest_ts if latest_ts > 0.0 else time.time(),
                        channel_data=channel_slices,
                        sta_lta_ratios={"EHZ": detector.get_current_ratio()},
                    )

            # c) Get latest analysis window
            import obspy

            trace = ring_buffer.get_latest(primary_channel, duration_sec=window_sec)
            if trace is None or len(trace.data) < 10:
                await asyncio.sleep(0.25)
                continue

            # d) Preprocess
            try:
                trace = preprocess(
                    trace,
                    bandpass_low=float(getattr(config, "bandpass_low", 1.0)),
                    bandpass_high=float(getattr(config, "bandpass_high", 10.0)),
                )
            except Exception:
                log.exception("engine.preprocess_failed")

            # e) Run detector
            triggers = detector.detect(trace)

            # f) Process each trigger
            for trigger in triggers:
                try:
                    # False-positive filter validation (spectral ratio, noise floor, duration)
                    result = fp_filter.validate(trigger, trace, noise_model)
                    if not result.passed:
                        log.debug(
                            "engine.trigger_rejected",
                            reason=result.rejection_reason,
                            checks=result.checks,
                        )
                        continue

                    health.record_trigger()

                    # Broadcast confirmed trigger symbology to connected browsers
                    await broadcaster.broadcast_trigger({
                        "channel": trigger.channel,
                        "start_time": float(trigger.start_time.timestamp),
                        "end_time": float(trigger.end_time.timestamp) if trigger.end_time else None,
                        "peak_sta_lta": trigger.peak_sta_lta,
                        "sta_lta_ratio": trigger.sta_lta_ratio,
                        "start_sample": trigger.start_sample,
                        "end_sample": trigger.end_sample,
                    })

                    # Magnitude estimation
                    mag_est: float | None = None
                    if magnitude_estimator is not None:
                        try:
                            accel_traces_dict: dict[str, obspy.Trace] = {}
                            for ch in ("ENZ", "ENN", "ENE"):
                                if ch in channels:
                                    t = ring_buffer.get_latest(ch, duration_sec=window_sec)
                                    if t is not None:
                                        accel_traces_dict[ch] = t
                            est_res = magnitude_estimator.estimate(
                                trace,
                                accel_traces=accel_traces_dict or None,
                                p_arrival=trigger.start_time,
                                window_sec=float(getattr(config, "pd_window_sec", 3.0)),
                            )
                            mag_est = est_res.magnitude if est_res else None
                        except Exception:
                            log.exception("engine.magnitude_estimation_failed")

                    # ML validation
                    ml_result = None
                    if ml_picker is not None:
                        try:
                            stream = obspy.Stream([trace])
                            ml_result = ml_picker.validate_p_wave(
                                stream,
                                obspy.UTCDateTime(trigger.on_time),
                            )
                        except Exception:
                            log.exception("engine.ml_validation_failed")

                    # Cooldown check
                    if not alert_manager.should_alert():
                        log.debug("engine.alert_cooldown_active")
                        continue

                    # Create & dispatch alert
                    alert = alert_manager.create_alert(
                        trigger=trigger,
                        magnitude_est=mag_est,
                        ml_result=ml_result,
                        config=config,
                    )
                    health.record_confirmed()
                    await send_alert(alert)
                    log.info(
                        "engine.alert_dispatched",
                        alert_id=alert.alert_id,
                        severity=alert.severity,
                        magnitude=alert.estimated_magnitude,
                    )
                except Exception:
                    log.exception("engine.trigger_processing_failed")

            # g) Periodic RSAM & heartbeat
            now = time.time()
            if now - last_heartbeat >= heartbeat_interval:
                rsam.compute(trace.data)
                await health.report()

                # Log continuous 1-minute ML baseline telemetry
                try:
                    from eqengine.ml.dataset_logger import get_dataset_logger, compute_spectral_features
                    spec = compute_spectral_features(trace.data, sampling_rate=float(config.sampling_rate))
                    await get_dataset_logger().log_1min_telemetry(
                        timestamp=now,
                        rsam=getattr(rsam, "current_rsam", 0.0),
                        noise_floor=getattr(health, "noise_floor", 0.0),
                        pga_resultant=0.0,
                        spectral_centroid=spec.get("spectral_centroid_hz", 0.0),
                    )
                except Exception:
                    pass

                last_heartbeat = now

            # Pace the loop
            elapsed = time.time() - cycle_start
            sleep_time = max(0.0, 0.25 - elapsed)
            await asyncio.sleep(sleep_time)

    except asyncio.CancelledError:
        log.info("engine.loop_cancelled")
    finally:
        # ---------------------------------------------------------------
        # 10. Graceful shutdown
        # ---------------------------------------------------------------
        log.info("engine.shutting_down")
        if web_server_task and not web_server_task.done():
            web_server_task.cancel()
            try:
                await web_server_task
            except asyncio.CancelledError:
                pass

        if usgs_poller:
            try:
                await usgs_poller.stop()
            except Exception:
                pass

        try:
            ingest.stop()
        except Exception:
            log.exception("engine.ingest_stop_failed")

        # Final health report
        try:
            await health.report()
        except Exception:
            log.exception("engine.final_health_report_failed")

        log.info("engine.stopped")


# ---------------------------------------------------------------------------
# Replay mode
# ---------------------------------------------------------------------------
async def _run_replay(mseed_path: str, config: Any) -> None:
    """Replay a MiniSEED file through the detection pipeline.

    This is a simplified version of the live loop — reads the entire file
    and processes it in sliding windows.
    """
    import obspy

    from eqengine.validation.false_positive import FalsePositiveFilter
    from eqengine.alerts.manager import AlertManager
    from eqengine.alerts.dispatcher import send_alert
    from eqengine.telemetry.rsam import RSAMCalculator

    log.info("replay.starting", file=mseed_path)
    st = obspy.read(mseed_path)

    fp_filter = FalsePositiveFilter()
    alert_manager = AlertManager(cooldown_sec=5.0)  # shorter for replay
    rsam = RSAMCalculator()

    try:
        from eqengine.detection import Detector  # type: ignore[import-untyped]
    except ImportError:
        log.error("replay.missing_detector_module")
        return

    detector = Detector(
        sta_window=float(getattr(config, "sta_window", 1.0)),
        lta_window=float(getattr(config, "lta_window", 30.0)),
        trigger_on=float(getattr(config, "trigger_on", 3.5)),
        trigger_off=float(getattr(config, "trigger_off", 1.5)),
    )

    for trace in st:
        log.info("replay.trace", channel=trace.stats.channel, samples=len(trace.data))
        triggers = detector.detect(trace)

        for trigger in triggers:
            result = fp_filter.validate(trigger, trace)
            if result.passed and alert_manager.should_alert():
                alert = alert_manager.create_alert(
                    trigger=trigger, magnitude_est=None, ml_result=None, config=config,
                )
                await send_alert(alert)

        rsam.compute(trace.data)

    log.info(
        "replay.complete",
        traces=len(st),
        rsam_final=round(rsam.get_current_rsam(), 2),
    )


# ---------------------------------------------------------------------------
# Noise calibration
# ---------------------------------------------------------------------------
def _run_calibrate(config: Any) -> None:
    """Record background noise and save a site noise model."""
    import obspy

    from eqengine.validation.noise_model import NoiseModel

    log.info("calibrate.starting")

    # In a real deployment this would record live data.  For now, we read
    # a pre-recorded quiet-period file.
    noise_file = getattr(config, "noise_calibration_file", None)
    if noise_file is None or not Path(noise_file).exists():
        log.error(
            "calibrate.no_input",
            hint="Set config.noise_calibration_file to a MiniSEED path",
        )
        return

    st = obspy.read(str(noise_file))
    if not st:
        log.error("calibrate.empty_stream")
        return

    model = NoiseModel.from_trace(st[0])
    out_path = str(getattr(config, "noise_model_path", "./data/noise_model.json"))
    model.save(out_path)
    log.info("calibrate.complete", path=out_path, rms=round(model.baseline_rms, 4))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def cli() -> None:
    """Command-line interface for the EarthquakePredictionEngine."""
    parser = argparse.ArgumentParser(
        prog="eqengine",
        description="EarthquakePredictionEngine — real-time seismic detection",
    )
    parser.add_argument(
        "--version", action="version", version=f"%(prog)s {__version__}",
    )
    parser.add_argument(
        "--replay",
        metavar="MSEED_FILE",
        help="Replay a MiniSEED file instead of live ingest",
    )
    parser.add_argument(
        "--calibrate-noise",
        action="store_true",
        help="Compute and save a site noise model",
    )
    parser.add_argument(
        "--config",
        action="store_true",
        dest="show_config",
        help="Show the resolved configuration and exit",
    )
    args = parser.parse_args()

    # Attempt to load config — fall back to a simple namespace stub
    config: Any
    try:
        from eqengine.config import get_config
        config = get_config()
    except ImportError:
        log.warning("engine.config_module_missing, using defaults")
        config = _default_config()

    # --config
    if args.show_config:
        import json as _json
        if hasattr(config, "model_dump"):
            print(_json.dumps(config.model_dump(), indent=2, default=str))
        else:
            print(vars(config))
        return

    # --calibrate-noise
    if args.calibrate_noise:
        _run_calibrate(config)
        return

    # --replay
    if args.replay:
        asyncio.run(_run_replay(args.replay, config))
        return

    # Default — live engine
    asyncio.run(run_engine(config))


# ---------------------------------------------------------------------------
# Fallback config
# ---------------------------------------------------------------------------
class _DefaultConfig:
    """Bare-minimum config namespace so the engine can start without a
    dedicated config module."""

    station: str = "RS4D"
    channels: list[str] = ["EHZ", "ENZ", "ENN", "ENE"]
    sampling_rate: float = 100.0
    ingest_mode: str = "udp"
    detection_method: str = "classic_sta_lta"
    buffer_duration_sec: float = 300.0
    sta_window: float = 1.0
    lta_window: float = 30.0
    trigger_on: float = 3.5
    trigger_off: float = 1.5
    heartbeat_interval_sec: float = 60.0
    noise_model_path: str = "./data/noise_model.json"
    noise_calibration_file: str | None = None
    ml_enabled: bool = False
    ml_model_name: str = "PhaseNet"
    ml_p_threshold: float = 0.3
    alert_cooldown_sec: float = 30.0


def _default_config() -> _DefaultConfig:
    return _DefaultConfig()


# ---------------------------------------------------------------------------
# Script entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    cli()
