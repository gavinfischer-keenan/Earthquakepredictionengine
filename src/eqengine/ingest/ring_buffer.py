"""Thread-safe circular waveform buffer backed by pre-allocated NumPy arrays.

Each channel owns an independent ring of shape ``(buffer_samples,)`` where
*buffer_samples = buffer_duration_sec × sampling_rate*.  Concurrent access
from producer threads (UDP listener, SeedLink client) and consumer threads
(STA/LTA, feature extraction) is serialised with a per-channel
:class:`threading.Lock`.

Gap handling
~~~~~~~~~~~~
If a newly appended batch has a timestamp that diverges from the expected
next timestamp by more than ``2 / sampling_rate`` seconds, the intervening
gap is zero-filled and a warning is emitted via *structlog*.
"""
from __future__ import annotations

import threading
from typing import TYPE_CHECKING

import numpy as np
import structlog
from obspy import Trace, UTCDateTime

if TYPE_CHECKING:
    from collections.abc import Sequence

logger = structlog.get_logger(__name__)

# Default seconds of data required before the buffer reports ready.
_DEFAULT_LTA_SECONDS: int = 30


class _ChannelRing:
    """Internal storage for a single channel's ring buffer.

    Not part of the public API — always access through :class:`RingBuffer`.
    """

    __slots__ = (
        "name",
        "buf",
        "capacity",
        "write_pos",
        "total_written",
        "last_timestamp",
        "sampling_rate",
        "lock",
    )

    def __init__(self, name: str, capacity: int, sampling_rate: int) -> None:
        self.name: str = name
        self.capacity: int = capacity
        self.buf: np.ndarray = np.zeros(capacity, dtype=np.float64)
        self.write_pos: int = 0
        self.total_written: int = 0
        self.last_timestamp: float | None = None
        self.sampling_rate: int = sampling_rate
        self.lock: threading.Lock = threading.Lock()


class RingBuffer:
    """Rolling waveform buffer for multiple channels.

    Parameters
    ----------
    channels:
        List of channel codes (e.g. ``["EHZ", "ENZ", "ENN", "ENE"]``).
    buffer_duration_sec:
        How many seconds of data each ring should hold.
    sampling_rate:
        Expected sample rate in Hz (default 100 for Raspberry Shake).
    network:
        SEED network code written into ObsPy Trace headers.
    station:
        SEED station code written into ObsPy Trace headers.
    lta_seconds:
        Minimum seconds of data required for :meth:`is_ready` to return
        ``True``.  Defaults to ``30``.
    """

    def __init__(
        self,
        channels: Sequence[str],
        buffer_duration_sec: int = 600,
        sampling_rate: int = 100,
        *,
        network: str = "AM",
        station: str = "R1A3D",
        lta_seconds: int = _DEFAULT_LTA_SECONDS,
    ) -> None:
        if not channels:
            raise ValueError("channels must not be empty")
        if buffer_duration_sec <= 0:
            raise ValueError("buffer_duration_sec must be positive")
        if sampling_rate <= 0:
            raise ValueError("sampling_rate must be positive")

        self.channels: tuple[str, ...] = tuple(channels)
        self.buffer_duration_sec: int = buffer_duration_sec
        self.sampling_rate: int = sampling_rate
        self.network: str = network
        self.station: str = station
        self.lta_seconds: int = lta_seconds

        capacity = buffer_duration_sec * sampling_rate
        self._rings: dict[str, _ChannelRing] = {
            ch: _ChannelRing(ch, capacity, sampling_rate) for ch in channels
        }

        logger.info(
            "ring_buffer.init",
            channels=self.channels,
            capacity_samples=capacity,
            buffer_duration_sec=buffer_duration_sec,
            sampling_rate=sampling_rate,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ring(self, channel: str) -> _ChannelRing:
        """Return the ring for *channel*, raising ``KeyError`` if unknown."""
        try:
            return self._rings[channel]
        except KeyError:
            raise KeyError(
                f"Unknown channel '{channel}'. "
                f"Registered channels: {self.channels}"
            ) from None

    @staticmethod
    def _write_into_ring(ring: _ChannelRing, data: np.ndarray) -> None:
        """Write *data* into *ring*, wrapping around as needed.

        Caller **must** hold ``ring.lock``.
        """
        n = len(data)
        if n == 0:
            return

        capacity = ring.capacity
        start = ring.write_pos

        if start + n <= capacity:
            # Fast path — no wrap.
            ring.buf[start : start + n] = data
        else:
            # Two-part copy around the boundary.
            first = capacity - start
            ring.buf[start:capacity] = data[:first]
            ring.buf[: n - first] = data[first:]

        ring.write_pos = (start + n) % capacity
        ring.total_written += n

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def append(self, channel: str, samples: np.ndarray, timestamp: float) -> None:
        """Append *samples* to *channel*'s ring buffer.

        Parameters
        ----------
        channel:
            SEED channel code, must be one of the registered channels.
        samples:
            1-D array of new sample values (float or int — will be cast).
        timestamp:
            POSIX timestamp of the **first** sample in *samples*.
        """
        ring = self._ring(channel)
        data = np.asarray(samples, dtype=np.float64).ravel()
        n_samples = len(data)
        if n_samples == 0:
            return

        with ring.lock:
            # ----------------------------------------------------------
            # Gap detection & zero-fill
            # ----------------------------------------------------------
            if ring.last_timestamp is not None:
                expected_ts = ring.last_timestamp + (1.0 / ring.sampling_rate)
                gap = timestamp - expected_ts
                gap_threshold = 2.0 / ring.sampling_rate  # 20 ms at 100 Hz

                if gap > gap_threshold:
                    gap_samples = int(round(gap * ring.sampling_rate))
                    # Clamp to capacity so we don't allocate absurdly.
                    gap_samples = min(gap_samples, ring.capacity)
                    logger.warning(
                        "ring_buffer.gap_detected",
                        channel=channel,
                        gap_seconds=round(gap, 6),
                        gap_samples=gap_samples,
                        expected_ts=expected_ts,
                        received_ts=timestamp,
                    )
                    zeros = np.zeros(gap_samples, dtype=np.float64)
                    self._write_into_ring(ring, zeros)

            # ----------------------------------------------------------
            # Write actual samples
            # ----------------------------------------------------------
            self._write_into_ring(ring, data)

            # Update last_timestamp to the timestamp of the *last* sample
            # so the next expected timestamp is one sample period later.
            ring.last_timestamp = timestamp + (n_samples - 1) / ring.sampling_rate

    def get_window(
        self, channel: str, seconds: float
    ) -> tuple[np.ndarray, float]:
        """Return the most recent *seconds* of data.

        Returns
        -------
        data:
            1-D float64 array of length ``min(requested, available)`` samples.
        start_timestamp:
            POSIX timestamp of the first sample in the returned window.
            ``0.0`` if no data has been written yet.
        """
        ring = self._ring(channel)

        with ring.lock:
            available = min(ring.total_written, ring.capacity)
            requested = int(seconds * ring.sampling_rate)
            n = min(requested, available)

            if n == 0:
                return np.empty(0, dtype=np.float64), 0.0

            # Copy out of the ring (may wrap).
            end = ring.write_pos  # one past last written
            start = (end - n) % ring.capacity

            if start < end:
                window = ring.buf[start:end].copy()
            else:
                window = np.concatenate(
                    (ring.buf[start:], ring.buf[:end])
                ).copy()

            # Compute start timestamp from last_timestamp.
            if ring.last_timestamp is not None:
                start_ts = ring.last_timestamp - (available - 1) / ring.sampling_rate
                # Adjust for the offset within the available data.
                start_ts += (available - n) / ring.sampling_rate
            else:
                start_ts = 0.0

        return window, start_ts

    def get_trace(self, channel: str, seconds: float) -> Trace:
        """Return an ObsPy :class:`~obspy.core.trace.Trace`.

        The trace header is populated with *network*, *station*, *channel*,
        *sampling_rate*, and the correct *starttime*.
        """
        data, start_ts = self.get_window(channel, seconds)
        tr = Trace(data=data)
        tr.stats.network = self.network
        tr.stats.station = self.station
        tr.stats.channel = channel
        tr.stats.sampling_rate = float(self.sampling_rate)
        tr.stats.starttime = UTCDateTime(start_ts) if start_ts > 0.0 else UTCDateTime(0)
        return tr

    def get_fill_ratio(self, channel: str) -> float:
        """Fraction of the ring buffer that has been written (0.0–1.0)."""
        ring = self._ring(channel)
        with ring.lock:
            return min(ring.total_written / ring.capacity, 1.0)

    def is_ready(self, channel: str) -> bool:
        """``True`` once at least :attr:`lta_seconds` of data have been buffered."""
        ring = self._ring(channel)
        min_samples = self.lta_seconds * ring.sampling_rate
        with ring.lock:
            return ring.total_written >= min_samples

    # ------------------------------------------------------------------
    # Convenience / diagnostics
    # ------------------------------------------------------------------

    def __repr__(self) -> str:
        fills = {ch: f"{self.get_fill_ratio(ch):.1%}" for ch in self.channels}
        return (
            f"<RingBuffer channels={self.channels} "
            f"buf={self.buffer_duration_sec}s "
            f"sr={self.sampling_rate}Hz fill={fills}>"
        )
