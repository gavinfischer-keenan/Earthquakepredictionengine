"""Shared physical and hardware constants for EarthquakePredictionEngine."""
from __future__ import annotations

RS4D_CHANNELS: tuple[str, ...] = ("EHZ", "ENZ", "ENN", "ENE")
DEFAULT_SAMPLING_RATE: int = 100

# RS4D Physical Calibration Constants
COUNTS_TO_ACCEL: float = 1.9e-6  # 1 count ≈ 1.9 µm/s² for RS4D MEMS accelerometers
COUNTS_TO_VELOCITY_M_S: float = 0.05e-6  # 1 count ≈ 0.05 µm/s in m/s for EHZ geophone
COUNTS_TO_VELOCITY_UM_S: float = 0.05  # 1 count ≈ 0.05 µm/s for EHZ geophone

# Geodesy constants
KM_TO_MILES: float = 0.621371
EARTH_RADIUS_KM: float = 6371.0

COMPASS_16: tuple[str, ...] = (
    "N", "NNE", "NE", "ENE",
    "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW",
    "W", "WNW", "NW", "NNW",
)


def deg_to_cardinal(deg: float) -> str:
    """Convert bearing/direction in degrees [0, 360) to 16-point compass label."""
    idx = int((deg % 360.0) / 22.5 + 0.5) % 16
    return COMPASS_16[idx]
