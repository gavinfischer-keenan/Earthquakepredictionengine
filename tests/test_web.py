"""Tests for eqengine.web (FastAPI server, broadcaster, and endpoints)."""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient
from obspy import Trace, UTCDateTime

from eqengine.web.broadcaster import WaveformBroadcaster, get_broadcaster
from eqengine.web.server import create_app


@pytest.fixture
def mock_ring_buffer():
    trace = Trace(data=np.array([10.0, 20.0, 30.0]), header={"sampling_rate": 100.0, "starttime": UTCDateTime(0)})
    return SimpleNamespace(
        channels=("EHZ", "ENZ"),
        get_fill_ratios=lambda: {"EHZ": 0.9, "ENZ": 0.9},
        get_latest=lambda ch, duration_sec: trace if ch in ("EHZ", "ENZ") else None,
    )


@pytest.fixture
def mock_detector():
    return SimpleNamespace(
        get_current_ratio=lambda: 1.25,
        is_triggered=False,
    )


@pytest.fixture
def client(mock_ring_buffer, mock_detector):
    app = create_app(ring_buffer=mock_ring_buffer, detector=mock_detector)
    return TestClient(app)


class TestWebServer:
    def test_status_endpoint(self, client: TestClient):
        response = client.get("/api/status")
        assert response.status_code == 200
        data = response.json()
        assert "station" in data
        assert "network" in data
        assert "channels" in data
        assert "buffer_health" in data

    def test_events_endpoint(self, client: TestClient):
        response = client.get("/api/events")
        assert response.status_code == 200
        data = response.json()
        assert "triggers" in data
        assert "alerts" in data
        assert "usgs_events" in data

    def test_usgs_events_endpoint(self, client: TestClient):
        response = client.get("/api/usgs-events")
        assert response.status_code == 200
        data = response.json()
        assert "events" in data
        assert "count" in data

    def test_channel_buffer_endpoint_valid(self, client: TestClient):
        response = client.get("/api/buffer/EHZ?duration=10.0")
        assert response.status_code == 200
        data = response.json()
        assert data["channel"] == "EHZ"
        assert "samples" in data

    def test_channel_buffer_endpoint_missing(self, client: TestClient):
        response = client.get("/api/buffer/UNKNOWN")
        assert response.status_code == 404

    def test_simulate_trigger_endpoint(self, client: TestClient):
        response = client.post("/api/simulate-trigger?magnitude=4.2&distance_km=15.0")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    def test_simulate_usgs_endpoint(self, client: TestClient):
        response = client.post("/api/simulate-usgs?magnitude=5.0&place=Test+Region&distance_km=100.0")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    def test_broadcaster_singleton(self):
        b1 = get_broadcaster()
        b2 = get_broadcaster()
        assert b1 is b2
        assert isinstance(b1, WaveformBroadcaster)

    def test_static_index_html_serving(self, client: TestClient):
        response = client.get("/")
        assert response.status_code == 200
        assert "Earthquake Prediction Engine" in response.text
        assert "spectrogramCanvas" in response.text
        assert "radarMap" in response.text
        assert "staltaCanvas" in response.text
        assert "observatoryTooltip" in response.text
        assert "forensicPrimaryTitle" in response.text
        assert "envExternalEventsPanel" in response.text
        assert "extCalTitle" in response.text
        assert "extGreekTitle" in response.text
        assert "extWeatherTitle" in response.text
        assert "extBartTitle" in response.text
        assert "alertMagVal" in response.text
        assert "incomingPCount" in response.text

    def test_static_js_views_exist(self, client: TestClient):
        # Verify that all JS modules and extracted geo data files are served
        view_files = [
            "style.css",
            "js/main.js",
            "js/state.js",
            "js/dom.js",
            "js/dsp.js",
            "js/websocket.js",
            "js/data/clusters.js",
            "js/data/faults.js",
            "js/data/historic_quakes.js",
            "js/views/oscilloscope.js",
            "js/views/spectrogram.js",
            "js/views/helicorder.js",
            "js/views/stalta.js",
            "js/views/hodogram.js",
            "js/views/radar.js",
            "js/views/urban.js",
            "js/views/phasenet.js",
            "js/views/peterson.js",
            "js/views/tables.js",
            "js/views/review_studio.js",
        ]
        for v in view_files:
            resp = client.get(f"/static/{v}")
            assert resp.status_code == 200, f"Failed to serve /static/{v}"
            if v.endswith(".js"):
                assert "?v=" not in resp.text, f"Inconsistent query-string import found in {v}"

    def test_external_events_endpoints(self, tmp_path):
        from eqengine.external_events.manager import ExternalEventsManager
        from eqengine.external_events.providers.cal_football import parse_espn_cal_schedule

        mgr = ExternalEventsManager(data_dir=tmp_path)
        mgr.cal_events = parse_espn_cal_schedule(
            {
                "events": [
                    {
                        "id": "cal-test",
                        "name": "Stanford at California",
                        "date": "2026-11-28T20:00Z",
                        "competitions": [
                            {
                                "venue": {"fullName": "California Memorial Stadium"},
                                "competitors": [{"homeAway": "home", "team": {"id": "25", "abbreviation": "CAL"}}],
                                "status": {"type": {"state": "pre"}},
                            }
                        ],
                    }
                ]
            },
            now_ts=1795800000.0,
        )

        async def _noop_refresh():
            return mgr.get_payload()

        mgr.refresh_all = _noop_refresh  # type: ignore[method-assign]

        app = create_app(external_events_manager=mgr)
        test_client = TestClient(app)

        res_get = test_client.get("/api/external-events")
        assert res_get.status_code == 200
        data = res_get.json()
        assert data["next_cal_game"]["title"] == "Stanford at California"
        assert "correlation" in data

        res_post = test_client.post("/api/external-events/refresh")
        assert res_post.status_code == 200
        assert res_post.json()["status"] == "ok"

    def test_environmental_intelligence_endpoints(self, monkeypatch, tmp_path):
        from eqengine.telemetry.environmental_intelligence import EnvironmentalIntelligenceEngine

        isolated_engine = EnvironmentalIntelligenceEngine(data_dir=tmp_path)
        isolated_engine.buoys["46026"] = {
            "buoy_id": "46026",
            "name": "San Francisco Bar",
            "wvht_m": 4.2,
            "wvht_ft": 13.8,
            "dpd_s": 14.0,
            "wspd_mps": 2.0,
            "mwd_deg": 280.0,
            "mwd_cardinal": "W",
        }
        monkeypatch.setattr(
            "eqengine.telemetry.environmental_intelligence.get_environmental_engine",
            lambda: isolated_engine,
        )

        async def _noop_refresh():
            return isolated_engine.buoys

        monkeypatch.setattr(isolated_engine, "refresh_buoys", _noop_refresh)

        rng = np.random.default_rng(99)
        long_trace = Trace(
            data=rng.normal(0.0, 18.0, size=3500),
            header={"network": "AM", "station": "R1A3D", "channel": "EHZ", "sampling_rate": 100.0, "starttime": UTCDateTime(1700000000)},
        )
        rb = SimpleNamespace(
            channels=("EHZ",),
            get_fill_ratios=lambda: {"EHZ": 1.0},
            get_latest=lambda ch, duration_sec=60.0: long_trace if ch == "EHZ" else None,
        )
        app = create_app(ring_buffer=rb, detector=SimpleNamespace(get_current_ratio=lambda: 1.0, is_triggered=False))
        test_client = TestClient(app)

        res_get = test_client.get("/api/environmental-intelligence")
        assert res_get.status_code == 200
        payload = res_get.json()
        assert payload["buoy"]["buoy_id"] == "46026"
        assert "quiet_hunter" in payload
        assert len(payload["quiet_hunter"]["hourly_profile"]) == 24

        res_cal = test_client.post("/api/environmental/calibrate")
        assert res_cal.status_code == 200
        cal_json = res_cal.json()
        assert cal_json["status"] == "ok"
        assert cal_json["baseline"]["ehz_rms_counts"] > 0

        res_csv = test_client.get("/api/forensics/export.csv")
        assert res_csv.status_code == 200
        assert "text/csv" in res_csv.headers["content-type"]
        assert "ehz_rms_counts" in res_csv.text

    def test_observatory_routes_and_dynamic_status(self, monkeypatch, tmp_path):
        from eqengine.ingest.archive import MiniSeedArchiver
        from eqengine.telemetry.environmental_intelligence import EnvironmentalIntelligenceEngine
        from eqengine.telemetry.highlights import HighlightsRecorder
        from eqengine.validation.witness import MultiStationWitness

        archiver = MiniSeedArchiver(archive_dir=tmp_path / "archive")
        highlights = HighlightsRecorder(highlights_dir=tmp_path / "highlights")
        witness = MultiStationWitness()
        iso_env = EnvironmentalIntelligenceEngine(data_dir=tmp_path / "env")

        monkeypatch.setattr("eqengine.telemetry.environmental_intelligence.get_environmental_engine", lambda: iso_env)

        app = create_app(
            witness=witness,
            archiver=archiver,
            highlights=highlights,
        )
        tc = TestClient(app)

        st = tc.get("/api/status").json()
        assert "station_name" in st
        assert "picker_label" in st
        assert "picker_mode" in st
        assert "witness_station" in st
        assert "public_mode" in st

        tr = tc.get("/api/forensics/trends?days=7")
        assert tr.status_code == 200
        assert "band_thresholds" in tr.json()

        wt = tc.get("/api/witness/status")
        assert wt.status_code == 200
        assert "BK.BKS" in wt.json()["witness_station"]

        ar = tc.get("/api/archive/status")
        assert ar.status_code == 200
        assert "file_count" in ar.json()

        qr = tc.get("/api/archive/quake-replay?origin_time=1795000000&distance_km=25&magnitude=3.1")
        assert qr.status_code == 200
        assert qr.json()["verdict"] == "NO ARCHIVE DATA"

        hl = tc.get("/api/highlights")
        assert hl.status_code == 200
        assert hl.json()["highlights"] == []

        sim = tc.post("/api/simulate-trigger?magnitude=4.2&distance_km=18.0")
        assert sim.status_code == 200
        assert sim.json()["status"] == "ok"
        latest_alert = get_broadcaster().recent_alerts[-1]
        assert "mmi" in latest_alert
        assert "mmi_roman" in latest_alert
        assert "mmi_label" in latest_alert

