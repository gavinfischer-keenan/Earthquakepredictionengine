"""Cal Memorial Stadium football schedule provider via ESPN public API."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import httpx

from eqengine.external_events.base import ExternalEventProvider
from eqengine.external_events.schema import ExternalEvent
from eqengine.ingest.usgs_poller import haversine_km

MEMORIAL_STADIUM_LAT: float = 37.8710
MEMORIAL_STADIUM_LON: float = -122.2508
_GAME_DURATION_SEC: float = 4 * 3600.0
_PREGAME_WINDOW_SEC: float = 1800.0
_RECENT_WINDOW_SEC: float = 24 * 3600.0


def _parse_iso_ts(raw: str | None) -> float | None:
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt.timestamp()
    except ValueError:
        return None


def parse_espn_cal_schedule(
    data: dict[str, Any],
    now_ts: float,
    station_lat: float = 37.8696,
    station_lon: float = -122.2491,
    team_id: str = "25",
) -> list[ExternalEvent]:
    """Parse ESPN Cal football schedule JSON and return home games at Memorial Stadium."""
    dist_km = round(
        haversine_km(station_lat, station_lon, MEMORIAL_STADIUM_LAT, MEMORIAL_STADIUM_LON),
        3,
    )
    results: list[ExternalEvent] = []

    for raw_event in data.get("events", []):
        if not isinstance(raw_event, dict):
            continue
        competitions = raw_event.get("competitions") or []
        if not competitions:
            continue
        comp = competitions[0]
        competitors = comp.get("competitors") or []

        is_home = False
        opponent = ""
        cal_score = None
        opp_score = None

        for c in competitors:
            team = c.get("team") or {}
            tid = str(team.get("id", ""))
            abbr = str(team.get("abbreviation", "")).upper()
            if tid == str(team_id) or abbr == "CAL":
                if str(c.get("homeAway", "")).lower() == "home":
                    is_home = True
                cal_score = c.get("score", {}).get("displayValue") if isinstance(c.get("score"), dict) else c.get("score")
            else:
                opponent = team.get("displayName") or team.get("shortDisplayName") or abbr or "Opponent"
                opp_score = c.get("score", {}).get("displayValue") if isinstance(c.get("score"), dict) else c.get("score")

        venue_obj = comp.get("venue") or {}
        venue_name = str(venue_obj.get("fullName", ""))
        venue_city = str((venue_obj.get("address") or {}).get("city", ""))
        if not is_home and ("memorial stadium" in venue_name.lower() or venue_city.lower() == "berkeley"):
            is_home = True

        if not is_home:
            continue

        start_ts = _parse_iso_ts(raw_event.get("date") or comp.get("date"))
        if start_ts is None:
            continue
        end_ts = start_ts + _GAME_DURATION_SEC

        status_obj = (comp.get("status") or raw_event.get("status") or {}).get("type") or {}
        espn_state = str(status_obj.get("state", "")).lower()
        status_detail = str(status_obj.get("shortDetail") or status_obj.get("description") or "")

        if espn_state == "in" or (espn_state != "post" and (start_ts - _PREGAME_WINDOW_SEC) <= now_ts <= end_ts):
            status = "live"
        elif espn_state == "post" or now_ts > end_ts:
            if (now_ts - end_ts) > _RECENT_WINDOW_SEC:
                continue
            status = "recent"
        else:
            status = "upcoming"

        title = raw_event.get("name") or (f"Cal vs {opponent}" if opponent else "Cal Home Football")
        links = raw_event.get("links") or []
        url = links[0].get("href") if links and isinstance(links[0], dict) else None

        results.append(
            ExternalEvent(
                id=f"cal-fb-{raw_event.get('id', int(start_ts))}",
                source="espn-cfb",
                category="football",
                title=title,
                venue=venue_name or "California Memorial Stadium",
                start_time_utc=datetime.fromtimestamp(start_ts, tz=UTC).isoformat(),
                end_time_utc=datetime.fromtimestamp(end_ts, tz=UTC).isoformat(),
                start_ts=start_ts,
                end_ts=end_ts,
                status=status,
                distance_km=dist_km,
                expected_band_key="stadium",
                expected_bands_hz=(2.0, 5.0),
                seismic_note="Crowd stomp, jumping, and roar excite 2–5 Hz stadium resonance.",
                url=url,
                metadata={
                    "opponent": opponent,
                    "espn_state": espn_state,
                    "status_detail": status_detail,
                    "cal_score": cal_score,
                    "opp_score": opp_score,
                },
            )
        )

    results.sort(key=lambda ev: ev.start_ts or 0.0)
    return results


class CalFootballProvider(ExternalEventProvider):
    """Fetch Cal Golden Bears home football schedule from ESPN."""

    name = "cal_football"

    def __init__(
        self,
        *,
        team_id: str = "25",
        station_lat: float = 37.8696,
        station_lon: float = -122.2491,
        poll_interval_sec: float = 3600.0,
    ) -> None:
        self.team_id = team_id
        self.station_lat = station_lat
        self.station_lon = station_lon
        self.poll_interval_sec = poll_interval_sec

    async def fetch(self, client: httpx.AsyncClient) -> list[ExternalEvent]:
        url = f"https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/{self.team_id}/schedule"
        resp = await client.get(url)
        resp.raise_for_status()
        now_ts = datetime.now(tz=UTC).timestamp()
        return parse_espn_cal_schedule(
            resp.json(),
            now_ts=now_ts,
            station_lat=self.station_lat,
            station_lon=self.station_lon,
            team_id=self.team_id,
        )
