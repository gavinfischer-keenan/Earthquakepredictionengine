"""Telemetry, waveform buffer, helicorder, and USGS REST endpoints."""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

import httpx
import structlog
from fastapi import APIRouter, HTTPException, Request, Response

from eqengine import __version__
from eqengine.config import get_config
from eqengine.constants import RS4D_CHANNELS
from eqengine.web.broadcaster import get_broadcaster

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/api", tags=["telemetry"])


@router.get("/status")
async def get_status(request: Request) -> dict[str, Any]:
    """Return station metadata, engine health, and active connections."""
    config = get_config()
    broadcaster = get_broadcaster()
    ring_buffer = request.app.state.ring_buffer

    buffer_health: dict[str, float] = {}
    if ring_buffer is not None and hasattr(ring_buffer, "get_fill_ratios"):
        buffer_health = ring_buffer.get_fill_ratios()

    channels = (
        config.shake_channels
        if isinstance(config.shake_channels, list)
        else [ch.strip() for ch in config.shake_channels.split(",")]
    )
    ml_picker = getattr(request.app.state, "ml_picker", None)
    witness = getattr(request.app.state, "witness", None)
    picker_mode = ml_picker.active_backend if ml_picker is not None else "heuristic"
    picker_label = ml_picker.picker_label if ml_picker is not None else "Z/H Polarization Heuristic"

    return {
        "station": config.shake_station,
        "network": config.shake_network,
        "station_name": config.station_name,
        "station_tz": config.station_tz,
        "primary_channel": config.shake_channel,
        "channels": channels,
        "station_lat": config.station_lat,
        "station_lon": config.station_lon,
        "station_elevation": config.station_elevation,
        "sampling_rate": config.sampling_rate,
        "ingest_mode": str(config.ingest_mode.value if hasattr(config.ingest_mode, "value") else config.ingest_mode),
        "shake_ip": config.shake_ip,
        "public_mode": config.public_mode,
        "mqtt_enabled": config.mqtt_enabled,
        "ml_enabled": config.ml_enabled,
        "picker_mode": picker_mode,
        "picker_label": picker_label,
        "witness_station": witness.witness_id if witness is not None else f"{config.witness_network}.{config.witness_station}..{config.witness_channel}",
        "connected_clients": broadcaster.client_count,
        "buffer_health": buffer_health,
        "version": __version__,
        "timestamp": time.time(),
    }


@router.get("/events")
async def get_events() -> dict[str, Any]:
    """Return recently detected triggers and earthquake alerts."""
    broadcaster = get_broadcaster()
    return {
        "triggers": broadcaster.recent_events,
        "alerts": broadcaster.recent_alerts,
        "usgs_events": broadcaster.recent_usgs,
        "timestamp": time.time(),
    }


@router.get("/usgs-events")
async def get_usgs_events(request: Request, response: Response) -> dict[str, Any]:
    """Return recently recorded and observable USGS earthquakes from memory/cache."""
    response.headers["Cache-Control"] = "public, max-age=15"
    usgs_poller = request.app.state.usgs_poller
    broadcaster = get_broadcaster()

    events: list[dict[str, Any]] = []
    if usgs_poller is not None:
        events = usgs_poller.get_recent_events(max_age_sec=172800.0)
    elif broadcaster.recent_usgs:
        events = broadcaster.recent_usgs
    else:
        cache_file = Path("./data/usgs_cache.json")
        if cache_file.exists():
            try:
                data = json.loads(cache_file.read_text(encoding="utf-8"))
                now = time.time()
                if isinstance(data, list):
                    events = [
                        e
                        for e in data
                        if isinstance(e, dict) and e.get("time", 0) >= (now - 172800.0)
                    ]
            except (OSError, json.JSONDecodeError):
                pass

    return {
        "events": events,
        "count": len(events),
        "timestamp": time.time(),
    }


@router.get("/buffer/{channel}")
async def get_channel_buffer(
    channel: str,
    request: Request,
    duration: float = 60.0,
) -> dict[str, Any]:
    """Return a snapshot of the most recent *duration* seconds for *channel*."""
    ring_buffer = request.app.state.ring_buffer
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


@router.get("/seismograph/historical")
async def get_historical_seismograph(
    request: Request,
    start_time: float | None = None,
    duration_sec: float = 60.0,
) -> dict[str, Any]:
    """Fetch 4-channel seismograph samples for historical review and range labelling."""
    ring_buffer = request.app.state.ring_buffer
    if ring_buffer is None:
        raise HTTPException(status_code=503, detail="RingBuffer not active")

    config = get_config()
    now = time.time()
    dur = min(max(float(duration_sec), 5.0), 600.0)
    end_t = float(start_time + dur) if start_time is not None else now
    start_t = end_t - dur

    channels: dict[str, list[float]] = {}
    actual_starts: dict[str, float] = {}

    for ch in RS4D_CHANNELS:
        data_arr, act_start = ring_buffer.get_time_range(ch, start_t, end_t)
        channels[ch] = data_arr.tolist()
        actual_starts[ch] = act_start

    return {
        "requested_start": start_t,
        "requested_end": end_t,
        "duration_sec": dur,
        "sampling_rate": float(config.sampling_rate),
        "channels": channels,
        "actual_start_times": actual_starts,
    }


@router.get("/helicorder/latest")
async def get_latest_helicorder(channel: str = "EHZ", block: int = 0) -> Response:
    """Fetch the official 24-hour Helicorder drum plot directly from Raspberry Shake."""
    config = get_config()
    shake_host = config.shake_ip
    station = config.shake_station
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            res = await client.get(f"http://{shake_host}/heli/")
            if res.status_code == 200:
                pattern = rf'href=[\"\']({station}_{channel.upper()}[^\"\']+\.gif)[^\"\']*[\"\']'
                matches = sorted(set(re.findall(pattern, res.text)), reverse=True)
                if matches:
                    idx = min(max(block, 0), len(matches) - 1)
                    img_filename = matches[idx]
                    img_res = await client.get(f"http://{shake_host}/heli/{img_filename}")
                    if img_res.status_code == 200:
                        return Response(content=img_res.content, media_type="image/gif")
    except httpx.HTTPError as exc:
        log.warning("helicorder.fetch_failed", error=str(exc))

    raise HTTPException(
        status_code=502,
        detail="Could not fetch helicorder drum from Raspberry Shake",
    )
