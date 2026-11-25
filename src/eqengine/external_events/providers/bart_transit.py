"""BART real-time ETD provider for Berkeley Hills Tunnel (DBRK & ROCK)."""
from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import httpx

from eqengine.external_events.base import ExternalEventProvider
from eqengine.external_events.schema import (
    BartTrainArrival,
    BartTransitSnapshot,
    ExternalEvent,
)

_TUNNEL_WINDOW_MIN: int = 3


def _parse_minutes(raw: Any) -> int | None:
    text = str(raw or "").strip()
    if not text:
        return None
    if text.lower() == "leaving":
        return 0
    try:
        return max(0, int(text))
    except ValueError:
        return None


def parse_bart_etd_responses(
    station_payloads: dict[str, dict[str, Any]],
    now_ts: float,
) -> tuple[BartTransitSnapshot, list[ExternalEvent]]:
    """Parse BART JSON ETD payloads into a BartTransitSnapshot and active tunnel event."""
    arrivals: list[BartTrainArrival] = []

    for stn_code, payload in station_payloads.items():
        root = payload.get("root") or {}
        stations = root.get("station") or []
        if isinstance(stations, dict):
            stations = [stations]
        for stn_obj in stations:
            etd_list = stn_obj.get("etd") or []
            if isinstance(etd_list, dict):
                etd_list = [etd_list]
            for etd in etd_list:
                dest = str(etd.get("destination") or etd.get("abbreviation") or "Train")
                estimates = etd.get("estimate") or []
                if isinstance(estimates, dict):
                    estimates = [estimates]
                for est in estimates:
                    mins = _parse_minutes(est.get("minutes"))
                    if mins is None:
                        continue
                    try:
                        cars = int(est.get("length") or 0)
                    except (TypeError, ValueError):
                        cars = 0
                    arrivals.append(
                        BartTrainArrival(
                            station=stn_code,
                            destination=dest,
                            line_color=str(est.get("color") or ""),
                            minutes=mins,
                            direction=str(est.get("direction") or ""),
                            length_cars=cars,
                            in_tunnel_window=mins <= _TUNNEL_WINDOW_MIN,
                        )
                    )

    arrivals.sort(key=lambda a: (a.minutes, a.station))
    imminent = [a for a in arrivals if a.in_tunnel_window]
    tunnel_active = len(imminent) > 0
    fetched_utc = datetime.fromtimestamp(now_ts, tz=UTC).isoformat()

    snap = BartTransitSnapshot(
        fetched_at_utc=fetched_utc,
        stations=list(station_payloads.keys()),
        trains_imminent_count=len(imminent),
        tunnel_active=tunnel_active,
        next_trains=arrivals[:8],
    )

    events: list[ExternalEvent] = []
    if tunnel_active:
        summary = ", ".join(
            f"{a.station}->{a.destination} ({'Leaving' if a.minutes == 0 else f'{a.minutes}m'})"
            for a in imminent[:3]
        )
        events.append(
            ExternalEvent(
                id="bart-hills-tunnel-live",
                source="bart-etd",
                category="transit",
                title=f"BART Hills Tunnel Active ({len(imminent)} imminent)",
                venue="Berkeley Hills Tunnel (DBRK / ROCK)",
                start_time_utc=fetched_utc,
                end_time_utc=None,
                start_ts=now_ts,
                end_ts=None,
                status="live",
                distance_km=1.4,
                expected_band_key="rail",
                expected_bands_hz=(4.0, 8.0),
                seismic_note="Transbay/Richmond trains in the Hills Tunnel excite 4–8 Hz rail harmonics.",
                metadata={"imminent_summary": summary, "count": len(imminent)},
            )
        )

    return snap, events


class BartTransitProvider(ExternalEventProvider):
    """Fetch live BART ETD arrivals for DBRK and ROCK near the Berkeley Hills Tunnel."""

    name = "bart_transit"

    def __init__(
        self,
        *,
        stations: Sequence[str] = ("DBRK", "ROCK"),
        api_key: str = "MW9S-E7SL-26DU-VV8V",
        poll_interval_sec: float = 60.0,
    ) -> None:
        self.stations = [s.strip().upper() for s in stations if s.strip()]
        self.api_key = api_key
        self.poll_interval_sec = poll_interval_sec

    async def fetch(
        self, client: httpx.AsyncClient
    ) -> tuple[BartTransitSnapshot, list[ExternalEvent]]:
        payloads: dict[str, dict[str, Any]] = {}
        for stn in self.stations:
            url = f"https://api.bart.gov/api/etd.aspx?cmd=etd&orig={stn}&key={self.api_key}&json=y"
            resp = await client.get(url)
            resp.raise_for_status()
            payloads[stn] = resp.json()
        now_ts = datetime.now(tz=UTC).timestamp()
        return parse_bart_etd_responses(payloads, now_ts=now_ts)
