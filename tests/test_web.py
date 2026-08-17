"""Tests for eqengine.web (FastAPI server, broadcaster, and endpoints)."""
from __future__ import annotations

from types import SimpleNamespace
import numpy as np
import pytest
from fastapi.testclient import TestClient
from obspy import Trace, UTCDateTime

from eqengine.web.server import create_app
from eqengine.web.broadcaster import get_broadcaster, WaveformBroadcaster


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
