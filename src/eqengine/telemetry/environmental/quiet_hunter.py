"""Diurnal Quiet-Window Hunter & automatic NoiseModel calibration."""
from __future__ import annotations

import math
import time
from datetime import UTC, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import numpy as np
import obspy

from eqengine.telemetry.environmental.forensics import compute_minute_forensics
from eqengine.validation.noise_model import NoiseModel

# Relative diurnal cultural-noise prior (Berkeley Hills: quietest 02:00–04:00 PST).
DIURNAL_NOISE_PRIOR: tuple[float, ...] = (
    0.72, 0.62, 0.52, 0.50, 0.56, 0.68,
    0.85, 1.05, 1.22, 1.28, 1.30, 1.32,
    1.34, 1.32, 1.30, 1.35, 1.40, 1.42,
    1.35, 1.25, 1.15, 1.02, 0.88, 0.78,
)


def get_station_tz(
    tz_name: str = "America/Los_Angeles",
    station_lon: float = -122.2491,
) -> timezone | ZoneInfo:
    """Resolve station timezone with safe offset fallback if zoneinfo DB is unavailable."""
    try:
        return ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        offset_hours = round(station_lon / 15.0)
        return timezone(timedelta(hours=offset_hours), name="LOCAL")


def build_hourly_score_series(
    hourly_stats: dict[int, dict[str, float]],
    station_tz: timezone | ZoneInfo,
    quiet_baseline: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Build 24-hour diurnal noise scores combining observed samples & nocturnal prior."""
    observed_mins = [
        b["min_cultural"]
        for b in hourly_stats.values()
        if b["quiet_count"] > 0 and math.isfinite(b["min_cultural"])
    ]
    if observed_mins:
        scale_ref = float(np.median(observed_mins))
    elif quiet_baseline and float(quiet_baseline.get("cultural_noise_um_s", 0.0)) > 0:
        scale_ref = float(quiet_baseline["cultural_noise_um_s"]) / 0.52
    else:
        scale_ref = 0.25

    tz_abbr = datetime.now(station_tz).tzname() or "Local"
    series: list[dict[str, Any]] = []
    for h in range(24):
        b = hourly_stats[h]
        prior_val = scale_ref * DIURNAL_NOISE_PRIOR[h]
        n_obs = int(b["sample_count"])
        n_quiet = int(b["quiet_count"])
        if n_quiet > 0 and math.isfinite(b["min_cultural"]):
            obs_val: float | None = float(b["min_cultural"])
            weight_obs = min(1.0, n_quiet / 5.0)
            score = weight_obs * obs_val + (1.0 - weight_obs) * prior_val
            source = "observed"
        elif n_obs > 0:
            obs_val = float(b["sum_cultural"] / n_obs)
            weight_obs = min(0.85, n_obs / 6.0)
            score = weight_obs * obs_val + (1.0 - weight_obs) * prior_val
            source = "observed"
        else:
            obs_val = None
            score = prior_val
            source = "prior"

        series.append(
            {
                "hour": h,
                "label": f"{h:02d}h",
                "tz": tz_abbr,
                "sample_count": n_obs,
                "quiet_count": n_quiet,
                "effective_cultural_um_s": round(score, 4),
                "min_cultural_um_s": round(obs_val, 4) if obs_val is not None else None,
                "mean_rms_counts": round(b["sum_rms"] / n_obs, 2) if n_obs > 0 else None,
                "source": source,
            }
        )
    return series


def discover_quiet_window(
    hourly_stats: dict[int, dict[str, float]],
    station_tz: timezone | ZoneInfo,
    quiet_baseline: dict[str, Any] | None = None,
) -> tuple[str, int, int, list[dict[str, Any]]]:
    """Discover the empirically quietest consecutive 2-hour window in station-local time."""
    series = build_hourly_score_series(hourly_stats, station_tz, quiet_baseline)
    best_start = 2
    best_pair_score = float("inf")
    for h in range(24):
        pair_score = 0.5 * (
            series[h]["effective_cultural_um_s"]
            + series[(h + 1) % 24]["effective_cultural_um_s"]
        )
        if pair_score < best_pair_score:
            best_pair_score = pair_score
            best_start = h

    quietest_hour = min(series, key=lambda item: item["effective_cultural_um_s"])["hour"]
    tz_abbr = series[0]["tz"]
    end_hour = (best_start + 2) % 24
    label = f"{best_start:02d}:00–{end_hour:02d}:00 {tz_abbr}"
    return label, best_start, int(quietest_hour), series


def select_quiet_segment(
    ring_buffer: Any | None,
    *,
    sta_lta_max: float = 1.0,
) -> tuple[NoiseModel, dict[str, Any], float] | None:
    """Scan up to 300s of EHZ telemetry for the lowest-kurtosis quiet segment."""
    if ring_buffer is None:
        return None

    ehz_trace = ring_buffer.get_latest("EHZ", duration_sec=300.0)
    if ehz_trace is None or len(ehz_trace.data) == 0:
        return None

    sr = float(ehz_trace.stats.sampling_rate or 100.0)
    data = np.asarray(ehz_trace.data, dtype=np.float64)
    min_samples = max(int(20 * sr), 512)
    if len(data) < min_samples:
        return None

    seg_len = min(len(data), int(30 * sr))
    step = max(int(5 * sr), 100)

    best_slice = data[-seg_len:]
    best_metrics: dict[str, Any] | None = None
    best_rank: tuple[int, float, float] | None = None

    start_idx = 0
    while start_idx + seg_len <= len(data):
        cand = data[start_idx : start_idx + seg_len]
        m = compute_minute_forensics(cand, sampling_rate=sr, sta_lta_max=sta_lta_max)
        kurt_penalty = 0 if abs(float(m["kurtosis"])) < 2.5 else 1
        rank = (kurt_penalty, float(m["cultural_noise_um_s"]), float(m["ehz_rms_counts"]))
        if best_rank is None or rank < best_rank:
            best_rank = rank
            best_slice = cand
            best_metrics = m
        start_idx += step

    if best_metrics is None:
        best_metrics = compute_minute_forensics(best_slice, sampling_rate=sr, sta_lta_max=sta_lta_max)

    best_trace = obspy.Trace(
        data=best_slice - np.mean(best_slice),
        header={
            "network": ehz_trace.stats.network,
            "station": ehz_trace.stats.station,
            "channel": ehz_trace.stats.channel,
            "sampling_rate": sr,
            "starttime": ehz_trace.stats.starttime,
        },
    )
    noise_model = NoiseModel.from_trace(best_trace)
    return noise_model, best_metrics, round(len(best_slice) / sr, 1)


def build_quiet_baseline_record(
    *,
    noise_model: NoiseModel,
    best_metrics: dict[str, Any],
    seg_duration_sec: float,
    calibration_count: int,
    window_label: str,
    station_tz: timezone | ZoneInfo,
    force: bool,
) -> dict[str, Any]:
    """Construct persisted quiet_baseline.json dictionary."""
    now_ts = time.time()
    local_dt = datetime.fromtimestamp(now_ts, tz=station_tz)
    return {
        "calibrated_at_utc": datetime.now(tz=UTC).isoformat(),
        "calibrated_at_ts": now_ts,
        "calibrated_local_hour": local_dt.hour,
        "calibrated_local_time": local_dt.strftime("%Y-%m-%d %H:%M %Z"),
        "discovered_quiet_window_local": window_label,
        "calibration_count": calibration_count,
        "calibration_mode": "manual" if force else "auto_quiet_hunter",
        "segment_duration_sec": seg_duration_sec,
        "ehz_rms_counts": round(noise_model.baseline_rms, 3),
        "ehz_mad_counts": best_metrics["ehz_mad_counts"],
        "percentile_95_counts": round(noise_model.percentile_95, 3),
        "cultural_noise_um_s": best_metrics["cultural_noise_um_s"],
        "wind_um_s": best_metrics["wind_um_s"],
        "stadium_um_s": best_metrics["stadium_um_s"],
        "traffic_um_s": best_metrics["traffic_um_s"],
        "human_um_s": best_metrics["human_um_s"],
        "concert_um_s": best_metrics["concert_um_s"],
        "kurtosis": best_metrics["kurtosis"],
    }
