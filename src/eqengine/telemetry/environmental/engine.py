"""Autonomous environmental intelligence orchestrator."""
from __future__ import annotations

import asyncio
import contextlib
import json
import time
from collections import deque
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import structlog

from eqengine.telemetry.environmental.forensics import compute_minute_forensics
from eqengine.telemetry.environmental.ndbc import (
    NDBC_BUOYS,
    correlate_ocean_microseism,
    fetch_ndbc_buoys,
)
from eqengine.telemetry.environmental.quiet_hunter import (
    build_quiet_baseline_record,
    discover_quiet_window,
    get_station_tz,
    select_quiet_segment,
)
from eqengine.telemetry.environmental.storage import (
    append_forensics_row,
    ensure_csv_header,
    load_forensics_history,
)

log = structlog.get_logger(__name__)


class EnvironmentalIntelligenceEngine:
    """Autonomous ocean buoy correlator, Quiet-Window Hunter, and forensics logger."""

    def __init__(
        self,
        data_dir: str | Path | None = None,
        station_tz: str = "America/Los_Angeles",
        station_lon: float = -122.2491,
        buoy_poll_interval_sec: float = 600.0,
    ) -> None:
        self.data_dir = Path(data_dir) if data_dir is not None else Path("data")
        self.data_dir.mkdir(parents=True, exist_ok=True)

        self.ndbc_cache_path = self.data_dir / "ndbc_buoy_cache.json"
        self.quiet_baseline_path = self.data_dir / "quiet_baseline.json"
        self.noise_model_path = self.data_dir / "noise_model.json"
        self.forensics_jsonl_path = self.data_dir / "forensics_history.jsonl"
        self.forensics_csv_path = self.data_dir / "forensics_history.csv"

        self.station_tz = get_station_tz(station_tz, station_lon=station_lon)
        self.buoy_poll_interval_sec = float(buoy_poll_interval_sec)

        self._lock = asyncio.Lock()
        self._poll_task: asyncio.Task[None] | None = None
        self._running = False

        self.buoys: dict[str, dict[str, Any]] = {}
        self.quiet_baseline: dict[str, Any] | None = None
        self.latest_correlation: dict[str, Any] = correlate_ocean_microseism(12.5, 0.0, 0.0, None)
        self.calibration_count: int = 0
        self._last_calibration_ts: float = 0.0

        self.recent_forensics: deque[dict[str, Any]] = deque(maxlen=180)
        self._hourly_stats: dict[int, dict[str, float]] = {
            h: {
                "sample_count": 0,
                "quiet_count": 0,
                "sum_cultural": 0.0,
                "min_cultural": float("inf"),
                "sum_rms": 0.0,
                "min_rms": float("inf"),
                "sum_ocean_nm": 0.0,
            }
            for h in range(24)
        }

        self._load_or_seed_state()

    def _load_or_seed_state(self) -> None:
        if self.ndbc_cache_path.exists():
            try:
                raw = json.loads(self.ndbc_cache_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    self.buoys = raw
            except (OSError, json.JSONDecodeError):
                log.warning("env_intel.ndbc_cache_corrupt", path=str(self.ndbc_cache_path))

        if self.quiet_baseline_path.exists():
            try:
                qb = json.loads(self.quiet_baseline_path.read_text(encoding="utf-8"))
                if isinstance(qb, dict):
                    self.quiet_baseline = qb
                    self.calibration_count = int(qb.get("calibration_count", 1))
                    self._last_calibration_ts = float(qb.get("calibrated_at_ts", 0.0))
            except (OSError, json.JSONDecodeError):
                log.warning("env_intel.quiet_baseline_corrupt", path=str(self.quiet_baseline_path))

        load_forensics_history(
            jsonl_path=self.forensics_jsonl_path,
            telemetry_path=self.data_dir / "ml_dataset" / "telemetry_1min.jsonl",
            recent_forensics=self.recent_forensics,
            update_hour_bucket=self._update_hour_bucket,
            accumulate_hour_stat=self._accumulate_hour_stat,
            station_tz=self.station_tz,
            hourly_stats=self._hourly_stats,
        )

        if self.recent_forensics:
            last = self.recent_forensics[-1]
            self.latest_correlation = correlate_ocean_microseism(
                seismic_swell_s=float(last.get("seismic_swell_s", 12.5)),
                ocean_amp_nm_s=float(last.get("ocean_microseism_nm_s", 0.0)),
                wind_um_s=float(last.get("wind_um_s", 0.0)),
                buoy=self.primary_buoy,
            )

    @property
    def primary_buoy(self) -> dict[str, Any] | None:
        return self.buoys.get("46026") or self.buoys.get("46012")

    @property
    def secondary_buoy(self) -> dict[str, Any] | None:
        return self.buoys.get("46012")

    # ------------------------------------------------------------------
    # NOAA NDBC Poller
    # ------------------------------------------------------------------
    async def start(self) -> None:
        """Start background NOAA NDBC buoy polling."""
        if self._running:
            return
        self._running = True
        self._poll_task = asyncio.create_task(self._buoy_poll_loop())

    async def stop(self) -> None:
        """Stop background NOAA NDBC buoy polling."""
        self._running = False
        if self._poll_task is not None and not self._poll_task.done():
            self._poll_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._poll_task
        self._poll_task = None

    async def _buoy_poll_loop(self) -> None:
        await self.refresh_buoys()
        while self._running:
            try:
                await asyncio.sleep(self.buoy_poll_interval_sec)
                if not self._running:
                    break
                await self.refresh_buoys()
            except asyncio.CancelledError:
                break
            except (httpx.HTTPError, OSError, ValueError) as exc:
                log.warning("env_intel.buoy_loop_error", error=str(exc))

    async def refresh_buoys(self) -> dict[str, dict[str, Any]]:
        """Fetch latest real-time NOAA NDBC observations for configured buoys."""
        updated = await fetch_ndbc_buoys(NDBC_BUOYS)
        if updated:
            async with self._lock:
                self.buoys.update(updated)
                with contextlib.suppress(OSError):
                    self.ndbc_cache_path.write_text(json.dumps(self.buoys, indent=2), encoding="utf-8")

                if self.recent_forensics:
                    last = self.recent_forensics[-1]
                    self.latest_correlation = correlate_ocean_microseism(
                        seismic_swell_s=float(last.get("seismic_swell_s", 12.5)),
                        ocean_amp_nm_s=float(last.get("ocean_microseism_nm_s", 0.0)),
                        wind_um_s=float(last.get("wind_um_s", 0.0)),
                        buoy=self.primary_buoy,
                    )

            primary = self.primary_buoy
            if primary:
                log.info(
                    "env_intel.ndbc_updated",
                    buoy_id=primary.get("buoy_id"),
                    wvht_m=primary.get("wvht_m"),
                    dpd_s=primary.get("dpd_s"),
                    wspd_mps=primary.get("wspd_mps"),
                )
        return self.buoys

    # ------------------------------------------------------------------
    # Diurnal Profile & Quiet-Window Discovery
    # ------------------------------------------------------------------
    def _update_hour_bucket(
        self,
        *,
        hour: int,
        cultural: float,
        rms: float,
        ocean_nm: float,
        is_quiet: bool,
    ) -> None:
        b = self._hourly_stats[int(hour) % 24]
        b["sample_count"] += 1
        b["sum_cultural"] += cultural
        b["sum_rms"] += rms
        b["sum_ocean_nm"] += ocean_nm
        if is_quiet:
            b["quiet_count"] += 1
            b["min_cultural"] = min(b["min_cultural"], cultural)
            if rms > 0:
                b["min_rms"] = min(b["min_rms"], rms)

    def _accumulate_hour_stat(self, rec: dict[str, Any]) -> None:
        hour = rec.get("local_hour")
        if hour is None:
            ts = float(rec.get("timestamp", 0.0))
            if ts <= 0:
                return
            hour = datetime.fromtimestamp(ts, tz=self.station_tz).hour
        self._update_hour_bucket(
            hour=int(hour),
            cultural=float(rec.get("cultural_noise_um_s", 0.0)),
            rms=float(rec.get("ehz_rms_counts", 0.0)),
            ocean_nm=float(rec.get("ocean_microseism_nm_s", 0.0)),
            is_quiet=bool(rec.get("is_quiet_candidate", True)),
        )

    def discover_quiet_window(self) -> tuple[str, int, int, list[dict[str, Any]]]:
        """Discover the empirically quietest consecutive 2-hour window in station-local time."""
        return discover_quiet_window(self._hourly_stats, self.station_tz, self.quiet_baseline)

    # ------------------------------------------------------------------
    # Forensics Logging & Baseline Calibration
    # ------------------------------------------------------------------
    async def record_minute(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        """Record a 1-minute environmental snapshot to JSONL, CSV, and hourly profile."""
        ts = float(snapshot.get("timestamp") or time.time())
        iso_utc = snapshot.get("timestamp_utc") or datetime.fromtimestamp(ts, tz=UTC).isoformat()
        local_dt = datetime.fromtimestamp(ts, tz=self.station_tz)
        local_hour = int(snapshot.get("local_hour", local_dt.hour))

        corr = snapshot.get("_correlation") or correlate_ocean_microseism(
            seismic_swell_s=float(snapshot.get("seismic_swell_s", 12.5)),
            ocean_amp_nm_s=float(snapshot.get("ocean_microseism_nm_s", 0.0)),
            wind_um_s=float(snapshot.get("wind_um_s", 0.0)),
            buoy=self.primary_buoy,
        )

        row: dict[str, Any] = {
            "timestamp_utc": iso_utc,
            "timestamp": round(ts, 3),
            "local_hour": local_hour,
            "ehz_rms_counts": float(snapshot.get("ehz_rms_counts", 0.0)),
            "ehz_mad_counts": float(snapshot.get("ehz_mad_counts", 0.0)),
            "pga_m_s2": float(snapshot.get("pga_m_s2", 0.0)),
            "kurtosis": float(snapshot.get("kurtosis", 0.0)),
            "kurtosis_median": float(snapshot.get("kurtosis_median", 0.0)),
            "sta_lta_max": float(snapshot.get("sta_lta_max", 1.0)),
            "is_quiet_candidate": bool(snapshot.get("is_quiet_candidate", True)),
            "cultural_noise_um_s": float(snapshot.get("cultural_noise_um_s", 0.0)),
            "ocean_df_freq_hz": float(snapshot.get("ocean_df_freq_hz", 0.16)),
            "seismic_swell_s": float(snapshot.get("seismic_swell_s", 12.5)),
            "ocean_microseism_nm_s": float(snapshot.get("ocean_microseism_nm_s", 0.0)),
            "wind_um_s": float(snapshot.get("wind_um_s", 0.0)),
            "stadium_um_s": float(snapshot.get("stadium_um_s", 0.0)),
            "rail_um_s": float(snapshot.get("rail_um_s", 0.0)),
            "traffic_um_s": float(snapshot.get("traffic_um_s", 0.0)),
            "human_um_s": float(snapshot.get("human_um_s", 0.0)),
            "concert_um_s": float(snapshot.get("concert_um_s", 0.0)),
            "hv_ratio": float(snapshot.get("hv_ratio", 1.0)),
            "hv_peak_hz": float(snapshot.get("hv_peak_hz", 0.0)),
            "buoy_id": corr.get("buoy_id") or "",
            "buoy_wvht_m": corr.get("buoy_wvht_m") if corr.get("buoy_wvht_m") is not None else "",
            "buoy_dpd_s": corr.get("buoy_dpd_s") if corr.get("buoy_dpd_s") is not None else "",
            "buoy_wspd_mps": corr.get("buoy_wspd_mps") if corr.get("buoy_wspd_mps") is not None else "",
            "buoy_mwd_deg": corr.get("buoy_mwd_deg") if corr.get("buoy_mwd_deg") is not None else "",
            "correlation_status": corr.get("status", "UNAVAILABLE"),
            "correlation_match_pct": corr.get("match_pct", 0),
            "correlation_regime": corr.get("regime", ""),
            "active_external_event": snapshot.get("active_external_event", ""),
            "external_event_category": snapshot.get("external_event_category", ""),
            "weather_wind_mps": snapshot.get("weather_wind_mps", ""),
            "weather_gust_mps": snapshot.get("weather_gust_mps", ""),
            "bart_active_trains": snapshot.get("bart_active_trains", ""),
            "aircraft_overhead_count": snapshot.get("aircraft_overhead_count", ""),
            "closest_aircraft_alt_ft": snapshot.get("closest_aircraft_alt_ft", ""),
        }

        async with self._lock:
            self.latest_correlation = corr
            self.recent_forensics.append(row)
            self._accumulate_hour_stat(row)
            await asyncio.to_thread(
                append_forensics_row,
                self.forensics_jsonl_path,
                self.forensics_csv_path,
                row,
            )

        return row

    async def hunt_and_calibrate(
        self,
        ring_buffer: Any | None,
        force: bool = False,
        sta_lta_max: float = 1.0,
    ) -> dict[str, Any] | None:
        """Scan up to 300s of EHZ telemetry for the lowest-kurtosis quiet segment and calibrate."""
        selection = select_quiet_segment(ring_buffer, sta_lta_max=sta_lta_max)
        if selection is None:
            return None
        noise_model, best_metrics, seg_dur = selection

        window_label, _, _, _ = self.discover_quiet_window()
        async with self._lock:
            noise_model.save(str(self.noise_model_path))
            self.calibration_count += 1
            baseline = build_quiet_baseline_record(
                noise_model=noise_model,
                best_metrics=best_metrics,
                seg_duration_sec=seg_dur,
                calibration_count=self.calibration_count,
                window_label=window_label,
                station_tz=self.station_tz,
                force=force,
            )
            self._last_calibration_ts = float(baseline["calibrated_at_ts"])
            self.quiet_baseline = baseline
            self.quiet_baseline_path.write_text(json.dumps(baseline, indent=2), encoding="utf-8")

        log.info(
            "env_intel.baseline_calibrated",
            mode=baseline["calibration_mode"],
            rms_counts=baseline["ehz_rms_counts"],
            cultural_um_s=baseline["cultural_noise_um_s"],
            window=window_label,
        )
        return baseline

    def _should_auto_calibrate(
        self,
        *,
        is_quiet_candidate: bool,
        cultural_noise_um_s: float,
        local_hour: int,
        best_start_hour: int,
    ) -> bool:
        if self.quiet_baseline is None:
            return True
        if not is_quiet_candidate:
            return False

        now_ts = time.time()
        elapsed = now_ts - self._last_calibration_ts
        in_discovered = local_hour in (best_start_hour, (best_start_hour + 1) % 24)
        in_nocturnal_prior = local_hour in (2, 3)

        if (in_discovered or in_nocturnal_prior) and elapsed >= 1800.0:
            return True

        prev_cultural = float(self.quiet_baseline.get("cultural_noise_um_s", float("inf")))
        return cultural_noise_um_s < prev_cultural * 0.95 and elapsed >= 900.0

    async def process_1min_tick(
        self,
        ring_buffer: Any,
        detector: Any | None = None,
        external_events_manager: Any | None = None,
    ) -> dict[str, Any] | None:
        """Compute, log, correlate, and auto-calibrate on a 1-minute heartbeat cycle."""
        ehz_tr = ring_buffer.get_latest("EHZ", duration_sec=60.0)
        if ehz_tr is None or len(ehz_tr.data) < 64:
            return None

        enz_tr = ring_buffer.get_latest("ENZ", duration_sec=60.0)
        enn_tr = ring_buffer.get_latest("ENN", duration_sec=60.0)
        ene_tr = ring_buffer.get_latest("ENE", duration_sec=60.0)

        sta_lta_max = 1.0
        if detector is not None and hasattr(detector, "get_current_ratio"):
            with contextlib.suppress(TypeError, ValueError):
                sta_lta_max = float(detector.get_current_ratio())

        metrics = compute_minute_forensics(
            ehz=np.asarray(ehz_tr.data),
            enz=np.asarray(enz_tr.data) if enz_tr is not None else None,
            enn=np.asarray(enn_tr.data) if enn_tr is not None else None,
            ene=np.asarray(ene_tr.data) if ene_tr is not None else None,
            sampling_rate=float(ehz_tr.stats.sampling_rate or 100.0),
            sta_lta_max=sta_lta_max,
        )

        now_ts = time.time()
        local_hour = datetime.fromtimestamp(now_ts, tz=self.station_tz).hour
        corr = correlate_ocean_microseism(
            seismic_swell_s=metrics["seismic_swell_s"],
            ocean_amp_nm_s=metrics["ocean_microseism_nm_s"],
            wind_um_s=metrics["wind_um_s"],
            buoy=self.primary_buoy,
        )
        metrics["timestamp"] = now_ts
        metrics["local_hour"] = local_hour
        metrics["_correlation"] = corr

        if external_events_manager is not None:
            ext_corr = external_events_manager.correlate(metrics)
            metrics["active_external_event"] = ext_corr.active_event_title or ""
            metrics["external_event_category"] = ext_corr.active_category or ""
            if external_events_manager.weather is not None:
                metrics["weather_wind_mps"] = external_events_manager.weather.wind_speed_mps
                metrics["weather_gust_mps"] = external_events_manager.weather.wind_gusts_mps
            if external_events_manager.bart is not None:
                metrics["bart_active_trains"] = external_events_manager.bart.trains_imminent_count
            if getattr(external_events_manager, "aircraft", None) is not None:
                ac_snap = external_events_manager.aircraft
                metrics["aircraft_overhead_count"] = ac_snap.low_overhead_count
                if ac_snap.closest_aircraft is not None:
                    metrics["closest_aircraft_alt_ft"] = ac_snap.closest_aircraft.altitude_ft

        row = await self.record_minute(metrics)

        _, best_start, _, _ = self.discover_quiet_window()
        if self._should_auto_calibrate(
            is_quiet_candidate=metrics["is_quiet_candidate"],
            cultural_noise_um_s=metrics["cultural_noise_um_s"],
            local_hour=local_hour,
            best_start_hour=best_start,
        ):
            await self.hunt_and_calibrate(ring_buffer=ring_buffer, force=False, sta_lta_max=sta_lta_max)

        return row

    def get_intelligence_payload(
        self,
        ring_buffer: Any | None = None,
        external_events_manager: Any | None = None,
    ) -> dict[str, Any]:
        """Build JSON-serializable state for the observatory dashboard & REST API."""
        window_label, best_start, quietest_hour, series = self.discover_quiet_window()
        now_local = datetime.now(self.station_tz)
        in_quiet_window = now_local.hour in (best_start, (best_start + 1) % 24)

        current_rms = None
        noise_ratio = None
        live_forensics: dict[str, Any] | None = None
        if ring_buffer is not None:
            tr = ring_buffer.get_latest("EHZ", duration_sec=60.0)
            if tr is not None and len(tr.data) >= 64:
                d = np.asarray(tr.data, dtype=np.float64)
                d = d - np.mean(d)
                recent_d = d[-min(len(d), 500) :]
                current_rms = round(float(np.sqrt(np.mean(recent_d ** 2))), 2)
                if self.quiet_baseline and float(self.quiet_baseline.get("ehz_rms_counts", 0.0)) > 0:
                    noise_ratio = round(current_rms / float(self.quiet_baseline["ehz_rms_counts"]), 2)
                if self.latest_correlation.get("status") == "UNAVAILABLE" and self.primary_buoy is not None:
                    live_forensics = compute_minute_forensics(
                        d, sampling_rate=float(tr.stats.sampling_rate or 100.0)
                    )
                    self.latest_correlation = correlate_ocean_microseism(
                        seismic_swell_s=live_forensics["seismic_swell_s"],
                        ocean_amp_nm_s=live_forensics["ocean_microseism_nm_s"],
                        wind_um_s=live_forensics["wind_um_s"],
                        buoy=self.primary_buoy,
                    )
                elif external_events_manager is not None:
                    live_forensics = compute_minute_forensics(
                        d, sampling_rate=float(tr.stats.sampling_rate or 100.0)
                    )

        ext_corr = None
        if external_events_manager is not None:
            basis = live_forensics or (self.recent_forensics[-1] if self.recent_forensics else None)
            ext_corr = external_events_manager.correlate(basis).model_dump()

        return {
            "buoy": self.primary_buoy,
            "secondary_buoy": self.secondary_buoy,
            "correlation": self.latest_correlation,
            "external_correlation": ext_corr,
            "quiet_hunter": {
                "discovered_window_local": window_label,
                "best_start_hour_local": best_start,
                "quietest_hour_local": quietest_hour,
                "current_local_hour": now_local.hour,
                "current_local_time": now_local.strftime("%H:%M %Z"),
                "is_in_quiet_window": in_quiet_window,
                "calibration_count": self.calibration_count,
                "baseline": self.quiet_baseline,
                "current_ehz_rms_counts": current_rms,
                "noise_ratio": noise_ratio,
                "hourly_profile": series,
            },
            "recent_forensics": list(self.recent_forensics)[-120:],
        }

    def ensure_csv_exists(self) -> Path:
        """Create an empty CSV with header row if no minutes have been logged yet."""
        return ensure_csv_header(self.forensics_csv_path)


_env_engine: EnvironmentalIntelligenceEngine | None = None


def get_environmental_engine() -> EnvironmentalIntelligenceEngine:
    """Return or initialize the global EnvironmentalIntelligenceEngine singleton."""
    global _env_engine
    if _env_engine is None:
        _env_engine = EnvironmentalIntelligenceEngine()
    return _env_engine
