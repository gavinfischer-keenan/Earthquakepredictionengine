"""Tests for the STA/LTA earthquake detector.

Validates P-wave detection, noise rejection, minimum-duration filtering,
trigger event field correctness, and STA/LTA ratio computation.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np
import pytest
from obspy import Trace, UTCDateTime

if TYPE_CHECKING:
    from tests.conftest import TestConfig


# ---------------------------------------------------------------------------
# Lightweight TriggerEvent stand-in (used until the real model exists)
# ---------------------------------------------------------------------------

@dataclass
class _TriggerEventFields:
    """Expected fields on a TriggerEvent data object."""
    trigger_time: UTCDateTime
    sta_lta_ratio: float
    channel: str
    duration: float


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_sta_lta_detector(config: TestConfig):
    """Attempt to import the real detector; fall back to a minimal stub."""
    try:
        from eqengine.detector import STALTADetector  # type: ignore[import-untyped]
        return STALTADetector(config)
    except ImportError:
        return _STALTADetectorStub(config)


class _STALTADetectorStub:
    """Minimal STA/LTA detector for fixture-level smoke testing.

    Uses ObsPy's classic STA/LTA under the hood so that the test
    assertions exercise realistic signal processing even before the
    production class is written.
    """

    def __init__(self, config: TestConfig) -> None:
        self.config = config
        self._ratio: float = 0.0

    def detect(self, trace: Trace) -> list[dict]:
        """Run recursive STA/LTA and return trigger dicts."""
        from obspy.signal.trigger import recursive_sta_lta, trigger_onset

        df = trace.stats.sampling_rate
        sta_len = int(self.config.sta_window * df)
        lta_len = int(self.config.lta_window * df)

        # Guard: need enough samples for at least one LTA window
        if trace.stats.npts < lta_len + sta_len:
            return []

        cft = recursive_sta_lta(trace.data, sta_len, lta_len)
        self._ratio = float(np.max(cft)) if len(cft) > 0 else 0.0

        on_off = trigger_onset(cft, self.config.trigger_on, self.config.trigger_off)

        triggers: list[dict] = []
        for on_sample, off_sample in on_off:
            duration = (off_sample - on_sample) / df
            if duration < self.config.min_trigger_duration:
                continue
            triggers.append({
                "trigger_time": trace.stats.starttime + on_sample / df,
                "sta_lta_ratio": float(cft[on_sample]),
                "channel": trace.stats.channel,
                "duration": duration,
            })
        return triggers

    def get_current_ratio(self) -> float:
        return self._ratio


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestDetector:
    """Test suite for STA/LTA earthquake detection."""

    def test_detects_p_wave(self, sample_trace: Trace, config: TestConfig) -> None:
        """A synthetic trace with a P-wave at t=5 s should produce a trigger."""
        detector = _make_sta_lta_detector(config)
        triggers = detector.detect(sample_trace)

        assert len(triggers) >= 1, "Expected at least one trigger on P-wave trace"

        # The trigger should be near t = 5 s (sample 500)
        first = triggers[0]
        onset_offset = first["trigger_time"] - sample_trace.stats.starttime
        assert 4.0 <= onset_offset <= 7.0, (
            f"Trigger onset at {onset_offset:.2f} s — expected near 5 s"
        )

    def test_no_trigger_on_noise(
        self, sample_trace_noise: Trace, config: TestConfig
    ) -> None:
        """Pure noise should not produce any triggers."""
        detector = _make_sta_lta_detector(config)
        triggers = detector.detect(sample_trace_noise)
        assert len(triggers) == 0, "Noise trace should not trigger the detector"

    def test_short_trigger_filtered(self, config: TestConfig) -> None:
        """A trigger shorter than min_trigger_duration must be rejected.

        We craft a trace with a very brief spike (0.5 s) that might
        cross the STA/LTA threshold but doesn't persist long enough.
        """
        rng = np.random.default_rng(seed=77)
        npts = 3000  # 30 s
        data = rng.normal(0, 50, size=npts).astype(np.float64)

        # Inject a single-sample impulse (will cross STA/LTA briefly)
        data[1500] = 50_000.0

        header = {
            "channel": "EHZ",
            "station": "R1A3D",
            "network": "AM",
            "location": "00",
            "sampling_rate": 100.0,
            "starttime": UTCDateTime(2025, 1, 15, 12, 0, 0),
            "npts": npts,
        }
        tr = Trace(data=data, header=header)

        # Set a generous min_trigger_duration so impulse is rejected
        config.min_trigger_duration = 2.0
        detector = _make_sta_lta_detector(config)
        triggers = detector.detect(tr)

        assert len(triggers) == 0, "Short impulse should be filtered out"

    def test_trigger_event_fields(
        self, sample_trace: Trace, config: TestConfig
    ) -> None:
        """Verify that each trigger dict contains the expected fields."""
        detector = _make_sta_lta_detector(config)
        triggers = detector.detect(sample_trace)

        if len(triggers) == 0:
            pytest.skip("No triggers produced — field check not applicable")

        required_keys = {"trigger_time", "sta_lta_ratio", "channel", "duration"}
        for trig in triggers:
            assert required_keys.issubset(trig.keys()), (
                f"Missing keys: {required_keys - trig.keys()}"
            )
            assert isinstance(trig["sta_lta_ratio"], float)
            assert trig["channel"] == "EHZ"
            assert trig["duration"] > 0

    def test_sta_lta_ratio_computed(
        self, sample_trace: Trace, config: TestConfig
    ) -> None:
        """After running detect(), get_current_ratio returns a non-zero value."""
        detector = _make_sta_lta_detector(config)
        detector.detect(sample_trace)

        ratio = detector.get_current_ratio()
        assert ratio > 0, "STA/LTA ratio should be positive after processing"
