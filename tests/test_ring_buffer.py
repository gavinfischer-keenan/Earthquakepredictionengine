"""Tests for the RingBuffer — circular sample storage per channel.

Validates append / retrieve semantics, wrap-around behaviour,
thread safety under concurrent writes, and ObsPy Trace conversion.
"""
from __future__ import annotations

import threading
from typing import TYPE_CHECKING

import numpy as np
import pytest
from obspy import Trace

if TYPE_CHECKING:
    from tests.conftest import TestConfig


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestRingBuffer:
    """Test suite for RingBuffer operations."""

    def test_append_and_retrieve(self, ring_buffer, config: TestConfig) -> None:
        """Appending samples then calling get_window returns the correct data."""
        channel = "EHZ"
        samples = np.arange(200, dtype=np.float64)  # 2 seconds @ 100 Hz
        ring_buffer.append(channel, samples)

        window = ring_buffer.get_window(channel, 200)
        np.testing.assert_array_equal(window, samples)

    def test_wrap_around(self, ring_buffer, config: TestConfig) -> None:
        """Filling beyond capacity overwrites the oldest data correctly."""
        channel = "EHZ"
        capacity = int(config.buffer_duration * config.sampling_rate)  # 6000

        # Write capacity + 500 samples so the buffer wraps
        total = capacity + 500
        all_samples = np.arange(total, dtype=np.float64)
        ring_buffer.append(channel, all_samples)

        # The most recent `capacity` samples should be the tail of all_samples
        window = ring_buffer.get_window(channel, capacity)
        expected = all_samples[-capacity:]
        np.testing.assert_array_equal(window, expected)

    def test_thread_safety(self, ring_buffer) -> None:
        """Concurrent appends from multiple threads must not corrupt data."""
        channel = "EHZ"
        n_threads = 8
        samples_per_thread = 500
        errors: list[Exception] = []

        def _writer(thread_id: int) -> None:
            try:
                data = np.full(samples_per_thread, thread_id, dtype=np.float64)
                ring_buffer.append(channel, data)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [
            threading.Thread(target=_writer, args=(i,)) for i in range(n_threads)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(errors) == 0, f"Thread errors: {errors}"

        # Buffer should contain *some* data — exact ordering depends on
        # scheduling, but total written ≤ n_threads × samples_per_thread
        window = ring_buffer.get_window(channel, n_threads * samples_per_thread)
        assert window is not None
        assert len(window) == n_threads * samples_per_thread

    def test_get_trace_returns_obspy_trace(self, ring_buffer) -> None:
        """get_trace must return a valid ObsPy Trace with correct stats."""
        channel = "EHZ"
        ring_buffer.append(channel, np.ones(300, dtype=np.float64))

        tr = ring_buffer.get_trace(channel, 300)

        assert isinstance(tr, Trace)
        assert tr.stats.channel == "EHZ"
        assert tr.stats.station == "R1A3D"
        assert tr.stats.network == "AM"
        assert tr.stats.sampling_rate == 100.0
        assert tr.stats.npts == 300

    def test_fill_ratio(self, ring_buffer, config: TestConfig) -> None:
        """Fill ratio starts at 0 and increases proportionally."""
        channel = "EHZ"
        capacity = int(config.buffer_duration * config.sampling_rate)

        assert ring_buffer.fill_ratio(channel) == pytest.approx(0.0)

        half = capacity // 2
        ring_buffer.append(channel, np.zeros(half, dtype=np.float64))
        assert ring_buffer.fill_ratio(channel) == pytest.approx(0.5, rel=0.01)

        ring_buffer.append(channel, np.zeros(half, dtype=np.float64))
        assert ring_buffer.fill_ratio(channel) == pytest.approx(1.0)

    def test_empty_buffer_returns_zeros(self, ring_buffer) -> None:
        """get_window on an empty buffer returns all zeros."""
        channel = "EHZ"
        window = ring_buffer.get_window(channel, 100)

        np.testing.assert_array_equal(window, np.zeros(100))
