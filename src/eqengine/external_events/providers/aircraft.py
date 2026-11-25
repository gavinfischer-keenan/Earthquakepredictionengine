"""Overhead helicopter & low-altitude aircraft ADS-B provider via airplanes.live."""
from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any

import httpx

from eqengine.external_events.base import ExternalEventProvider
from eqengine.external_events.schema import (
    AircraftSnapshot,
    AircraftTrack,
    ExternalEvent,
)
from eqengine.ingest.usgs_poller import haversine_km

HELICOPTER_ICAO_TYPES: frozenset[str] = frozenset({
    "R22", "R44", "R66",
    "B06", "B206", "B407", "B412", "B429", "B505",
    "AS50", "AS55", "AS65",
    "EC30", "EC35", "EC45",
    "H125", "H130", "H135", "H145",
    "S70", "S76", "UH1", "UH60",
    "AW139", "MD52", "MD60", "MD90",
    "CH47", "V22", "KMAX", "BK17",
})


def _parse_alt_ft(ac: dict[str, Any]) -> int | None:
    raw = ac.get("alt_baro")
    if raw is None or isinstance(raw, str) and raw.strip().lower() == "ground":
        return None
    try:
        alt = float(raw)
    except (TypeError, ValueError):
        raw_geom = ac.get("alt_geom")
        try:
            alt = float(raw_geom)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None
    if not math.isfinite(alt) or alt <= 0:
        return None
    return round(alt)


def parse_airplanes_live_response(
    data: dict[str, Any],
    now_ts: float,
    station_lat: float = 37.8696,
    station_lon: float = -122.2491,
    max_alt_ft: int = 5000,
    max_dist_km: float = 6.0,
) -> tuple[AircraftSnapshot, list[ExternalEvent]]:
    """Parse airplanes.live JSON into an AircraftSnapshot and overhead live ExternalEvent."""
    raw_ac = data.get("ac") or []
    nearby_tracks: list[AircraftTrack] = []
    overhead_tracks: list[AircraftTrack] = []

    for ac in raw_ac:
        if not isinstance(ac, dict):
            continue
        lat = ac.get("lat")
        lon = ac.get("lon")
        alt_ft = _parse_alt_ft(ac)
        if lat is None or lon is None or alt_ft is None:
            continue

        lat_f = float(lat)
        lon_f = float(lon)
        dist_km = haversine_km(station_lat, station_lon, lat_f, lon_f)
        slant_km = math.sqrt(dist_km ** 2 + (alt_ft * 0.0003048) ** 2)

        cat_code = str(ac.get("category") or "").strip().upper()
        ac_type = str(ac.get("t") or "").strip().upper()
        is_heli = cat_code == "A7" or ac_type in HELICOPTER_ICAO_TYPES
        callsign = str(ac.get("flight") or ac.get("r") or ac.get("hex") or "UNKNOWN").strip()
        hex_id = str(ac.get("hex") or callsign).strip().lower()

        gs_raw = ac.get("gs")
        gs_kt = round(float(gs_raw), 1) if gs_raw is not None else None
        trk_raw = ac.get("track")
        trk_deg = round(float(trk_raw), 1) if trk_raw is not None else None

        track = AircraftTrack(
            hex_id=hex_id,
            callsign=callsign,
            aircraft_type=ac_type,
            category_code=cat_code,
            is_helicopter=is_heli,
            altitude_ft=alt_ft,
            ground_speed_kt=gs_kt,
            track_deg=trk_deg,
            distance_km=round(dist_km, 2),
            slant_range_km=round(slant_km, 2),
            lat=lat_f,
            lon=lon_f,
        )
        nearby_tracks.append(track)

        fixed_wing_max_dist = min(max_dist_km, 5.0)
        if alt_ft <= max_alt_ft and (
            (is_heli and dist_km <= max_dist_km)
            or (not is_heli and dist_km <= fixed_wing_max_dist)
        ):
            overhead_tracks.append(track)

    overhead_tracks.sort(key=lambda t: (0 if t.is_helicopter else 1, t.slant_range_km))
    heli_overhead = any(t.is_helicopter for t in overhead_tracks)
    closest = overhead_tracks[0] if overhead_tracks else None
    fetched_utc = datetime.fromtimestamp(now_ts, tz=UTC).isoformat()

    snap = AircraftSnapshot(
        fetched_at_utc=fetched_utc,
        total_nearby=len(nearby_tracks),
        low_overhead_count=len(overhead_tracks),
        helicopter_overhead=heli_overhead,
        closest_aircraft=closest,
        aircraft=overhead_tracks[:8],
    )

    events: list[ExternalEvent] = []
    if closest is not None:
        kind = "Helicopter" if closest.is_helicopter else "Aircraft"
        type_label = closest.aircraft_type or closest.callsign
        events.append(
            ExternalEvent(
                id="aircraft-overhead-live",
                source="airplanes-live",
                category="aircraft",
                title=f"Low {kind} Overhead ({type_label} · {closest.altitude_ft:,} ft)",
                venue=f"{closest.distance_km:.1f} km from station",
                start_time_utc=fetched_utc,
                end_time_utc=None,
                start_ts=now_ts,
                end_ts=None,
                status="live",
                distance_km=closest.distance_km,
                expected_band_key="aircraft",
                expected_bands_hz=(10.0, 35.0),
                seismic_note="Rotor/propeller blades produce 10–35 Hz harmonic comb stripes & Doppler swoops.",
                metadata={
                    "is_helicopter": closest.is_helicopter,
                    "callsign": closest.callsign,
                    "aircraft_type": closest.aircraft_type,
                    "altitude_ft": closest.altitude_ft,
                    "distance_km": closest.distance_km,
                    "ground_speed_kt": closest.ground_speed_kt,
                },
            )
        )

    return snap, events


class AircraftProvider(ExternalEventProvider):
    """Fetch live ADS-B aircraft & helicopter tracks near the station."""

    name = "aircraft"

    def __init__(
        self,
        *,
        station_lat: float = 37.8696,
        station_lon: float = -122.2491,
        radius_nm: float = 5.0,
        max_alt_ft: int = 5000,
        poll_interval_sec: float = 15.0,
    ) -> None:
        self.station_lat = station_lat
        self.station_lon = station_lon
        self.radius_nm = radius_nm
        self.max_alt_ft = max_alt_ft
        self.poll_interval_sec = poll_interval_sec

    async def fetch(
        self, client: httpx.AsyncClient
    ) -> tuple[AircraftSnapshot, list[ExternalEvent]]:
        url = f"https://api.airplanes.live/v2/point/{self.station_lat}/{self.station_lon}/{self.radius_nm}"
        resp = await client.get(url)
        resp.raise_for_status()
        now_ts = datetime.now(tz=UTC).timestamp()
        return parse_airplanes_live_response(
            resp.json(),
            now_ts=now_ts,
            station_lat=self.station_lat,
            station_lon=self.station_lon,
            max_alt_ft=self.max_alt_ft,
        )
