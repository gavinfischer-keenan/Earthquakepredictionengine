"""External-event provider implementations for the Berkeley Hills observatory."""
from __future__ import annotations

from eqengine.external_events.providers.aircraft import (
    AircraftProvider,
    parse_airplanes_live_response,
    parse_opensky_response,
)
from eqengine.external_events.providers.bart_transit import (
    BartTransitProvider,
    parse_bart_etd_responses,
)
from eqengine.external_events.providers.berkeley_weather import (
    BerkeleyWeatherProvider,
    parse_open_meteo_weather,
)
from eqengine.external_events.providers.cal_football import (
    CalFootballProvider,
    parse_espn_cal_schedule,
)
from eqengine.external_events.providers.greek_theatre import (
    GreekTheatreProvider,
    parse_greek_theatre_html,
)

__all__ = [
    "AircraftProvider",
    "BartTransitProvider",
    "BerkeleyWeatherProvider",
    "CalFootballProvider",
    "GreekTheatreProvider",
    "parse_airplanes_live_response",
    "parse_bart_etd_responses",
    "parse_espn_cal_schedule",
    "parse_greek_theatre_html",
    "parse_open_meteo_weather",
    "parse_opensky_response",
]
