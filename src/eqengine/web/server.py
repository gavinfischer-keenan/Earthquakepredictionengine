"""
eqengine.web.server — FastAPI web application for EarthquakePredictionEngine.

Provides:
  1. Interactive standalone single-page Observatory Web App (HTML/Canvas/JS).
  2. High-speed WebSocket stream at `/ws/live` for continuous 100 Hz waveforms and instant warning symbology.
  3. REST API for station health, recent alerts, buffer queries, and simulated trigger testing.
"""
from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Any

import structlog
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from eqengine import __version__
from eqengine.config import get_config
from eqengine.web.broadcaster import get_broadcaster

log = structlog.get_logger(__name__)

STATIC_DIR = Path(__file__).parent / "static"


def create_app(ring_buffer: Any = None, detector: Any = None) -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="EarthquakePredictionEngine Observatory",
        description="Real-Time Seismic Early Warning & Waveform Observatory",
        version=__version__,
    )

    # Enable CORS for local development & internal LAN access
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    broadcaster = get_broadcaster()
    config = get_config()

    # ------------------------------------------------------------------
    # REST API Routes
    # ------------------------------------------------------------------

    @app.get("/api/status")
    async def get_status() -> dict[str, Any]:
        """Return station metadata, engine health, and active connections."""
        buffer_health: dict[str, float] = {}
        if ring_buffer is not None and hasattr(ring_buffer, "get_fill_ratios"):
            buffer_health = ring_buffer.get_fill_ratios()

        return {
            "station": config.shake_station,
            "network": config.shake_network,
            "primary_channel": config.shake_channel,
            "channels": config.shake_channels if isinstance(config.shake_channels, list) else [ch.strip() for ch in config.shake_channels.split(",")],
            "station_lat": config.station_lat,
            "station_lon": config.station_lon,
            "station_elevation": config.station_elevation,
            "sampling_rate": config.sampling_rate,
            "ingest_mode": str(config.ingest_mode),
            "shake_ip": config.shake_ip,
            "connected_clients": broadcaster.client_count,
            "buffer_health": buffer_health,
            "version": __version__,
            "timestamp": time.time(),
        }

    @app.get("/api/events")
    async def get_events() -> dict[str, Any]:
        """Return recently detected triggers and earthquake alerts."""
        return {
            "triggers": broadcaster.recent_events,
            "alerts": broadcaster.recent_alerts,
            "timestamp": time.time(),
        }

    @app.get("/api/buffer/{channel}")
    async def get_channel_buffer(channel: str, duration: float = 60.0) -> dict[str, Any]:
        """Return a snapshot of the most recent *duration* seconds for *channel*."""
        if ring_buffer is None:
            raise HTTPException(status_code=503, detail="RingBuffer not initialized")

        trace = ring_buffer.get_latest(channel.upper(), duration_sec=duration)
        if trace is None:
            raise HTTPException(status_code=404, detail=f"Channel {channel} not available")

        return {
            "channel": channel.upper(),
            "starttime": float(trace.stats.starttime.timestamp),
            "sampling_rate": float(trace.stats.sampling_rate),
            "npts": len(trace.data),
            "samples": trace.data.tolist(),
        }

    @app.post("/api/simulate-trigger")
    async def simulate_trigger(magnitude: float = 3.5, distance_km: float = 25.0) -> dict[str, Any]:
        """Simulate an earthquake trigger to test instant warning symbology on the dashboard."""
        now = time.time()
        sim_trigger = {
            "channel": config.shake_channel,
            "start_time": now - 1.0,
            "end_time": now + 4.0,
            "peak_sta_lta": 8.5,
            "sta_lta_ratio": 8.5,
            "start_sample": 0,
            "end_sample": 500,
            "is_simulation": True,
        }
        await broadcaster.broadcast_trigger(sim_trigger)

        sim_alert = {
            "alert_id": f"sim-{int(now)}",
            "alert_type": "earthquake",
            "severity": "warning" if magnitude >= 3.5 else "advisory",
            "timestamp": now,
            "p_wave_time": now - 1.0,
            "sta_lta_ratio": 8.5,
            "estimated_magnitude": magnitude,
            "estimated_distance_km": distance_km,
            "distance_miles": round(distance_km * 0.621371, 1),
            "distance_class": "LOCAL",
            "mag_class": "LIGHT" if magnitude < 4.0 else "MODERATE",
            "station": config.shake_station,
            "channel": config.shake_channel,
            "tts_message": f"Earthquake Warning. Simulated magnitude {magnitude} detected {round(distance_km * 0.621371, 1)} miles away.",
            "is_simulation": True,
        }
        await broadcaster.broadcast_alert(sim_alert)

        return {"status": "ok", "message": "Simulation trigger & alert dispatched to connected browsers"}

    # ------------------------------------------------------------------
    # WebSocket Route
    # ------------------------------------------------------------------

    @app.websocket("/ws/live")
    async def websocket_live(websocket: WebSocket) -> None:
        """High-throughput WebSocket stream for live waveforms & trigger symbology."""
        await broadcaster.connect(websocket)
        try:
            while True:
                # Keep socket alive and handle client-side ping/commands
                data = await websocket.receive_text()
                # Optional client commands (e.g. time range adjustment or manual marker requests)
                if data == "ping":
                    await websocket.send_text('{"type":"pong"}')
        except WebSocketDisconnect:
            await broadcaster.disconnect(websocket)
        except Exception:
            await broadcaster.disconnect(websocket)

    # ------------------------------------------------------------------
    # Static Files & SPA
    # ------------------------------------------------------------------

    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

        @app.get("/")
        async def serve_spa() -> FileResponse:
            index_path = STATIC_DIR / "index.html"
            if not index_path.exists():
                raise HTTPException(status_code=404, detail="index.html not found")
            return FileResponse(str(index_path))

    return app
