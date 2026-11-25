"""Greek Theatre Berkeley concert calendar provider (JSON-LD MusicEvent parser)."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

from eqengine.external_events.base import ExternalEventProvider
from eqengine.external_events.schema import ExternalEvent
from eqengine.ingest.usgs_poller import haversine_km

GREEK_THEATRE_LAT: float = 37.8736
GREEK_THEATRE_LON: float = -122.2542
_SOUNDCHECK_LEAD_SEC: float = 2 * 3600.0
_SHOW_DURATION_SEC: float = 3.5 * 3600.0
_RECENT_WINDOW_SEC: float = 24 * 3600.0

_JSON_LD_RE = re.compile(
    r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
    re.IGNORECASE | re.DOTALL,
)


def _get_pacific_tz() -> ZoneInfo | UTC.__class__:
    try:
        return ZoneInfo("America/Los_Angeles")
    except ZoneInfoNotFoundError:
        return UTC


def _parse_event_ts(raw: str | None) -> float | None:
    if not raw or not isinstance(raw, str):
        return None
    val = raw.strip()
    if not val:
        return None
    try:
        dt = datetime.fromisoformat(val)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_get_pacific_tz())
        return dt.timestamp()
    except ValueError:
        return None


def _iter_json_ld_events(payload: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if isinstance(payload, list):
        for item in payload:
            found.extend(_iter_json_ld_events(item))
    elif isinstance(payload, dict):
        if "@graph" in payload:
            found.extend(_iter_json_ld_events(payload["@graph"]))
        raw_type = payload.get("@type")
        types = [raw_type] if isinstance(raw_type, str) else (raw_type if isinstance(raw_type, list) else [])
        if any(str(t) in ("MusicEvent", "Event") for t in types):
            found.append(payload)
    return found


def parse_greek_theatre_html(
    html: str,
    now_ts: float,
    station_lat: float = 37.8696,
    station_lon: float = -122.2491,
) -> list[ExternalEvent]:
    """Extract concert events from Greek Theatre HTML via JSON-LD MusicEvent blocks."""
    dist_km = round(
        haversine_km(station_lat, station_lon, GREEK_THEATRE_LAT, GREEK_THEATRE_LON),
        3,
    )
    events: list[ExternalEvent] = []
    seen_keys: set[str] = set()

    for match in _JSON_LD_RE.finditer(html or ""):
        raw_json = match.group(1).strip()
        if not raw_json:
            continue
        try:
            parsed = json.loads(raw_json)
        except json.JSONDecodeError:
            continue

        for item in _iter_json_ld_events(parsed):
            title = str(item.get("name", "")).strip()
            start_ts = _parse_event_ts(item.get("startDate"))
            if not title or start_ts is None:
                continue

            end_ts = _parse_event_ts(item.get("endDate")) or (start_ts + _SHOW_DURATION_SEC)
            soundcheck_ts = start_ts - _SOUNDCHECK_LEAD_SEC

            if soundcheck_ts <= now_ts <= end_ts:
                status = "live"
                phase = "soundcheck" if now_ts < start_ts else "live_show"
            elif now_ts > end_ts:
                if (now_ts - end_ts) > _RECENT_WINDOW_SEC:
                    continue
                status = "recent"
                phase = "ended"
            else:
                status = "upcoming"
                phase = "scheduled"

            dedup_key = f"{title.lower()}::{int(start_ts)}"
            if dedup_key in seen_keys:
                continue
            seen_keys.add(dedup_key)

            loc = item.get("location")
            venue_name = (
                str(loc.get("name", "")).strip()
                if isinstance(loc, dict) and loc.get("name")
                else "The Greek Theatre at UC Berkeley"
            )
            ev_id = "greek-" + hashlib.sha1(dedup_key.encode("utf-8")).hexdigest()[:10]

            events.append(
                ExternalEvent(
                    id=ev_id,
                    source="greek-theatre",
                    category="concert",
                    title=title,
                    venue=venue_name,
                    start_time_utc=datetime.fromtimestamp(start_ts, tz=UTC).isoformat(),
                    end_time_utc=datetime.fromtimestamp(end_ts, tz=UTC).isoformat(),
                    start_ts=start_ts,
                    end_ts=end_ts,
                    status=status,
                    distance_km=dist_km,
                    expected_band_key="concert",
                    expected_bands_hz=(25.0, 45.0),
                    seismic_note="PA subwoofers couple 25–45 Hz acoustic sub-bass into the hillside.",
                    url=item.get("url") if isinstance(item.get("url"), str) else None,
                    metadata={"phase": phase},
                )
            )

    events.sort(key=lambda ev: ev.start_ts or 0.0)
    return events


class GreekTheatreProvider(ExternalEventProvider):
    """Fetch upcoming and tonight's concerts at The Greek Theatre Berkeley."""

    name = "greek_theatre"

    def __init__(
        self,
        *,
        events_url: str = "https://thegreekberkeley.com/events/",
        station_lat: float = 37.8696,
        station_lon: float = -122.2491,
        poll_interval_sec: float = 3600.0,
    ) -> None:
        self.events_url = events_url
        self.station_lat = station_lat
        self.station_lon = station_lon
        self.poll_interval_sec = poll_interval_sec

    async def fetch(self, client: httpx.AsyncClient) -> list[ExternalEvent]:
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (compatible; EarthquakePredictionEngine/0.2; "
                "+https://github.com/gavinfischer-keenan/Earthquakepredictionengine)"
            )
        }
        resp = await client.get(self.events_url, headers=headers)
        resp.raise_for_status()
        now_ts = datetime.now(tz=UTC).timestamp()
        return parse_greek_theatre_html(
            resp.text,
            now_ts=now_ts,
            station_lat=self.station_lat,
            station_lon=self.station_lon,
        )
