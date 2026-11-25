"""External Events Manager — schedules providers, caches state, and correlates bands."""
from __future__ import annotations

import asyncio
import contextlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import structlog

from eqengine.config import get_config
from eqengine.external_events.correlator import correlate_external_events
from eqengine.external_events.providers.aircraft import AircraftProvider
from eqengine.external_events.providers.bart_transit import BartTransitProvider
from eqengine.external_events.providers.berkeley_weather import BerkeleyWeatherProvider
from eqengine.external_events.providers.cal_football import CalFootballProvider
from eqengine.external_events.providers.greek_theatre import GreekTheatreProvider
from eqengine.external_events.schema import (
    AircraftSnapshot,
    BartTransitSnapshot,
    ExternalCorrelation,
    ExternalEvent,
    WeatherSnapshot,
)

log = structlog.get_logger(__name__)


class ExternalEventsManager:
    """Autonomous multi-provider external-event orchestrator with disk caching."""

    def __init__(
        self,
        *,
        data_dir: str | Path | None = None,
        station_lat: float = 37.8696,
        station_lon: float = -122.2491,
        schedule_poll_sec: float = 3600.0,
        weather_poll_sec: float = 600.0,
        bart_poll_sec: float = 60.0,
        aircraft_poll_sec: float = 15.0,
        aircraft_radius_nm: float = 5.0,
        aircraft_max_alt_ft: int = 5000,
        cal_team_id: str = "25",
        greek_url: str = "https://thegreekberkeley.com/events/",
        bart_api_key: str = "MW9S-E7SL-26DU-VV8V",
        bart_stations: list[str] | tuple[str, ...] = ("DBRK", "ROCK"),
    ) -> None:
        self.data_dir = Path(data_dir) if data_dir is not None else Path("data")
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.cache_path = self.data_dir / "external_events_cache.json"

        self.cal_provider = CalFootballProvider(
            team_id=cal_team_id,
            station_lat=station_lat,
            station_lon=station_lon,
            poll_interval_sec=schedule_poll_sec,
        )
        self.greek_provider = GreekTheatreProvider(
            events_url=greek_url,
            station_lat=station_lat,
            station_lon=station_lon,
            poll_interval_sec=schedule_poll_sec,
        )
        self.weather_provider = BerkeleyWeatherProvider(
            station_lat=station_lat,
            station_lon=station_lon,
            poll_interval_sec=weather_poll_sec,
        )
        self.bart_provider = BartTransitProvider(
            stations=list(bart_stations),
            api_key=bart_api_key,
            poll_interval_sec=bart_poll_sec,
        )
        self.aircraft_provider = AircraftProvider(
            station_lat=station_lat,
            station_lon=station_lon,
            radius_nm=aircraft_radius_nm,
            max_alt_ft=aircraft_max_alt_ft,
            poll_interval_sec=aircraft_poll_sec,
        )

        self._lock = asyncio.Lock()
        self._tasks: list[asyncio.Task[None]] = []
        self._running = False

        self.cal_events: list[ExternalEvent] = []
        self.greek_events: list[ExternalEvent] = []
        self.weather: WeatherSnapshot | None = None
        self.weather_events: list[ExternalEvent] = []
        self.bart: BartTransitSnapshot | None = None
        self.bart_events: list[ExternalEvent] = []
        self.aircraft: AircraftSnapshot | None = None
        self.aircraft_events: list[ExternalEvent] = []
        self.provider_status: dict[str, dict[str, Any]] = {}
        self.updated_at_utc: str | None = None

        self._load_cache()

    def _load_cache(self) -> None:
        if not self.cache_path.exists():
            return
        try:
            raw = json.loads(self.cache_path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                return
            self.cal_events = [ExternalEvent.model_validate(e) for e in raw.get("cal_events", [])]
            self.greek_events = [ExternalEvent.model_validate(e) for e in raw.get("greek_events", [])]
            if raw.get("weather"):
                self.weather = WeatherSnapshot.model_validate(raw["weather"])
            if raw.get("bart"):
                self.bart = BartTransitSnapshot.model_validate(raw["bart"])
            if raw.get("aircraft"):
                self.aircraft = AircraftSnapshot.model_validate(raw["aircraft"])
            self.updated_at_utc = raw.get("updated_at_utc")
        except (OSError, json.JSONDecodeError, ValueError):
            log.warning("external_events.cache_load_failed", path=str(self.cache_path))

    def _save_cache(self) -> None:
        payload = {
            "updated_at_utc": self.updated_at_utc,
            "cal_events": [e.model_dump() for e in self.cal_events],
            "greek_events": [e.model_dump() for e in self.greek_events],
            "weather": self.weather.model_dump() if self.weather else None,
            "bart": self.bart.model_dump() if self.bart else None,
            "aircraft": self.aircraft.model_dump() if self.aircraft else None,
        }
        with contextlib.suppress(OSError):
            self.cache_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def _mark_provider(self, name: str, ok: bool, detail: str = "") -> None:
        self.provider_status[name] = {
            "ok": ok,
            "updated_at_utc": datetime.now(tz=UTC).isoformat(),
            "detail": detail,
        }

    async def refresh_schedules(self, client: httpx.AsyncClient | None = None) -> None:
        """Refresh Cal Football and Greek Theatre schedules."""
        own_client = client is None
        http = client or httpx.AsyncClient(timeout=12.0, follow_redirects=True)
        try:
            try:
                cal = await self.cal_provider.fetch(http)
                async with self._lock:
                    self.cal_events = cal
                self._mark_provider("cal_football", True, f"{len(cal)} home games")
            except (httpx.HTTPError, ValueError) as exc:
                self._mark_provider("cal_football", False, str(exc))
                log.warning("external_events.cal_fetch_failed", error=str(exc))

            try:
                greek = await self.greek_provider.fetch(http)
                async with self._lock:
                    self.greek_events = greek
                self._mark_provider("greek_theatre", True, f"{len(greek)} concerts")
            except (httpx.HTTPError, ValueError) as exc:
                self._mark_provider("greek_theatre", False, str(exc))
                log.warning("external_events.greek_fetch_failed", error=str(exc))

            async with self._lock:
                self.updated_at_utc = datetime.now(tz=UTC).isoformat()
                self._save_cache()
        finally:
            if own_client:
                await http.aclose()

    async def refresh_weather(self, client: httpx.AsyncClient | None = None) -> None:
        """Refresh Berkeley Hills weather & wind conditions."""
        own_client = client is None
        http = client or httpx.AsyncClient(timeout=10.0, follow_redirects=True)
        try:
            snap, evs = await self.weather_provider.fetch(http)
            async with self._lock:
                self.weather = snap
                self.weather_events = evs
                self.updated_at_utc = datetime.now(tz=UTC).isoformat()
                self._save_cache()
            self._mark_provider("berkeley_weather", True, f"{snap.regime} ({snap.wind_gusts_mph} mph gusts)")
        except (httpx.HTTPError, ValueError) as exc:
            self._mark_provider("berkeley_weather", False, str(exc))
            log.warning("external_events.weather_fetch_failed", error=str(exc))
        finally:
            if own_client:
                await http.aclose()

    async def refresh_bart(self, client: httpx.AsyncClient | None = None) -> None:
        """Refresh live BART ETD arrivals at DBRK & ROCK."""
        own_client = client is None
        http = client or httpx.AsyncClient(timeout=10.0, follow_redirects=True)
        try:
            snap, evs = await self.bart_provider.fetch(http)
            async with self._lock:
                self.bart = snap
                self.bart_events = evs
                self.updated_at_utc = datetime.now(tz=UTC).isoformat()
                self._save_cache()
            self._mark_provider("bart_transit", True, f"{snap.trains_imminent_count} imminent")
        except (httpx.HTTPError, ValueError) as exc:
            self._mark_provider("bart_transit", False, str(exc))
            log.warning("external_events.bart_fetch_failed", error=str(exc))
        finally:
            if own_client:
                await http.aclose()

    async def refresh_aircraft(self, client: httpx.AsyncClient | None = None) -> None:
        """Refresh nearby overhead helicopters and low-altitude ADS-B tracks."""
        own_client = client is None
        http = client or httpx.AsyncClient(timeout=8.0, follow_redirects=True)
        try:
            snap, evs = await self.aircraft_provider.fetch(http)
            async with self._lock:
                self.aircraft = snap
                self.aircraft_events = evs
                self.updated_at_utc = datetime.now(tz=UTC).isoformat()
                self._save_cache()
            self._mark_provider("aircraft", True, f"{snap.low_overhead_count} overhead")
        except (httpx.HTTPError, ValueError) as exc:
            self._mark_provider("aircraft", False, str(exc))
            log.warning("external_events.aircraft_fetch_failed", error=str(exc))
        finally:
            if own_client:
                await http.aclose()

    async def refresh_all(self) -> dict[str, Any]:
        """Refresh every external-event provider concurrently."""
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as client:
            await asyncio.gather(
                self.refresh_schedules(client),
                self.refresh_weather(client),
                self.refresh_bart(client),
                self.refresh_aircraft(client),
                return_exceptions=True,
            )
        return self.get_payload()

    async def start(self) -> None:
        """Start background polling loops for schedules, weather, BART, and aircraft."""
        if self._running:
            return
        self._running = True
        self._tasks = [
            asyncio.create_task(self._poll_loop(self.refresh_schedules, self.cal_provider.poll_interval_sec), name="ext-schedules"),
            asyncio.create_task(self._poll_loop(self.refresh_weather, self.weather_provider.poll_interval_sec), name="ext-weather"),
            asyncio.create_task(self._poll_loop(self.refresh_bart, self.bart_provider.poll_interval_sec), name="ext-bart"),
            asyncio.create_task(self._poll_loop(self.refresh_aircraft, self.aircraft_provider.poll_interval_sec), name="ext-aircraft"),
        ]

    async def stop(self) -> None:
        """Cancel background polling tasks."""
        self._running = False
        for task in self._tasks:
            if not task.done():
                task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks = []

    async def _poll_loop(self, fn: Any, interval_sec: float) -> None:
        with contextlib.suppress(Exception):
            await fn()
        while self._running:
            try:
                await asyncio.sleep(interval_sec)
                if not self._running:
                    break
                await fn()
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001
                log.warning("external_events.poll_loop_error", error=str(exc))

    def all_events(self) -> list[ExternalEvent]:
        """Return combined list of all tracked external events."""
        return [
            *self.cal_events,
            *self.greek_events,
            *self.weather_events,
            *self.bart_events,
            *self.aircraft_events,
        ]

    def correlate(self, forensics_metrics: dict[str, Any] | None) -> ExternalCorrelation:
        """Correlate current seismic band readings with active external events."""
        return correlate_external_events(
            forensics=forensics_metrics,
            events=self.all_events(),
            weather=self.weather,
            bart=self.bart,
            aircraft=self.aircraft,
        )

    def get_payload(self, forensics_metrics: dict[str, Any] | None = None) -> dict[str, Any]:
        """Build JSON-serializable payload for `/api/external-events`."""
        events = self.all_events()
        live_events = [e for e in events if e.status == "live"]

        def _next_for(items: list[ExternalEvent]) -> dict[str, Any] | None:
            for item in items:
                if item.status == "live":
                    return item.model_dump()
            for item in items:
                if item.status == "upcoming":
                    return item.model_dump()
            return items[-1].model_dump() if items else None

        corr = self.correlate(forensics_metrics)
        return {
            "events": [e.model_dump() for e in events],
            "live_events": [e.model_dump() for e in live_events],
            "next_cal_game": _next_for(self.cal_events),
            "next_greek_concert": _next_for(self.greek_events),
            "weather": self.weather.model_dump() if self.weather else None,
            "bart": self.bart.model_dump() if self.bart else None,
            "aircraft": self.aircraft.model_dump() if self.aircraft else None,
            "correlation": corr.model_dump(),
            "provider_status": self.provider_status,
            "updated_at_utc": self.updated_at_utc,
        }


_external_manager: ExternalEventsManager | None = None


def get_external_events_manager(config: Any | None = None) -> ExternalEventsManager:
    """Return or initialize the global ExternalEventsManager singleton."""
    global _external_manager
    if _external_manager is None:
        cfg = config or get_config()
        bart_stations = getattr(cfg, "bart_stations", ["DBRK", "ROCK"])
        _external_manager = ExternalEventsManager(
            station_lat=float(getattr(cfg, "station_lat", 37.8696)),
            station_lon=float(getattr(cfg, "station_lon", -122.2491)),
            schedule_poll_sec=float(getattr(cfg, "external_events_schedule_poll_sec", 3600.0)),
            weather_poll_sec=float(getattr(cfg, "external_events_weather_poll_sec", 600.0)),
            bart_poll_sec=float(getattr(cfg, "external_events_bart_poll_sec", 60.0)),
            aircraft_poll_sec=float(getattr(cfg, "external_events_aircraft_poll_sec", 15.0)),
            aircraft_radius_nm=float(getattr(cfg, "aircraft_radius_nm", 5.0)),
            aircraft_max_alt_ft=int(getattr(cfg, "aircraft_max_alt_ft", 5000)),
            cal_team_id=str(getattr(cfg, "cal_football_team_id", "25")),
            greek_url=str(getattr(cfg, "greek_theatre_url", "https://thegreekberkeley.com/events/")),
            bart_api_key=str(getattr(cfg, "bart_api_key", "MW9S-E7SL-26DU-VV8V")),
            bart_stations=list(bart_stations),
        )
    return _external_manager
