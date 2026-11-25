"""
eqengine.web.server — FastAPI web application for EarthquakePredictionEngine.

Provides:
  1. Interactive standalone single-page Observatory Web App (HTML/Canvas/JS).
  2. High-speed WebSocket stream at ``/ws/live`` for continuous 100 Hz waveforms.
  3. Modular REST API routers for telemetry, simulation, ML dataset, environmental
     intelligence, and external Berkeley events.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from eqengine import __version__
from eqengine.ingest.ring_buffer import RingBuffer
from eqengine.web.broadcaster import get_broadcaster
from eqengine.web.routes import (
    environmental_router,
    external_events_router,
    ml_router,
    observatory_router,
    simulation_router,
    telemetry_router,
)

STATIC_DIR = Path(__file__).parent / "static"


def create_app(
    ring_buffer: RingBuffer | None = None,
    detector: Any | None = None,
    usgs_poller: Any | None = None,
    external_events_manager: Any | None = None,
    ml_picker: Any | None = None,
    witness: Any | None = None,
    archiver: Any | None = None,
    highlights: Any | None = None,
) -> FastAPI:
    """Create and configure the FastAPI web application."""
    app = FastAPI(
        title="Earthquake Prediction Engine API",
        version=__version__,
        description="Real-Time RS4D Seismic Waveform & Early Warning Telemetry Hub",
    )

    app.state.ring_buffer = ring_buffer
    app.state.detector = detector
    app.state.usgs_poller = usgs_poller
    app.state.external_events_manager = external_events_manager
    app.state.ml_picker = ml_picker
    app.state.witness = witness
    app.state.archiver = archiver
    app.state.highlights = highlights

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(telemetry_router)
    app.include_router(simulation_router)
    app.include_router(ml_router)
    app.include_router(environmental_router)
    app.include_router(external_events_router)
    app.include_router(observatory_router)

    broadcaster = get_broadcaster()

    @app.websocket("/ws/live")
    async def websocket_live(websocket: WebSocket) -> None:
        """High-throughput WebSocket stream for live waveforms & trigger symbology."""
        await broadcaster.connect(websocket)
        try:
            while True:
                data = await websocket.receive_text()
                if data == "ping":
                    await websocket.send_text('{"type":"pong"}')
        except WebSocketDisconnect:
            await broadcaster.disconnect(websocket)
        except Exception:
            await broadcaster.disconnect(websocket)

    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

        @app.get("/")
        async def serve_spa() -> FileResponse:
            index_path = STATIC_DIR / "index.html"
            if not index_path.exists():
                raise HTTPException(status_code=404, detail="index.html not found")
            return FileResponse(str(index_path))

        @app.get("/manual")
        async def serve_manual() -> FileResponse:
            manual_path = STATIC_DIR / "manual.html"
            if not manual_path.exists():
                raise HTTPException(status_code=404, detail="manual.html not found")
            return FileResponse(str(manual_path))

    return app
