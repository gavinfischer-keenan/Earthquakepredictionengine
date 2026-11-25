"""NOAA NDBC ocean buoy ingestion and 2f ocean microseism correlation."""
from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any

import httpx
import structlog

from eqengine.constants import deg_to_cardinal

log = structlog.get_logger(__name__)

NDBC_BUOYS: tuple[tuple[str, str], ...] = (
    ("46026", "San Francisco Bar"),
    ("46012", "Half Moon Bay"),
)


def _parse_optional_float(token: str) -> float | None:
    """Parse an NDBC token, returning None for missing-data sentinel 'MM'."""
    if not token or token.upper() == "MM":
        return None
    try:
        val = float(token)
    except ValueError:
        return None
    return val if math.isfinite(val) else None


def _row_timestamp_utc(row: list[str], col_map: dict[str, int]) -> str | None:
    """Format NDBC '#YY MM DD hh mm' columns into an ISO-8601 UTC timestamp."""
    keys = ("YY", "MM", "DD", "hh", "mm")
    if not all(k in col_map for k in keys):
        return None
    try:
        yr = int(row[col_map["YY"]])
        mo = int(row[col_map["MM"]])
        dy = int(row[col_map["DD"]])
        hr = int(row[col_map["hh"]])
        mn = int(row[col_map["mm"]])
        return datetime(yr, mo, dy, hr, mn, tzinfo=UTC).isoformat()
    except (ValueError, IndexError):
        return None


def parse_ndbc_realtime_text(text: str, buoy_id: str, name: str) -> dict[str, Any]:
    """Parse an NDBC ``realtime2/<id>.txt`` table cleanly."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    col_names: list[str] = []
    data_rows: list[list[str]] = []

    for ln in lines:
        if ln.startswith("#"):
            stripped = ln.lstrip("#").strip()
            parts = stripped.split()
            if parts and parts[0] in ("YY", "YYYY"):
                col_names = parts
            continue
        data_rows.append(ln.split())
        if len(data_rows) >= 15:
            break

    if not col_names:
        col_names = [
            "YY", "MM", "DD", "hh", "mm",
            "WDIR", "WSPD", "GST", "WVHT", "DPD",
            "APD", "MWD", "PRES", "ATMP", "WTMP",
        ]

    col_map = {col: idx for idx, col in enumerate(col_names)}
    field_spec: dict[str, str] = {
        "WDIR": "wdir_deg",
        "WSPD": "wspd_mps",
        "GST": "gst_mps",
        "WVHT": "wvht_m",
        "DPD": "dpd_s",
        "APD": "apd_s",
        "MWD": "mwd_deg",
        "PRES": "pres_hpa",
        "ATMP": "atmp_c",
        "WTMP": "wtmp_c",
    }

    parsed: dict[str, Any] = {
        "buoy_id": buoy_id,
        "name": name,
        "fetched_at_utc": datetime.now(tz=UTC).isoformat(),
        "obs_time_utc": None,
        "wave_obs_time_utc": None,
        "wdir_deg": None,
        "wspd_mps": None,
        "gst_mps": None,
        "wvht_m": None,
        "wvht_ft": None,
        "dpd_s": None,
        "apd_s": None,
        "mwd_deg": None,
        "mwd_cardinal": None,
        "pres_hpa": None,
        "atmp_c": None,
        "wtmp_c": None,
        "expected_df_freq_hz": None,
    }

    if data_rows:
        parsed["obs_time_utc"] = _row_timestamp_utc(data_rows[0], col_map)

    for row in data_rows:
        for ndbc_col, out_key in field_spec.items():
            if parsed[out_key] is not None:
                continue
            idx = col_map.get(ndbc_col)
            if idx is None or idx >= len(row):
                continue
            val = _parse_optional_float(row[idx])
            if val is not None:
                parsed[out_key] = round(val, 2)
                if ndbc_col in ("WVHT", "DPD") and parsed["wave_obs_time_utc"] is None:
                    parsed["wave_obs_time_utc"] = _row_timestamp_utc(row, col_map)

    if parsed["wvht_m"] is not None:
        parsed["wvht_ft"] = round(float(parsed["wvht_m"]) * 3.28084, 1)
    if parsed["mwd_deg"] is not None:
        parsed["mwd_cardinal"] = deg_to_cardinal(float(parsed["mwd_deg"]))

    period_ref = parsed["dpd_s"] or parsed["apd_s"]
    if period_ref is not None and float(period_ref) > 0:
        parsed["expected_df_freq_hz"] = round(2.0 / float(period_ref), 3)

    return parsed


def correlate_ocean_microseism(
    seismic_swell_s: float,
    ocean_amp_nm_s: float,
    wind_um_s: float,
    buoy: dict[str, Any] | None,
) -> dict[str, Any]:
    """Compare station sub-Hz microseism period against NOAA buoy dominant wave period."""
    t_buoy = None
    if buoy is not None:
        t_buoy = buoy.get("dpd_s") or buoy.get("apd_s")

    if buoy is None or t_buoy is None or float(t_buoy) <= 0.0:
        return {
            "buoy_id": buoy.get("buoy_id") if buoy else None,
            "buoy_name": buoy.get("name") if buoy else None,
            "status": "UNAVAILABLE",
            "regime": "Awaiting NOAA Buoy Feed",
            "match_pct": 0,
            "delta_period_s": None,
            "buoy_wvht_m": buoy.get("wvht_m") if buoy else None,
            "buoy_wvht_ft": buoy.get("wvht_ft") if buoy else None,
            "buoy_dpd_s": None,
            "buoy_wspd_mps": buoy.get("wspd_mps") if buoy else None,
            "buoy_mwd_deg": buoy.get("mwd_deg") if buoy else None,
            "buoy_mwd_cardinal": buoy.get("mwd_cardinal") if buoy else None,
            "expected_df_freq_hz": None,
            "ocean_amp_nm_s": round(float(ocean_amp_nm_s), 1),
        }

    t_buoy_f = float(t_buoy)
    delta_t = abs(float(seismic_swell_s) - t_buoy_f)
    match_pct = max(0, min(100, round(100.0 * math.exp(-((delta_t / 3.5) ** 2)))))

    wvht_m = float(buoy.get("wvht_m") or 0.0)
    wspd_mps = float(buoy.get("wspd_mps") or 0.0)

    if delta_t <= 3.0 and wvht_m >= 1.2:
        status = "LOCKED"
        regime = "Pacific Swell Confirmed (2f Match)"
    elif wspd_mps >= 8.0 or (wind_um_s > 1.5 and wvht_m < 1.2):
        status = "WIND_DOMINANT"
        regime = "Atmospheric / Local Wind Load"
    else:
        status = "PARTIAL"
        regime = "Mixed Swell & Coastal Noise"

    return {
        "buoy_id": buoy.get("buoy_id"),
        "buoy_name": buoy.get("name"),
        "status": status,
        "regime": regime,
        "match_pct": match_pct,
        "delta_period_s": round(delta_t, 2),
        "buoy_wvht_m": buoy.get("wvht_m"),
        "buoy_wvht_ft": buoy.get("wvht_ft"),
        "buoy_dpd_s": round(t_buoy_f, 1),
        "buoy_wspd_mps": buoy.get("wspd_mps"),
        "buoy_mwd_deg": buoy.get("mwd_deg"),
        "buoy_mwd_cardinal": buoy.get("mwd_cardinal"),
        "expected_df_freq_hz": round(2.0 / t_buoy_f, 3),
        "ocean_amp_nm_s": round(float(ocean_amp_nm_s), 1),
    }


async def fetch_ndbc_buoys(buoys: tuple[tuple[str, str], ...] = NDBC_BUOYS) -> dict[str, dict[str, Any]]:
    """Fetch latest real-time NOAA NDBC observations for configured buoys."""
    updated: dict[str, dict[str, Any]] = {}
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            for buoy_id, name in buoys:
                url = f"https://www.ndbc.noaa.gov/data/realtime2/{buoy_id}.txt"
                try:
                    resp = await client.get(url)
                    if resp.status_code == 200 and resp.text:
                        updated[buoy_id] = parse_ndbc_realtime_text(resp.text, buoy_id, name)
                except (httpx.HTTPError, ValueError) as exc:
                    log.warning("env_intel.buoy_fetch_failed", buoy_id=buoy_id, error=str(exc))
    except httpx.HTTPError as exc:
        log.warning("env_intel.ndbc_client_error", error=str(exc))
    return updated
