"""Tests for eqengine.config module.

Validates configuration defaults, environment variable overrides,
field validation rules, computed properties, and singleton caching.
"""
from __future__ import annotations

import os
import pytest
from pydantic import ValidationError

from eqengine.config import Settings, IngestMode, LogLevel, get_config


class TestSettings:
    """Test suite for eqengine Settings configuration."""

    def test_default_settings(self):
        cfg = Settings()
        assert cfg.shake_station == "R1A3D"
        assert cfg.shake_network == "AM"
        assert cfg.shake_channel == "EHZ"
        assert cfg.shake_channels == ["EHZ", "ENZ", "ENN", "ENE"]
        assert cfg.sampling_rate == 100
        assert cfg.sta_seconds == 0.5
        assert cfg.lta_seconds == 20.0
        assert cfg.trigger_on == 6.5
        assert cfg.trigger_off == 2.0
        assert cfg.min_trigger_duration_sec == 1.2
        assert cfg.web_enabled is True
        assert cfg.web_port == 8088
        assert cfg.ingest_mode == IngestMode.SEEDLINK
        assert cfg.log_level == LogLevel.INFO

    def test_computed_properties(self):
        cfg = Settings(
            sta_seconds=0.5,
            lta_seconds=10.0,
            sampling_rate=100,
            buffer_duration_sec=60.0,
            shake_network="AM",
            shake_station="R1A3D",
            shake_channel="EHZ",
        )
        assert cfg.nsta == 50
        assert cfg.nlta == 1000
        assert cfg.buffer_samples == 6000
        assert cfg.seed_id == "AM.R1A3D..EHZ"

    def test_channel_string_parsing(self):
        cfg = Settings(shake_channels="EHZ, ENZ, ENN")
        assert cfg.shake_channels == ["EHZ", "ENZ", "ENN"]

    def test_invalid_sta_lta_raises(self):
        with pytest.raises(ValidationError):
            Settings(sta_seconds=10.0, lta_seconds=5.0)

    def test_invalid_trigger_thresholds_raises(self):
        with pytest.raises(ValidationError):
            Settings(trigger_on=1.5, trigger_off=3.0)

    def test_invalid_bandpass_raises(self):
        with pytest.raises(ValidationError):
            Settings(bandpass_low=15.0, bandpass_high=1.0)

    def test_get_config_singleton(self):
        get_config.cache_clear()
        cfg1 = get_config()
        cfg2 = get_config()
        assert cfg1 is cfg2
