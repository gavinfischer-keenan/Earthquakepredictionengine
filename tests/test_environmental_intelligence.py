"""Tests for NOAA NDBC buoy parsing, 2f microseism correlation, Quiet-Window Hunter, and forensics logging."""
from __future__ import annotations

import asyncio
import csv
import time
from types import SimpleNamespace

import numpy as np
import pytest
from obspy import Trace, UTCDateTime

from eqengine.telemetry.environmental_intelligence import (
    EnvironmentalIntelligenceEngine,
    compute_minute_forensics,
    correlate_ocean_microseism,
    parse_ndbc_realtime_text,
)

_SAMPLE_NDBC_TXT = """#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
2026 11 16 04 30 310  1.5  3.0    MM    MM  13.4  MM 1017.8    MM    MM    MM   MM   MM    MM
2026 11 16 04 20 310  1.0  3.0   5.8    16  13.2 272 1017.7    MM    MM    MM   MM   MM    MM
2026 11 16 03 50  10  3.0  5.0   5.2    MM  12.4 281     MM    MM  18.5    MM   MM   MM    MM
"""


class TestNDBCParserAndCorrelation:
    def test_parses_latest_non_missing_wave_and_wind_fields(self) -> None:
        parsed = parse_ndbc_realtime_text(_SAMPLE_NDBC_TXT, "46026", "San Francisco Bar")
        assert parsed["buoy_id"] == "46026"
        assert parsed["name"] == "San Francisco Bar"
        assert parsed["wspd_mps"] == 1.5
        assert parsed["wvht_m"] == 5.8
        assert parsed["wvht_ft"] == pytest.approx(19.0, abs=0.2)
        assert parsed["dpd_s"] == 16.0
        assert parsed["mwd_deg"] == 272.0
        assert parsed["mwd_cardinal"] == "W"
        assert parsed["expected_df_freq_hz"] == pytest.approx(0.125, abs=0.001)
        assert parsed["wtmp_c"] == 18.5

    def test_correlate_ocean_microseism_locked_vs_wind(self) -> None:
        buoy_swell = {"buoy_id": "46026", "name": "SF Bar", "wvht_m": 5.8, "wvht_ft": 19.0, "dpd_s": 16.0, "wspd_mps": 1.5, "mwd_deg": 272.0, "mwd_cardinal": "W"}
        locked = correlate_ocean_microseism(15.8, 1200.0, 0.5, buoy_swell)
        assert locked["status"] == "LOCKED"
        assert locked["match_pct"] >= 95
        assert locked["delta_period_s"] == pytest.approx(0.2, abs=0.05)

        buoy_wind = {"buoy_id": "46026", "name": "SF Bar", "wvht_m": 0.8, "wvht_ft": 2.6, "dpd_s": 6.0, "wspd_mps": 11.5, "mwd_deg": 320.0, "mwd_cardinal": "NW"}
        windy = correlate_ocean_microseism(17.0, 150.0, 2.8, buoy_wind)
        assert windy["status"] == "WIND_DOMINANT"
        assert windy["match_pct"] < 15


class TestMinuteForensicsAndQuietHunter:
    def test_kurtosis_rejects_impulsive_footstep_minutes(self) -> None:
        rng = np.random.default_rng(42)
        sr = 100.0
        n = 3000  # 30s
        quiet = rng.normal(0.0, 15.0, size=n)
        m_quiet = compute_minute_forensics(quiet, sampling_rate=sr, sta_lta_max=1.1)
        assert abs(m_quiet["kurtosis"]) < 2.5
        assert m_quiet["is_quiet_candidate"] is True

        noisy = quiet.copy()
        noisy[1500:1510] += 800.0  # single sharp door/footstep transient
        m_noisy = compute_minute_forensics(noisy, sampling_rate=sr, sta_lta_max=1.2)
        assert m_noisy["kurtosis"] > 10.0
        assert m_noisy["is_quiet_candidate"] is False

    def test_quiet_hunter_discovers_quiet_window_and_writes_files(self, tmp_path) -> None:
        engine = EnvironmentalIntelligenceEngine(data_dir=tmp_path)
        base_ts = 1794800000.0

        # Populate diurnal samples making 02:00 and 03:00 clearly quietest
        for hour in range(24):
            cultural = 0.08 if hour in (2, 3) else (0.95 if 8 <= hour <= 20 else 0.45)
            asyncio.run(
                engine.record_minute(
                    {
                        "timestamp": base_ts + hour * 60.0,
                        "local_hour": hour,
                        "ehz_rms_counts": 40.0 if hour in (2, 3) else 180.0,
                        "ehz_mad_counts": 35.0,
                        "pga_m_s2": 0.002,
                        "kurtosis": 0.1,
                        "kurtosis_median": 0.05,
                        "sta_lta_max": 1.0,
                        "is_quiet_candidate": True,
                        "cultural_noise_um_s": cultural,
                        "ocean_df_freq_hz": 0.125,
                        "seismic_swell_s": 16.0,
                        "ocean_microseism_nm_s": 800.0,
                        "wind_um_s": 0.2,
                        "stadium_um_s": 0.1,
                        "rail_um_s": 0.1,
                        "traffic_um_s": cultural,
                        "human_um_s": 0.05,
                        "concert_um_s": 0.05,
                        "hv_ratio": 1.4,
                        "hv_peak_hz": 4.2,
                    }
                )
            )

        window_label, best_start, quietest_hour, series = engine.discover_quiet_window()
        assert best_start == 2
        assert quietest_hour in (2, 3)
        assert "02:00–04:00" in window_label
        assert len(series) == 24

        # Verify CSV export persistence
        assert engine.forensics_csv_path.exists()
        with open(engine.forensics_csv_path, encoding="utf-8", newline="") as f:
            rows = list(csv.DictReader(f))
        assert len(rows) == 24
        assert rows[2]["local_hour"] == "2"

        # Verify Quiet-Window Hunter calibrates NoiseModel + quiet_baseline from ring buffer
        rng = np.random.default_rng(7)
        t_data = rng.normal(0.0, 22.0, size=6000)  # 60s @ 100 Hz
        t_data[500:512] += 1200.0  # transient in first 10s should be skipped
        trace = Trace(
            data=t_data,
            header={
                "network": "AM",
                "station": "R1A3D",
                "channel": "EHZ",
                "sampling_rate": 100.0,
                "starttime": UTCDateTime(time.time() - 60),
            },
        )
        rb = SimpleNamespace(get_latest=lambda ch, duration_sec=300.0: trace if ch == "EHZ" else None)

        baseline = asyncio.run(engine.hunt_and_calibrate(rb, force=True))
        assert baseline is not None
        assert engine.noise_model_path.exists()
        assert engine.quiet_baseline_path.exists()
        # Picked clean segment (rms ~22) rather than impulsive first segment
        assert baseline["ehz_rms_counts"] < 35.0
