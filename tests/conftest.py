"""Shared pytest fixtures for EarthquakePredictionEngine test suite.

Provides synthetic seismic traces, UDP packets, configuration objects,
and pre-initialized ring buffers for deterministic, repeatable tests.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np
import pytest
from obspy import Trace, UTCDateTime

if TYPE_CHECKING:
    pass

# ---------------------------------------------------------------------------
# Station metadata (Raspberry Shake RS4D — R1A3D)
# ---------------------------------------------------------------------------
STATION = "R1A3D"
NETWORK = "AM"
LOCATION = "00"
CHANNELS = ["EHZ", "ENZ", "ENN", "ENE"]
SAMPLING_RATE = 100.0  # Hz
LATITUDE = 37.8696
LONGITUDE = -122.2491


# ---------------------------------------------------------------------------
# Lightweight config dataclass used across tests
# ---------------------------------------------------------------------------
@dataclass
class TestConfig:
    """Minimal configuration object mirroring the real app config."""

    station: str = STATION
    network: str = NETWORK
    location: str = LOCATION
    channels: list[str] = field(default_factory=lambda: list(CHANNELS))
    sampling_rate: float = SAMPLING_RATE
    latitude: float = LATITUDE
    longitude: float = LONGITUDE

    # STA/LTA detector params
    sta_window: float = 1.0   # seconds
    lta_window: float = 30.0  # seconds
    trigger_on: float = 3.5
    trigger_off: float = 1.5
    min_trigger_duration: float = 2.0  # seconds

    # Magnitude estimation
    tau_c_window: float = 3.0  # seconds after P-wave
    pd_window: float = 3.0    # seconds after P-wave
    vp: float = 6.0           # km/s  (P-wave velocity)
    vs: float = 3.5           # km/s  (S-wave velocity)

    # Ring buffer
    buffer_duration: float = 60.0  # seconds

    # Alert dispatch
    dashboard_url: str = "http://localhost:8080/api/alerts"
    events_dir: str = "/opt/eqengine/events"

    # False positive filters
    min_signal_duration: float = 1.0   # seconds
    max_dominant_freq: float = 20.0    # Hz
    snr_threshold: float = 3.0


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def config() -> TestConfig:
    """Return a config object with default test parameters."""
    return TestConfig()


@pytest.fixture()
def sample_trace() -> Trace:
    """Create a synthetic ObsPy Trace with a simulated P-wave arrival.

    Specification
    -------------
    * Duration : 10 seconds at 100 Hz (1 000 samples)
    * Background noise : Gaussian, std ≈ 100 counts
    * P-wave onset at t = 5 s (sample 500)
    * Post-arrival amplitude : sharp increase to ~5 000 counts
      with a decaying envelope and ~1 Hz dominant period
    """
    rng = np.random.default_rng(seed=42)
    npts = 1000
    dt = 1.0 / SAMPLING_RATE

    # Background noise
    data = rng.normal(loc=0, scale=100, size=npts).astype(np.float64)

    # P-wave arrival at sample 500
    p_onset = 500
    t_post = np.arange(npts - p_onset) * dt          # time after onset
    envelope = 5000.0 * np.exp(-0.3 * t_post)         # decaying amplitude
    signal = envelope * np.sin(2.0 * np.pi * 1.0 * t_post)  # 1 Hz dominant
    data[p_onset:] += signal

    header = {
        "network": NETWORK,
        "station": STATION,
        "location": LOCATION,
        "channel": "EHZ",
        "sampling_rate": SAMPLING_RATE,
        "starttime": UTCDateTime(2025, 1, 15, 12, 0, 0),
        "npts": npts,
    }
    return Trace(data=data, header=header)


@pytest.fixture()
def sample_trace_noise() -> Trace:
    """Create a pure noise trace — 30 seconds at 100 Hz.

    Random normal distribution, std = 50, no coherent signal.
    Useful for verifying that detectors do *not* trigger on noise.
    """
    rng = np.random.default_rng(seed=99)
    npts = 3000  # 30 s × 100 Hz

    data = rng.normal(loc=0, scale=50, size=npts).astype(np.float64)

    header = {
        "network": NETWORK,
        "station": STATION,
        "location": LOCATION,
        "channel": "EHZ",
        "sampling_rate": SAMPLING_RATE,
        "starttime": UTCDateTime(2025, 1, 15, 12, 0, 0),
        "npts": npts,
    }
    return Trace(data=data, header=header)


@pytest.fixture()
def sample_udp_packet() -> str:
    """Return a sample RS4D UDP packet string for channel EHZ.

    Format: ``{'CHANNEL', timestamp, s1, s2, ..., s25}``

    The packet contains 25 integer samples typical of a Raspberry Shake
    data stream at 100 Hz (25 samples → 0.25 s per packet).
    """
    timestamp = 1582315130.292
    samples = [
        17537, 18052, 17477, 17528, 17631,
        17297, 17360, 17818, 17611, 17555,
        17402, 17388, 17501, 17629, 17784,
        17893, 17671, 17448, 17325, 17486,
        17623, 17711, 17579, 17492, 17380,
    ]
    sample_str = ", ".join(str(s) for s in samples)
    return f"{{'EHZ', {timestamp}, {sample_str}}}"


@pytest.fixture()
def ring_buffer(config: TestConfig):
    """Return a pre-initialized RingBuffer with 60 s capacity.

    Falls back to a lightweight stub if the real RingBuffer class is
    not yet implemented, so that downstream tests can still import
    this fixture without import errors.
    """
    try:
        from eqengine.ring_buffer import RingBuffer  # type: ignore[import-untyped]

        return RingBuffer(
            duration_s=config.buffer_duration,
            sampling_rate=config.sampling_rate,
            channels=config.channels,
        )
    except ImportError:
        # Provide a minimal stub so conftest itself doesn't blow up
        # before the implementation exists.
        return _RingBufferStub(
            duration_s=config.buffer_duration,
            sampling_rate=config.sampling_rate,
            channels=list(config.channels),
        )


# ---------------------------------------------------------------------------
# Stub for RingBuffer (used only when the real class isn't importable yet)
# ---------------------------------------------------------------------------

class _RingBufferStub:
    """Minimal ring-buffer stand-in for early-stage testing."""

    def __init__(
        self,
        duration_s: float,
        sampling_rate: float,
        channels: list[str],
    ) -> None:
        self.duration_s = duration_s
        self.sampling_rate = sampling_rate
        self.channels = channels
        capacity = int(duration_s * sampling_rate)
        self._buffers: dict[str, np.ndarray] = {
            ch: np.zeros(capacity, dtype=np.float64) for ch in channels
        }
        self._write_pos: dict[str, int] = {ch: 0 for ch in channels}
        self._count: dict[str, int] = {ch: 0 for ch in channels}

    # -- public API matching the expected RingBuffer interface --

    def append(self, channel: str, samples: np.ndarray) -> None:
        """Append *samples* to the named channel's circular buffer."""
        buf = self._buffers[channel]
        cap = len(buf)
        for s in np.atleast_1d(samples):
            buf[self._write_pos[channel] % cap] = s
            self._write_pos[channel] += 1
            self._count[channel] = min(self._count[channel] + 1, cap)

    def get_window(self, channel: str, num_samples: int) -> np.ndarray:
        """Return the most recent *num_samples* from the channel."""
        buf = self._buffers[channel]
        cap = len(buf)
        count = self._count[channel]
        actual = min(num_samples, count)
        if actual == 0:
            return np.zeros(num_samples, dtype=np.float64)
        end = self._write_pos[channel] % cap
        indices = [(end - actual + i) % cap for i in range(actual)]
        result = buf[indices]
        if actual < num_samples:
            padded = np.zeros(num_samples, dtype=np.float64)
            padded[-actual:] = result
            return padded
        return result

    def get_trace(self, channel: str, num_samples: int) -> Trace:
        """Return an ObsPy Trace for the requested window."""
        data = self.get_window(channel, num_samples)
        header = {
            "network": NETWORK,
            "station": STATION,
            "location": LOCATION,
            "channel": channel,
            "sampling_rate": self.sampling_rate,
            "starttime": UTCDateTime() - num_samples / self.sampling_rate,
            "npts": len(data),
        }
        return Trace(data=data, header=header)

    def fill_ratio(self, channel: str) -> float:
        """Return fraction of buffer filled (0.0 – 1.0)."""
        cap = len(self._buffers[channel])
        return self._count[channel] / cap
