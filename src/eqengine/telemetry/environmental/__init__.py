"""Modular environmental intelligence package."""
from __future__ import annotations

from eqengine.telemetry.environmental.engine import (
    EnvironmentalIntelligenceEngine,
    get_environmental_engine,
)
from eqengine.telemetry.environmental.forensics import compute_minute_forensics
from eqengine.telemetry.environmental.ndbc import (
    correlate_ocean_microseism,
    parse_ndbc_realtime_text,
)
from eqengine.telemetry.environmental.trends import (
    classify_band_level,
    compute_band_thresholds,
    compute_forensics_trends,
    load_forensics_rows,
)

__all__ = [
    "EnvironmentalIntelligenceEngine",
    "classify_band_level",
    "compute_band_thresholds",
    "compute_forensics_trends",
    "compute_minute_forensics",
    "correlate_ocean_microseism",
    "get_environmental_engine",
    "load_forensics_rows",
    "parse_ndbc_realtime_text",
]
