"""Tests for validation modules: NoiseModel, MLPicker, and FalsePositiveFilter."""
from __future__ import annotations

import os
import tempfile
import numpy as np
import pytest
from obspy import Trace, UTCDateTime

from eqengine.validation.noise_model import NoiseModel
from eqengine.validation.ml_picker import MLPicker, MLPickResult
from eqengine.validation.false_positive import FalsePositiveFilter, _TriggerLike


class TestNoiseModel:
    def test_from_trace_and_save_load(self):
        rng = np.random.default_rng(123)
        data = rng.normal(0, 20.0, size=1000)
        trace = Trace(
            data=data,
            header={"sampling_rate": 100.0, "starttime": UTCDateTime(2026, 1, 1)},
        )

        model = NoiseModel.from_trace(trace)
        assert pytest.approx(model.baseline_rms, rel=0.1) == 20.0
        assert model.is_noisy(25.0) is False
        assert model.is_noisy(70.0) is True  # > 3 * 20.0

        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
            temp_path = tf.name

        try:
            model.save(temp_path)
            loaded = NoiseModel.load(temp_path)
            assert pytest.approx(loaded.baseline_rms, 0.01) == model.baseline_rms
            assert pytest.approx(loaded.percentile_95, 0.01) == model.percentile_95
            assert len(loaded.baseline_spectrum) == len(model.baseline_spectrum)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)


class TestMLPicker:
    def test_picker_defaults_and_graceful_degradation(self):
        picker = MLPicker(model_name="PhaseNet", p_threshold=0.3)
        assert picker.model_name == "PhaseNet"
        # If seisbench is not installed, validate_p_wave safely returns None
        if not picker.is_available():
            trace = Trace(data=np.zeros(100), header={"sampling_rate": 100.0})
            from obspy import Stream
            stream = Stream([trace])
            result = picker.validate_p_wave(stream, UTCDateTime())
            assert result is None


class TestFalsePositiveFilterDetailed:
    def test_filter_rejection_reasons(self):
        fp = FalsePositiveFilter(min_trigger_duration_sec=1.0)
        trigger = _TriggerLike()
        trigger.on_time = 10.0
        trigger.off_time = 10.2  # 0.2s < 1.0s
        trigger.sta_lta_ratio = 5.0

        trace = Trace(
            data=np.random.normal(0, 10, 1000),
            header={"sampling_rate": 100.0, "starttime": UTCDateTime(0)},
        )
        res = fp.validate(trigger, trace)
        assert res.passed is False
        assert "duration" in res.rejection_reason
