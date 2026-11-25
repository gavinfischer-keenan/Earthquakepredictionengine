"""Tests for Worden et al. (2012) Modified Mercalli Intensity (MMI) GMICE equations."""
from __future__ import annotations

import numpy as np
import obspy
from obspy import UTCDateTime

from eqengine.processing.intensity import compute_mmi, mmi_from_pga, mmi_from_pgv
from eqengine.processing.magnitude import MagnitudeEstimator


def test_mmi_from_pga_monotonic_and_clamped() -> None:
    assert mmi_from_pga(0.0) == 1.0
    low = mmi_from_pga(0.005)      # 0.5 cm/s² -> weak
    mid = mmi_from_pga(0.5)        # 50 cm/s² -> strong / very strong
    high = mmi_from_pga(10.0)      # 1000 cm/s² -> extreme
    assert 1.0 <= low < mid < high <= 10.0
    assert mmi_from_pga(500.0) == 10.0


def test_mmi_from_pgv_crossover() -> None:
    assert mmi_from_pgv(0.0) == 1.0
    below = mmi_from_pgv(0.01)     # 1 cm/s (log10=0 <= 0.53)
    above = mmi_from_pgv(0.20)     # 20 cm/s (log10=1.30 > 0.53)
    assert 3.0 <= below <= 4.5
    assert above >= 6.5


def test_compute_mmi_metadata_and_defaults() -> None:
    empty = compute_mmi()
    assert empty.mmi == 1.0
    assert empty.roman == "I"
    assert empty.label == "Not Felt"
    assert empty.color == "#ffffff"

    light = compute_mmi(pga_m_s2=0.15, pgv_m_s=0.01)
    assert light.roman in ("III", "IV", "V")
    assert light.pga_cm_s2 == 15.0
    assert light.pgv_cm_s == 1.0

    severe = compute_mmi(pga_m_s2=5.0, pgv_m_s=0.55)
    assert severe.mmi >= 7.5
    assert severe.roman in ("VIII", "IX", "X")
    assert severe.color.startswith("#")


def test_magnitude_estimator_includes_mmi() -> None:
    est = MagnitudeEstimator()
    n = 600
    t = np.linspace(0, 6.0, n, endpoint=False)
    vel_counts = (50000.0 * np.sin(2 * np.pi * 2.5 * t)).astype(np.float64)
    tr = obspy.Trace(
        data=vel_counts,
        header={
            "network": "AM",
            "station": "R1A3D",
            "channel": "EHZ",
            "sampling_rate": 100.0,
            "starttime": UTCDateTime(1795000000.0),
        },
    )
    res = est.estimate(tr, accel_traces=None, p_arrival=UTCDateTime(1795000001.0), window_sec=3.0)
    assert res is not None
    assert 1.0 <= res.mmi <= 10.0
    assert res.mmi_roman in ("I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X")
    assert len(res.mmi_label) > 0
    assert res.mmi_color.startswith("#")
