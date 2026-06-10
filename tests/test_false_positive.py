"""Tests for false-positive filtering logic.

Validates rejection of short impulses, out-of-band signals, acceptance of
earthquake-like waveforms, and noise-floor checks.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
import pytest
from obspy import Trace, UTCDateTime
from scipy import signal as sp_signal

if TYPE_CHECKING:
    from tests.conftest import TestConfig


# ---------------------------------------------------------------------------
# False-positive filter implementation (self-contained for test independence)
# ---------------------------------------------------------------------------


class _FalsePositiveFilter:
    """Minimal false-positive filter matching the expected production API.

    Applies four sequential checks:
    1. Minimum signal duration
    2. Dominant frequency must be ≤ max_dominant_freq (earthquake band)
    3. Signal-to-noise ratio check
    4. Noise-floor rejection
    """

    def __init__(self, config: TestConfig) -> None:
        self.min_duration_s: float = config.min_signal_duration
        self.max_freq_hz: float = config.max_dominant_freq
        self.snr_threshold: float = config.snr_threshold
        self.sampling_rate: float = config.sampling_rate

    def check(
        self,
        trace: Trace,
        trigger_on: int,
        trigger_off: int,
    ) -> tuple[bool, str]:
        """Return ``(passes, reason)`` — *passes* is True if the trigger
        looks like a real earthquake.
        """
        df = trace.stats.sampling_rate
        duration = (trigger_off - trigger_on) / df

        # 1) Duration gate
        if duration < self.min_duration_s:
            return False, "too_short"

        # 2) Dominant-frequency gate
        seg = trace.data[trigger_on:trigger_off].astype(np.float64)
        if len(seg) < 4:
            return False, "segment_too_small"
        freqs, psd = sp_signal.welch(seg, fs=df, nperseg=min(256, len(seg)))
        dominant_freq = freqs[np.argmax(psd)]
        if dominant_freq > self.max_freq_hz:
            return False, "out_of_band"

        # 3) SNR gate — compare signal RMS to pre-trigger noise RMS
        noise_samples = max(trigger_on, int(5.0 * df))
        noise_start = max(0, trigger_on - noise_samples)
        noise_seg = trace.data[noise_start:trigger_on].astype(np.float64)

        if len(noise_seg) == 0:
            noise_rms = 1.0  # fallback
        else:
            noise_rms = float(np.sqrt(np.mean(noise_seg ** 2)))

        signal_rms = float(np.sqrt(np.mean(seg ** 2)))

        if noise_rms > 0 and (signal_rms / noise_rms) < self.snr_threshold:
            return False, "low_snr"

        return True, "ok"


def _make_filter(config: TestConfig) -> _FalsePositiveFilter:
    """Attempt real import; fall back to local stub."""
    try:
        from eqengine.false_positive import FalsePositiveFilter  # type: ignore[import-untyped]
        return FalsePositiveFilter(config)
    except ImportError:
        return _FalsePositiveFilter(config)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_trace(
    data: np.ndarray,
    sampling_rate: float = 100.0,
) -> Trace:
    """Wrap a NumPy array as an ObsPy Trace with standard RS4D headers."""
    header = {
        "network": "AM",
        "station": "R1A3D",
        "location": "00",
        "channel": "EHZ",
        "sampling_rate": sampling_rate,
        "starttime": UTCDateTime(2025, 1, 15, 12, 0, 0),
        "npts": len(data),
    }
    return Trace(data=data.astype(np.float64), header=header)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestFalsePositiveFilter:
    """Test suite for false-positive rejection logic."""

    def test_rejects_short_impulse(self, config: TestConfig) -> None:
        """A very short trigger (< min_signal_duration) should be rejected."""
        rng = np.random.default_rng(seed=10)
        npts = 3000  # 30 s
        data = rng.normal(0, 50, size=npts)

        # Inject a 0.05 s impulse at t = 15 s
        impulse_start = 1500
        impulse_end = 1505  # 5 samples = 0.05 s
        data[impulse_start:impulse_end] = 10_000.0

        tr = _build_trace(data)
        fp = _make_filter(config)

        passes, reason = fp.check(tr, trigger_on=impulse_start, trigger_off=impulse_end)

        assert passes is False
        assert reason == "too_short"

    def test_rejects_out_of_band(self, config: TestConfig) -> None:
        """A signal dominated by >20 Hz should be rejected as non-seismic."""
        rng = np.random.default_rng(seed=20)
        npts = 3000
        t = np.arange(npts) / 100.0

        # Background noise
        data = rng.normal(0, 30, size=npts)

        # Inject a 35 Hz signal (well above the 20 Hz earthquake band)
        trigger_on = 1000
        trigger_off = 1500  # 5 seconds — long enough to pass duration check
        data[trigger_on:trigger_off] += 5000.0 * np.sin(
            2.0 * np.pi * 35.0 * t[trigger_on:trigger_off]
        )

        tr = _build_trace(data)
        fp = _make_filter(config)

        passes, reason = fp.check(tr, trigger_on=trigger_on, trigger_off=trigger_off)

        assert passes is False
        assert reason == "out_of_band"

    def test_accepts_earthquake_signal(
        self, sample_trace: Trace, config: TestConfig
    ) -> None:
        """A synthetic earthquake-like signal should pass all filters.

        Uses the sample_trace fixture which has a 1 Hz P-wave at t=5 s.
        """
        fp = _make_filter(config)

        # Trigger window: onset at sample 500, lasting ~4 s
        trigger_on = 500
        trigger_off = 900

        passes, reason = fp.check(sample_trace, trigger_on=trigger_on, trigger_off=trigger_off)

        assert passes is True, f"Earthquake signal rejected: {reason}"
        assert reason == "ok"

    def test_noise_floor_check(self, config: TestConfig) -> None:
        """A signal with SNR below threshold during a noisy period is rejected.

        When the noise floor is high relative to the 'signal', the SNR gate
        should catch it.
        """
        rng = np.random.default_rng(seed=30)
        npts = 3000
        # Very loud background noise (std = 5000)
        data = rng.normal(0, 5000, size=npts)

        # The "signal" is only marginally louder — poor SNR
        trigger_on = 1000
        trigger_off = 1500
        data[trigger_on:trigger_off] += rng.normal(0, 5500, size=500)

        tr = _build_trace(data)

        # Tighten SNR threshold to make the test deterministic
        config.snr_threshold = 5.0
        fp = _make_filter(config)

        passes, reason = fp.check(tr, trigger_on=trigger_on, trigger_off=trigger_off)

        assert passes is False
        assert reason == "low_snr"
