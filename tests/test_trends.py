"""Tests for Berkeley Pulse 7D/30D forensics trends, learned thresholds, and forecasts."""
from __future__ import annotations

import math
from datetime import datetime
from zoneinfo import ZoneInfo

from eqengine.telemetry.environmental.trends import (
    classify_band_level,
    compute_band_thresholds,
    compute_forensics_trends,
)


def m_idx_phase(idx: int) -> float:
    return (idx % 7) * 0.45


def _make_synthetic_rows(days: int = 10) -> tuple[list[dict], float]:
    tz = ZoneInfo("America/Los_Angeles")
    # Anchor end at a Monday evening so both weekday & weekend hours exist
    end_dt = datetime(2026, 11, 16, 20, 0, tzinfo=tz)
    end_ts = end_dt.timestamp()
    rows: list[dict] = []

    total_hours = days * 24
    for h_back in range(total_hours, 0, -1):
        ts = end_ts - h_back * 3600.0
        dt = datetime.fromtimestamp(ts, tz=tz)
        date_str = dt.strftime("%Y-%m-%d")
        hr = dt.hour
        is_wknd = dt.weekday() >= 5

        # Ocean buoy height & correlated microseism
        wvht = 1.2 + 0.9 * math.sin(h_back / 18.0) ** 2
        dpd = 12.0 + 3.0 * math.cos(h_back / 24.0)
        ocean_nm = 40.0 + 55.0 * ((wvht ** 2) * dpd / 12.0)

        # Diurnal traffic + BART (smooth variation so p25 < p50 < p75 < p95)
        rush = 1.0 if (7 <= hr <= 19 and not is_wknd) else (0.55 if is_wknd else 0.35)
        diurnal_mod = 0.08 * math.sin((hr / 24.0) * 2.0 * math.pi + m_idx_phase(h_back))
        traffic = max(0.02, 0.30 * rush + 0.08 + diurnal_mod)
        rail = 0.22 * rush + 0.02
        cultural = traffic + 0.5 * rail

        # Inject one Cal Stadium Saturday game day & one blind Greek Theatre concert night
        is_game_day = is_wknd and dt.weekday() == 5 and (13 <= hr <= 16)
        stadium = 2.4 if is_game_day else 0.12
        is_concert = dt.weekday() == 4 and (20 <= hr <= 22)
        concert = 1.8 if is_concert else 0.06

        # Log 12 samples per simulated hour so blind >=10 min event-day detection triggers too
        for m in range(12):
            rows.append(
                {
                    "timestamp": ts + m * 60.0,
                    "ocean_microseism_nm_s": ocean_nm,
                    "seismic_swell_s": dpd,
                    "buoy_wvht_m": wvht,
                    "buoy_dpd_s": dpd,
                    "correlation_match_pct": 85.0,
                    "wind_um_s": 0.15,
                    "stadium_um_s": stadium,
                    "rail_um_s": rail,
                    "traffic_um_s": traffic,
                    "human_um_s": 0.08,
                    "concert_um_s": concert,
                    "cultural_noise_um_s": cultural,
                    "ehz_rms_counts": 45.0 * rush + 15.0,
                    "external_event_category": "football" if (is_game_day and date_str) else None,
                }
            )
    return rows, end_ts


def test_band_thresholds_and_classification() -> None:
    rows, _ = _make_synthetic_rows(days=5)
    thresholds = compute_band_thresholds(rows)
    assert "traffic_um_s" in thresholds
    tr_th = thresholds["traffic_um_s"]
    assert tr_th["p25"] <= tr_th["p50"] <= tr_th["p75"] <= tr_th["p95"]

    assert classify_band_level(tr_th["p25"] * 0.5, tr_th) == "LIGHT"
    assert classify_band_level(tr_th["p50"], tr_th) == "NORMAL"
    assert classify_band_level((tr_th["p75"] + tr_th["p95"]) / 2.0, tr_th) == "HEAVY"
    assert classify_band_level(tr_th["p95"] + 1.0, tr_th) == "EXTREME"


def test_compute_forensics_trends_models_and_anchor() -> None:
    rows, end_ts = _make_synthetic_rows(days=10)
    trends = compute_forensics_trends(
        rows,
        days=7,
        now_ts=end_ts,
        current_buoy={"wvht_m": 2.1, "dpd_s": 13.0},
    )

    assert trends["summary"]["days_requested"] == 7
    assert trends["summary"]["anchored_to_latest_data"] is False
    assert trends["summary"]["total_minutes"] > 100

    # Ocean regression should fit strong synthetic linear relationship
    ocean = trends["ocean_model"]
    assert ocean["model_ready"] is True
    assert ocean["r2"] > 0.85
    assert ocean["slope"] > 0.0
    assert ocean["live_predicted_nm_s"] is not None

    # Cultural weekday vs weekend + 24h forecast
    cult = trends["cultural_model"]
    assert len(cult["weekday_profile"]) == 24
    assert len(cult["weekend_profile"]) == 24
    assert len(cult["next_24h_forecast"]) == 24
    assert "z_score" in cult["live_anomaly"]

    # Game & concert separation (tagged football + blind concert)
    ev = trends["event_profiles"]
    assert ev["stadium_event_days_count"] >= 1
    assert ev["concert_event_days_count"] >= 1

    # When querying 30 days in the future, should anchor to latest logged window
    future_trends = compute_forensics_trends(rows, days=7, now_ts=end_ts + 40 * 86400.0)
    assert future_trends["summary"]["anchored_to_latest_data"] is True
    assert future_trends["summary"]["total_minutes"] > 100
