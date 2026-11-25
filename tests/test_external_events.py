"""Tests for the modular External Events package (Cal Football, Greek Theatre, Weather, BART)."""
from __future__ import annotations

from datetime import UTC, datetime

from eqengine.external_events.correlator import correlate_external_events
from eqengine.external_events.manager import ExternalEventsManager
from eqengine.external_events.providers.aircraft import parse_airplanes_live_response
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
