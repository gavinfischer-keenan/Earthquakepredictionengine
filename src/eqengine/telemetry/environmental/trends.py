"""Long-horizon (7D / 30D) forensics trends, empirical Light/Normal/Heavy bands,
and predictive models for ocean microseisms, cultural diurnal curves, and event anomalies.
"""
from __future__ import annotations

import csv
import json
import math
import time
from collections import defaultdict
from datetime import UTC, datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np

from eqengine.telemetry.environmental.quiet_hunter import (
    DIURNAL_NOISE_PRIOR,
    get_station_tz,
)

BAND_SPECS: tuple[tuple[str, str, str], ...] = (
    ("ocean_microseism_nm_s", "Ocean Microseism", "nm/s"),
    ("wind_um_s", "Wind & Canopy Sway", "µm/s"),
    ("stadium_um_s", "Stadium / Crowd (2–5 Hz)", "µm/s"),
    ("rail_um_s", "BART / Rail (4–8 Hz)", "µm/s"),
    ("traffic_um_s", "Roadway Traffic (8–14 Hz)", "µm/s"),
    ("human_um_s", "Indoor Impacts (15–24 Hz)", "µm/s"),
    ("concert_um_s", "Sub-Bass / Concert (25–45 Hz)", "µm/s"),
    ("cultural_noise_um_s", "Cultural Composite", "µm/s"),
    ("ehz_rms_counts", "EHZ RMS", "counts"),
)


def _safe_float(val: Any) -> float | None:
    if val is None or val == "":
        return None
    try:
        f = float(val)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def load_forensics_rows(
    jsonl_path: Path,
    csv_path: Path,
    max_days: int = 90,
) -> list[dict[str, Any]]:
    """Load recent 1-minute forensics records from JSONL (falling back to CSV)."""
    cutoff = time.time() - max(1, max_days) * 86400.0
    rows: list[dict[str, Any]] = []

    if jsonl_path.exists():
        try:
            with open(jsonl_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    ts = _safe_float(rec.get("timestamp"))
                    if ts is not None and ts >= cutoff:
                        rows.append(rec)
        except OSError:
            pass
        if rows:
            rows.sort(key=lambda r: float(r.get("timestamp", 0.0)))
            return rows

    if csv_path.exists():
        try:
            with open(csv_path, encoding="utf-8", newline="") as f:
                for rec in csv.DictReader(f):
                    ts = _safe_float(rec.get("timestamp"))
                    if ts is not None and ts >= cutoff:
                        rows.append(rec)
        except OSError:
            pass

    rows.sort(key=lambda r: float(r.get("timestamp", 0.0)))
    return rows


def classify_band_level(value: float, threshold_info: dict[str, Any] | None) -> str:
    """Classify *value* into LIGHT / NORMAL / HEAVY / EXTREME using learned percentiles."""
    if not threshold_info or int(threshold_info.get("sample_count", 0)) < 5:
        return "NORMAL"
    p25 = float(threshold_info.get("p25", 0.0))
    p75 = float(threshold_info.get("p75", 0.0))
    p95 = float(threshold_info.get("p95", 0.0))
    if value > p95:
        return "EXTREME"
    if value > p75:
        return "HEAVY"
    if value <= p25:
        return "LIGHT"
    return "NORMAL"


def compute_band_thresholds(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Compute empirical Light (<=p25), Normal (p25–p75), Heavy (p75–p95), Extreme (>p95) bands."""
    thresholds: dict[str, dict[str, Any]] = {}
    for key, label, unit in BAND_SPECS:
        vals: list[float] = []
        for r in rows:
            v = _safe_float(r.get(key))
            if v is not None and v >= 0.0:
                vals.append(v)

        if not vals:
            thresholds[key] = {
                "key": key,
                "label": label,
                "unit": unit,
                "sample_count": 0,
                "p10": 0.0,
                "p25": 0.0,
                "p50": 0.0,
                "p75": 0.0,
                "p95": 0.0,
                "mean": 0.0,
                "std": 0.0,
            }
            continue

        arr = np.asarray(vals, dtype=np.float64)
        p10, p25, p50, p75, p95 = np.percentile(arr, [10, 25, 50, 75, 95])
        thresholds[key] = {
            "key": key,
            "label": label,
            "unit": unit,
            "sample_count": int(arr.size),
            "p10": round(float(p10), 4),
            "p25": round(float(p25), 4),
            "p50": round(float(p50), 4),
            "p75": round(float(p75), 4),
            "p95": round(float(p95), 4),
            "mean": round(float(np.mean(arr)), 4),
            "std": round(float(np.std(arr)), 4),
        }
    return thresholds


def _fit_ocean_transfer_model(
    rows: list[dict[str, Any]],
    bucket_sec: float,
    start_ts: float,
    end_ts: float,
    current_buoy: dict[str, Any] | None,
) -> dict[str, Any]:
    """Fit Buoy wave-energy proxy -> sub-Hz microseism regression and bucket time series."""
    buckets: dict[int, list[dict[str, Any]]] = defaultdict(list)
    pair_x: list[float] = []
    pair_y: list[float] = []
    pair_h: list[float] = []

    for r in rows:
        ts = _safe_float(r.get("timestamp"))
        if ts is None or ts < start_ts or ts > end_ts:
            continue
        b_idx = int((ts - start_ts) // bucket_sec)
        buckets[b_idx].append(r)

        wvht = _safe_float(r.get("buoy_wvht_m"))
        dpd = _safe_float(r.get("buoy_dpd_s")) or 12.0
        nm = _safe_float(r.get("ocean_microseism_nm_s"))
        if wvht is not None and wvht > 0 and nm is not None and nm > 0:
            energy_proxy = (wvht ** 2) * max(dpd, 6.0) / 12.0
            pair_x.append(energy_proxy)
            pair_y.append(nm)
            pair_h.append(wvht)

    slope = 0.0
    intercept = 0.0
    r2 = 0.0
    pearson_r = 0.0
    residual_std = 0.0
    model_ready = len(pair_x) >= 6

    if model_ready:
        x_arr = np.asarray(pair_x, dtype=np.float64)
        y_arr = np.asarray(pair_y, dtype=np.float64)
        h_arr = np.asarray(pair_h, dtype=np.float64)

        if float(np.std(x_arr)) > 1e-6:
            slope, intercept = (float(c) for c in np.polyfit(x_arr, y_arr, 1))
            y_pred = np.maximum(0.0, slope * x_arr + intercept)
            ss_res = float(np.sum((y_arr - y_pred) ** 2))
            ss_tot = float(np.sum((y_arr - np.mean(y_arr)) ** 2))
            r2 = max(0.0, 1.0 - ss_res / ss_tot) if ss_tot > 1e-9 else 0.0
            residual_std = float(np.std(y_arr - y_pred))
        else:
            intercept = float(np.mean(y_arr))

        if float(np.std(h_arr)) > 1e-6 and float(np.std(y_arr)) > 1e-6:
            pearson_r = float(np.corrcoef(h_arr, y_arr)[0, 1])
    elif pair_y:
        intercept = float(np.mean(pair_y))

    series: list[dict[str, Any]] = []
    for b_idx in sorted(buckets):
        items = buckets[b_idx]
        b_ts = start_ts + (b_idx + 0.5) * bucket_sec
        nm_vals = [v for r in items if (v := _safe_float(r.get("ocean_microseism_nm_s"))) is not None]
        sw_vals = [v for r in items if (v := _safe_float(r.get("seismic_swell_s"))) is not None]
        wv_vals = [v for r in items if (v := _safe_float(r.get("buoy_wvht_m"))) is not None]
        dp_vals = [v for r in items if (v := _safe_float(r.get("buoy_dpd_s"))) is not None]
        mt_vals = [v for r in items if (v := _safe_float(r.get("correlation_match_pct"))) is not None]

        mean_nm = round(float(np.mean(nm_vals)), 1) if nm_vals else None
        mean_wv = round(float(np.mean(wv_vals)), 2) if wv_vals else None
        mean_dp = round(float(np.mean(dp_vals)), 1) if dp_vals else None
        pred_nm: float | None = None
        if model_ready and mean_wv is not None and mean_wv > 0:
            proxy = (mean_wv ** 2) * max(mean_dp or 12.0, 6.0) / 12.0
            pred_nm = round(max(0.0, slope * proxy + intercept), 1)

        series.append(
            {
                "timestamp": round(b_ts, 1),
                "label": datetime.fromtimestamp(b_ts, tz=UTC).strftime("%m/%d %H:%M"),
                "ocean_microseism_nm_s": mean_nm,
                "predicted_ocean_nm_s": pred_nm,
                "seismic_swell_s": round(float(np.mean(sw_vals)), 1) if sw_vals else None,
                "buoy_wvht_m": mean_wv,
                "buoy_dpd_s": mean_dp,
                "match_pct": round(float(np.mean(mt_vals))) if mt_vals else None,
            }
        )

    ref_buoy = current_buoy
    if ref_buoy is None and rows:
        for r in reversed(rows):
            wv = _safe_float(r.get("buoy_wvht_m"))
            if wv is not None:
                ref_buoy = {"wvht_m": wv, "dpd_s": _safe_float(r.get("buoy_dpd_s"))}
                break

    live_pred_nm: float | None = None
    live_z: float | None = None
    if model_ready and ref_buoy and ref_buoy.get("wvht_m") is not None:
        wv = float(ref_buoy["wvht_m"])
        dp = float(ref_buoy.get("dpd_s") or ref_buoy.get("apd_s") or 12.0)
        proxy = (wv ** 2) * max(dp, 6.0) / 12.0
        live_pred_nm = round(max(0.0, slope * proxy + intercept), 1)
        latest_nm = _safe_float(rows[-1].get("ocean_microseism_nm_s")) if rows else None
        if latest_nm is not None and residual_std > 1e-3:
            live_z = round((latest_nm - live_pred_nm) / residual_std, 2)

    return {
        "model_ready": model_ready,
        "sample_pairs": len(pair_x),
        "slope": round(slope, 3),
        "intercept": round(intercept, 2),
        "pearson_r": round(pearson_r, 3),
        "r2": round(r2, 3),
        "residual_std_nm_s": round(residual_std, 1),
        "live_predicted_nm_s": live_pred_nm,
        "live_anomaly_z": live_z,
        "series": series[-240:],
    }


def _build_cultural_diurnal_model(
    rows: list[dict[str, Any]],
    station_tz: timezone | ZoneInfo,
    now_ts: float,
    thresholds: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Learn weekday vs weekend 24h traffic/rail/cultural profiles and predict next 24h."""
    buckets: dict[tuple[int, int], list[dict[str, float]]] = defaultdict(list)
    overall_hour: dict[int, list[dict[str, float]]] = defaultdict(list)

    for r in rows:
        ts = _safe_float(r.get("timestamp"))
        if ts is None:
            continue
        dt = datetime.fromtimestamp(ts, tz=station_tz)
        is_wknd = 1 if dt.weekday() >= 5 else 0
        hr = dt.hour
        item = {
            "traffic": _safe_float(r.get("traffic_um_s")) or 0.0,
            "rail": _safe_float(r.get("rail_um_s")) or 0.0,
            "cultural": _safe_float(r.get("cultural_noise_um_s")) or 0.0,
            "rms": _safe_float(r.get("ehz_rms_counts")) or 0.0,
        }
        buckets[(is_wknd, hr)].append(item)
        overall_hour[hr].append(item)

    all_cultural = [x["cultural"] for lst in overall_hour.values() for x in lst]
    scale_ref = max(float(np.median(all_cultural)) / 0.95, 0.1) if all_cultural else 0.25

    def _summarize_day_type(is_wknd: int) -> list[dict[str, Any]]:
        profile: list[dict[str, Any]] = []
        for h in range(24):
            items = buckets.get((is_wknd, h), [])
            src = "observed"
            if not items:
                items = overall_hour.get(h, [])
                src = "interpolated" if items else "prior"

            if items:
                tr = np.asarray([i["traffic"] for i in items], dtype=np.float64)
                rl = np.asarray([i["rail"] for i in items], dtype=np.float64)
                cu = np.asarray([i["cultural"] for i in items], dtype=np.float64)
                rm = np.asarray([i["rms"] for i in items], dtype=np.float64)
                profile.append(
                    {
                        "hour": h,
                        "label": f"{h:02d}h",
                        "sample_count": len(items),
                        "source": src,
                        "traffic_mean": round(float(np.mean(tr)), 4),
                        "traffic_std": round(float(np.std(tr)), 4),
                        "rail_mean": round(float(np.mean(rl)), 4),
                        "rail_std": round(float(np.std(rl)), 4),
                        "cultural_mean": round(float(np.mean(cu)), 4),
                        "cultural_std": round(float(np.std(cu)), 4),
                        "rms_mean": round(float(np.mean(rm)), 2),
                    }
                )
            else:
                prior_cu = scale_ref * DIURNAL_NOISE_PRIOR[h]
                profile.append(
                    {
                        "hour": h,
                        "label": f"{h:02d}h",
                        "sample_count": 0,
                        "source": "prior",
                        "traffic_mean": round(prior_cu * 0.9, 4),
                        "traffic_std": round(prior_cu * 0.2, 4),
                        "rail_mean": round(prior_cu * 0.7, 4),
                        "rail_std": round(prior_cu * 0.15, 4),
                        "cultural_mean": round(prior_cu, 4),
                        "cultural_std": round(prior_cu * 0.2, 4),
                        "rms_mean": 0.0,
                    }
                )
        return profile

    weekday_profile = _summarize_day_type(0)
    weekend_profile = _summarize_day_type(1)

    next_24h: list[dict[str, Any]] = []
    cult_thresh = thresholds.get("cultural_noise_um_s")
    for offset in range(24):
        fut_dt = datetime.fromtimestamp(now_ts + offset * 3600.0, tz=station_tz)
        wknd = fut_dt.weekday() >= 5
        slot = (weekend_profile if wknd else weekday_profile)[fut_dt.hour]
        mu = float(slot["cultural_mean"])
        sd = float(slot["cultural_std"])
        next_24h.append(
            {
                "offset_hours": offset,
                "hour": fut_dt.hour,
                "label": fut_dt.strftime("%a %H:00"),
                "day_type": "weekend" if wknd else "weekday",
                "predicted_traffic_um_s": slot["traffic_mean"],
                "predicted_rail_um_s": slot["rail_mean"],
                "predicted_cultural_um_s": round(mu, 4),
                "lower_1sigma": round(max(0.0, mu - sd), 4),
                "upper_1sigma": round(mu + sd, 4),
                "predicted_level": classify_band_level(mu, cult_thresh),
                "source": slot["source"],
            }
        )

    live_anomaly: dict[str, Any] = {
        "z_score": 0.0,
        "status": "NORMAL",
        "level": "NORMAL",
        "observed_cultural_um_s": None,
        "expected_cultural_um_s": next_24h[0]["predicted_cultural_um_s"],
    }
    if rows:
        last = rows[-1]
        obs_c = _safe_float(last.get("cultural_noise_um_s"))
        last_ts = _safe_float(last.get("timestamp")) or now_ts
        ldt = datetime.fromtimestamp(last_ts, tz=station_tz)
        slot_now = (weekend_profile if ldt.weekday() >= 5 else weekday_profile)[ldt.hour]
        if obs_c is not None:
            exp_mu = float(slot_now["cultural_mean"])
            exp_sd = max(float(slot_now["cultural_std"]), 0.02)
            z = (obs_c - exp_mu) / exp_sd
            if z >= 2.5:
                status = "ANOMALOUS"
            elif z >= 1.25:
                status = "ELEVATED"
            elif z <= -1.0:
                status = "QUIETER_THAN_NORMAL"
            else:
                status = "NORMAL"
            live_anomaly = {
                "z_score": round(z, 2),
                "status": status,
                "level": classify_band_level(obs_c, cult_thresh),
                "observed_cultural_um_s": round(obs_c, 4),
                "expected_cultural_um_s": round(exp_mu, 4),
            }

    return {
        "weekday_profile": weekday_profile,
        "weekend_profile": weekend_profile,
        "next_24h_forecast": next_24h,
        "live_anomaly": live_anomaly,
    }


def _build_event_profiles(
    rows: list[dict[str, Any]],
    station_tz: timezone | ZoneInfo,
    thresholds: dict[str, dict[str, Any]],
    upcoming_events: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Separate Game/Concert days (via tag OR blind anomaly detection) from baseline days."""
    stad_stats = thresholds.get("stadium_um_s", {})
    conc_stats = thresholds.get("concert_um_s", {})
    stad_thresh = max(
        float(stad_stats.get("mean", 0.0)) + 2.5 * float(stad_stats.get("std", 0.0)),
        float(stad_stats.get("p95", 0.0)) * 1.25,
        0.45,
    )
    conc_thresh = max(
        float(conc_stats.get("mean", 0.0)) + 2.5 * float(conc_stats.get("std", 0.0)),
        float(conc_stats.get("p95", 0.0)) * 1.25,
        0.25,
    )

    by_date: dict[str, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    for r in rows:
        ts = _safe_float(r.get("timestamp"))
        if ts is None:
            continue
        dt = datetime.fromtimestamp(ts, tz=station_tz)
        by_date[dt.strftime("%Y-%m-%d")].append((dt.hour, r))

    stadium_event_dates: set[str] = set()
    concert_event_dates: set[str] = set()
    detected_event_days: list[dict[str, Any]] = []

    for date_str, items in sorted(by_date.items()):
        tagged_fb = any(r.get("external_event_category") == "football" for _, r in items)
        tagged_conc = any(r.get("external_event_category") == "concert" for _, r in items)

        stad_hits = sum(1 for _, r in items if (_safe_float(r.get("stadium_um_s")) or 0.0) >= stad_thresh)
        conc_hits = sum(
            1
            for h, r in items
            if h >= 16 and (_safe_float(r.get("concert_um_s")) or 0.0) >= conc_thresh
        )

        is_stad_day = tagged_fb or stad_hits >= 10
        is_conc_day = tagged_conc or conc_hits >= 10
        if is_stad_day:
            stadium_event_dates.add(date_str)
            peak_s = max((_safe_float(r.get("stadium_um_s")) or 0.0) for _, r in items)
            detected_event_days.append(
                {
                    "date": date_str,
                    "category": "football",
                    "method": "tagged" if tagged_fb else "blind_learned",
                    "peak_um_s": round(peak_s, 3),
                    "minutes_above_threshold": stad_hits,
                }
            )
        if is_conc_day:
            concert_event_dates.add(date_str)
            peak_c = max((_safe_float(r.get("concert_um_s")) or 0.0) for _, r in items)
            detected_event_days.append(
                {
                    "date": date_str,
                    "category": "concert",
                    "method": "tagged" if tagged_conc else "blind_learned",
                    "peak_um_s": round(peak_c, 3),
                    "minutes_above_threshold": conc_hits,
                }
            )

    def _hourly_split(key: str, event_dates: set[str]) -> tuple[list[float], list[float]]:
        ev_h: dict[int, list[float]] = defaultdict(list)
        base_h: dict[int, list[float]] = defaultdict(list)
        for date_str, items in by_date.items():
            target = ev_h if date_str in event_dates else base_h
            for h, r in items:
                val = _safe_float(r.get(key))
                if val is not None:
                    target[h].append(val)
        ev_curve = [round(float(np.mean(ev_h[h])), 4) if ev_h[h] else 0.0 for h in range(24)]
        base_curve = [round(float(np.mean(base_h[h])), 4) if base_h[h] else 0.0 for h in range(24)]
        return ev_curve, base_curve

    stad_ev_curve, stad_base_curve = _hourly_split("stadium_um_s", stadium_event_dates)
    conc_ev_curve, conc_base_curve = _hourly_split("concert_um_s", concert_event_dates)

    predicted_windows: list[dict[str, Any]] = []
    for ev in upcoming_events or []:
        if ev.get("category") in ("football", "concert") and ev.get("status") in ("live", "upcoming"):
            predicted_windows.append(
                {
                    "title": ev.get("title"),
                    "category": ev.get("category"),
                    "status": ev.get("status"),
                    "start_time_utc": ev.get("start_time_utc"),
                    "expected_band_key": ev.get("expected_band_key"),
                    "source": "scheduled",
                }
            )

    return {
        "learned_stadium_threshold_um_s": round(stad_thresh, 4),
        "learned_concert_threshold_um_s": round(conc_thresh, 4),
        "stadium_event_days_count": len(stadium_event_dates),
        "concert_event_days_count": len(concert_event_dates),
        "detected_event_days": detected_event_days[-14:],
        "hours": [f"{h:02d}h" for h in range(24)],
        "stadium_event_day": stad_ev_curve,
        "stadium_baseline_day": stad_base_curve,
        "concert_event_day": conc_ev_curve,
        "concert_baseline_day": conc_base_curve,
        "predicted_event_windows": predicted_windows[:6],
    }


def compute_forensics_trends(
    rows: list[dict[str, Any]],
    *,
    days: int = 7,
    station_tz: str | timezone | ZoneInfo = "America/Los_Angeles",
    station_lon: float = -122.2491,
    now_ts: float | None = None,
    current_buoy: dict[str, Any] | None = None,
    upcoming_events: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Compute 7D/30D Berkeley Pulse analytics, Light/Normal/Heavy bands, and forecasts."""
    tz = (
        get_station_tz(station_tz, station_lon=station_lon)
        if isinstance(station_tz, str)
        else station_tz
    )
    now_ref = float(now_ts if now_ts is not None else time.time())
    days_clamped = max(1, min(90, int(days)))
    window_sec = days_clamped * 86400.0

    valid_rows = [r for r in rows if _safe_float(r.get("timestamp")) is not None]
    valid_rows.sort(key=lambda r: float(r["timestamp"]))

    window_rows = [r for r in valid_rows if float(r["timestamp"]) >= (now_ref - window_sec)]
    anchored = False
    end_ts = now_ref
    if not window_rows and valid_rows:
        anchored = True
        end_ts = float(valid_rows[-1]["timestamp"])
        window_rows = [r for r in valid_rows if float(r["timestamp"]) >= (end_ts - window_sec)]
    start_ts = end_ts - window_sec

    if window_rows:
        actual_start = float(window_rows[0]["timestamp"])
        actual_end = float(window_rows[-1]["timestamp"])
        span_hours = round(max(0.0, (actual_end - actual_start) / 3600.0), 2)
    else:
        actual_start = start_ts
        actual_end = end_ts
        span_hours = 0.0

    bucket_sec = 900.0 if days_clamped <= 2 else (3600.0 if days_clamped <= 10 else 10800.0)
    thresholds = compute_band_thresholds(valid_rows)
    ocean_model = _fit_ocean_transfer_model(
        window_rows,
        bucket_sec=bucket_sec,
        start_ts=actual_start,
        end_ts=actual_end if window_rows else end_ts,
        current_buoy=current_buoy,
    )
    cultural_model = _build_cultural_diurnal_model(
        window_rows,
        station_tz=tz,
        now_ts=end_ts,
        thresholds=thresholds,
    )
    event_profiles = _build_event_profiles(
        window_rows,
        station_tz=tz,
        thresholds=thresholds,
        upcoming_events=upcoming_events,
    )

    peak_ocean = max(
        (_safe_float(r.get("ocean_microseism_nm_s")) or 0.0 for r in window_rows),
        default=0.0,
    )
    peak_wvht = max(
        (_safe_float(r.get("buoy_wvht_m")) or 0.0 for r in window_rows),
        default=0.0,
    )

    weekday_prof = cultural_model["weekday_profile"]
    quietest_h = min(weekday_prof, key=lambda x: x["cultural_mean"])["hour"]
    busiest_h = max(weekday_prof, key=lambda x: x["cultural_mean"])["hour"]

    return {
        "summary": {
            "total_minutes": len(window_rows),
            "total_history_minutes": len(valid_rows),
            "days_requested": days_clamped,
            "span_hours": span_hours,
            "bucket_minutes": int(bucket_sec // 60),
            "anchored_to_latest_data": anchored,
            "peak_ocean_nm_s": round(peak_ocean, 1),
            "peak_buoy_wvht_m": round(peak_wvht, 2),
            "quietest_hour_local": int(quietest_h),
            "busiest_hour_local": int(busiest_h),
        },
        "band_thresholds": thresholds,
        "ocean_model": ocean_model,
        "cultural_model": cultural_model,
        "event_profiles": event_profiles,
    }
