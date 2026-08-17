"""Tests for eqengine.telemetry.rsam and eqengine.telemetry.health.

Validates RSAM calculation, history rolling window, mean RSAM, and
HealthReporter engine status building and event counting.
"""
from __future__ import annotations

from types import SimpleNamespace
import numpy as np
import pytest

from eqengine.telemetry.rsam import RSAMCalculator
from eqengine.telemetry.health import HealthReporter


class TestRSAMCalculator:
    def test_rsam_compute(self):
        calc = RSAMCalculator(interval_sec=60.0, history_len=5)
        assert calc.get_current_rsam() == 0.0
        assert calc.mean_rsam == 0.0

        # Uniform amplitude 10.0 -> RMS is 10.0
        data = np.full(100, 10.0)
        rms = calc.compute(data)
        assert pytest.approx(rms, 0.01) == 10.0
        assert pytest.approx(calc.get_current_rsam(), 0.01) == 10.0
        assert pytest.approx(calc.mean_rsam, 0.01) == 10.0

    def test_rsam_history_rolling(self):
        calc = RSAMCalculator(history_len=3)
        calc.compute(np.full(10, 2.0))
        calc.compute(np.full(10, 4.0))
        calc.compute(np.full(10, 6.0))
        assert len(calc.history) == 3
        assert pytest.approx(calc.mean_rsam, 0.01) == 4.0

        # Roll over
        calc.compute(np.full(10, 8.0))
        assert len(calc.history) == 3
        assert calc.history == [4.0, 6.0, 8.0]
        assert pytest.approx(calc.mean_rsam, 0.01) == 6.0

    def test_rsam_empty_data(self):
        calc = RSAMCalculator()
        assert calc.compute(np.array([])) == 0.0


class TestHealthReporter:
    def test_health_reporter_build_status(self):
        rsam = RSAMCalculator()
        rsam.compute(np.full(50, 15.0))

        config = SimpleNamespace(
            station="R1A3D",
            ingest_mode="seedlink",
            channels=["EHZ", "ENZ"],
        )
        ring_buffer = SimpleNamespace(
            get_fill_ratios=lambda: {"EHZ": 0.8, "ENZ": 0.8}
        )
        detector = SimpleNamespace(trigger_count=0)

        reporter = HealthReporter(
            config=config,
            ring_buffer=ring_buffer,
            detector=detector,
            rsam_calculator=rsam,
            ml_loaded=False,
        )

        reporter.record_trigger()
        reporter.record_confirmed()

        status = reporter.build_status()
        assert status.status == "online"
        assert status.total_triggers == 1
        assert status.total_confirmed_events == 1
        assert status.rsam_1min == pytest.approx(15.0, 0.01)
        assert status.buffer_health == {"EHZ": 0.8, "ENZ": 0.8}
