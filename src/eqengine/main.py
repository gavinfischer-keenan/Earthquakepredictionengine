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
    # 1–2.  Ring buffer & ingest  (import lazily to avoid hard deps
    #        during testing if those modules aren't created yet)
    # ---------------------------------------------------------------
    try:
        from eqengine.buffer import RingBuffer  # type: ignore[import-untyped]
    except ImportError:
        log.error("engine.missing_module", module="eqengine.buffer")
        raise SystemExit(1)

    channels: list[str] = list(getattr(config, "channels", ["EHZ"]))
    buf_duration = float(getattr(config, "buffer_duration_sec", 300))
    sampling_rate = float(getattr(config, "sampling_rate", 100.0))
    ring_buffer = RingBuffer(
        channels=channels,
        duration_sec=buf_duration,
        sampling_rate=sampling_rate,
    )

    try:
        from eqengine.ingest import create_ingest  # type: ignore[import-untyped]
    except ImportError:
        log.error("engine.missing_module", module="eqengine.ingest")
        raise SystemExit(1)

    ingest = create_ingest(config, ring_buffer)

    # ---------------------------------------------------------------
    # 3.  Detector, preprocessor, magnitude estimator
    # ---------------------------------------------------------------
    try:
        from eqengine.detection import Detector  # type: ignore[import-untyped]
    except ImportError:
        log.error("engine.missing_module", module="eqengine.detection")
        raise SystemExit(1)

    detector = Detector(
        sta_window=float(getattr(config, "sta_window", 1.0)),
        lta_window=float(getattr(config, "lta_window", 30.0)),
        trigger_on=float(getattr(config, "trigger_on", 3.5)),
        trigger_off=float(getattr(config, "trigger_off", 1.5)),
        method=str(getattr(config, "detection_method", "classic_sta_lta")),
    )

    preprocessor: Any = None
    try:
        from eqengine.processing import Preprocessor  # type: ignore[import-untyped]
        preprocessor = Preprocessor()
    except ImportError:
        log.warning("engine.preprocessor_unavailable")

    magnitude_estimator: Any = None
    try:
        from eqengine.magnitude import MagnitudeEstimator  # type: ignore[import-untyped]
        magnitude_estimator = MagnitudeEstimator()
    except ImportError:
        log.warning("engine.magnitude_estimator_unavailable")

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
    # 8.  Start ingest
    # ---------------------------------------------------------------
    ingest.start()
    log.info("engine.ingest_started", mode=getattr(config, "ingest_mode", "udp"))

    # ---------------------------------------------------------------
    # 9.  Main processing loop (4 Hz cadence)
    # ---------------------------------------------------------------
    heartbeat_interval = float(getattr(config, "heartbeat_interval_sec", 60.0))
    last_heartbeat = time.time()
    primary_channel = channels[0] if channels else "EHZ"
    window_sec = float(getattr(config, "lta_window", 30.0))

    log.info("engine.loop_starting", cadence_hz=4, primary_channel=primary_channel)

    try:
        while not _shutdown_event.is_set():
            cycle_start = time.time()

            # a) Buffer readiness
            if not ring_buffer.is_ready(primary_channel):
                await asyncio.sleep(0.25)
                continue

            # b) Get latest window
            import obspy

            trace = ring_buffer.get_latest(primary_channel, duration_sec=window_sec)
            if trace is None or len(trace.data) < 10:
                await asyncio.sleep(0.25)
                continue

            # c) Preprocess
            if preprocessor is not None:
                trace = preprocessor.process(trace)

            # d) Run detector
            triggers = detector.detect(trace)

            # e) Process each trigger
            for trigger in triggers:
                health.record_trigger()

                # False-positive filter
                result = fp_filter.validate(trigger, trace, noise_model)
                if not result.passed:
                    log.info(
                        "engine.trigger_rejected",
                        reason=result.rejection_reason,
                        checks=result.checks,
                    )
                    continue

                # Magnitude estimation
                mag_est: float | None = None
                if magnitude_estimator is not None:
                    try:
                        # Try to get accelerometer traces for better estimate
                        accel_traces: list[obspy.Trace] = []
                        for ch in ("ENZ", "ENN", "ENE"):
                            if ch in channels:
                                t = ring_buffer.get_latest(ch, duration_sec=window_sec)
                                if t is not None:
                                    accel_traces.append(t)
                        mag_est = magnitude_estimator.estimate(
                            trace, accel_traces=accel_traces or None,
                        )
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

            # f) Heartbeat: RSAM + health status
            now = time.time()
            if (now - last_heartbeat) >= heartbeat_interval:
                # RSAM on 1-minute of the primary channel
                rsam_trace = ring_buffer.get_latest(primary_channel, duration_sec=60.0)
                if rsam_trace is not None and len(rsam_trace.data) > 0:
                    rsam.compute(rsam_trace.data)

                await health.report()
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
        from eqengine.config import load_config  # type: ignore[import-untyped]
        config = load_config()
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
