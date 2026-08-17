"""
eqengine.web.broadcaster — Real-time WebSocket waveform & alert broadcasting hub.

Maintains active browser connections and broadcasts:
  1. High-rate waveform packets (~10 Hz chunks containing 100 Hz data points)
  2. Instantaneous trigger events & P-wave arrival markers
  3. Earthquake warning alerts and early warning parameters (PGA, PGV, magnitude, distance)
  4. RSAM and station telemetry snapshots
"""
from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from typing import Any

import numpy as np
import structlog
from fastapi import WebSocket

log = structlog.get_logger(__name__)


class WaveformBroadcaster:
    """Thread-safe async WebSocket hub for real-time geophysical telemetry."""

    def __init__(self, max_history: int = 50) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self._event_history: deque[dict[str, Any]] = deque(maxlen=max_history)
        self._alert_history: deque[dict[str, Any]] = deque(maxlen=max_history)
        self._usgs_history: deque[dict[str, Any]] = deque(maxlen=100)
        self._last_status: dict[str, Any] | None = None
        self._latest_ratios: dict[str, float] = {}

    async def connect(self, websocket: WebSocket) -> None:
        """Register a new WebSocket connection and send initial state."""
        await websocket.accept()
        async with self._lock:
            self._clients.add(websocket)
            log.info("broadcaster.client_connected", client=websocket.client.host if websocket.client else "?", total=len(self._clients))

        # Send initial state snapshot
        try:
            init_msg = {
                "type": "init",
                "timestamp": time.time(),
                "recent_events": list(self._event_history),
                "recent_alerts": list(self._alert_history),
                "recent_usgs": list(self._usgs_history),
                "last_status": self._last_status,
            }
            await websocket.send_text(json.dumps(init_msg, default=str))
        except Exception:
            log.exception("broadcaster.init_send_failed")

    async def disconnect(self, websocket: WebSocket) -> None:
        """Unregister a disconnected WebSocket."""
        async with self._lock:
            self._clients.discard(websocket)
            log.info("broadcaster.client_disconnected", total=len(self._clients))

    async def broadcast_waveform(
        self,
        timestamp: float,
        channel_data: dict[str, list[float] | np.ndarray],
        sta_lta_ratios: dict[str, float] | None = None,
    ) -> None:
        """Broadcast real-time waveform samples to all connected clients."""
        if not self._clients:
            return

        formatted_channels: dict[str, list[float]] = {}
        for ch, samples in channel_data.items():
            if isinstance(samples, np.ndarray):
                formatted_channels[ch] = samples.tolist()
            else:
                formatted_channels[ch] = list(samples)

        if sta_lta_ratios:
            self._latest_ratios.update(sta_lta_ratios)

        message = {
            "type": "waveform",
            "timestamp": timestamp,
            "channels": formatted_channels,
            "sta_lta": self._latest_ratios,
        }
        await self._broadcast_json(message)

    async def broadcast_trigger(self, trigger_dict: dict[str, Any]) -> None:
        """Broadcast a trigger event with drop symbology info immediately."""
        self._event_history.append(trigger_dict)
        message = {
            "type": "trigger",
            "timestamp": time.time(),
            "trigger": trigger_dict,
        }
        log.info("broadcaster.trigger_emitted", channel=trigger_dict.get("channel"), sta_lta=trigger_dict.get("peak_sta_lta"))
        await self._broadcast_json(message)

    async def broadcast_alert(self, alert_dict: dict[str, Any]) -> None:
        """Broadcast an earthquake early warning alert immediately."""
        self._alert_history.append(alert_dict)
        message = {
            "type": "alert",
            "timestamp": time.time(),
            "alert": alert_dict,
        }
        log.info("broadcaster.alert_emitted", severity=alert_dict.get("severity"), mag=alert_dict.get("estimated_magnitude"))
        await self._broadcast_json(message)

    async def broadcast_status(self, status_dict: dict[str, Any]) -> None:
        """Broadcast a periodic station health / RSAM telemetry snapshot."""
        self._last_status = status_dict
        message = {
            "type": "status",
            "timestamp": time.time(),
            "status": status_dict,
        }
        await self._broadcast_json(message)

    async def broadcast_usgs_event(self, usgs_dict: dict[str, Any]) -> None:
        """Broadcast a USGS regional/observable earthquake with theoretical arrivals."""
        self._usgs_history.append(usgs_dict)
        message = {
            "type": "usgs_event",
            "timestamp": time.time(),
            "event": usgs_dict,
        }
        log.info(
            "broadcaster.usgs_event_emitted",
            event_id=usgs_dict.get("id"),
            mag=usgs_dict.get("magnitude"),
            place=usgs_dict.get("place"),
            dist_km=usgs_dict.get("distance_km"),
            theor_p=usgs_dict.get("p_arrival"),
        )
        await self._broadcast_json(message)

    async def _broadcast_json(self, data: dict[str, Any]) -> None:
        """Send JSON payload to all active clients, pruning broken sockets."""
        if not self._clients:
            return

        payload = json.dumps(data, default=str)
        dead_clients: list[WebSocket] = []

        # Send concurrently to all clients
        for client in list(self._clients):
            try:
                await client.send_text(payload)
            except Exception:
                dead_clients.append(client)

        if dead_clients:
            async with self._lock:
                for dead in dead_clients:
                    self._clients.discard(dead)

    @property
    def client_count(self) -> int:
        return len(self._clients)

    @property
    def recent_events(self) -> list[dict[str, Any]]:
        return list(self._event_history)

    @property
    def recent_alerts(self) -> list[dict[str, Any]]:
        return list(self._alert_history)

    @property
    def recent_usgs(self) -> list[dict[str, Any]]:
        return list(self._usgs_history)


# ---------------------------------------------------------------------------
# Global singleton
# ---------------------------------------------------------------------------
_broadcaster: WaveformBroadcaster | None = None


def get_broadcaster() -> WaveformBroadcaster:
    """Return the application-wide WaveformBroadcaster singleton."""
    global _broadcaster
    if _broadcaster is None:
        _broadcaster = WaveformBroadcaster()
    return _broadcaster
