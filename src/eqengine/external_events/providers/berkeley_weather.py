"""Berkeley Hills wind & atmospheric weather provider via Open-Meteo."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

import httpx

from eqengine.constants import deg_to_cardinal
from eqengine.external_events.base import ExternalEventProvider
from eqengine.external_events.schema import ExternalEvent, WeatherSnapshot

_MPS_TO_MPH: float = 2.23694


def _classify_wind_regime(
    wind_mps: float, gusts_mps: float
) -> Literal["CALM", "BREEZY", "GUSTY", "STORM"]:
    if gusts_mps >= 16.0 or wind_mps >= 12.0:
        return "STORM"
    if gusts_mps >= 10.0 or wind_mps >= 7.0:
        return "GUSTY"
    if gusts_mps >= 6.0 or wind_mps >= 4.0:
        return "BREEZY"
    return "CALM"


def parse_open_meteo_weather(
    data: dict[str, Any],
    now_ts: float,
) -> tuple[WeatherSnapshot, list[ExternalEvent]]:
    """Parse Open-Meteo current-weather JSON into a WeatherSnapshot and live wind event."""
    cur = data.get("current") or {}
    wind_mps = float(cur.get("wind_speed_10m") or 0.0)
    gusts_mps = float(cur.get("wind_gusts_10m") or wind_mps)
    wind_dir = float(cur.get("wind_direction_10m") or 0.0)
    pressure = cur.get("surface_pressure")
    precip = float(cur.get("precipitation") or 0.0)
    temp_c = cur.get("temperature_2m")

    regime = _classify_wind_regime(wind_mps, gusts_mps)
    wind_mph = round(wind_mps * _MPS_TO_MPH, 1)
    gusts_mph = round(gusts_mps * _MPS_TO_MPH, 1)
    cardinal = deg_to_cardinal(wind_dir)

    snap = WeatherSnapshot(
        fetched_at_utc=datetime.fromtimestamp(now_ts, tz=UTC).isoformat(),
        wind_speed_mps=round(wind_mps, 2),
        wind_speed_mph=wind_mph,
        wind_gusts_mps=round(gusts_mps, 2),
        wind_gusts_mph=gusts_mph,
        wind_direction_deg=round(wind_dir, 1),
        wind_direction_cardinal=cardinal,
        pressure_hpa=round(float(pressure), 1) if pressure is not None else None,
        precipitation_mm=round(precip, 2),
        temperature_c=round(float(temp_c), 1) if temp_c is not None else None,
        regime=regime,
    )

    events: list[ExternalEvent] = []
    if regime in ("GUSTY", "STORM"):
        events.append(
            ExternalEvent(
                id="weather-berkeley-wind",
                source="open-meteo",
                category="weather",
                title=f"{regime.title()} Ridge Winds ({wind_mph:.0f} mph, gusts {gusts_mph:.0f} mph {cardinal})",
                venue="Berkeley Hills Canopy",
                start_time_utc=snap.fetched_at_utc,
                end_time_utc=None,
                start_ts=now_ts,
                end_ts=None,
                status="live",
                distance_km=0.0,
                expected_band_key="wind",
                expected_bands_hz=(0.38, 0.85),
                seismic_note="Tree-root torque and ridge gusts excite 0.38–0.85 Hz sway.",
                metadata={"regime": regime, "wind_mph": wind_mph, "gusts_mph": gusts_mph},
            )
        )

    return snap, events


class BerkeleyWeatherProvider(ExternalEventProvider):
    """Fetch local Berkeley Hills wind, gusts, pressure, and rain from Open-Meteo."""

    name = "berkeley_weather"

    def __init__(
        self,
        *,
        station_lat: float = 37.8696,
        station_lon: float = -122.2491,
        poll_interval_sec: float = 600.0,
    ) -> None:
        self.station_lat = station_lat
        self.station_lon = station_lon
        self.poll_interval_sec = poll_interval_sec

    async def fetch(
        self, client: httpx.AsyncClient
    ) -> tuple[WeatherSnapshot, list[ExternalEvent]]:
        url = (
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={self.station_lat}&longitude={self.station_lon}"
            "&current=temperature_2m,precipitation,surface_pressure,"
            "wind_speed_10m,wind_direction_10m,wind_gusts_10m"
            "&wind_speed_unit=ms"
        )
        resp = await client.get(url)
        resp.raise_for_status()
        now_ts = datetime.now(tz=UTC).timestamp()
        return parse_open_meteo_weather(resp.json(), now_ts=now_ts)
