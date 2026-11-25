"""Backwards-compatible facade for :mod:`eqengine.telemetry.environmental`."""
from __future__ import annotations

from eqengine.constants import COUNTS_TO_ACCEL, COUNTS_TO_VELOCITY_UM_S
from eqengine.telemetry.environmental.engine import (
    EnvironmentalIntelligenceEngine,
    get_environmental_engine,
)
from eqengine.telemetry.environmental.forensics import compute_minute_forensics
from eqengine.telemetry.environmental.ndbc import (
    correlate_ocean_microseism,
    parse_ndbc_realtime_text,
)

__all__ = [
    "COUNTS_TO_ACCEL",
    "COUNTS_TO_VELOCITY_UM_S",
    "EnvironmentalIntelligenceEngine",
    "compute_minute_forensics",
    "correlate_ocean_microseism",
    "get_environmental_engine",
    "parse_ndbc_realtime_text",
]
