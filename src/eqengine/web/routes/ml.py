"""ML dataset annotation, snippet inspection, and dataset summary endpoints."""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from eqengine.config import get_config
from eqengine.constants import RS4D_CHANNELS
from eqengine.ml.dataset_logger import get_dataset_logger

router = APIRouter(prefix="/api/ml", tags=["ml"])


@router.post("/annotate")
async def annotate_event(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    """Extract recent waveform window from ring buffer, compute features, and save to ML dataset."""
    ring_buffer = request.app.state.ring_buffer
    if ring_buffer is None:
        raise HTTPException(status_code=503, detail="RingBuffer not active")

    config = get_config()
    label = payload.get("label", "unlabeled").strip()
    category = payload.get("category", "custom").strip()
    notes = payload.get("notes", "").strip()
    confidence = float(payload.get("confidence", 1.0))
    duration_sec = min(max(float(payload.get("duration_sec", 30.0)), 5.0), 120.0)

    channel_data: dict[str, Any] = {}
    now = time.time()
    start_time = now - duration_sec
    end_time = now

    for ch in RS4D_CHANNELS:
        tr = ring_buffer.get_latest(ch, duration_sec=duration_sec)
        if tr is not None:
            channel_data[ch] = tr.data
            start_time = float(tr.stats.starttime.timestamp)
            end_time = float(tr.stats.endtime.timestamp)

    record = await get_dataset_logger().log_annotated_event(
        label=label,
        start_time=start_time,
        end_time=end_time,
        channel_data=channel_data,
        category=category,
        annotator=config.ml_annotator,
        notes=notes,
        confidence=confidence,
        sampling_rate=float(config.sampling_rate),
    )
    return {"status": "ok", "message": f"Recorded '{label}' to ML dataset", "event": record}


@router.get("/events")
async def get_ml_events(limit: int = 100) -> dict[str, Any]:
    """Return recently recorded and annotated ML training events."""
    return {"events": get_dataset_logger().get_recent_events(limit=limit)}


@router.get("/snippet/{event_id}")
async def get_ml_snippet(event_id: str) -> dict[str, Any]:
    """Return the 4-channel NPZ waveform tensor and metadata for review and audio playback."""
    snippet = get_dataset_logger().get_event_snippet(event_id)
    if snippet is None:
        raise HTTPException(status_code=404, detail=f"Snippet for event '{event_id}' not found")
    return snippet


@router.delete("/events/{event_id}")
async def delete_ml_event(event_id: str) -> dict[str, Any]:
    """Delete an annotated event from the ML dataset and remove its snippet file."""
    success = await get_dataset_logger().delete_event(event_id)
    return {"status": "ok", "message": f"Deleted event '{event_id}'", "success": success}


@router.post("/annotate_range")
async def annotate_custom_range(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    """Extract a user-selected time range from the ring buffer and save as an ML event."""
    ring_buffer = request.app.state.ring_buffer
    if ring_buffer is None:
        raise HTTPException(status_code=503, detail="RingBuffer not active")

    config = get_config()
    label = payload.get("label", "unlabeled").strip()
    category = payload.get("category", "custom").strip()
    notes = payload.get("notes", "").strip()
    confidence = float(payload.get("confidence", 1.0))
    start_time = float(payload.get("start_time", 0.0))
    end_time = float(payload.get("end_time", 0.0))

    if start_time <= 0 or end_time <= start_time:
        raise HTTPException(status_code=400, detail="Invalid time range (start_time and end_time required)")

    channel_data: dict[str, Any] = {}
    for ch in RS4D_CHANNELS:
        data_arr, _ = ring_buffer.get_time_range(ch, start_time, end_time)
        if len(data_arr) > 0:
            channel_data[ch] = data_arr

    if not channel_data or len(channel_data.get("EHZ", [])) == 0:
        raise HTTPException(
            status_code=404,
            detail="No waveform data available in buffer for requested time range",
        )

    record = await get_dataset_logger().log_annotated_event(
        label=label,
        start_time=start_time,
        end_time=end_time,
        channel_data=channel_data,
        category=category,
        annotator=config.ml_annotator,
        notes=notes,
        confidence=confidence,
        sampling_rate=float(config.sampling_rate),
    )
    return {"status": "ok", "message": f"Successfully annotated '{label}'", "event": record}


@router.get("/summary")
async def get_ml_summary() -> dict[str, Any]:
    """Return dataset size, class distributions, and file paths."""
    return get_dataset_logger().get_dataset_summary()
