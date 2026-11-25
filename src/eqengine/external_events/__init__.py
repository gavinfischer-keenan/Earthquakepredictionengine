"""External events correlation subsystem (Cal Football, Greek Theatre, Weather, BART)."""
from __future__ import annotations

from eqengine.external_events.base import ExternalEventProvider
from eqengine.external_events.correlator import correlate_external_events
from eqengine.external_events.manager import (
    ExternalEventsManager,
    get_external_events_manager,
)
from eqengine.external_events.schema import (
    AircraftSnapshot,
    AircraftTrack,
    BartTrainArrival,
    BartTransitSnapshot,
    ExternalCorrelation,
    ExternalEvent,
    WeatherSnapshot,
)

__all__ = [
    "AircraftSnapshot",
    "AircraftTrack",
    "BartTrainArrival",
    "BartTransitSnapshot",
    "ExternalCorrelation",
    "ExternalEvent",
    "ExternalEventProvider",
    "ExternalEventsManager",
    "WeatherSnapshot",
    "correlate_external_events",
    "get_external_events_manager",
]
