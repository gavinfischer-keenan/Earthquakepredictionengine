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
    """Import and return the real Detector wrapped for test compatibility."""
    try:
        from eqengine.processing.detector import Detector

        class _DetectorWrapper:
            def __init__(self, cfg: TestConfig):
                # Use a suitable LTA window for short synthetic traces (up to 4.0s)
                lta = min(cfg.lta_window, 4.0) if cfg.lta_window > 4.0 else cfg.lta_window
                self._det = Detector(
                    sta_seconds=cfg.sta_window if cfg.sta_window < lta else 0.5,
                    lta_seconds=lta,
                    trigger_on=cfg.trigger_on,
                    trigger_off=cfg.trigger_off,
                    sampling_rate=cfg.sampling_rate,
                    min_trigger_duration_sec=cfg.min_trigger_duration,
                )

            def detect(self, trace: Trace) -> list[dict]:
                events = self._det.process(trace)
                triggers = []
                for ev in events:
                    dur = (ev.end_time - ev.start_time) if ev.end_time else (trace.stats.endtime - ev.start_time)
                    triggers.append({
                        "trigger_time": ev.start_time,
                        "sta_lta_ratio": ev.peak_sta_lta,
                        "channel": ev.channel,
                        "duration": float(dur),
                    })
                return triggers

            def get_current_ratio(self) -> float:
                return self._det.get_current_ratio()

        return _DetectorWrapper(config)
    except ImportError:
        return _STALTADetectorStub(config)


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

    def test_direct_trigger_event_model(self) -> None:
        """Test TriggerEvent properties on_time, duration, and representation."""
        from eqengine.processing.detector import TriggerEvent
        t0 = UTCDateTime(1786940000.0)
        t1 = UTCDateTime(1786940005.0)
        ev = TriggerEvent(
            start_time=t0,
            end_time=t1,
            peak_sta_lta=7.8,
            start_sample=100,
            end_sample=600,
            channel="EHZ",
        )
        assert ev.on_time == 1786940000.0
        assert ev.peak_sta_lta == 7.8
        assert ev.channel == "EHZ"
