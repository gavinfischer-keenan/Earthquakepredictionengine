"""
eqengine.config — Centralized configuration for the EarthquakePredictionEngine.

Loads settings from environment variables (with .env file support via python-dotenv)
and exposes them as a validated, typed Pydantic model. A singleton accessor
:func:`get_config` ensures a single ``Settings`` instance across the application.

Usage::

    from eqengine.config import get_config

    cfg = get_config()
    print(cfg.shake_station)   # "R1A3D"
    print(cfg.nsta)            # 50 (0.5 s × 100 Hz)
"""

from __future__ import annotations

import enum
import functools
from pathlib import Path
from typing import Annotated

from dotenv import load_dotenv
from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings

# ---------------------------------------------------------------------------
# Load .env file as early as possible so os.environ is populated before
# Pydantic reads it.  ``override=False`` keeps real env vars authoritative.
# ---------------------------------------------------------------------------
load_dotenv(dotenv_path=Path.cwd() / ".env", override=False)


class IngestMode(str, enum.Enum):
    """Supported data-ingestion transports."""

    SEEDLINK = "seedlink"
    UDP = "udp"


class LogLevel(str, enum.Enum):
    """Allowed log-level names."""

    DEBUG = "DEBUG"
    INFO = "INFO"
    WARNING = "WARNING"
    ERROR = "ERROR"


class Settings(BaseSettings):
    """Typed, validated application settings sourced from the environment.

    Every field corresponds to a variable in ``.env.example``.  Defaults are
    tuned for a typical Raspberry Shake RS4D deployment.
    """

    # -- Raspberry Shake connection ------------------------------------------
    shake_ip: str = Field(
        default="192.168.4.164",
        description="Hostname or IP address of the Raspberry Shake device.",
    )
    shake_station: str = Field(
        default="R1A3D",
        description="FDSN station code (printed on the Shake).",
    )
    shake_network: str = Field(
        default="AM",
        description="FDSN network code (AM = Raspberry Shake citizen network).",
    )
    shake_channel: str = Field(
        default="EHZ",
        description="Primary channel for event detection.",
    )
    shake_channels: list[str] = Field(
        default=["EHZ", "ENZ", "ENN", "ENE"],
        description="All RS4D channels to buffer (comma-separated in env).",
    )

    # -- Station location ----------------------------------------------------
    station_lat: float = Field(
        default=37.8696,
        description="Station latitude in decimal degrees.",
    )
    station_lon: float = Field(
        default=-122.2491,
        description="Station longitude in decimal degrees.",
    )
    station_elevation: float = Field(
        default=161.1,
        description="Station elevation in metres above sea level.",
    )

    # -- Ingestion -----------------------------------------------------------
    ingest_mode: IngestMode = Field(
        default=IngestMode.SEEDLINK,
        description="Data transport: 'seedlink' (TCP) or 'udp'.",
    )
    udp_port: int = Field(
        default=8888,
        ge=1024,
        le=65535,
        description="UDP port for raw Shake packets (INGEST_MODE=udp only).",
    )
    seedlink_port: int = Field(
        default=18000,
        ge=1,
        le=65535,
        description="SeedLink server port on the Shake.",
    )

    # -- STA/LTA trigger -----------------------------------------------------
    sta_seconds: Annotated[float, Field(gt=0)] = 0.5
    """Short-Term Average window in seconds."""

    lta_seconds: Annotated[float, Field(gt=0)] = 20.0
    """Long-Term Average window in seconds."""

    trigger_on: Annotated[float, Field(gt=0)] = 4.0
    """STA/LTA ratio threshold to declare a trigger."""

    trigger_off: Annotated[float, Field(gt=0)] = 1.5
    """STA/LTA ratio threshold to end a trigger."""

    # -- Bandpass filter ------------------------------------------------------
    bandpass_low: Annotated[float, Field(gt=0)] = 1.0
    """Lower corner frequency (Hz) for Butterworth bandpass."""

    bandpass_high: Annotated[float, Field(gt=0)] = 10.0
    """Upper corner frequency (Hz) for Butterworth bandpass."""

    # -- Event validation ----------------------------------------------------
    min_trigger_duration_sec: Annotated[float, Field(ge=0)] = 0.5
    """Minimum trigger duration (seconds) to accept an event."""

    pd_window_sec: Annotated[float, Field(gt=0)] = 3.0
    """Predominant-period (Pd) measurement window after P-arrival."""

    tc_window_sec: Annotated[float, Field(gt=0)] = 3.0
    """Tau-c (τ_c) period-parameter window after P-arrival."""

    # -- Machine learning (optional) -----------------------------------------
    ml_enabled: bool = False
    """Enable ML-based phase picking (requires ``[ml]`` extras)."""

    ml_p_threshold: Annotated[float, Field(ge=0.0, le=1.0)] = 0.3
    """P-wave detection probability threshold."""

    ml_model: str = Field(
        default="phasenet",
        description="SeisBench model identifier (phasenet, eqtransformer, …).",
    )

    # -- Alerting & dashboard ------------------------------------------------
    dashboard_url: str = "http://localhost:5050/api/ingest/earthquake-engine"
    """HTTP endpoint for Berkeley-style dashboard ingestion."""

    alert_cooldown_sec: Annotated[float, Field(ge=0)] = 30.0
    """Minimum seconds between successive alerts."""

    # -- Telemetry -----------------------------------------------------------
    heartbeat_interval_sec: Annotated[float, Field(gt=0)] = 60.0
    """Seconds between heartbeat/status messages."""

    # -- Data buffer ---------------------------------------------------------
    buffer_duration_sec: Annotated[float, Field(gt=0)] = 120.0
    """Rolling waveform buffer length in seconds."""

    sampling_rate: Annotated[int, Field(gt=0)] = 100
    """ADC sampling rate of the RS4D in Hz."""

    # -- Logging & storage ---------------------------------------------------
    log_level: LogLevel = LogLevel.INFO
    """Minimum log level (DEBUG / INFO / WARNING / ERROR)."""

    event_log_dir: Path = Path("./events")
    """Directory for per-event miniSEED and metadata files."""

    # -----------------------------------------------------------------------
    # RS4D-specific hard-coded constants
    # -----------------------------------------------------------------------
    CHANNELS: list[str] = ["EHZ", "ENZ", "ENN", "ENE"]
    """All four RS4D channel codes (read-only reference)."""

    # -----------------------------------------------------------------------
    # Pydantic model configuration
    # -----------------------------------------------------------------------
    model_config = {
        "env_prefix": "",          # no prefix — matches .env variable names exactly
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "case_sensitive": False,   # SHAKE_IP → shake_ip
        "extra": "ignore",        # silently ignore unknown env vars
    }

    # -----------------------------------------------------------------------
    # Validators
    # -----------------------------------------------------------------------
    @field_validator("shake_channels", mode="before")
    @classmethod
    def _parse_channels(cls, v: object) -> list[str]:
        """Accept a comma-separated string *or* a list."""
        if isinstance(v, str):
            return [ch.strip() for ch in v.split(",") if ch.strip()]
        return list(v)  # type: ignore[arg-type]

    @model_validator(mode="after")
    def _validate_cross_field(self) -> "Settings":
        """Ensure STA/LTA and trigger thresholds are physically sensible."""
        if self.sta_seconds >= self.lta_seconds:
            raise ValueError(
                f"STA window ({self.sta_seconds} s) must be shorter than "
                f"LTA window ({self.lta_seconds} s)."
            )
        if self.trigger_on <= self.trigger_off:
            raise ValueError(
                f"trigger_on ({self.trigger_on}) must be greater than "
                f"trigger_off ({self.trigger_off})."
            )
        if self.bandpass_low >= self.bandpass_high:
            raise ValueError(
                f"bandpass_low ({self.bandpass_low} Hz) must be less than "
                f"bandpass_high ({self.bandpass_high} Hz)."
            )
        return self

    # -----------------------------------------------------------------------
    # Computed properties
    # -----------------------------------------------------------------------
    @property
    def nsta(self) -> int:
        """Number of samples in the STA window."""
        return int(self.sta_seconds * self.sampling_rate)

    @property
    def nlta(self) -> int:
        """Number of samples in the LTA window."""
        return int(self.lta_seconds * self.sampling_rate)

    @property
    def buffer_samples(self) -> int:
        """Total number of samples in the rolling waveform buffer."""
        return int(self.buffer_duration_sec * self.sampling_rate)

    @property
    def seed_id(self) -> str:
        """Full SEED identifier, e.g. ``AM.R1A3D..EHZ``."""
        return f"{self.shake_network}.{self.shake_station}..{self.shake_channel}"


# ---------------------------------------------------------------------------
# Singleton accessor
# ---------------------------------------------------------------------------

@functools.lru_cache(maxsize=1)
def get_config() -> Settings:
    """Return the application-wide :class:`Settings` singleton.

    The instance is created on first call and cached thereafter.  To force
    a reload (e.g. in tests), call ``get_config.cache_clear()`` first.
    """
    return Settings()
