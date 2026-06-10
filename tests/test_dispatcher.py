"""Tests for the alert dispatcher — hook registration, delivery, and resilience.

Validates that registered hooks are called, HTTP hooks POST correctly,
log hooks write to disk, hook failures are isolated, and alert models
serialize cleanly.
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from obspy import UTCDateTime
from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Alert schema (mirrors expected production model)
# ---------------------------------------------------------------------------


class EarthquakeAlert(BaseModel):
    """Pydantic v2 model for an earthquake alert payload."""

    event_id: str
    origin_time: str        # ISO-8601
    magnitude: float
    distance_km: float
    s_arrival_utc: str      # ISO-8601
    station: str
    channel: str
    sta_lta_ratio: float
    tau_c: float
    pd: float
    latitude: float
    longitude: float
    alert_level: str        # "green" | "yellow" | "orange" | "red"
    issued_at: str          # ISO-8601

    model_config = {"extra": "forbid"}


# ---------------------------------------------------------------------------
# Dispatcher + hook helpers
# ---------------------------------------------------------------------------


class _AlertDispatcher:
    """Minimal dispatcher: fan-out an alert to all registered hooks."""

    def __init__(self) -> None:
        self._hooks: list[Any] = []

    def register(self, hook: Any) -> None:  # noqa: ANN401
        self._hooks.append(hook)

    def dispatch(self, alert: EarthquakeAlert) -> list[Exception]:
        """Call every hook. Return a list of exceptions (empty = all OK)."""
        errors: list[Exception] = []
        payload = alert.model_dump()
        for hook in self._hooks:
            try:
                hook(payload)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
        return errors


def _log_hook_factory(path: str):
    """Return a hook that appends each alert as a JSON line to *path*."""

    def _hook(payload: dict) -> None:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, default=str) + "\n")

    return _hook


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def sample_alert() -> EarthquakeAlert:
    """Build a realistic sample alert."""
    return EarthquakeAlert(
        event_id="eq-2025-0115-120005",
        origin_time="2025-01-15T12:00:05.000Z",
        magnitude=4.2,
        distance_km=42.0,
        s_arrival_utc="2025-01-15T12:00:10.000Z",
        station="R1A3D",
        channel="EHZ",
        sta_lta_ratio=8.3,
        tau_c=0.85,
        pd=4200.0,
        latitude=37.8696,
        longitude=-122.2491,
        alert_level="yellow",
        issued_at=datetime.now(tz=timezone.utc).isoformat(),
    )


@pytest.fixture()
def dispatcher() -> _AlertDispatcher:
    return _AlertDispatcher()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestAlertDispatcher:
    """Test suite for alert dispatching and hook management."""

    def test_send_alert_calls_hooks(
        self, dispatcher: _AlertDispatcher, sample_alert: EarthquakeAlert
    ) -> None:
        """Registering a mock hook and dispatching should invoke it."""
        mock_hook = MagicMock()
        dispatcher.register(mock_hook)

        errors = dispatcher.dispatch(sample_alert)

        assert len(errors) == 0
        mock_hook.assert_called_once()
        payload = mock_hook.call_args[0][0]
        assert payload["station"] == "R1A3D"
        assert payload["magnitude"] == 4.2

    def test_dashboard_hook_posts_correctly(
        self, sample_alert: EarthquakeAlert
    ) -> None:
        """A dashboard HTTP hook should POST the alert payload."""
        with patch("httpx.post") as mock_post:
            mock_post.return_value = MagicMock(status_code=200)

            def _dashboard_hook(payload: dict) -> None:
                import httpx
                httpx.post(
                    "http://localhost:8080/api/alerts",
                    json=payload,
                    timeout=5.0,
                )

            disp = _AlertDispatcher()
            disp.register(_dashboard_hook)
            disp.dispatch(sample_alert)

            mock_post.assert_called_once()
            call_kwargs = mock_post.call_args
            assert call_kwargs.kwargs["json"]["event_id"] == "eq-2025-0115-120005"
            assert "http://localhost:8080/api/alerts" in call_kwargs.args

    def test_log_hook_writes_file(self, sample_alert: EarthquakeAlert) -> None:
        """A log hook must append a JSON line to events.jsonl."""
        with tempfile.TemporaryDirectory() as tmpdir:
            log_path = os.path.join(tmpdir, "events.jsonl")
            hook = _log_hook_factory(log_path)

            disp = _AlertDispatcher()
            disp.register(hook)
            disp.dispatch(sample_alert)

            assert os.path.exists(log_path)
            with open(log_path, encoding="utf-8") as fh:
                lines = fh.readlines()
            assert len(lines) == 1

            record = json.loads(lines[0])
            assert record["event_id"] == "eq-2025-0115-120005"
            assert record["magnitude"] == 4.2

    def test_hook_failure_doesnt_block_others(
        self, sample_alert: EarthquakeAlert
    ) -> None:
        """If one hook raises, the remaining hooks must still be called."""
        called: list[str] = []

        def _good_hook_a(payload: dict) -> None:
            called.append("A")

        def _bad_hook(payload: dict) -> None:
            raise RuntimeError("Simulated hook failure")

        def _good_hook_b(payload: dict) -> None:
            called.append("B")

        disp = _AlertDispatcher()
        disp.register(_good_hook_a)
        disp.register(_bad_hook)
        disp.register(_good_hook_b)

        errors = disp.dispatch(sample_alert)

        # Both good hooks should have been called
        assert "A" in called
        assert "B" in called
        # One error from the bad hook
        assert len(errors) == 1
        assert "Simulated hook failure" in str(errors[0])

    def test_alert_schema_serialization(self, sample_alert: EarthquakeAlert) -> None:
        """EarthquakeAlert.model_dump() should produce valid, complete JSON."""
        payload = sample_alert.model_dump()

        # Round-trip through JSON
        json_str = json.dumps(payload, default=str)
        restored = json.loads(json_str)

        assert restored["event_id"] == "eq-2025-0115-120005"
        assert restored["magnitude"] == 4.2
        assert restored["distance_km"] == 42.0
        assert restored["alert_level"] == "yellow"
        assert restored["station"] == "R1A3D"

        # Verify all fields present
        expected_fields = {
            "event_id", "origin_time", "magnitude", "distance_km",
            "s_arrival_utc", "station", "channel", "sta_lta_ratio",
            "tau_c", "pd", "latitude", "longitude", "alert_level", "issued_at",
        }
        assert expected_fields == set(restored.keys())
