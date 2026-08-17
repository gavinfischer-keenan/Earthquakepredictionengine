"""USGS GeoJSON earthquake feed poller with haversine distance calculation.

Polls the USGS earthquake API at a configurable interval, calculates
great-circle distance from the station, and exposes recent events for
correlation with local RS4D seismometer triggers.

Typical usage::

    poller = USGSPoller(station_lat=37.87, station_lon=-122.25)
    await poller.start()
    # ... later ...
    match = poller.correlate_with_trigger(time.time())
    await poller.stop()
"""
from __future__ import annotations

import asyncio
import math
import time
from typing import Any

import httpx
import structlog

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
KM_TO_MILES: float = 0.621371
EARTH_RADIUS_KM: float = 6371.0

# Distance classification thresholds (km)
_DIST_LOCAL_KM: float = 80.0      # ~50 miles
_DIST_REGIONAL_KM: float = 240.0  # ~150 miles
_DIST_STATE_KM: float = 640.0     # ~400 miles

# Dedup cache max size
_MAX_SEEN_IDS: int = 5000


# ---------------------------------------------------------------------------
# Haversine distance
# ---------------------------------------------------------------------------
def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in km.

    Uses the Haversine formula, which is accurate for typical earthquake
    distances (error < 0.5% for distances under 10,000 km).

    Parameters
    ----------
    lat1, lon1:
        First point (decimal degrees).
    lat2, lon2:
        Second point (decimal degrees).

    Returns
    -------
    float
        Distance in kilometres.
    """
    lat1_r, lon1_r = math.radians(lat1), math.radians(lon1)
    lat2_r, lon2_r = math.radians(lat2), math.radians(lon2)

    dlat = lat2_r - lat1_r
    dlon = lon2_r - lon1_r

    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1_r) * math.cos(lat2_r) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.asin(math.sqrt(a))

    return EARTH_RADIUS_KM * c


# ---------------------------------------------------------------------------
# Seismic Wave Travel Time & Observability Models
# ---------------------------------------------------------------------------
def calculate_seismic_travel_times(
    distance_km: float, depth_km: float = 10.0
) -> dict[str, float]:
    """Calculate theoretical P, S, and surface wave travel times in seconds.

    Uses standard local/regional crustal velocities for distances < 800 km,
    and IASP91 empirical polynomial approximations for teleseismic distances.
    """
    depth = max(depth_km, 0.0)
    slant_dist = math.sqrt(distance_km**2 + depth**2)

    if distance_km < 800.0:
        # Crustal & Moho refracted phases (Pg/Pn and Sg/Sn)
        # Average crustal Vp ~ 6.1 km/s, Vs ~ 3.55 km/s, Surface ~ 3.0 km/s
        vp = 6.1 if distance_km < 150 else 7.8
        vs = 3.55 if distance_km < 150 else 4.45
        t_p = slant_dist / vp
        t_s = slant_dist / vs
        t_surf = distance_km / 3.0
    else:
        # Teleseismic deep mantle raypath approximation
        # Delta in degrees (1 deg ~ 111.19 km)
        delta_deg = distance_km / 111.19
        # Empirical IASP91 P-wave travel time fit: ~ 60 + delta_deg * 8.5 - delta_deg^2 * 0.02
        t_p = max(delta_deg * 8.2 - (delta_deg**2) * 0.015 + 10.0, 100.0)
        # S-wave: ~ delta_deg * 15.0
        t_s = max(t_p * 1.82, 180.0)
        # Rayleigh / Love surface wave (dispersion ~ 3.3 km/s)
        t_surf = distance_km / 3.3

    return {
        "p_travel_sec": round(t_p, 1),
        "s_travel_sec": round(t_s, 1),
        "surface_travel_sec": round(t_surf, 1),
    }


def is_observable_on_shake(magnitude: float | None, distance_km: float) -> bool:
    """Determine if an earthquake is theoretically observable on a Raspberry Shake RS4D.

    Based on empirical detection thresholds of 4.5 Hz geophones and strong-motion accelerometers:
      - Local (<80 km): M >= 1.0
      - Regional (80–300 km): M >= 2.0
      - State / Multi-state (300–1,000 km): M >= 3.5
      - Continental (1,000–3,000 km): M >= 4.8
      - Global Teleseismic (>3,000 km): M >= 5.8
    """
    if magnitude is None:
        return False
    if distance_km <= 80.0:
        return magnitude >= 1.0
    elif distance_km <= 300.0:
        return magnitude >= 2.0
    elif distance_km <= 1000.0:
        return magnitude >= 3.5
    elif distance_km <= 3000.0:
        return magnitude >= 4.8
    else:
        return magnitude >= 5.8


# ---------------------------------------------------------------------------
# Classification helpers (module-level for testability)
# ---------------------------------------------------------------------------
def classify_distance_km(distance_km: float | None) -> str:
    """Classify distance into proximity bands.

    Returns one of: ``LOCAL``, ``REGIONAL``, ``STATE``, ``DISTANT``.
    ``None`` distance is treated as ``LOCAL`` (unknown = assume nearby).
    """
    if distance_km is None or distance_km < _DIST_LOCAL_KM:
        return "LOCAL"
    if distance_km < _DIST_REGIONAL_KM:
        return "REGIONAL"
    if distance_km < _DIST_STATE_KM:
        return "STATE"
    return "DISTANT"


def classify_magnitude(mag: float | None) -> str:
    """Classify magnitude into named bands.

    Returns one of: ``MINOR``, ``LIGHT``, ``MODERATE``, ``STRONG``, ``MAJOR``.
    ``None`` magnitude is treated as ``MINOR``.
    """
    if mag is None or mag < 2.5:
        return "MINOR"
    if mag < 4.0:
        return "LIGHT"
    if mag < 5.0:
        return "MODERATE"
    if mag < 6.0:
        return "STRONG"
    return "MAJOR"


# ---------------------------------------------------------------------------
# USGS Poller
# ---------------------------------------------------------------------------
class USGSPoller:
    """Async background poller for the USGS GeoJSON earthquake feed.

    Parameters
    ----------
    station_lat, station_lon:
        Station coordinates in decimal degrees.
    feed_url:
        USGS GeoJSON feed URL.
    poll_interval_sec:
        Seconds between API polls (default 60).
    min_magnitude:
        Minimum magnitude to process (default 1.0).
    """

    def __init__(
        self,
        station_lat: float,
        station_lon: float,
        *,
        feed_url: str = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson",
        poll_interval_sec: float = 60.0,
        min_magnitude: float = 1.0,
    ) -> None:
        self._lat = station_lat
        self._lon = station_lon
        self._feed_url = feed_url
        self._poll_interval = poll_interval_sec
        self._min_mag = min_magnitude

        self._seen_ids: set[str] = set()
        self._recent_events: list[dict[str, Any]] = []
        self._task: asyncio.Task | None = None
        self._running = False

    # ── lifecycle ──────────────────────────────────────────────────────

    async def start(self) -> None:
        """Start the background polling task."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._poll_loop(), name="usgs-poller")
        log.info(
            "usgs_poller.started",
            feed_url=self._feed_url,
            interval_sec=self._poll_interval,
        )

    async def stop(self) -> None:
        """Stop the background polling task."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        log.info("usgs_poller.stopped")

    # ── public API ─────────────────────────────────────────────────────

    def get_recent_events(self, max_age_sec: float = 300.0) -> list[dict[str, Any]]:
        """Return events from the last *max_age_sec* seconds.

        Returns
        -------
        list[dict]
            Each dict contains: ``id``, ``magnitude``, ``place``,
            ``time`` (unix epoch), ``distance_km``, ``distance_miles``,
            ``distance_class``, ``mag_class``, ``latitude``, ``longitude``,
            ``depth_km``.
        """
        cutoff = time.time() - max_age_sec
        return [e for e in self._recent_events if e["time"] >= cutoff]

    def correlate_with_trigger(
        self,
        trigger_time: float,
        max_time_diff: float = 120.0,
        max_distance_km: float = 50.0,
    ) -> dict[str, Any] | None:
        """Find a USGS event that matches a local RS4D trigger.

        Matching criteria:
        - Event time within ±max_time_diff seconds of trigger_time
        - Event distance ≤ max_distance_km from station

        Returns the best match (closest in time), or None.

        Parameters
        ----------
        trigger_time:
            Unix epoch seconds of the RS4D trigger.
        max_time_diff:
            Maximum |trigger_time - event_time| in seconds.
        max_distance_km:
            Maximum distance from station in km.

        Returns
        -------
        dict | None
            The matching USGS event dict, or None.
        """
        candidates = []
        for event in self._recent_events:
            dt = abs(trigger_time - event["time"])
            if dt <= max_time_diff and event["distance_km"] <= max_distance_km:
                candidates.append((dt, event))

        if not candidates:
            return None

        # Return the closest in time
        candidates.sort(key=lambda x: x[0])
        return candidates[0][1]

    # ── internals ──────────────────────────────────────────────────────

    async def _poll_loop(self) -> None:
        """Background loop: poll → parse → store → sleep."""
        while self._running:
            try:
                await self._poll_once()
            except asyncio.CancelledError:
                break
            except Exception:
                log.exception("usgs_poller.poll_failed")

            try:
                await asyncio.sleep(self._poll_interval)
            except asyncio.CancelledError:
                break

    async def _poll_once(self) -> None:
        """Fetch and process one cycle of the USGS feed."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(self._feed_url)
            resp.raise_for_status()
            data = resp.json()

        features = data.get("features", [])
        new_count = 0

        for feature in features:
            props = feature.get("properties", {})
            geom = feature.get("geometry", {})
            event_id = feature.get("id", "")

            # Skip already-seen events
            if event_id in self._seen_ids:
                continue

            # Skip below minimum magnitude
            mag = props.get("mag")
            if mag is not None and mag < self._min_mag:
                continue

            # Extract coordinates [lon, lat, depth]
            coords = geom.get("coordinates", [0, 0, 0])
            event_lon, event_lat = coords[0], coords[1]
            depth_km = coords[2] if len(coords) > 2 else 0.0

            # Calculate distance
            distance_km = haversine_km(self._lat, self._lon, event_lat, event_lon)
            distance_miles = round(distance_km * KM_TO_MILES, 1)

            # Classify
            dist_class = classify_distance_km(distance_km)
            mag_class = classify_magnitude(mag)

            # Convert USGS time (milliseconds since epoch) to seconds
            event_time = props.get("time", 0) / 1000.0

            # Calculate theoretical travel times
            travel = calculate_seismic_travel_times(distance_km, depth_km)
            theor_p = event_time + travel["p_travel_sec"]
            theor_s = event_time + travel["s_travel_sec"]
            theor_surf = event_time + travel["surface_travel_sec"]
            observable = is_observable_on_shake(mag, distance_km)

            event_record = {
                "id": event_id,
                "magnitude": mag,
                "place": props.get("place", ""),
                "time": event_time,
                "distance_km": round(distance_km, 1),
                "distance_miles": distance_miles,
                "distance_class": dist_class,
                "mag_class": mag_class,
                "latitude": event_lat,
                "longitude": event_lon,
                "depth_km": depth_km,
                "url": props.get("url", ""),
                "fetched_at": time.time(),
                "p_travel_sec": travel["p_travel_sec"],
                "s_travel_sec": travel["s_travel_sec"],
                "p_arrival": round(theor_p, 2),
                "s_arrival": round(theor_s, 2),
                "surf_arrival": round(theor_surf, 2),
                "is_observable": observable,
            }

            self._recent_events.append(event_record)
            self._seen_ids.add(event_id)
            new_count += 1

            # Broadcast new observable/regional earthquake to live UI
            try:
                from eqengine.web.broadcaster import get_broadcaster
                await get_broadcaster().broadcast_usgs_event(event_record)
            except Exception:
                pass

            log.info(
                "usgs_poller.new_event",
                event_id=event_id,
                magnitude=mag,
                place=props.get("place"),
                distance_km=round(distance_km, 1),
                distance_class=dist_class,
                is_observable=observable,
                theor_p=theor_p,
            )

        # Prune old events (keep last 2 hours)
        cutoff = time.time() - 7200
        self._recent_events = [e for e in self._recent_events if e["time"] >= cutoff]

        # Prune seen IDs if too large
        if len(self._seen_ids) > _MAX_SEEN_IDS:
            # Keep only IDs from current events
            self._seen_ids = {e["id"] for e in self._recent_events}

        if new_count > 0:
            log.info(
                "usgs_poller.poll_complete",
                new_events=new_count,
                total_cached=len(self._recent_events),
            )
"""Module-level convenience function for standalone haversine testing."""
