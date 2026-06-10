"""Pydantic v2 schemas for earthquake alerts and engine status.

All models use ``model_dump()`` / ``model_validate()`` for (de)serialisation
and are designed to be directly JSON-encodable for HTTP dispatch and JSONL
logging.
"""
from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Earthquake alert
# ---------------------------------------------------------------------------
class EarthquakeAlert(BaseModel):
    """Canonical alert emitted when the engine detects a seismic event."""

    # Identity / type
    alert_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    alert_type: Literal["earthquake"] = "earthquake"
    severity: Literal["info", "warning", "critical"]

    # Timing
    timestamp: float  # unix epoch — when the alert was created
    p_wave_time: float  # unix epoch — STA/LTA trigger onset

    # Detection
    sta_lta_ratio: float
    ml_confidence: float | None = None
    detection_method: str  # e.g. "classic_sta_lta" or "recursive_sta_lta"

    # Seismological estimates (all optional until computed)
    estimated_magnitude: float | None = None
    estimated_distance_km: float | None = None
    estimated_s_arrival: float | None = None
    seconds_until_s_wave: float | None = None
    peak_displacement_m: float | None = None
    predominant_period_s: float | None = None
    peak_ground_acceleration: float | None = None
    peak_ground_velocity: float | None = None

    # Station metadata
    station: str
    channel: str

    # Lifecycle
    status: Literal["triggered", "confirmed", "cancelled", "expired"] = "triggered"

    # ------------------------------------------------------------------
    # Severity classification helper
    # ------------------------------------------------------------------
    @staticmethod
    def classify_severity(magnitude: float | None) -> Literal["info", "warning", "critical"]:
        """Map estimated magnitude to an alert severity tier.

        * ``info``     — M < 2  *or* magnitude unknown
        * ``warning``  — 2 ≤ M < 4
        * ``critical`` — M ≥ 4
        """
        if magnitude is None or magnitude < 2.0:
            return "info"
        if magnitude < 4.0:
            return "warning"
        return "critical"


# ---------------------------------------------------------------------------
# Engine health / status
# ---------------------------------------------------------------------------
class EngineStatus(BaseModel):
    """Snapshot of the engine's operational state — emitted on the heartbeat."""

    status: Literal["online", "degraded", "offline"]
    engine_version: str
    uptime_seconds: float

    # Seismic metrics
    noise_floor_counts: float
    rsam_1min: float

    # Event stats
    last_trigger_time: float | None = None
    total_triggers: int = 0
    total_confirmed_events: int = 0

    # Infrastructure
    buffer_health: dict[str, float] = Field(
        default_factory=dict,
        description="Channel → fill ratio (0.0–1.0)",
    )
    ml_model_loaded: bool = False
    ingest_mode: str = "udp"
    channels_active: list[str] = Field(default_factory=list)
