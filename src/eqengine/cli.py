"""Command-line interface, MiniSEED replay, and noise calibration commands."""
from __future__ import annotations

import argparse
import asyncio
import json as _json
from pathlib import Path
from typing import Any

import structlog

from eqengine import __version__
from eqengine.config import get_config
from eqengine.engine import run_engine

log = structlog.get_logger(__name__)


async def _run_replay(mseed_path: str, config: Any) -> int:
    """Replay a MiniSEED file through preprocessing, STA/LTA detection, validation, and alerts."""
    import obspy

    from eqengine.alerts.dispatcher import send_alert
    from eqengine.alerts.manager import AlertManager
    from eqengine.processing.detector import Detector
    from eqengine.processing.preprocessor import preprocess
    from eqengine.telemetry.rsam import RSAMCalculator
    from eqengine.validation.false_positive import FalsePositiveFilter

    log.info("replay.starting", file=mseed_path)
    st = obspy.read(mseed_path)

    fp_filter = FalsePositiveFilter(
        min_trigger_duration_sec=float(getattr(config, "min_trigger_duration_sec", 1.2)),
    )
    alert_manager = AlertManager(cooldown_sec=5.0)
    rsam = RSAMCalculator()
    detector = Detector(
        sta_seconds=float(getattr(config, "sta_seconds", getattr(config, "sta_window", 0.5))),
        lta_seconds=float(getattr(config, "lta_seconds", getattr(config, "lta_window", 20.0))),
        trigger_on=float(getattr(config, "trigger_on", 6.5)),
        trigger_off=float(getattr(config, "trigger_off", 2.0)),
        sampling_rate=float(getattr(config, "sampling_rate", 100.0)),
        min_trigger_duration_sec=float(getattr(config, "min_trigger_duration_sec", 1.2)),
    )

    confirmed = 0
    for trace in st:
        log.info("replay.trace", channel=trace.stats.channel, samples=len(trace.data))
        filtered = preprocess(
            trace,
            bandpass_low=float(getattr(config, "bandpass_low", 1.0)),
            bandpass_high=float(getattr(config, "bandpass_high", 10.0)),
        )
        triggers = detector.detect(filtered)

        for trigger in triggers:
            result = fp_filter.validate(trigger, filtered)
            if result.passed and alert_manager.should_alert():
                alert = alert_manager.create_alert(
                    trigger=trigger,
                    magnitude_est=None,
                    ml_result=None,
                    config=config,
                )
                await send_alert(alert)
                confirmed += 1

        rsam.compute(trace.data)

    log.info(
        "replay.complete",
        traces=len(st),
        confirmed=confirmed,
        rsam_final=round(rsam.get_current_rsam(), 2),
    )
    return confirmed


def _run_calibrate(config: Any) -> None:
    """Compute and save a site NoiseModel from a quiet MiniSEED recording."""
    import obspy

    from eqengine.validation.noise_model import NoiseModel

    log.info("calibrate.starting")
    noise_file = getattr(config, "noise_calibration_file", None)
    if noise_file is None or not Path(noise_file).exists():
        log.error(
            "calibrate.no_input",
            hint="Set NOISE_CALIBRATION_FILE to a quiet MiniSEED path (or use the UI Quiet-Window Hunter).",
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
        help="Compute and save a site noise model from NOISE_CALIBRATION_FILE",
    )
    parser.add_argument(
        "--config",
        action="store_true",
        dest="show_config",
        help="Show the resolved configuration and exit",
    )
    args = parser.parse_args()
    config = get_config()

    if args.show_config:
        print(_json.dumps(config.model_dump(), indent=2, default=str))
        return

    if args.calibrate_noise:
        _run_calibrate(config)
        return

    if args.replay:
        asyncio.run(_run_replay(args.replay, config))
        return

    asyncio.run(run_engine(config))
