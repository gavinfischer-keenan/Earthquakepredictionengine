"""
eqengine.web — Standalone Geophysical Observatory Web Subsystem.

Provides FastAPI REST endpoints, WebSocket live streaming, and rich geophysical UI.
"""
from __future__ import annotations

from eqengine.web.broadcaster import WaveformBroadcaster, get_broadcaster
from eqengine.web.server import create_app

__all__ = [
    "WaveformBroadcaster",
    "get_broadcaster",
    "create_app",
]
