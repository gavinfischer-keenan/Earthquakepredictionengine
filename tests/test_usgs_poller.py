"""Tests for USGS poller, haversine distance, and severity classification matrix.

Tests the complete distance × magnitude severity matrix (20 cells),
classification boundary conditions, and haversine distance calculations
for known Bay Area coordinates.
"""
import pytest

from eqengine.ingest.usgs_poller import (
    classify_distance_km,
    classify_magnitude,
    haversine_km,
)
from eqengine.alerts.schema import EarthquakeAlert


# ── Haversine distance ─────────────────────────────────────────────────────


class TestHaversine:
    """Verify haversine_km against known distances."""

    def test_same_point(self):
        assert haversine_km(37.87, -122.27, 37.87, -122.27) == 0.0

    def test_berkeley_to_sf(self):
        dist = haversine_km(37.8716, -122.2727, 37.7749, -122.4194)
        assert 12 < dist < 18, f"Expected ~14km, got {dist}"

    def test_berkeley_to_la(self):
        dist = haversine_km(37.8716, -122.2727, 34.0522, -118.2437)
        assert 530 < dist < 570, f"Expected ~550km, got {dist}"

    def test_berkeley_to_portland(self):
        dist = haversine_km(37.8716, -122.2727, 45.5155, -122.6789)
        assert 830 < dist < 870, f"Expected ~850km, got {dist}"


# ── Distance classification ────────────────────────────────────────────────


class TestClassifyDistance:
    """Verify distance band boundaries."""

    def test_local(self):
        assert classify_distance_km(10) == "LOCAL"

    def test_local_boundary(self):
        assert classify_distance_km(79.9) == "LOCAL"

    def test_regional(self):
        assert classify_distance_km(80) == "REGIONAL"

    def test_regional_boundary(self):
        assert classify_distance_km(239.9) == "REGIONAL"

    def test_state(self):
        assert classify_distance_km(240) == "STATE"

    def test_state_boundary(self):
        assert classify_distance_km(639.9) == "STATE"

    def test_distant(self):
        assert classify_distance_km(640) == "DISTANT"

    def test_very_distant(self):
        assert classify_distance_km(5000) == "DISTANT"

    def test_none_is_local(self):
        assert classify_distance_km(None) == "LOCAL"

    def test_zero_is_local(self):
        assert classify_distance_km(0) == "LOCAL"


# ── Magnitude classification ──────────────────────────────────────────────


class TestClassifyMagnitude:
    """Verify magnitude band boundaries."""

    def test_minor(self):
        assert classify_magnitude(1.0) == "MINOR"

    def test_minor_boundary(self):
        assert classify_magnitude(2.4) == "MINOR"

    def test_light(self):
        assert classify_magnitude(2.5) == "LIGHT"

    def test_light_boundary(self):
        assert classify_magnitude(3.9) == "LIGHT"

    def test_moderate(self):
        assert classify_magnitude(4.0) == "MODERATE"

    def test_moderate_boundary(self):
        assert classify_magnitude(4.9) == "MODERATE"

    def test_strong(self):
        assert classify_magnitude(5.0) == "STRONG"

    def test_strong_boundary(self):
        assert classify_magnitude(5.9) == "STRONG"

    def test_major(self):
        assert classify_magnitude(6.0) == "MAJOR"

    def test_large_major(self):
        assert classify_magnitude(9.0) == "MAJOR"

    def test_none_is_minor(self):
        assert classify_magnitude(None) == "MINOR"


# ── Severity matrix (all 20 cells) ────────────────────────────────────────


class TestSeverityMatrix:
    """Test every cell of the distance × magnitude severity matrix."""

    @pytest.mark.parametrize(
        "dist_km,mag,expected",
        [
            # LOCAL
            (10, 7.0, "critical"),     # LOCAL + MAJOR
            (10, 5.5, "critical"),     # LOCAL + STRONG
            (10, 4.5, "warning"),      # LOCAL + MODERATE
            (10, 3.0, "advisory"),     # LOCAL + LIGHT
            (10, 1.0, "info"),         # LOCAL + MINOR
            # REGIONAL
            (100, 7.0, "critical"),    # REGIONAL + MAJOR
            (100, 5.5, "warning"),     # REGIONAL + STRONG
            (100, 4.5, "advisory"),    # REGIONAL + MODERATE
            (100, 3.0, "info"),        # REGIONAL + LIGHT
            (100, 1.0, "info"),        # REGIONAL + MINOR
            # STATE
            (300, 7.0, "warning"),     # STATE + MAJOR
            (300, 5.5, "advisory"),    # STATE + STRONG
            (300, 4.5, "info"),        # STATE + MODERATE
            (300, 3.0, "info"),        # STATE + LIGHT
            (300, 1.0, "ignore"),      # STATE + MINOR
            # DISTANT
            (700, 7.0, "advisory"),    # DISTANT + MAJOR
            (700, 5.5, "info"),        # DISTANT + STRONG
            (700, 4.5, "ignore"),      # DISTANT + MODERATE
            (700, 3.0, "ignore"),      # DISTANT + LIGHT
            (700, 1.0, "ignore"),      # DISTANT + MINOR
        ],
    )
    def test_matrix(self, dist_km: float, mag: float, expected: str):
        result = EarthquakeAlert.classify_severity(mag, dist_km)
        assert result == expected, (
            f"classify_severity(mag={mag}, dist_km={dist_km}) = {result}, "
            f"expected {expected}"
        )

    def test_none_distance_treated_as_local(self):
        # None distance → LOCAL, STRONG → critical
        assert EarthquakeAlert.classify_severity(5.5, None) == "critical"

    def test_none_magnitude_treated_as_minor(self):
        # None magnitude → MINOR, LOCAL → info
        assert EarthquakeAlert.classify_severity(None, 10) == "info"

    def test_both_none(self):
        # None/None → LOCAL + MINOR → info
        assert EarthquakeAlert.classify_severity(None, None) == "info"


# ── TTS generation ────────────────────────────────────────────────────────


class TestTTSGeneration:
    """Verify dynamic TTS text generation."""

    def test_local_critical(self):
        alert = EarthquakeAlert(
            severity="critical",
            timestamp=0,
            p_wave_time=0,
            sta_lta_ratio=5.0,
            detection_method="classic_sta_lta",
            estimated_magnitude=5.5,
            station="R1A3D",
            channel="EHZ",
            distance_class="LOCAL",
        )
        msg = alert.generate_tts_message()
        assert "Imminent" in msg
        assert "5.5" in msg

    def test_regional_alert(self):
        alert = EarthquakeAlert(
            severity="warning",
            timestamp=0,
            p_wave_time=0,
            sta_lta_ratio=3.0,
            detection_method="classic_sta_lta",
            estimated_magnitude=4.2,
            station="R1A3D",
            channel="EHZ",
            distance_class="REGIONAL",
        )
        msg = alert.generate_tts_message()
        assert "region" in msg.lower()

    def test_unknown_magnitude(self):
        alert = EarthquakeAlert(
            severity="info",
            timestamp=0,
            p_wave_time=0,
            sta_lta_ratio=2.0,
            detection_method="classic_sta_lta",
            station="R1A3D",
            channel="EHZ",
            distance_class="DISTANT",
        )
        msg = alert.generate_tts_message()
        assert "unknown magnitude" in msg
