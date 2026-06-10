"""Tests for earthquake magnitude estimation routines.

Validates τ_c (predominant period), P_d (peak displacement),
magnitude formulae, distance from S-P time, and S-arrival prediction.
"""
from __future__ import annotations

import math
from typing import TYPE_CHECKING

import numpy as np
import pytest
from obspy import Trace, UTCDateTime

if TYPE_CHECKING:
    from tests.conftest import TestConfig


# ---------------------------------------------------------------------------
# Pure-function implementations used by tests (mirrors expected API)
# ---------------------------------------------------------------------------
# These are self-contained so the test file runs before the production
# module is written.  Once ``eqengine.magnitude`` exists, swap to imports.
# ---------------------------------------------------------------------------


def _compute_tau_c(
    trace: Trace,
    onset_sample: int,
    window_s: float = 3.0,
) -> float:
    """Compute τ_c (predominant period) from the first *window_s* seconds
    after P-wave onset.

    τ_c = 2π √(∫ẋ² dt / ∫ẍ² dt)

    where ẋ is velocity and ẍ is acceleration (first & second derivative
    of the displacement trace).
    """
    dt = 1.0 / trace.stats.sampling_rate
    win = int(window_s * trace.stats.sampling_rate)
    seg = trace.data[onset_sample : onset_sample + win].astype(np.float64)

    # Velocity = first derivative of displacement
    vel = np.gradient(seg, dt)
    # Acceleration = second derivative
    acc = np.gradient(vel, dt)

    int_vel2 = np.trapezoid(vel ** 2, dx=dt)
    int_acc2 = np.trapezoid(acc ** 2, dx=dt)

    if int_acc2 == 0:
        return 0.0

    return 2.0 * math.pi * math.sqrt(int_vel2 / int_acc2)


def _compute_pd(
    trace: Trace,
    onset_sample: int,
    window_s: float = 3.0,
) -> float:
    """Compute P_d — peak displacement in the first *window_s* seconds
    after P-wave onset.

    Assumes the input trace is already in displacement (or counts
    proportional to displacement).  Returns the maximum absolute
    amplitude.
    """
    win = int(window_s * trace.stats.sampling_rate)
    seg = trace.data[onset_sample : onset_sample + win]
    return float(np.max(np.abs(seg)))


def _magnitude_from_tau_c(tau_c: float) -> float:
    """Empirical magnitude estimate from τ_c.

    M = 6.3 + (1 / 0.798) × log10(τ_c)

    Reference: Kanamori (2005), Wu & Kanamori (2005).
    """
    if tau_c <= 0:
        return 0.0
    return 6.3 + (1.0 / 0.798) * math.log10(tau_c)


def _distance_from_sp_time(sp_seconds: float, vp: float = 6.0, vs: float = 3.5) -> float:
    """Estimate epicentral distance (km) from S-P arrival time gap.

    d = (V_p × V_s) / (V_p − V_s) × Δt
    """
    if vp <= vs:
        raise ValueError("vp must be greater than vs")
    return (vp * vs) / (vp - vs) * sp_seconds


def _predict_s_arrival(
    p_time: UTCDateTime,
    distance_km: float,
    vp: float = 6.0,
    vs: float = 3.5,
) -> UTCDateTime:
    """Predict S-wave arrival time given P-arrival and distance."""
    travel_p = distance_km / vp
    travel_s = distance_km / vs
    # S-P gap
    s_p_gap = travel_s - travel_p
    return p_time + s_p_gap


# ---------------------------------------------------------------------------
# Helpers to build test data
# ---------------------------------------------------------------------------


def _make_displacement_trace(
    freq_hz: float = 1.0,
    amplitude: float = 5000.0,
    duration_s: float = 6.0,
    sampling_rate: float = 100.0,
) -> Trace:
    """Create a simple sinusoidal displacement trace."""
    npts = int(duration_s * sampling_rate)
    t = np.arange(npts) / sampling_rate
    data = amplitude * np.sin(2.0 * np.pi * freq_hz * t)
    header = {
        "sampling_rate": sampling_rate,
        "starttime": UTCDateTime(2025, 1, 15, 12, 0, 0),
        "npts": npts,
        "channel": "EHZ",
        "station": "R1A3D",
        "network": "AM",
        "location": "00",
    }
    return Trace(data=data.astype(np.float64), header=header)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestMagnitudeEstimation:
    """Test suite for magnitude estimation helpers."""

    def test_tau_c_computation(self) -> None:
        """A known sinusoidal input at 1 Hz should yield τ_c ≈ 1.0 s."""
        tr = _make_displacement_trace(freq_hz=1.0, duration_s=6.0)
        onset = 0
        tau_c = _compute_tau_c(tr, onset, window_s=3.0)

        # τ_c of a pure 1 Hz sinusoid should be ~1 s (period)
        assert 0.8 <= tau_c <= 1.2, f"τ_c = {tau_c:.4f}, expected ~1.0 s"

    def test_pd_computation(self) -> None:
        """Peak displacement of a 5 000-count sinusoid should be ~5 000."""
        tr = _make_displacement_trace(amplitude=5000.0, duration_s=6.0)
        onset = 0
        pd = _compute_pd(tr, onset, window_s=3.0)

        assert 4900.0 <= pd <= 5100.0, f"P_d = {pd:.1f}, expected ~5000"

    def test_magnitude_from_tau_c(self) -> None:
        """Verify the empirical τ_c → M formula at several known values."""
        # τ_c = 1.0 s → M ≈ 6.3
        m1 = _magnitude_from_tau_c(1.0)
        assert 6.2 <= m1 <= 6.4, f"M(τ_c=1.0) = {m1:.2f}"

        # τ_c = 0.1 s → M ≈ 6.3 − 1.253 ≈ 5.047
        m2 = _magnitude_from_tau_c(0.1)
        assert 4.9 <= m2 <= 5.2, f"M(τ_c=0.1) = {m2:.2f}"

        # τ_c ≤ 0 → M = 0 (guard)
        assert _magnitude_from_tau_c(0.0) == 0.0
        assert _magnitude_from_tau_c(-1.0) == 0.0

    def test_distance_from_sp_time(self, config: TestConfig) -> None:
        """A 5-second S-P gap should give ~42 km epicentral distance.

        d = (V_p × V_s) / (V_p − V_s) × Δt
          = (6.0 × 3.5) / (6.0 − 3.5) × 5
          = 21.0 / 2.5 × 5
          = 42.0 km
        """
        dist = _distance_from_sp_time(5.0, vp=config.vp, vs=config.vs)
        assert dist == pytest.approx(42.0, abs=0.1)

    def test_s_arrival_prediction(self, config: TestConfig) -> None:
        """Predicted S-arrival should be P-arrival + S-P travel-time gap."""
        p_time = UTCDateTime(2025, 1, 15, 12, 0, 5)  # P at +5 s
        distance_km = 42.0  # from test above

        s_time = _predict_s_arrival(p_time, distance_km, vp=config.vp, vs=config.vs)

        # Expected gap = d/Vs − d/Vp = 42/3.5 − 42/6.0 = 12.0 − 7.0 = 5.0 s
        expected_gap = distance_km / config.vs - distance_km / config.vp
        assert (s_time - p_time) == pytest.approx(expected_gap, abs=0.01)
        assert expected_gap == pytest.approx(5.0, abs=0.01)
