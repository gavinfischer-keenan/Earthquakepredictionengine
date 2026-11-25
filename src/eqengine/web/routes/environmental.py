"""Environmental intelligence, Quiet-Window Hunter calibration, and forensics CSV endpoints."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

import eqengine.telemetry.environmental_intelligence as env_mod
from eqengine.config import get_config
from eqengine.telemetry.environmental.trends import (
    compute_forensics_trends,
    load_forensics_rows,
)

router = APIRouter(prefix="/api", tags=["environmental"])


@router.get("/environmental-intelligence")
async def get_environmental_intelligence(request: Request) -> dict[str, Any]:
    """Return NOAA NDBC ocean buoy data, 2f microseism correlation, and Quiet-Window Hunter state."""
    env_engine = env_mod.get_environmental_engine()
    return env_engine.get_intelligence_payload(
        ring_buffer=request.app.state.ring_buffer,
        external_events_manager=request.app.state.external_events_manager,
    )


@router.post("/environmental/calibrate")
async def calibrate_environmental_baseline(request: Request) -> dict[str, Any]:
    """Manually invoke the Quiet-Window Hunter to calibrate NoiseModel & quiet band floors."""
    ring_buffer = request.app.state.ring_buffer
    if ring_buffer is None:
        raise HTTPException(status_code=503, detail="RingBuffer not initialized")

    env_engine = env_mod.get_environmental_engine()
    await env_engine.refresh_buoys()
    baseline = await env_engine.hunt_and_calibrate(ring_buffer=ring_buffer, force=True)
    if baseline is None:
        raise HTTPException(
            status_code=400,
            detail="Insufficient waveform history in buffer (need >= 20 seconds of EHZ data)",
        )
    return {
        "status": "ok",
        "baseline": baseline,
        "intelligence": env_engine.get_intelligence_payload(
            ring_buffer=ring_buffer,
            external_events_manager=request.app.state.external_events_manager,
        ),
    }


@router.get("/forensics/export.csv")
async def export_forensics_csv() -> FileResponse:
    """Download continuous 1-minute environmental forensics & buoy history as CSV."""
    env_engine = env_mod.get_environmental_engine()
    csv_path = env_engine.ensure_csv_exists()
    return FileResponse(
        str(csv_path),
        media_type="text/csv",
        filename="shake_forensics_history.csv",
        headers={"Content-Disposition": 'attachment; filename="shake_forensics_history.csv"'},
    )


@router.get("/forensics/trends")
async def get_forensics_trends(request: Request, days: int = 7) -> dict[str, Any]:
    """Return 7D/30D Berkeley Pulse analytics, predictive models, and Light/Normal/Heavy bands."""
    cfg = get_config()
    env_engine = env_mod.get_environmental_engine()
    rows = load_forensics_rows(
        env_engine.forensics_jsonl_path,
        env_engine.forensics_csv_path,
        max_days=max(days, 30),
    )
    ext_mgr = request.app.state.external_events_manager
    upcoming = [e.model_dump() for e in ext_mgr.all_events()] if ext_mgr is not None else None

    return compute_forensics_trends(
        rows,
        days=days,
        station_tz=cfg.station_tz,
        station_lon=cfg.station_lon,
        current_buoy=env_engine.primary_buoy,
        upcoming_events=upcoming,
    )
