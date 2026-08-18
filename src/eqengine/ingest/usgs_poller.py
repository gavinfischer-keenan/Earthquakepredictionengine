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

import json
from pathlib import Path

# Distance classification thresholds (km)
_DIST_LOCAL_KM: float = 80.0      # ~50 miles
_DIST_REGIONAL_KM: float = 240.0  # ~150 miles
_DIST_STATE_KM: float = 640.0     # ~400 miles

# Dedup cache max size
_MAX_SEEN_IDS: int = 25000


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
    """Determine if an earthquake is theoretically observable on a Raspberry Shake RS4D within 700 miles.

    Uses a sliding scale where a M5.0 at 500-700 miles is observable, down to M0.8 nearby.
    Earthquakes beyond 700 miles (1126.5 km) are filtered out unless large teleseismic (M5.5+).
    """
    if magnitude is None:
        return False
    distance_miles = distance_km * KM_TO_MILES
    if distance_miles > 700.0:
        return False  # 700-mile regional limit

    # Sliding scale: M_min(R) = 0.8 + 2.05 * log10(max(R, 5.0) / 5.0)
    r_effective = max(distance_miles, 5.0)
    m_min = 0.8 + 2.05 * math.log10(r_effective / 5.0)
    return magnitude >= m_min


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
    """Async background poller for the USGS GeoJSON earthquake feed with persistent disk caching.

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
    cache_path:
        Path to persistent JSON cache file.
    """

    def __init__(
        self,
        station_lat: float,
        station_lon: float,
        *,
        feed_url: str = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson",
        poll_interval_sec: float = 60.0,
        min_magnitude: float = 1.0,
        cache_path: str = "./data/usgs_cache.json",
    ) -> None:
        self._lat = station_lat
        self._lon = station_lon
        self._feed_url = feed_url
        self._poll_interval = poll_interval_sec
        self._min_mag = min_magnitude
        self._cache_path = Path(cache_path)

        self._seen_ids: set[str] = set()
        self._recent_events: list[dict[str, Any]] = []
        self._task: asyncio.Task | None = None
        self._running = False

    def _load_cache(self) -> None:
        """Load cached earthquakes from disk."""
        if not self._cache_path.exists():
            return
        try:
            with open(self._cache_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    now = time.time()
                    # Filter events from past 7 days
                    valid_events = [e for e in data if isinstance(e, dict) and e.get("time", 0) >= (now - 7 * 86400)]
                    self._recent_events = valid_events
                    for e in valid_events:
                        if "id" in e:
                            self._seen_ids.add(str(e["id"]))
                    log.info("usgs_poller.cache_loaded", count=len(self._recent_events), path=str(self._cache_path))
        except Exception:
            log.exception("usgs_poller.cache_load_failed", path=str(self._cache_path))

    def _save_cache(self) -> None:
        """Persist cached earthquakes to disk."""
        try:
            self._cache_path.parent.mkdir(parents=True, exist_ok=True)
            # Keep up to 2000 events, sorted by time descending
            self._recent_events.sort(key=lambda x: x.get("time", 0), reverse=True)
            to_save = self._recent_events[:2000]
            with open(self._cache_path, "w", encoding="utf-8") as f:
                json.dump(to_save, f, indent=2)
        except Exception:
            log.exception("usgs_poller.cache_save_failed", path=str(self._cache_path))

    # ── lifecycle ──────────────────────────────────────────────────────

    async def start(self) -> None:
        """Start the background polling task."""
        if self._running:
            return
        self._running = True
        self._load_cache()

        # Seed cache on first run if empty
        if len(self._recent_events) < 20:
            try:
                await self._poll_feed("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson")
            except Exception:
                log.warning("usgs_poller.initial_seed_failed")

        self._task = asyncio.create_task(self._poll_loop(), name="usgs-poller")
        log.info(
            "usgs_poller.started",
            feed_url=self._feed_url,
            interval_sec=self._poll_interval,
            cached_count=len(self._recent_events),
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
        self._save_cache()
        log.info("usgs_poller.stopped")

    # ── public API ─────────────────────────────────────────────────────

    def get_recent_events(self, max_age_sec: float = 172800.0) -> list[dict[str, Any]]:
        """Return events from the last *max_age_sec* seconds (default 48 hours)."""
        cutoff = time.time() - max_age_sec
        return [e for e in self._recent_events if e.get("time", 0) >= cutoff]

    def correlate_with_trigger(
        self,
        trigger_time: float,
        max_time_diff: float = 120.0,
        max_distance_km: float = 50.0,
    ) -> dict[str, Any] | None:
        """Find a USGS event that matches a local RS4D trigger."""
        candidates = []
        for event in self._recent_events:
            dt = abs(trigger_time - event.get("time", 0))
            if dt <= max_time_diff and event.get("distance_km", 9999) <= max_distance_km:
                candidates.append((dt, event))

        if not candidates:
            return None

        candidates.sort(key=lambda x: x[0])
        return candidates[0][1]

    # ── internals ──────────────────────────────────────────────────────

    async def _poll_loop(self) -> None:
        """Background loop: poll → parse → store → sleep."""
        while self._running:
            try:
                await self._poll_feed(self._feed_url)
            except asyncio.CancelledError:
                break
            except Exception:
                log.exception("usgs_poller.poll_failed")

            try:
                await asyncio.sleep(self._poll_interval)
            except asyncio.CancelledError:
                break

    async def _poll_feed(self, feed_url: str) -> None:
        """Fetch and process one cycle of a USGS GeoJSON feed."""
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(feed_url)
            resp.raise_for_status()
            data = resp.json()

        features = data.get("features", [])
        new_events = []

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

            # Only store events within 700 miles, or observable/large teleseismic events
            if distance_miles > 700.0 and not observable and (mag is None or mag < 5.5):
                self._seen_ids.add(event_id)
                continue

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
                "surface_travel_sec": travel["surface_travel_sec"],
                "theor_p_arrival": theor_p,
                "theor_s_arrival": theor_s,
                "theor_surface_arrival": theor_surf,
                "is_observable": observable,
            }

            self._seen_ids.add(event_id)
            new_events.append(event_record)

            # Broadcast live event if initial poll already done
            if getattr(self, "_initial_poll_done", False):
                try:
                    from eqengine.web.broadcaster import get_broadcaster
                    asyncio.create_task(get_broadcaster().broadcast_usgs_event(event_record))
                except Exception:
                    pass

        if new_events:
            self._recent_events.extend(new_events)
            self._save_cache()
            log.info("usgs_poller.new_events_cached", count=len(new_events), total=len(self._recent_events))

        self._initial_poll_done = True

        # Prune old events (retain 7 days in memory / disk)
        cutoff_7d = time.time() - 7 * 86400.0
        self._recent_events = [e for e in self._recent_events if e.get("time", 0) >= cutoff_7d]

        # Prune seen IDs if too large
        if len(self._seen_ids) > _MAX_SEEN_IDS:
            self._seen_ids = {e["id"] for e in self._recent_events if "id" in e}
