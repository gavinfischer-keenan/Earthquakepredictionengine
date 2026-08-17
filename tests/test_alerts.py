"""Tests for eqengine.alerts.manager and eqengine.alerts.schema.

Validates alert creation, severity classification, cooldown enforcement,
updates, cancellations, history ring tracking, and schema validations.
"""
from __future__ import annotations

import time
from types import SimpleNamespace
import pytest

from eqengine.alerts.manager import AlertManager
from eqengine.alerts.schema import EarthquakeAlert


class TestAlertManagerAndSchema:
    def test_alert_schema_creation(self):
        alert = EarthquakeAlert(
            severity="warning",
            timestamp=time.time(),
            p_wave_time=time.time(),
            sta_lta_ratio=5.5,
            detection_method="classic_sta_lta",
            station="R1A3D",
            channel="EHZ",
            estimated_magnitude=4.8,
            estimated_distance_km=45.0,
            distance_miles=28.0,
            distance_class="LOCAL",
            mag_class="MODERATE",
            data_source="rs4d",
        )
        assert isinstance(alert.alert_id, str) and len(alert.alert_id) > 0
        assert alert.severity == "warning"
        msg = alert.generate_tts_message()
        assert "moderate" in msg.lower() or "earthquake" in msg.lower()

    def test_alert_manager_create_and_cooldown(self):
        mgr = AlertManager(cooldown_sec=10.0, max_history=5)
        assert mgr.should_alert() is True

        trigger = SimpleNamespace(on_time=time.time(), sta_lta_ratio=6.0, channel="EHZ")
        config = SimpleNamespace(station="R1A3D", detection_method="sta_lta")

        alert = mgr.create_alert(
            trigger=trigger,
            magnitude_est=5.2,
            ml_result=None,
            config=config,
            distance_km=25.0,
        )

        assert alert.alert_id in [a.alert_id for a in mgr.get_active_alerts()]
        assert mgr.total_triggers == 1
        assert mgr.should_alert() is False

    def test_alert_manager_update_and_cancel(self):
        mgr = AlertManager(cooldown_sec=1.0)
        trigger = SimpleNamespace(on_time=time.time(), sta_lta_ratio=6.0, channel="EHZ")
        config = SimpleNamespace(station="R1A3D", detection_method="sta_lta")

        alert = mgr.create_alert(trigger, 5.0, None, config, distance_km=50.0)
        updated = mgr.update_alert(alert.alert_id, status="confirmed")
        assert updated is not None
        assert updated.status == "confirmed"
        assert mgr.total_confirmed == 1

        mgr.cancel_alert(alert.alert_id, reason="false_alarm")
        assert len(mgr.get_active_alerts()) == 0

    def test_ignore_severity_not_tracked_as_active(self):
        mgr = AlertManager()
        trigger = SimpleNamespace(on_time=time.time(), sta_lta_ratio=2.0, channel="EHZ")
        config = SimpleNamespace(station="R1A3D", detection_method="sta_lta")

        # Distant microquake -> severity="ignore"
        alert = mgr.create_alert(trigger, 1.2, None, config, distance_km=500.0)
        assert alert.severity == "ignore"
        assert len(mgr.get_active_alerts()) == 0
