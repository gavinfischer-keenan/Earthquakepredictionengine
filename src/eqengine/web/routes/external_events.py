"""External events endpoints (Cal Football, Greek Theatre, weather, and BART)."""
from __future__ import annotations

from typing import Any

import numpy as np
from fastapi import APIRouter, Request

import eqengine.external_events.manager as ext_mod
from eqengine.telemetry.environmental.forensics import compute_minute_forensics

router = APIRouter(prefix="/api", tags=["external-events"])


def _live_forensics_from_buffer(ring_buffer: Any | None) -> dict[str, Any] | None:
    if ring_buffer is None:
        return None
    tr = ring_buffer.get_latest("EHZ", duration_sec=60.0)
    if tr is None or len(tr.data) < 64:
        return None
    return compute_minute_forensics(
        np.asarray(tr.data),
        sampling_rate=float(tr.stats.sampling_rate or 100.0),
    )


@router.get("/external-events")
async def get_external_events(request: Request) -> dict[str, Any]:
    """Return Cal Football, Greek Theatre, weather, BART, and live seismic correlation."""
    manager = request.app.state.external_events_manager or ext_mod.get_external_events_manager()
    metrics = _live_forensics_from_buffer(request.app.state.ring_buffer)
    return manager.get_payload(forensics_metrics=metrics)


@router.post("/external-events/refresh")
async def refresh_external_events(request: Request) -> dict[str, Any]:
    """Force an immediate refresh of all external event providers."""
    manager = request.app.state.external_events_manager or ext_mod.get_external_events_manager()
    await manager.refresh_all()
    metrics = _live_forensics_from_buffer(request.app.state.ring_buffer)
    return {"status": "ok", **manager.get_payload(forensics_metrics=metrics)}
