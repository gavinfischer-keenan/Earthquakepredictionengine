"""UDP Datacast receiver for Raspberry Shake RS4D.

The Raspberry Shake streams waveform data as UDP packets in the format::

    {'CHANNEL', timestamp, s1, s2, …, s25}

Each packet contains 25 integer samples at 100 Hz (0.25 s of data).
This module binds a UDP socket, parses incoming packets, and feeds them
into a :class:`~eqengine.ingest.ring_buffer.RingBuffer`.
"""
from __future__ import annotations

import socket
import threading
import time
from typing import TYPE_CHECKING

import numpy as np
import structlog

if TYPE_CHECKING:
    from eqengine.ingest.ring_buffer import RingBuffer

logger = structlog.get_logger(__name__)

# Maximum expected UDP packet size (generous upper bound).
_MAX_PACKET_BYTES: int = 4096


class UDPListener:
    """Receive Raspberry Shake UDP Datacast packets in a background thread.

    Parameters
    ----------
    ring_buffer:
        Shared :class:`RingBuffer` instance that parsed samples are
        appended to.
    port:
        UDP port to listen on (Raspberry Shake default is ``8888``).
    host:
        Bind address.  ``0.0.0.0`` accepts packets on any interface.
    """

    def __init__(
        self,
        ring_buffer: RingBuffer,
        port: int = 8888,
        host: str = "0.0.0.0",
    ) -> None:
        self._ring_buffer: RingBuffer = ring_buffer
        self._port: int = port
        self._host: str = host

        self._sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._running: bool = False

        # ---- Diagnostics --------------------------------------------------
        self.packet_count: int = 0
        self.dropped_packets: int = 0
        self.last_receive_time: float | None = None

        logger.info(
            "udp_listener.init",
            host=host,
            port=port,
            channels=ring_buffer.channels,
        )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Bind the UDP socket and start the receive loop in a daemon thread."""
        if self._running:
            logger.warning("udp_listener.already_running")
            return

        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.settimeout(1.0)  # allow periodic check of _running flag
        self._sock.bind((self._host, self._port))

        self._running = True
        self._thread = threading.Thread(
            target=self._receive_loop,
            name="udp-listener",
            daemon=True,
        )
        self._thread.start()

        logger.info(
            "udp_listener.started",
            host=self._host,
            port=self._port,
        )

    def stop(self) -> None:
        """Signal the receive loop to stop, close the socket, and join."""
        if not self._running:
            return

        self._running = False

        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

        if self._thread is not None:
            self._thread.join(timeout=5.0)
            self._thread = None

        logger.info(
            "udp_listener.stopped",
            total_packets=self.packet_count,
            dropped=self.dropped_packets,
        )

    # ------------------------------------------------------------------
    # Receive loop
    # ------------------------------------------------------------------

    def _receive_loop(self) -> None:
        """Blocking loop executed inside the daemon thread."""
        log = logger.bind(thread="udp-listener")
        log.debug("udp_listener.loop_enter")

        while self._running:
            try:
                raw, _addr = self._sock.recvfrom(_MAX_PACKET_BYTES)  # type: ignore[union-attr]
            except socket.timeout:
                # Normal — lets us re-check self._running.
                continue
            except OSError:
                # Socket closed by stop().
                if self._running:
                    log.exception("udp_listener.recv_error")
                break

            self.last_receive_time = time.monotonic()

            try:
                self._parse_and_store(raw)
                self.packet_count += 1
            except Exception:
                self.dropped_packets += 1
                log.warning(
                    "udp_listener.malformed_packet",
                    raw=raw[:120],
                    exc_info=True,
                )

        log.debug("udp_listener.loop_exit")

    # ------------------------------------------------------------------
    # Parsing
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_packet(raw: bytes) -> tuple[str, float, np.ndarray]:
        """Parse a raw UDP payload into *(channel, timestamp, samples)*.

        Expected format (ASCII, within curly braces)::

            {'EHZ', 1582315130.292, 17537, 18052, …}

        Returns
        -------
        channel:
            Channel code with surrounding quotes/whitespace stripped.
        timestamp:
            POSIX timestamp of the first sample.
        samples:
            1-D int64 array of sample values.

        Raises
        ------
        ValueError
            If the packet cannot be parsed.
        """
        text = raw.decode("ascii", errors="replace").strip()

        # Strip enclosing braces.
        if text.startswith("{") and text.endswith("}"):
            text = text[1:-1]
        else:
            raise ValueError(f"Packet missing curly braces: {text!r}")

        parts = [p.strip() for p in text.split(",")]
        if len(parts) < 3:
            raise ValueError(
                f"Packet has fewer than 3 fields ({len(parts)}): {text!r}"
            )

        # Channel name — strip surrounding single/double quotes.
        channel = parts[0].strip("'\"")

        # Timestamp.
        timestamp = float(parts[1])

        # Remaining fields are integer sample values.
        samples = np.array([int(s) for s in parts[2:]], dtype=np.int64)

        return channel, timestamp, samples

    def _parse_and_store(self, raw: bytes) -> None:
        """Parse *raw* and append to the ring buffer."""
        channel, timestamp, samples = self._parse_packet(raw)

        # Silently skip channels we are not tracking.
        if channel not in self._ring_buffer._rings:
            return

        self._ring_buffer.append(channel, samples, timestamp)

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------

    @property
    def is_running(self) -> bool:
        """``True`` while the receive loop is active."""
        return self._running

    def __repr__(self) -> str:
        status = "running" if self._running else "stopped"
        return (
            f"<UDPListener {self._host}:{self._port} "
            f"{status} packets={self.packet_count} dropped={self.dropped_packets}>"
        )
