"""Async SeismicEngine orchestrator — wires ingest, DSP, validation, fusion, and web."""
from __future__ import annotations

import asyncio
import contextlib
import signal
import time
from pathlib import Path
from typing import Any

import numpy as np
import obspy
import structlog

from eqengine import __version__
from eqengine.alerts.dispatcher import send_alert
from eqengine.alerts.manager import AlertManager
from eqengine.constants import COUNTS_TO_ACCEL
from eqengine.ingest import create_ingest
from eqengine.ingest.archive import get_archiver
from eqengine.ingest.ring_buffer import RingBuffer
from eqengine.ml.dataset_logger import compute_spectral_features, get_dataset_logger
from eqengine.processing.detector import Detector
from eqengine.processing.magnitude import MagnitudeEstimator
from eqengine.processing.preprocessor import preprocess
from eqengine.telemetry.environmental_intelligence import get_environmental_engine
from eqengine.telemetry.health import HealthReporter
from eqengine.telemetry.highlights import get_highlights_recorder
from eqengine.telemetry.rsam import RSAMCalculator
from eqengine.validation.false_positive import FalsePositiveFilter
from eqengine.validation.ml_picker import MLPicker
from eqengine.validation.noise_model import NoiseModel
from eqengine.validation.witness import get_witness
from eqengine.web.broadcaster import get_broadcaster

log = structlog.get_logger(__name__)

_shutdown_event: asyncio.Event | None = None


def _request_shutdown(signum: int, _frame: Any) -> None:
    """Signal handler — sets the shutdown event."""
    sig_name = signal.Signals(signum).name
    log.info("engine.shutdown_requested", signal=sig_name)
    if _shutdown_event is not None:
        _shutdown_event.set()


def _install_signal_handlers(shutdown_event: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, shutdown_event.set)
        except NotImplementedError:
            signal.signal(sig, _request_shutdown)


class SeismicEngine:
    """Coordinates real-time ingestion, DSP detection, validation, fusion, and telemetry."""

    def __init__(self, config: Any) -> None:
        self.config = config
        self.channels: list[str] = list(
            getattr(config, "shake_channels", getattr(config, "channels", ["EHZ", "ENZ", "ENN", "ENE"]))
        )
        self.primary_channel: str = self.channels[0] if self.channels else "EHZ"
        self.sampling_rate: int = int(getattr(config, "sampling_rate", 100))

        self.ring_buffer = RingBuffer(
            channels=self.channels,
            buffer_duration_sec=int(float(getattr(config, "buffer_duration_sec", 120))),
            sampling_rate=self.sampling_rate,
            network=getattr(config, "shake_network", getattr(config, "network", "AM")),
            station=getattr(config, "shake_station", getattr(config, "station", "R1A3D")),
            lta_seconds=int(getattr(config, "lta_seconds", getattr(config, "lta_window", 20))),
        )
        self.ingest = create_ingest(config, self.ring_buffer)
        self.detector = Detector(
            sta_seconds=float(getattr(config, "sta_seconds", getattr(config, "sta_window", 0.5))),
            lta_seconds=float(getattr(config, "lta_seconds", getattr(config, "lta_window", 20.0))),
            trigger_on=float(getattr(config, "trigger_on", 6.5)),
            trigger_off=float(getattr(config, "trigger_off", 2.0)),
            sampling_rate=float(self.sampling_rate),
            min_trigger_duration_sec=float(getattr(config, "min_trigger_duration_sec", 1.2)),
        )
        self.magnitude_estimator = MagnitudeEstimator()
        self.fp_filter = FalsePositiveFilter(
            min_trigger_duration_sec=float(getattr(config, "min_trigger_duration_sec", 1.2)),
        )
        self.noise_model: NoiseModel | None = self._load_noise_model()
        self.alert_manager = AlertManager(cooldown_sec=float(getattr(config, "alert_cooldown_sec", 30.0)))
        self.ml_picker, ml_loaded = self._init_ml_picker()
        self.rsam = RSAMCalculator()
        self.health = HealthReporter(
            config=config,
            ring_buffer=self.ring_buffer,
            detector=self.detector,
            rsam_calculator=self.rsam,
            ml_loaded=ml_loaded,
        )
        self.broadcaster = get_broadcaster()
        self.broadcaster.set_ring_buffer(self.ring_buffer)

        self.witness = get_witness(config) if getattr(config, "witness_enabled", True) else None
        self.archiver = get_archiver(config) if getattr(config, "archive_enabled", True) else None
        self.highlights = get_highlights_recorder(config) if getattr(config, "highlights_enabled", True) else None

        self.usgs_poller: Any | None = None
        self.env_engine: Any | None = None
        self.external_events: Any | None = None
        self.web_server_task: asyncio.Task[None] | None = None

        self._last_emitted_trigger_onsets: dict[str, float] = {}
        self._last_streamed_counts: dict[str, int] = {}

    def _load_noise_model(self) -> NoiseModel | None:
        noise_path = str(getattr(self.config, "noise_model_path", "./data/noise_model.json"))
        if Path(noise_path).exists():
            try:
                return NoiseModel.load(noise_path)
            except Exception:
                log.exception("engine.noise_model_load_failed", path=noise_path)
        return None

    def _init_ml_picker(self) -> tuple[MLPicker | None, bool]:
        if not getattr(self.config, "ml_enabled", False):
            return None, False
        model_name = str(getattr(self.config, "ml_model", getattr(self.config, "ml_model_name", "PhaseNet")))
        picker = MLPicker(
            model_name=model_name,
            p_threshold=float(getattr(self.config, "ml_p_threshold", 0.3)),
            backend=str(getattr(self.config, "ml_backend", "auto")),
            onnx_model_path=str(getattr(self.config, "ml_onnx_model_path", "")),
        )
        if not picker.is_available():
            log.warning("engine.ml_unavailable", reason="neither onnxruntime model nor seisbench/torch available")
            return None, False
        try:
            picker.load_model()
            return picker, True
        except Exception:
            log.exception("engine.ml_model_load_failed")
            return None, False

    async def start_subsystems(self) -> None:
        """Start background pollers, environmental engine, ingest, and web server."""
        if getattr(self.config, "usgs_enabled", True):
            try:
                from eqengine.ingest.usgs_poller import USGSPoller

                self.usgs_poller = USGSPoller(
                    station_lat=float(getattr(self.config, "station_lat", 37.8696)),
                    station_lon=float(getattr(self.config, "station_lon", -122.2491)),
                    feed_url=str(
                        getattr(
                            self.config,
                            "usgs_feed_url",
                            "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson",
                        )
                    ),
                    poll_interval_sec=float(getattr(self.config, "usgs_poll_interval_sec", 60.0)),
                    min_magnitude=float(getattr(self.config, "usgs_min_magnitude", 0.5)),
                )
                await self.usgs_poller.start()
                log.info("engine.usgs_poller_started")
            except Exception:
                log.exception("engine.usgs_poller_start_failed")

        if getattr(self.config, "external_events_enabled", True):
            try:
                from eqengine.external_events.manager import get_external_events_manager

                self.external_events = get_external_events_manager(self.config)
                await self.external_events.start()
                log.info("engine.external_events_started")
            except Exception:
                log.exception("engine.external_events_start_failed")

        try:
            self.env_engine = get_environmental_engine()
            await self.env_engine.start()
            log.info("engine.environmental_intelligence_started")
        except Exception:
            log.exception("engine.environmental_intelligence_start_failed")

        self.ingest.start()
        log.info("engine.ingest_started", mode=getattr(self.config, "ingest_mode", "seedlink"))

        if getattr(self.config, "web_enabled", True):
            try:
                import uvicorn

                from eqengine.web.server import create_app

                app = create_app(
                    ring_buffer=self.ring_buffer,
                    detector=self.detector,
                    usgs_poller=self.usgs_poller,
                    external_events_manager=self.external_events,
                    ml_picker=self.ml_picker,
                    witness=self.witness,
                    archiver=self.archiver,
                    highlights=self.highlights,
                )
                server_config = uvicorn.Config(
                    app=app,
                    host=str(getattr(self.config, "web_host", "0.0.0.0")),
                    port=int(getattr(self.config, "web_port", 8088)),
                    log_level="warning",
                )
                server = uvicorn.Server(server_config)
                self.web_server_task = asyncio.create_task(server.serve())
                log.info("engine.web_server_started", host=self.config.web_host, port=self.config.web_port)
            except Exception:
                log.exception("engine.web_server_start_failed")

    async def stream_waveforms_to_clients(self) -> None:
        """Broadcast newly arrived contiguous samples to connected WebSocket browsers."""
        if self.broadcaster.client_count <= 0:
            for ch in self.channels:
                self._last_streamed_counts[ch] = self.ring_buffer._ring(ch).total_written
            return

        channel_slices: dict[str, Any] = {}
        latest_ts = 0.0
        for ch in self.channels:
            last_c = self._last_streamed_counts.get(ch, self.ring_buffer._ring(ch).total_written)
            samples, start_ts, new_c = self.ring_buffer.get_samples_since(ch, last_c)
            self._last_streamed_counts[ch] = new_c
            if len(samples) > 0:
                channel_slices[ch] = samples
                sample_end = start_ts + (len(samples) - 1) / self.ring_buffer.sampling_rate
                latest_ts = max(latest_ts, sample_end)

        if channel_slices:
            await self.broadcaster.broadcast_waveform(
                timestamp=latest_ts if latest_ts > 0.0 else time.time(),
                channel_data=channel_slices,
                sta_lta_ratios={self.primary_channel: self.detector.get_current_ratio()},
            )

    async def process_triggers(self, trace: obspy.Trace, window_sec: float) -> None:
        """Validate STA/LTA triggers, estimate magnitude, fuse with USGS, and dispatch alerts."""
        triggers = self.detector.detect(trace)
        for trigger in triggers:
            try:
                on_t = float(trigger.start_time.timestamp)
                ch = trigger.channel
                if abs(on_t - self._last_emitted_trigger_onsets.get(ch, 0.0)) < 15.0:
                    continue
                self._last_emitted_trigger_onsets[ch] = on_t

                result = self.fp_filter.validate(trigger, trace, self.noise_model)
                if not result.passed:
                    log.debug(
                        "engine.trigger_rejected",
                        reason=result.rejection_reason,
                        checks=result.checks,
                    )
                    continue

                self.health.record_trigger()
                await self.broadcaster.broadcast_trigger(
                    {
                        "channel": trigger.channel,
                        "start_time": float(trigger.start_time.timestamp),
                        "end_time": float(trigger.end_time.timestamp) if trigger.end_time else None,
                        "peak_sta_lta": trigger.peak_sta_lta,
                        "sta_lta_ratio": trigger.sta_lta_ratio,
                        "start_sample": trigger.start_sample,
                        "end_sample": trigger.end_sample,
                    }
                )

                accel_traces_dict: dict[str, obspy.Trace] = {}
                for acc_ch in ("ENZ", "ENN", "ENE"):
                    if acc_ch in self.channels:
                        t = self.ring_buffer.get_latest(acc_ch, duration_sec=window_sec)
                        if t is not None and len(t.data) > 0:
                            accel_traces_dict[acc_ch] = t

                est_res = self.magnitude_estimator.estimate(
                    trace,
                    accel_traces=accel_traces_dict or None,
                    p_arrival=trigger.start_time,
                    window_sec=float(getattr(self.config, "pd_window_sec", 3.0)),
                )
                mag_est = est_res.magnitude if est_res else None

                ml_result = None
                if self.ml_picker is not None:
                    try:
                        ml_traces = [trace]
                        for acc_ch in ("ENN", "ENE"):
                            if acc_ch in accel_traces_dict:
                                ml_traces.append(accel_traces_dict[acc_ch])
                        ml_result = self.ml_picker.validate_p_wave(
                            obspy.Stream(ml_traces),
                            obspy.UTCDateTime(trigger.on_time),
                        )
                        await self.broadcaster.broadcast_ml_pick(
                            {
                                "backend": self.ml_picker.active_backend,
                                "label": self.ml_picker.picker_label,
                                "is_earthquake": bool(ml_result.is_earthquake),
                                "p_probability": ml_result.p_probability,
                                "s_probability": ml_result.s_probability,
                                "p_time": str(ml_result.p_time) if ml_result.p_time else None,
                                "s_time": str(ml_result.s_time) if ml_result.s_time else None,
                                "trigger_time": on_t,
                            }
                        )
                    except Exception:
                        log.exception("engine.ml_validation_failed")

                if not self.alert_manager.should_alert():
                    log.debug("engine.alert_cooldown_active")
                    continue

                usgs_match = (
                    self.usgs_poller.correlate_with_trigger(on_t)
                    if self.usgs_poller is not None
                    else None
                )
                dist_km = (
                    est_res.estimated_distance_km
                    if est_res and est_res.estimated_distance_km is not None
                    else (usgs_match.get("distance_km") if usgs_match else None)
                )

                alert = self.alert_manager.create_alert(
                    trigger=trigger,
                    magnitude_est=mag_est,
                    ml_result=ml_result,
                    config=self.config,
                    distance_km=dist_km,
                    usgs_event=usgs_match,
                    data_source="fused" if usgs_match else "rs4d",
                )
                if est_res is not None:
                    alert = alert.model_copy(
                        update={
                            "peak_ground_acceleration": est_res.pga,
                            "peak_ground_velocity": est_res.pgv,
                            "peak_displacement_m": est_res.pd,
                            "predominant_period_s": est_res.tau_c,
                            "estimated_s_arrival": est_res.estimated_s_arrival,
                            "seconds_until_s_wave": est_res.seconds_until_s_wave,
                            "mmi": est_res.mmi,
                            "mmi_roman": est_res.mmi_roman,
                            "mmi_label": est_res.mmi_label,
                            "mmi_color": est_res.mmi_color,
                        }
                    )
                self.health.record_confirmed()
                await send_alert(alert)
                log.info(
                    "engine.alert_dispatched",
                    alert_id=alert.alert_id,
                    severity=alert.severity,
                    magnitude=alert.estimated_magnitude,
                    mmi=alert.mmi_roman,
                    data_source=alert.data_source,
                )
                if self.witness is not None:
                    asyncio.create_task(self._run_witness_check(on_t, alert, est_res, dist_km))
                elif self.highlights is not None:
                    self._capture_quake_highlight(alert, est_res, dist_km, witness_verdict=None)
            except Exception:
                log.exception("engine.trigger_processing_failed")

    async def run_heartbeat(self, trace: obspy.Trace, now: float) -> None:
        """Compute RSAM, report health, log ML baseline, and run environmental 1-min tick."""
        self.rsam.compute(trace.data)
        await self.health.report()

        try:
            spec = compute_spectral_features(trace.data, sampling_rate=float(self.sampling_rate))
            pga_comps: list[np.ndarray] = []
            for acc_ch in ("ENZ", "ENN", "ENE"):
                if acc_ch in self.channels:
                    acc_tr = self.ring_buffer.get_latest(acc_ch, duration_sec=60.0)
                    if acc_tr is not None and len(acc_tr.data) > 0:
                        centered = acc_tr.data.astype(np.float64) - float(np.mean(acc_tr.data))
                        pga_comps.append(centered * COUNTS_TO_ACCEL)
            if len(pga_comps) == 3:
                n_min = min(len(arr) for arr in pga_comps)
                pga_res = float(
                    np.max(
                        np.sqrt(
                            pga_comps[0][:n_min] ** 2
                            + pga_comps[1][:n_min] ** 2
                            + pga_comps[2][:n_min] ** 2
                        )
                    )
                )
            elif pga_comps:
                pga_res = float(max(np.max(np.abs(arr)) for arr in pga_comps))
            else:
                pga_res = 0.0

            await get_dataset_logger().log_1min_telemetry(
                timestamp=now,
                rsam=self.rsam.get_current_rsam(),
                noise_floor=self.rsam.mean_rsam,
                pga_resultant=pga_res,
                spectral_centroid=spec.get("spectral_centroid_hz", 0.0),
            )
        except (OSError, ValueError):
            log.debug("engine.ml_1min_telemetry_failed")

        if self.archiver is not None:
            try:
                self.archiver.flush_from_ring_buffer(self.ring_buffer, duration_sec=65.0)
            except Exception:
                log.exception("engine.archive_flush_failed")

        if self.env_engine is not None:
            try:
                prev_cal_count = self.env_engine.calibration_count
                await self.env_engine.process_1min_tick(
                    ring_buffer=self.ring_buffer,
                    detector=self.detector,
                    external_events_manager=self.external_events,
                )
                if self.env_engine.calibration_count > prev_cal_count and self.env_engine.noise_model_path.exists():
                    self.noise_model = NoiseModel.load(str(self.env_engine.noise_model_path))
                if self.highlights is not None:
                    quiet_bl = (
                        float(self.noise_model.median_rms)
                        if self.noise_model is not None and getattr(self.noise_model, "median_rms", 0) > 0
                        else None
                    )
                    self.highlights.evaluate_external_tick(
                        ring_buffer=self.ring_buffer,
                        forensics_metrics=self.env_engine.latest_metrics,
                        external_events_manager=self.external_events,
                        quiet_baseline=quiet_bl,
                    )
            except Exception:
                log.exception("engine.environmental_tick_failed")

    async def _run_witness_check(
        self,
        trigger_time: float,
        alert: Any,
        est_res: Any,
        dist_km: float | None,
    ) -> None:
        """Asynchronously cross-check a trigger against the reference witness station."""
        if self.witness is None:
            return
        try:
            verdict = await self.witness.verify_trigger(trigger_time)
            payload = verdict.model_dump()
            await self.broadcaster.broadcast_witness_verdict(payload)
            if self.highlights is not None and (verdict.verdict == "CONFIRMED_TECTONIC" or alert.usgs_event_id):
                self._capture_quake_highlight(
                    alert,
                    est_res,
                    dist_km,
                    witness_verdict=verdict.verdict,
                )
        except Exception:
            log.exception("engine.witness_check_failed")

    def _capture_quake_highlight(
        self,
        alert: Any,
        est_res: Any,
        dist_km: float | None,
        witness_verdict: str | None = None,
    ) -> None:
        """Capture a 60s highlight clip when an earthquake trigger occurs."""
        if self.highlights is None:
            return
        try:
            title = f"M{alert.estimated_magnitude:.1f} Seismic Event" if alert.estimated_magnitude else "Seismic Event"
            if alert.usgs_event_id:
                title = f"{title} ({alert.usgs_event_id})"
            self.highlights.capture_earthquake(
                ring_buffer=self.ring_buffer,
                title=title,
                magnitude=alert.estimated_magnitude,
                distance_km=dist_km,
                mmi_label=est_res.mmi_label if est_res else None,
                mmi_roman=est_res.mmi_roman if est_res else None,
                witness_verdict=witness_verdict,
            )
        except Exception:
            log.exception("engine.highlight_capture_failed")

    async def shutdown(self) -> None:
        """Gracefully tear down web server, background pollers, and ingest."""
        log.info("engine.shutting_down")
        if self.web_server_task and not self.web_server_task.done():
            self.web_server_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.web_server_task

        for svc in (self.env_engine, self.external_events, self.usgs_poller):
            if svc is not None:
                with contextlib.suppress(Exception):
                    await svc.stop()

        try:
            self.ingest.stop()
        except Exception:
            log.exception("engine.ingest_stop_failed")

        try:
            await self.health.report()
        except Exception:
            log.exception("engine.final_health_report_failed")

        log.info("engine.stopped")


async def run_engine(config: Any) -> None:
    """Main async loop driving the detection and observatory pipeline at 4 Hz."""
    global _shutdown_event
    _shutdown_event = asyncio.Event()
    _install_signal_handlers(_shutdown_event)

    log.info(
        "engine.starting",
        version=__version__,
        station=getattr(config, "shake_station", getattr(config, "station", "?")),
        mode=getattr(config, "ingest_mode", "seedlink"),
    )

    engine = SeismicEngine(config)
    await engine.start_subsystems()

    heartbeat_interval = float(getattr(config, "heartbeat_interval_sec", 60.0))
    last_heartbeat = time.time() - max(heartbeat_interval - 15.0, 0.0)
    window_sec = float(getattr(config, "lta_seconds", getattr(config, "lta_window", 20.0)))

    log.info("engine.loop_starting", cadence_hz=4, primary_channel=engine.primary_channel)

    try:
        while not _shutdown_event.is_set():
            cycle_start = time.time()
            if not engine.ring_buffer.is_ready(engine.primary_channel):
                await asyncio.sleep(0.25)
                continue

            await engine.stream_waveforms_to_clients()

            trace = engine.ring_buffer.get_latest(engine.primary_channel, duration_sec=window_sec)
            if trace is None or len(trace.data) < 10:
                await asyncio.sleep(0.25)
                continue

            try:
                trace = preprocess(
                    trace,
                    bandpass_low=float(getattr(config, "bandpass_low", 1.0)),
                    bandpass_high=float(getattr(config, "bandpass_high", 10.0)),
                )
            except Exception:
                log.exception("engine.preprocess_failed")

            await engine.process_triggers(trace, window_sec)

            now = time.time()
            if now - last_heartbeat >= heartbeat_interval:
                await engine.run_heartbeat(trace, now)
                last_heartbeat = now

            elapsed = time.time() - cycle_start
            await asyncio.sleep(max(0.0, 0.25 - elapsed))
    except asyncio.CancelledError:
        log.info("engine.loop_cancelled")
    finally:
        await engine.shutdown()
