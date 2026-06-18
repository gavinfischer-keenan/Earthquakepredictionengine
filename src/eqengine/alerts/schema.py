"""Pydantic v2 schemas for earthquake alerts and engine status.

All models use ``model_dump()`` / ``model_validate()`` for (de)serialisation
and are designed to be directly JSON-encodable for HTTP dispatch and JSONL
logging.
"""
from __future__ import annotations

import uuid
from typing import ClassVar, Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Earthquake alert
# ---------------------------------------------------------------------------
class EarthquakeAlert(BaseModel):
    """Canonical alert emitted when the engine detects a seismic event."""

    # Identity / type
    alert_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    alert_type: Literal["earthquake"] = "earthquake"
    severity: Literal["info", "warning", "critical", "advisory", "ignore"]

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

    # Distance & classification
    distance_miles: float | None = None
    distance_class: Literal["LOCAL", "REGIONAL", "STATE", "DISTANT"] | None = None
    mag_class: Literal["MINOR", "LIGHT", "MODERATE", "STRONG", "MAJOR"] | None = None

    # USGS correlation
    usgs_event_id: str | None = None
    usgs_magnitude: float | None = None
    place: str | None = None
    data_source: Literal["rs4d", "usgs", "fused"] = "rs4d"

    # Dynamic TTS for downstream consumers
    tts_message: str | None = None

    # Station metadata
    station: str
    channel: str

    # Lifecycle
    status: Literal["triggered", "confirmed", "cancelled", "expired"] = "triggered"

    # ------------------------------------------------------------------
    # Severity matrix: (distance_class, mag_class) -> severity
    # ------------------------------------------------------------------
    SEVERITY_MATRIX: ClassVar[dict[tuple[str, str], str]] = {
        ("LOCAL", "MAJOR"): "critical",
        ("LOCAL", "STRONG"): "critical",
        ("LOCAL", "MODERATE"): "warning",
        ("LOCAL", "LIGHT"): "advisory",
        ("LOCAL", "MINOR"): "info",
        ("REGIONAL", "MAJOR"): "critical",
        ("REGIONAL", "STRONG"): "warning",
        ("REGIONAL", "MODERATE"): "advisory",
        ("REGIONAL", "LIGHT"): "info",
        ("REGIONAL", "MINOR"): "info",
        ("STATE", "MAJOR"): "warning",
        ("STATE", "STRONG"): "advisory",
        ("STATE", "MODERATE"): "info",
        ("STATE", "LIGHT"): "info",
        ("STATE", "MINOR"): "ignore",
        ("DISTANT", "MAJOR"): "advisory",
        ("DISTANT", "STRONG"): "info",
        ("DISTANT", "MODERATE"): "ignore",
        ("DISTANT", "LIGHT"): "ignore",
        ("DISTANT", "MINOR"): "ignore",
    }

    # ------------------------------------------------------------------
    # Classification helpers
    # ------------------------------------------------------------------
    @staticmethod
    def classify_magnitude(mag: float | None) -> str:
        """Map magnitude to a named band: MINOR / LIGHT / MODERATE / STRONG / MAJOR."""
        if mag is None or mag < 2.5:
            return "MINOR"
        if mag < 4.0:
            return "LIGHT"
        if mag < 5.0:
            return "MODERATE"
        if mag < 6.0:
            return "STRONG"
        return "MAJOR"

    @staticmethod
    def classify_distance_km(distance_km: float | None) -> str:
        """Map distance to a proximity band: LOCAL / REGIONAL / STATE / DISTANT."""
        if distance_km is None or distance_km < 80:
            return "LOCAL"
        if distance_km < 240:
            return "REGIONAL"
        if distance_km < 640:
            return "STATE"
        return "DISTANT"

    @staticmethod
    def classify_severity(
        magnitude: float | None = None,
        distance_km: float | None = None,
    ) -> str:
        """Classify severity using the distance × magnitude matrix.

        Parameters
        ----------
        magnitude:
            Estimated magnitude (None treated as MINOR).
        distance_km:
            Distance from station in km (None treated as LOCAL).

        Returns
        -------
        str
            One of: ``critical``, ``warning``, ``advisory``, ``info``, ``ignore``.
        """
        mag_class = EarthquakeAlert.classify_magnitude(magnitude)
        dist_class = EarthquakeAlert.classify_distance_km(distance_km)
        return EarthquakeAlert.SEVERITY_MATRIX.get(
            (dist_class, mag_class), "info"
        )

    # ------------------------------------------------------------------
    # Dynamic TTS generation
    # ------------------------------------------------------------------
    def generate_tts_message(self) -> str:
        """Generate a human-readable TTS message based on severity and distance."""
        mag_str = (
            f"magnitude {self.estimated_magnitude:.1f}"
            if self.estimated_magnitude
            else "unknown magnitude"
        )
        if self.distance_class == "LOCAL":
            return f"Earthquake Imminent. {mag_str} earthquake detected nearby."
        elif self.distance_class == "REGIONAL":
            return f"Earthquake Alert. {mag_str} earthquake detected in the region."
        elif self.severity == "warning":
            return (
                f"Earthquake Warning. {mag_str} earthquake reported "
                f"{self.place or 'in the area'}."
            )
        return f"Seismic activity. {mag_str} earthquake reported."


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
