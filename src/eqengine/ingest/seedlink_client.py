"""SeedLink client for streaming waveform data via ObsPy.

Connects to a SeedLink server (local Raspberry Shake or remote IRIS/FDSN),
selects the configured station/channels, and pushes arriving
:class:`~obspy.core.trace.Trace` objects into a shared
:class:`~eqengine.ingest.ring_buffer.RingBuffer`.

Auto-reconnect
~~~~~~~~~~~~~~
On any disconnection or network error the client waits using exponential
back-off (1 s → 2 s → 4 s → … → 30 s cap) before attempting to reconnect.
"""
from __future__ import annotations

import threading
import time
from typing import TYPE_CHECKING

import numpy as np
import structlog
from obspy import Trace
from obspy.clients.seedlink.easyseedlink import create_client

if TYPE_CHECKING:
    from collections.abc import Sequence

    from eqengine.ingest.ring_buffer import RingBuffer

logger = structlog.get_logger(__name__)

# Exponential back-off parameters (seconds).
_BACKOFF_INITIAL: float = 1.0
_BACKOFF_FACTOR: float = 2.0
_BACKOFF_MAX: float = 30.0


class SeedLinkClient:
    """Stream waveform data from a SeedLink server into a RingBuffer.

    Parameters
    ----------
    ring_buffer:
        Shared :class:`RingBuffer` instance that incoming samples are
        appended to.
    server:
        SeedLink server address, e.g. ``"192.168.1.100:18000"`` or
        ``"rtserve.iris.washington.edu:18000"``.
    station:
        SEED station code, e.g. ``"R4989"``.
    network:
        SEED network code, e.g. ``"AM"``.
    channels:
        List of SEED channel codes to subscribe to,
        e.g. ``["EHZ", "ENZ", "ENN", "ENE"]``.
    """

    def __init__(
        self,
        ring_buffer: RingBuffer,
        server: str,
        station: str,
        network: str = "AM",
        channels: Sequence[str] | None = None,
    ) -> None:
        self._ring_buffer: RingBuffer = ring_buffer
        self._server: str = server
        self._station: str = station
        self._network: str = network
        self._channels: tuple[str, ...] = tuple(
            channels if channels is not None else ring_buffer.channels
        )

        self._thread: threading.Thread | None = None
        self._running: bool = False
        self._stop_event: threading.Event = threading.Event()

        # ---- Diagnostics --------------------------------------------------
        self.connection_status: str = "disconnected"
        self.reconnect_count: int = 0
        self.last_data_time: float | None = None

        logger.info(
            "seedlink_client.init",
            server=server,
            network=network,
            station=station,
            channels=self._channels,
        )

    # ------------------------------------------------------------------
    # Callback
    # ------------------------------------------------------------------

    def _on_data(self, trace: Trace) -> None:
        """Callback invoked by the EasySeedLinkClient for each data packet.

        Extracts the channel code and numpy array from the ObsPy Trace and
        appends into the shared ring buffer.
        """
        channel: str = trace.stats.channel
        timestamp: float = float(trace.stats.starttime.timestamp)
        samples: np.ndarray = trace.data.astype(np.float64)

        # Skip channels we are not tracking.
        if channel not in self._ring_buffer._rings:
            return

        self._ring_buffer.append(channel, samples, timestamp)
        self.last_data_time = time.monotonic()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the SeedLink connection loop in a daemon thread."""
        if self._running:
            logger.warning("seedlink_client.already_running")
            return

        self._running = True
        self._stop_event.clear()

        self._thread = threading.Thread(
            target=self._connection_loop,
            name="seedlink-client",
            daemon=True,
        )
        self._thread.start()

        logger.info(
            "seedlink_client.started",
            server=self._server,
            station=self._station,
        )

    def stop(self) -> None:
        """Signal the connection loop to stop and join the thread."""
        if not self._running:
            return

        self._running = False
        self._stop_event.set()

        if self._thread is not None:
            self._thread.join(timeout=10.0)
            self._thread = None

        self.connection_status = "stopped"
        logger.info(
            "seedlink_client.stopped",
            reconnects=self.reconnect_count,
        )

    # ------------------------------------------------------------------
    # Connection loop with auto-reconnect
    # ------------------------------------------------------------------

    def _connection_loop(self) -> None:
        """Blocking loop that (re-)connects to the SeedLink server."""
        log = logger.bind(thread="seedlink-client")
        backoff: float = _BACKOFF_INITIAL

        while self._running:
            try:
                log.info(
                    "seedlink_client.connecting",
                    server=self._server,
                    attempt=self.reconnect_count + 1,
                )
                self.connection_status = "connecting"

                # Build selector strings.  SeedLink selection is
                # "NETWORK STATION:CHANNEL" — the EasySeedLinkClient
                # helper uses ``select_stream(network, station, selector)``
                # where *selector* is just the channel code (e.g. "EHZ").
                client = create_client(self._server, self._on_data)

                for ch in self._channels:
                    client.select_stream(self._network, self._station, ch)

                self.connection_status = "connected"
                backoff = _BACKOFF_INITIAL  # reset on successful connection
                log.info("seedlink_client.connected", server=self._server)

                # run() blocks until the server closes the connection or an
                # error occurs.
                client.run()

            except Exception:
                if not self._running:
                    # Intentional shutdown — don't log as error.
                    break

                self.connection_status = "disconnected"
                self.reconnect_count += 1
                log.warning(
                    "seedlink_client.disconnected",
                    reconnect_count=self.reconnect_count,
                    backoff_seconds=backoff,
                    exc_info=True,
                )

                # Wait with exponential back-off, but honour early stop.
                if self._stop_event.wait(timeout=backoff):
                    break
                backoff = min(backoff * _BACKOFF_FACTOR, _BACKOFF_MAX)

        log.debug("seedlink_client.loop_exit")

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------

    @property
    def is_running(self) -> bool:
        """``True`` while the connection loop is active."""
        return self._running

    def __repr__(self) -> str:
        return (
            f"<SeedLinkClient {self._network}.{self._station}@{self._server} "
            f"status={self.connection_status} "
            f"reconnects={self.reconnect_count}>"
        )
