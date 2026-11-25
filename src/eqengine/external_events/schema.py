"""Pydantic v2 schemas for external events, local weather, BART transit, and correlation."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ExternalEvent(BaseModel):
    """Normalized representation of an external event observable on the Shake."""

    id: str
    source: str
    category: Literal["football", "concert", "weather", "transit", "aircraft", "other"]
    title: str
    venue: str
    start_time_utc: str | None = None
    end_time_utc: str | None = None
    start_ts: float | None = None
    end_ts: float | None = None
    status: Literal["live", "upcoming", "recent"]
    distance_km: float | None = None
    expected_band_key: Literal[
        "stadium", "concert", "wind", "rail", "traffic", "human", "aircraft", "other"
    ]
    expected_bands_hz: tuple[float, float]
    seismic_note: str
    url: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class WeatherSnapshot(BaseModel):
    """Current atmospheric & wind conditions near the station."""

    fetched_at_utc: str
    wind_speed_mps: float
    wind_speed_mph: float
    wind_gusts_mps: float
    wind_gusts_mph: float
    wind_direction_deg: float
    wind_direction_cardinal: str
    pressure_hpa: float | None = None
    precipitation_mm: float = 0.0
    temperature_c: float | None = None
    regime: Literal["CALM", "BREEZY", "GUSTY", "STORM"]
    source: str = "open-meteo"


class BartTrainArrival(BaseModel):
    """Single upcoming BART train departure near the Berkeley Hills tunnel."""

    station: str
    destination: str
    line_color: str
    minutes: int
    direction: str = ""
    length_cars: int = 0
    in_tunnel_window: bool = False


class BartTransitSnapshot(BaseModel):
    """Summary of live BART train activity near DBRK / ROCK."""

    fetched_at_utc: str
    stations: list[str] = Field(default_factory=list)
    trains_imminent_count: int = 0
    tunnel_active: bool = False
    next_trains: list[BartTrainArrival] = Field(default_factory=list)
    source: str = "bart-etd"


class AircraftTrack(BaseModel):
    """Single nearby low-altitude aircraft or helicopter track from ADS-B."""

    hex_id: str
    callsign: str
    aircraft_type: str = ""
    category_code: str = ""
    is_helicopter: bool = False
    altitude_ft: int
    ground_speed_kt: float | None = None
    track_deg: float | None = None
    distance_km: float
    slant_range_km: float
    lat: float
    lon: float


class AircraftSnapshot(BaseModel):
    """Summary of low-altitude aircraft & helicopters near the station."""

    fetched_at_utc: str
    total_nearby: int = 0
    low_overhead_count: int = 0
    helicopter_overhead: bool = False
    closest_aircraft: AircraftTrack | None = None
    aircraft: list[AircraftTrack] = Field(default_factory=list)
    source: str = "airplanes-live"


class ExternalCorrelation(BaseModel):
    """Result of matching live seismic band energy against active external events."""

    matched: bool = False
    active_event_id: str | None = None
    active_event_title: str | None = None
    active_category: str | None = None
    matched_band: str | None = None
    confidence: int = 0
    reason: str = "No active external event correlated with current vibration bands."
