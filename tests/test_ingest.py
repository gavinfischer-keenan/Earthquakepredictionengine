"""Tests for eqengine.ingest modules: UDPListener and SeedLink stub."""
from __future__ import annotations

import numpy as np
import pytest

from eqengine.ingest.ring_buffer import RingBuffer
from eqengine.ingest.udp_listener import UDPListener


class TestUDPParsing:
    def test_parse_valid_packet(self):
        packet = b"{'EHZ', 1582315130.292, 100, 200, 300, -50}"
        ch, ts, samples = UDPListener._parse_packet(packet)
        assert ch == "EHZ"
        assert ts == pytest.approx(1582315130.292, 0.001)
        assert np.array_equal(samples, np.array([100, 200, 300, -50]))

    def test_parse_invalid_packet_missing_braces(self):
        packet = b"'EHZ', 1582315130.292, 100, 200"
        with pytest.raises(ValueError, match="missing curly braces"):
            UDPListener._parse_packet(packet)

    def test_parse_invalid_packet_insufficient_fields(self):
        packet = b"{'EHZ', 1582315130.292}"
        with pytest.raises(ValueError, match="fewer than 3 fields"):
            UDPListener._parse_packet(packet)

    def test_udp_listener_store_into_ring_buffer(self):
        buf = RingBuffer(channels=["EHZ"], buffer_duration_sec=10, sampling_rate=100)
        listener = UDPListener(ring_buffer=buf, port=9999)

        packet = b"{'EHZ', 1582315130.292, 10, 20, 30, 40}"
        listener._parse_and_store(packet)

        retrieved, start_time = buf.get_window("EHZ", 4)
        assert np.array_equal(retrieved, np.array([10.0, 20.0, 30.0, 40.0]))
