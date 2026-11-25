"""Overhead helicopter & low-altitude aircraft ADS-B provider with multi-source fallback."""
from __future__ import annotations

import math
import time
from datetime import UTC, datetime
from typing import Any

import httpx
import structlog

from eqengine.external_events.base import ExternalEventProvider
from eqengine.external_events.schema import (
    AircraftSnapshot,
    AircraftTrack,
    ExternalEvent,
)
from eqengine.ingest.usgs_poller import haversine_km

log = structlog.get_logger(__name__)

_COOLDOWN_SEC: float = 900.0  # Skip 403/429-blocked sources for 15 minutes

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


def _is_overhead(track: AircraftTrack, max_alt_ft: int, max_dist_km: float) -> bool:
    fixed_wing_max_dist = min(max_dist_km, 5.0)
    if track.altitude_ft > max_alt_ft:
        return False
    return track.distance_km <= (max_dist_km if track.is_helicopter else fixed_wing_max_dist)


def _build_aircraft_snapshot(
    nearby_tracks: list[AircraftTrack],
    overhead_tracks: list[AircraftTrack],
    now_ts: float,
    source: str,
) -> tuple[AircraftSnapshot, list[ExternalEvent]]:
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
        source=source,
    )

    events: list[ExternalEvent] = []
    if closest is not None:
        kind = "Helicopter" if closest.is_helicopter else "Aircraft"
        type_label = closest.aircraft_type or closest.callsign
        events.append(
            ExternalEvent(
                id="aircraft-overhead-live",
                source=source,
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


def parse_airplanes_live_response(
    data: dict[str, Any],
    now_ts: float,
    station_lat: float = 37.8696,
    station_lon: float = -122.2491,
    max_alt_ft: int = 5000,
    max_dist_km: float = 6.0,
    source: str = "airplanes-live",
) -> tuple[AircraftSnapshot, list[ExternalEvent]]:
    """Parse readsb v2 JSON (adsb.lol ``ac``, adsb.fi ``aircraft``, airplanes.live ``ac``)."""
    raw_ac = data.get("ac") or data.get("aircraft") or []
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
        if _is_overhead(track, max_alt_ft=max_alt_ft, max_dist_km=max_dist_km):
            overhead_tracks.append(track)

    return _build_aircraft_snapshot(nearby_tracks, overhead_tracks, now_ts, source=source)


def parse_opensky_response(
    data: dict[str, Any],
    now_ts: float,
    station_lat: float = 37.8696,
    station_lon: float = -122.2491,
    max_alt_ft: int = 5000,
    max_dist_km: float = 6.0,
) -> tuple[AircraftSnapshot, list[ExternalEvent]]:
    """Parse OpenSky Network ``/api/states/all?extended=1`` response into an AircraftSnapshot."""
    states = data.get("states") or []
    nearby_tracks: list[AircraftTrack] = []
    overhead_tracks: list[AircraftTrack] = []

    for row in states:
        if not isinstance(row, list) or len(row) < 11:
            continue
        lon = row[5]
        lat = row[6]
        on_ground = bool(row[8]) if row[8] is not None else False
        if lat is None or lon is None or on_ground:
            continue

        alt_m = row[7] if row[7] is not None else (row[13] if len(row) > 13 else None)
        if alt_m is None or not math.isfinite(float(alt_m)) or float(alt_m) <= 0:
            continue

        alt_ft = round(float(alt_m) * 3.28084)
        lat_f = float(lat)
        lon_f = float(lon)
        dist_km = haversine_km(station_lat, station_lon, lat_f, lon_f)
        slant_km = math.sqrt(dist_km ** 2 + (alt_ft * 0.0003048) ** 2)

        hex_id = str(row[0] or "unknown").strip().lower()
        callsign = str(row[1] or hex_id).strip()
        vel_ms = row[9]
        gs_kt = round(float(vel_ms) * 1.94384, 1) if vel_ms is not None else None
        trk = row[10]
        trk_deg = round(float(trk), 1) if trk is not None else None

        cat_num = row[17] if len(row) > 17 else None
        is_heli = cat_num == 8  # OpenSky ADS-B category 8 = Rotorcraft
        cat_code = "A7" if is_heli else (f"OS{cat_num}" if cat_num is not None else "")

        track = AircraftTrack(
            hex_id=hex_id,
            callsign=callsign or hex_id,
            aircraft_type="HELI" if is_heli else "",
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
        if _is_overhead(track, max_alt_ft=max_alt_ft, max_dist_km=max_dist_km):
            overhead_tracks.append(track)

    return _build_aircraft_snapshot(nearby_tracks, overhead_tracks, now_ts, source="opensky")


class AircraftProvider(ExternalEventProvider):
    """Fetch live ADS-B aircraft & helicopter tracks with multi-source fallback."""

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
        self._cooldown_until: dict[str, float] = {}

    def _opensky_url(self) -> str:
        radius_deg_lat = (self.radius_nm * 1.852) / 111.0
        cos_lat = max(0.2, math.cos(math.radians(self.station_lat)))
        radius_deg_lon = radius_deg_lat / cos_lat
        return (
            "https://opensky-network.org/api/states/all"
            f"?lamin={self.station_lat - radius_deg_lat:.4f}"
            f"&lomin={self.station_lon - radius_deg_lon:.4f}"
            f"&lamax={self.station_lat + radius_deg_lat:.4f}"
            f"&lomax={self.station_lon + radius_deg_lon:.4f}"
            "&extended=1"
        )

    def _source_candidates(self) -> list[tuple[str, str]]:
        radius_int = max(1, round(self.radius_nm))
        return [
            ("adsb-lol", f"https://api.adsb.lol/v2/lat/{self.station_lat}/lon/{self.station_lon}/dist/{radius_int}"),
            ("adsb-fi", f"https://opendata.adsb.fi/api/v2/lat/{self.station_lat}/lon/{self.station_lon}/dist/{radius_int}"),
            ("airplanes-live", f"https://api.airplanes.live/v2/point/{self.station_lat}/{self.station_lon}/{self.radius_nm}"),
            ("opensky", self._opensky_url()),
        ]

    async def fetch(
        self, client: httpx.AsyncClient
    ) -> tuple[AircraftSnapshot, list[ExternalEvent]]:
        mono_now = time.monotonic()
        candidates = [
            (src, url)
            for src, url in self._source_candidates()
            if self._cooldown_until.get(src, 0.0) <= mono_now
        ]
        if not candidates:
            # All sources cooled down — probe full chain again cleanly
            candidates = self._source_candidates()

        last_exc: Exception | None = None
        for src, url in candidates:
            try:
                resp = await client.get(url)
                if resp.status_code in (403, 429):
                    self._cooldown_until[src] = time.monotonic() + _COOLDOWN_SEC
                    log.debug("aircraft.source_blocked", source=src, status=resp.status_code)
                    last_exc = httpx.HTTPStatusError(
                        f"HTTP {resp.status_code} from {src}",
                        request=resp.request,
                        response=resp,
                    )
                    continue
                resp.raise_for_status()
                payload = resp.json()
                now_ts = datetime.now(tz=UTC).timestamp()
                if src == "opensky":
                    return parse_opensky_response(
                        payload,
                        now_ts=now_ts,
                        station_lat=self.station_lat,
                        station_lon=self.station_lon,
                        max_alt_ft=self.max_alt_ft,
                    )
                return parse_airplanes_live_response(
                    payload,
                    now_ts=now_ts,
                    station_lat=self.station_lat,
                    station_lon=self.station_lon,
                    max_alt_ft=self.max_alt_ft,
                    source=src,
                )
            except (httpx.HTTPError, ValueError) as exc:
                last_exc = exc
                log.debug("aircraft.source_failed", source=src, error=str(exc))

        assert last_exc is not None
        raise last_exc
