"""Tests for the modular External Events package (Cal Football, Greek Theatre, Weather, BART)."""
from __future__ import annotations

from datetime import UTC, datetime

from eqengine.external_events.correlator import correlate_external_events
from eqengine.external_events.manager import ExternalEventsManager
from eqengine.external_events.providers.aircraft import (
    AircraftProvider,
    parse_airplanes_live_response,
    parse_opensky_response,
)
from eqengine.external_events.providers.bart_transit import parse_bart_etd_responses
from eqengine.external_events.providers.berkeley_weather import parse_open_meteo_weather
from eqengine.external_events.providers.cal_football import parse_espn_cal_schedule
from eqengine.external_events.providers.greek_theatre import parse_greek_theatre_html


class TestCalFootballProvider:
    def test_filters_home_games_and_detects_live_and_upcoming(self) -> None:
        now_ts = datetime(2026, 10, 17, 20, 0, tzinfo=UTC).timestamp()
        sample = {
            "events": [
                {
                    "id": "away-1",
                    "name": "California at Stanford",
                    "date": "2026-10-17T20:00Z",
                    "competitions": [
                        {
                            "venue": {"fullName": "Stanford Stadium", "address": {"city": "Stanford"}},
                            "competitors": [
                                {"homeAway": "away", "team": {"id": "25", "abbreviation": "CAL"}},
                                {"homeAway": "home", "team": {"id": "24", "abbreviation": "STAN", "displayName": "Stanford"}},
                            ],
                            "status": {"type": {"state": "in", "shortDetail": "Q2 08:12"}},
                        }
                    ],
                },
                {
                    "id": "home-live",
                    "name": "Oregon at California",
                    "date": "2026-10-17T19:00Z",
                    "competitions": [
                        {
                            "venue": {"fullName": "California Memorial Stadium", "address": {"city": "Berkeley"}},
                            "competitors": [
                                {"homeAway": "home", "score": "21", "team": {"id": "25", "abbreviation": "CAL"}},
                                {"homeAway": "away", "score": "14", "team": {"id": "2483", "abbreviation": "ORE", "displayName": "Oregon Ducks"}},
                            ],
                            "status": {"type": {"state": "in", "shortDetail": "Q3 04:10"}},
                        }
                    ],
                },
                {
                    "id": "home-upcoming",
                    "name": "UCLA at California",
                    "date": "2026-10-24T22:00Z",
                    "competitions": [
                        {
                            "venue": {"fullName": "California Memorial Stadium", "address": {"city": "Berkeley"}},
                            "competitors": [
                                {"homeAway": "home", "team": {"id": "25", "abbreviation": "CAL"}},
                                {"homeAway": "away", "team": {"id": "26", "abbreviation": "UCLA", "displayName": "UCLA Bruins"}},
                            ],
                            "status": {"type": {"state": "pre", "shortDetail": "10/24"}},
                        }
                    ],
                },
            ]
        }

        events = parse_espn_cal_schedule(sample, now_ts=now_ts)
        assert len(events) == 2
        assert events[0].id == "cal-fb-home-live"
        assert events[0].status == "live"
        assert events[0].expected_band_key == "stadium"
        assert events[0].distance_km is not None and events[0].distance_km < 1.0
        assert events[1].status == "upcoming"


class TestGreekTheatreProvider:
    def test_parses_json_ld_music_events_and_soundcheck_window(self) -> None:
        html = """
        <html><head>
        <script type="application/ld+json">
        {
          "@graph": [
            {
              "@type": "MusicEvent",
              "name": "Khruangbin — Live at The Greek",
              "startDate": "2026-10-17T20:00:00-07:00",
              "url": "https://thegreekberkeley.com/events/khruangbin",
              "location": {"name": "The Greek Theatre"}
            },
            {
              "@type": ["Event", "MusicEvent"],
              "name": "Tame Impala",
              "startDate": "2026-10-25T19:30:00-07:00"
            }
          ]
        }
        </script>
        </head><body></body></html>
        """
        # 18:30 PDT = 90 min before 20:00 PDT start -> soundcheck live window
        now_soundcheck = datetime.fromisoformat("2026-10-17T18:30:00-07:00").timestamp()
        events = parse_greek_theatre_html(html, now_ts=now_soundcheck)
        assert len(events) == 2
        assert events[0].title == "Khruangbin — Live at The Greek"
        assert events[0].status == "live"
        assert events[0].metadata["phase"] == "soundcheck"
        assert events[0].expected_band_key == "concert"
        assert events[1].status == "upcoming"

    def test_handles_empty_or_malformed_html_gracefully(self) -> None:
        assert parse_greek_theatre_html("<html><script type='application/ld+json'>{bad</script></html>", now_ts=1700000000.0) == []


class TestWeatherAndBartProviders:
    def test_open_meteo_gusty_wind_emits_live_event(self) -> None:
        payload = {
            "current": {
                "temperature_2m": 15.2,
                "precipitation": 0.4,
                "surface_pressure": 1009.5,
                "wind_speed_10m": 9.0,
                "wind_gusts_10m": 14.5,
                "wind_direction_10m": 295.0,
            }
        }
        snap, events = parse_open_meteo_weather(payload, now_ts=1794800000.0)
        assert snap.regime == "GUSTY"
        assert snap.wind_direction_cardinal == "WNW"
        assert len(events) == 1
        assert events[0].expected_band_key == "wind"

    def test_bart_etd_detects_imminent_tunnel_trains(self) -> None:
        payloads = {
            "DBRK": {
                "root": {
                    "station": [
                        {
                            "etd": [
                                {
                                    "destination": "SFO Airport",
                                    "estimate": [{"minutes": "Leaving", "color": "YELLOW", "length": "10", "direction": "South"}],
                                }
                            ]
                        }
                    ]
                }
            },
            "ROCK": {
                "root": {
                    "station": [
                        {
                            "etd": [
                                {
                                    "destination": "Antioch",
                                    "estimate": [{"minutes": "11", "color": "YELLOW", "length": "8", "direction": "North"}],
                                }
                            ]
                        }
                    ]
                }
            },
        }
        snap, events = parse_bart_etd_responses(payloads, now_ts=1794800000.0)
        assert snap.tunnel_active is True
        assert snap.trains_imminent_count == 1
        assert len(events) == 1
        assert events[0].expected_band_key == "rail"


class TestCorrelatorAndCache:
    def test_correlates_live_cal_game_with_stadium_band(self) -> None:
        now_ts = datetime(2026, 10, 17, 20, 0, tzinfo=UTC).timestamp()
        cal_events = parse_espn_cal_schedule(
            {
                "events": [
                    {
                        "id": "g1",
                        "name": "USC at California",
                        "date": "2026-10-17T19:00Z",
                        "competitions": [
                            {
                                "venue": {"fullName": "California Memorial Stadium"},
                                "competitors": [{"homeAway": "home", "team": {"id": "25", "abbreviation": "CAL"}}],
                                "status": {"type": {"state": "in"}},
                            }
                        ],
                    }
                ]
            },
            now_ts=now_ts,
        )
        corr = correlate_external_events({"stadium_um_s": 1.45, "concert_um_s": 0.1}, cal_events)
        assert corr.matched is True
        assert corr.active_category == "football"
        assert corr.matched_band == "stadium"
        assert corr.confidence >= 80

    def test_manager_cache_round_trip(self, tmp_path) -> None:
        mgr = ExternalEventsManager(data_dir=tmp_path)
        snap, evs = parse_open_meteo_weather(
            {"current": {"wind_speed_10m": 8.0, "wind_gusts_10m": 12.0, "wind_direction_10m": 270.0}},
            now_ts=1794800000.0,
        )
        mgr.weather = snap
        mgr.weather_events = evs
        mgr.updated_at_utc = snap.fetched_at_utc
        mgr._save_cache()

        mgr2 = ExternalEventsManager(data_dir=tmp_path)
        assert mgr2.weather is not None
        assert mgr2.weather.regime == "GUSTY"


class TestAircraftProvider:
    def test_parses_overhead_helicopter_and_correlates(self) -> None:
        now_ts = 1795000000.0
        payload = {
            "ac": [
                {
                    "hex": "a12345",
                    "flight": "CHP30 ",
                    "t": "H125",
                    "category": "A7",
                    "lat": 37.872,
                    "lon": -122.250,
                    "alt_baro": 1400,
                    "gs": 95.0,
                    "track": 180.0,
                },
                {
                    "hex": "b99999",
                    "flight": "UAL100",
                    "t": "B738",
                    "category": "A3",
                    "lat": 37.870,
                    "lon": -122.248,
                    "alt_baro": 28000,
                    "gs": 420.0,
                },
            ]
        }
        snap, evs = parse_airplanes_live_response(payload, now_ts=now_ts, max_alt_ft=5000, max_dist_km=6.0)
        assert snap.low_overhead_count == 1
        assert snap.helicopter_overhead is True
        assert snap.closest_aircraft is not None
        assert snap.closest_aircraft.callsign == "CHP30"
        assert snap.closest_aircraft.is_helicopter is True
        assert len(evs) == 1
        assert evs[0].category == "aircraft"

        corr = correlate_external_events(
            {"traffic_um_s": 0.45, "human_um_s": 0.35},
            evs,
            aircraft=snap,
        )
        assert corr.matched is True
        assert corr.active_category == "aircraft"
        assert corr.matched_band == "aircraft"
        assert "CHP30" in corr.reason

    def test_parses_adsb_fi_and_opensky_formats(self) -> None:
        now_ts = 1795000000.0
        fi_payload = {
            "aircraft": [
                {
                    "hex": "c11111",
                    "flight": "MED1",
                    "t": "H135",
                    "lat": 37.871,
                    "lon": -122.250,
                    "alt_baro": 1200,
                    "gs": 110.0,
                }
            ]
        }
        snap_fi, _ = parse_airplanes_live_response(fi_payload, now_ts=now_ts, source="adsb-fi")
        assert snap_fi.source == "adsb-fi"
        assert snap_fi.helicopter_overhead is True
        assert snap_fi.closest_aircraft is not None
        assert snap_fi.closest_aircraft.callsign == "MED1"

        opensky_payload = {
            "states": [
                # Low rotorcraft (category 8, ~400 m ≈ 1312 ft)
                ["a10001", "CHP32 ", "United States", 1795000000, 1795000000, -122.250, 37.870, 400.0, False, 50.0, 90.0, 0.0, None, 410.0, "1200", False, 0, 8],
                # On-ground aircraft -> ignored
                ["a10002", "GND1  ", "United States", 1795000000, 1795000000, -122.250, 37.870, 100.0, True, 5.0, 0.0, 0.0, None, 100.0, None, False, 0, 3],
                # High airliner (9000 m ≈ 29528 ft) -> excluded from overhead
                ["a10003", "UAL99 ", "United States", 1795000000, 1795000000, -122.250, 37.870, 9000.0, False, 220.0, 180.0, 0.0, None, 9100.0, "3000", False, 0, 4],
            ]
        }
        snap_os, evs_os = parse_opensky_response(opensky_payload, now_ts=now_ts, max_alt_ft=5000)
        assert snap_os.source == "opensky"
        assert snap_os.total_nearby == 2
        assert snap_os.low_overhead_count == 1
        assert snap_os.helicopter_overhead is True
        assert snap_os.closest_aircraft is not None
        assert snap_os.closest_aircraft.callsign == "CHP32"
        assert len(evs_os) == 1

    async def test_aircraft_provider_falls_back_on_403_and_cools_down(self) -> None:
        import httpx

        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.host)
            if "adsb.lol" in request.url.host:
                return httpx.Response(403, json={"error": "blocked"}, request=request)
            if "adsb.fi" in request.url.host:
                return httpx.Response(
                    200,
                    json={"aircraft": [{"hex": "abc123", "flight": "TEST1", "t": "H125", "lat": 37.87, "lon": -122.25, "alt_baro": 1500}]},
                    request=request,
                )
            return httpx.Response(404, request=request)

        provider = AircraftProvider()
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            snap, _ = await provider.fetch(client)
            assert snap.source == "adsb-fi"
            assert snap.low_overhead_count == 1
            assert "api.adsb.lol" in calls

            # Next poll skips blocked adsb.lol cleanly because cooldown is active
            calls.clear()
            snap2, _ = await provider.fetch(client)
            assert snap2.source == "adsb-fi"
            assert "api.adsb.lol" not in calls
