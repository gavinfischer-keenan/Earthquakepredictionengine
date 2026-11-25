"""Persistence helpers for 1-minute environmental forensics JSONL/CSV logs."""
from __future__ import annotations

import csv
import json
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import structlog

log = structlog.get_logger(__name__)

CSV_COLUMNS: tuple[str, ...] = (
    "timestamp_utc",
    "timestamp",
    "local_hour",
    "ehz_rms_counts",
    "ehz_mad_counts",
    "pga_m_s2",
    "kurtosis",
    "kurtosis_median",
    "sta_lta_max",
    "is_quiet_candidate",
    "cultural_noise_um_s",
    "ocean_df_freq_hz",
    "seismic_swell_s",
    "ocean_microseism_nm_s",
    "wind_um_s",
    "stadium_um_s",
    "rail_um_s",
    "traffic_um_s",
    "human_um_s",
    "concert_um_s",
    "hv_ratio",
    "hv_peak_hz",
    "buoy_id",
    "buoy_wvht_m",
    "buoy_dpd_s",
    "buoy_wspd_mps",
    "buoy_mwd_deg",
    "correlation_status",
    "correlation_match_pct",
    "correlation_regime",
    "active_external_event",
    "external_event_category",
    "weather_wind_mps",
    "weather_gust_mps",
    "bart_active_trains",
    "aircraft_overhead_count",
    "closest_aircraft_alt_ft",
)


def append_forensics_row(
    jsonl_path: Path,
    csv_path: Path,
    row: dict[str, Any],
) -> None:
    """Append a recorded 1-minute forensics row to JSONL and CSV storage."""
    with open(jsonl_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")

    write_header = not csv_path.exists() or csv_path.stat().st_size == 0
    with open(csv_path, "a", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(CSV_COLUMNS))
        if write_header:
            writer.writeheader()
        writer.writerow({k: row.get(k, "") for k in CSV_COLUMNS})


def ensure_csv_header(csv_path: Path) -> Path:
    """Create an empty CSV with header row if no minutes have been logged yet."""
    if not csv_path.exists():
        with open(csv_path, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(CSV_COLUMNS))
            writer.writeheader()
    return csv_path


def load_forensics_history(
    jsonl_path: Path,
    telemetry_path: Path,
    recent_forensics: deque[dict[str, Any]],
    update_hour_bucket: Any,
    accumulate_hour_stat: Any,
    station_tz: timezone | ZoneInfo,
    hourly_stats: dict[int, dict[str, float]],
) -> None:
    """Backfill hourly diurnal profile from forensics JSONL or ML 1-min telemetry."""
    if jsonl_path.exists():
        try:
            with open(jsonl_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    rec = json.loads(line)
                    recent_forensics.append(rec)
                    accumulate_hour_stat(rec)
        except (OSError, json.JSONDecodeError):
            log.warning("env_intel.forensics_seed_failed")

    if telemetry_path.exists() and sum(s["sample_count"] for s in hourly_stats.values()) == 0:
        try:
            with open(telemetry_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    rec = json.loads(line)
                    ts = float(rec.get("timestamp", 0.0))
                    if ts <= 0:
                        continue
                    local_h = datetime.fromtimestamp(ts, tz=station_tz).hour
                    proxy_cultural = round(float(rec.get("pga_resultant_m_s2", 0.0)) * 50.0, 4)
                    proxy_rms = float(rec.get("noise_floor", 0.0) or rec.get("rsam", 0.0))
                    update_hour_bucket(
                        hour=local_h,
                        cultural=proxy_cultural,
                        rms=proxy_rms,
                        ocean_nm=0.0,
                        is_quiet=True,
                    )
        except (OSError, json.JSONDecodeError, ValueError):
            pass
