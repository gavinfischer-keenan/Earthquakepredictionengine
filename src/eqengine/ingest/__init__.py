"""
eqengine.ingest — Data ingestion subsystem.

Provides SeedLink and UDP transports for consuming real-time waveform data
from a Raspberry Shake RS4D seismometer.
"""
from __future__ import annotations

from typing import Any

from eqengine.ingest.ring_buffer import RingBuffer
from eqengine.ingest.seedlink_client import SeedLinkClient
from eqengine.ingest.udp_listener import UDPListener
from eqengine.ingest.usgs_poller import USGSPoller

__all__ = [
    "RingBuffer",
    "SeedLinkClient",
    "UDPListener",
    "USGSPoller",
    "create_ingest",
]


def create_ingest(config: Any, ring_buffer: RingBuffer) -> SeedLinkClient | UDPListener:
    """Factory creating the appropriate ingest transport based on configuration."""
    mode = str(getattr(config, "ingest_mode", "seedlink")).lower()
    if mode in ("seedlink", "ingestmode.seedlink"):
        host = getattr(config, "shake_ip", "192.168.4.164")
        port = getattr(config, "seedlink_port", 18000)
        station = getattr(config, "shake_station", getattr(config, "station", "R1A3D"))
        network = getattr(config, "shake_network", getattr(config, "network", "AM"))
        channels = getattr(config, "shake_channels", getattr(config, "channels", ["EHZ", "ENZ", "ENN", "ENE"]))
        server = f"{host}:{port}"
        return SeedLinkClient(
            ring_buffer=ring_buffer,
            server=server,
            station=station,
            network=network,
            channels=channels,
        )
    elif mode in ("udp", "ingestmode.udp"):
        port = int(getattr(config, "udp_port", 8888))
        return UDPListener(
            ring_buffer=ring_buffer,
            port=port,
            host="0.0.0.0",
        )
    else:
        raise ValueError(f"Unknown ingest mode: {mode}")
