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
            "usgs_events": broadcaster.recent_usgs,
            "timestamp": time.time(),
        }

    @app.get("/api/usgs-events")
    async def get_usgs_events() -> dict[str, Any]:
        """Return recently recorded and observable USGS earthquakes."""
        return {
            "events": broadcaster.recent_usgs,
            "count": len(broadcaster.recent_usgs),
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

    @app.post("/api/simulate-usgs")
    async def simulate_usgs(magnitude: float = 4.7, place: str = "Off Coast of Northern California", distance_km: float = 320.0) -> dict[str, Any]:
        """Simulate an external regional USGS earthquake with incoming theoretical wavefronts."""
        now = time.time()
        from eqengine.ingest.usgs_poller import calculate_seismic_travel_times, is_observable_on_shake, classify_distance_km, classify_magnitude

        travel = calculate_seismic_travel_times(distance_km, 10.0)
        origin_time = now - 15.0  # Quake happened 15 seconds ago
        theor_p = origin_time + travel["p_travel_sec"]
        theor_s = origin_time + travel["s_travel_sec"]
        theor_surf = origin_time + travel["surface_travel_sec"]

        sim_usgs = {
            "id": f"sim-usgs-{int(now)}",
            "magnitude": magnitude,
            "place": place,
            "time": origin_time,
            "distance_km": distance_km,
            "distance_miles": round(distance_km * 0.621371, 1),
            "distance_class": classify_distance_km(distance_km),
            "mag_class": classify_magnitude(magnitude),
            "latitude": 40.3,
            "longitude": -124.6,
            "depth_km": 10.0,
            "url": "https://earthquake.usgs.gov/",
            "fetched_at": now,
            "p_travel_sec": travel["p_travel_sec"],
            "s_travel_sec": travel["s_travel_sec"],
            "p_arrival": round(theor_p, 2),
            "s_arrival": round(theor_s, 2),
            "surf_arrival": round(theor_surf, 2),
            "is_observable": is_observable_on_shake(magnitude, distance_km),
            "is_simulation": True,
        }
        await broadcaster.broadcast_usgs_event(sim_usgs)
        return {"status": "ok", "event": sim_usgs}

    # ------------------------------------------------------------------
    # ML Dataset & Annotation Routes
    # ------------------------------------------------------------------

    @app.post("/api/ml/annotate")
    async def annotate_event(payload: dict[str, Any]) -> dict[str, Any]:
        """Extract recent waveform window from ring buffer, compute features, and save to ML dataset."""
        label = payload.get("label", "unlabeled").strip()
        category = payload.get("category", "custom").strip()
        notes = payload.get("notes", "").strip()
        confidence = float(payload.get("confidence", 1.0))
        duration_sec = min(max(float(payload.get("duration_sec", 30.0)), 5.0), 120.0)

        if ring_buffer is None:
            raise HTTPException(status_code=503, detail="RingBuffer not active")

        # Extract waveform samples from ring buffer for all channels
        channel_data: dict[str, Any] = {}
        now = time.time()
        start_time = now - duration_sec
        end_time = now

        for ch in ("EHZ", "ENZ", "ENN", "ENE"):
            tr = ring_buffer.get_latest(ch, duration_sec=duration_sec)
            if tr is not None:
                channel_data[ch] = tr.data
                start_time = float(tr.stats.starttime.timestamp)
                end_time = float(tr.stats.endtime.timestamp)

        from eqengine.ml.dataset_logger import get_dataset_logger
        logger = get_dataset_logger()

        record = await logger.log_annotated_event(
            label=label,
            start_time=start_time,
            end_time=end_time,
            channel_data=channel_data,
            category=category,
            annotator="user_gavin",
            notes=notes,
            confidence=confidence,
            sampling_rate=float(config.sampling_rate),
        )

        return {"status": "ok", "message": f"Recorded '{label}' to ML dataset", "event": record}

    @app.get("/api/ml/events")
    async def get_ml_events(limit: int = 100) -> dict[str, Any]:
        """Return recently recorded and annotated ML training events."""
        from eqengine.ml.dataset_logger import get_dataset_logger
        logger = get_dataset_logger()
        return {"events": logger.get_recent_events(limit=limit)}

    @app.get("/api/ml/summary")
    async def get_ml_summary() -> dict[str, Any]:
        """Return dataset size, class distributions, and file paths."""
        from eqengine.ml.dataset_logger import get_dataset_logger
        logger = get_dataset_logger()
        return logger.get_dataset_summary()

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
