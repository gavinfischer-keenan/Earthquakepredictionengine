"""Tests for eqengine.processing.preprocessor.

Validates bandpass filtering, displacement integration, Hilbert envelope
computation, and error handling for empty traces or bad parameters.
"""
from __future__ import annotations

import numpy as np
import pytest
from obspy import Trace, UTCDateTime

from eqengine.processing.preprocessor import (
    preprocess,
    preprocess_for_displacement,
    compute_envelope,
)


@pytest.fixture
def raw_test_trace() -> Trace:
    rng = np.random.default_rng(42)
    npts = 1000
    data = 100.0 + rng.normal(0, 50, size=npts)  # Mean offset + noise
    header = {
        "network": "AM",
        "station": "R1A3D",
        "location": "00",
        "channel": "EHZ",
        "sampling_rate": 100.0,
        "starttime": UTCDateTime(2026, 1, 1, 0, 0, 0),
        "npts": npts,
    }
    return Trace(data=data, header=header)


class TestPreprocessor:
    def test_preprocess_demeans_and_filters(self, raw_test_trace: Trace):
        filtered = preprocess(raw_test_trace, bandpass_low=1.0, bandpass_high=10.0)
        assert filtered is not raw_test_trace
        assert len(filtered.data) == len(raw_test_trace.data)
        assert np.abs(np.mean(filtered.data)) < 1.0  # Demeaned

    def test_preprocess_empty_trace_raises(self):
        empty_tr = Trace(data=np.array([]), header={"sampling_rate": 100.0})
        with pytest.raises(ValueError, match="empty trace"):
            preprocess(empty_tr)

    def test_preprocess_invalid_corners_raises(self, raw_test_trace: Trace):
        with pytest.raises(ValueError, match="must be less than"):
            preprocess(raw_test_trace, bandpass_low=10.0, bandpass_high=2.0)

    def test_preprocess_for_displacement(self, raw_test_trace: Trace):
        disp = preprocess_for_displacement(raw_test_trace)
        assert disp is not raw_test_trace
        assert len(disp.data) == len(raw_test_trace.data)

    def test_compute_envelope(self, raw_test_trace: Trace):
        env = compute_envelope(raw_test_trace)
        assert isinstance(env, np.ndarray)
        assert len(env) == len(raw_test_trace.data)
        assert np.all(env >= 0)  # Envelope is non-negative
