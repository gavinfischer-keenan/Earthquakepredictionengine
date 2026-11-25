"""Observatory feature routes: BK.BKS Witness, MiniSEED Quake Replay, and Shake Highlights."""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request

import eqengine.ingest.archive as archive_mod
import eqengine.telemetry.highlights as highlights_mod
import eqengine.validation.witness as witness_mod
from eqengine.ingest.archive import analyze_quake_replay
from eqengine.ingest.usgs_poller import calculate_seismic_travel_times

router = APIRouter(prefix="/api", tags=["observatory"])


@router.get("/witness/status")
async def get_witness_status(request: Request) -> dict[str, Any]:
    """Return latest UC Berkeley BK.BKS multi-station witness verification state."""
    witness = request.app.state.witness or witness_mod.get_witness()
    return witness.get_status()


@router.post("/witness/check")
async def check_witness_trigger(
    request: Request,
    timestamp: float | None = None,
) -> dict[str, Any]:
    """Manually trigger an FDSN coincidence check against BK.BKS."""
    witness = request.app.state.witness or witness_mod.get_witness()
    ts = float(timestamp if timestamp is not None else time.time() - 15.0)
    verdict = await witness.verify_trigger(ts)
    return verdict.model_dump()


@router.get("/archive/status")
async def get_archive_status(request: Request) -> dict[str, Any]:
    """Return rolling MiniSEED archive retention, file count, and disk usage."""
    archiver = request.app.state.archiver or archive_mod.get_archiver()
    return archiver.get_status()


@router.get("/archive/quake-replay")
async def get_quake_replay(
    request: Request,
    origin_time: float | None = None,
    p_arrival: float | None = None,
    s_arrival: float | None = None,
    surf_arrival: float | None = None,
    distance_km: float | None = None,
    depth_km: float = 10.0,
    magnitude: float | None = None,
    place: str = "Regional Earthquake",
    channel: str = "EHZ",
) -> dict[str, Any]:
    """Slice archived/ring-buffer RS4D waveform for a USGS event and return SNR verdict."""
    now = time.time()
    origin = float(origin_time if origin_time is not None else (p_arrival - 10.0 if p_arrival else now - 90.0))

    if p_arrival is None and distance_km is not None:
        travel = calculate_seismic_travel_times(float(distance_km), float(depth_km))
        p_arr = origin + travel["p_travel_sec"]
        s_arr = origin + travel["s_travel_sec"]
        surf_arr = origin + travel["surface_travel_sec"]
    else:
        p_arr = float(p_arrival if p_arrival is not None else origin + 10.0)
        s_arr = float(s_arrival) if s_arrival is not None else (p_arr + 12.0)
        surf_arr = float(surf_arrival) if surf_arrival is not None else (s_arr + 12.0)

    win_start = p_arr - 25.0
    win_end = max(surf_arr + 45.0, p_arr + 90.0)

    archiver = request.app.state.archiver or archive_mod.get_archiver()
    ring_buffer = request.app.state.ring_buffer
    ch_upper = channel.upper()
    traces = archiver.read_window(
        win_start,
        win_end,
        ring_buffer=ring_buffer,
        channels=(ch_upper,),
    )
    tr = traces.get(ch_upper)

    if tr is None:
        return {
            "has_data": False,
            "detected": False,
            "verdict": "NO ARCHIVE DATA",
            "channel": ch_upper,
            "place": place,
            "magnitude": magnitude,
            "distance_km": distance_km,
            "origin_time": origin,
            "p_arrival": p_arr,
            "s_arrival": s_arr,
            "surf_arrival": surf_arr,
            "window_start": win_start,
            "window_end": win_end,
            "samples": [],
            "times": [],
        }

    analysis = analyze_quake_replay(
        tr,
        p_arrival=p_arr,
        s_arrival=s_arr,
        surf_arrival=surf_arr,
    )
    return {
        **analysis,
        "channel": ch_upper,
        "place": place,
        "magnitude": magnitude,
        "distance_km": distance_km,
        "origin_time": origin,
        "p_arrival": p_arr,
        "s_arrival": s_arr,
        "surf_arrival": surf_arr,
        "window_start": win_start,
        "window_end": win_end,
    }


@router.get("/highlights")
async def get_highlights(request: Request, limit: int = 30) -> dict[str, Any]:
    """Return auto-captured Shake Highlights (earthquakes, Cal touchdowns, Greek concerts)."""
    recorder = request.app.state.highlights or highlights_mod.get_highlights_recorder()
    return {"highlights": recorder.list_highlights(limit=limit)}


@router.get("/highlights/{highlight_id}")
async def get_highlight_clip(highlight_id: str, request: Request) -> dict[str, Any]:
    """Return waveform samples and metadata for a single Shake Highlight clip."""
    recorder = request.app.state.highlights or highlights_mod.get_highlights_recorder()
    clip = recorder.get_highlight_clip(highlight_id)
    if clip is None:
        raise HTTPException(status_code=404, detail=f"Highlight '{highlight_id}' not found")
    return clip
