"""Health reporting — periodic engine status snapshots.

`HealthReporter` aggregates metrics from across the engine (ring buffer fill,
RSAM, event counts, uptime) into an :class:`EngineStatus` model and dispatches
it via the alert dispatcher's status hooks.
"""
from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

import structlog

from eqengine import __version__
from eqengine.alerts.dispatcher import send_status
from eqengine.alerts.schema import EngineStatus

if TYPE_CHECKING:
    from eqengine.telemetry.rsam import RSAMCalculator

log = structlog.get_logger(__name__)


class HealthReporter:
    """Collect engine metrics and emit :class:`EngineStatus` snapshots.

    Parameters
    ----------
    config:
        Engine configuration object (duck-typed — needs ``station``,
        ``ingest_mode``, ``channels``).
    ring_buffer:
        Ring buffer instance (duck-typed — needs ``get_fill_ratios()``
        returning ``dict[str, float]``).
    detector:
        Detector instance (duck-typed — needs ``trigger_count`` int attribute).
    rsam_calculator:
        RSAM calculator for current 1-minute amplitude.
    ml_loaded:
        Whether the ML picker model has been loaded.
    """

    def __init__(
        self,
        *,
        config: Any,
        ring_buffer: Any,
        detector: Any,
        rsam_calculator: RSAMCalculator,
        ml_loaded: bool = False,
    ) -> None:
        self._config = config
        self._ring_buffer = ring_buffer
        self._detector = detector
        self._rsam = rsam_calculator
        self._ml_loaded = ml_loaded
        self._start_time: float = time.time()
        self._total_triggers: int = 0
        self._total_confirmed: int = 0
        self._last_trigger_time: float | None = None

    # ------------------------------------------------------------------
    # Metric update helpers
    # ------------------------------------------------------------------
    def record_trigger(self) -> None:
        """Increment the trigger counter and record the timestamp."""
        self._total_triggers += 1
        self._last_trigger_time = time.time()

    def record_confirmed(self) -> None:
        """Increment the confirmed event counter."""
        self._total_confirmed += 1

    # ------------------------------------------------------------------
    # Status building
    # ------------------------------------------------------------------
    def build_status(self) -> EngineStatus:
        """Assemble the current engine status from all subsystems."""
        uptime = time.time() - self._start_time

        # Buffer health — gracefully degrade if the buffer doesn't expose
        # fill ratios (e.g., during testing with a stub).
        buffer_health: dict[str, float] = {}
        if hasattr(self._ring_buffer, "get_fill_ratios"):
            buffer_health = self._ring_buffer.get_fill_ratios()

        # Noise floor from RSAM history mean (approximation)
        noise_floor = self._rsam.mean_rsam

        # Determine overall status
        status: str = "online"
        if not buffer_health:
            status = "degraded"
        elif any(v < 0.1 for v in buffer_health.values()):
            status = "degraded"

        channels = getattr(self._config, "channels", [])

        return EngineStatus(
            status=status,  # type: ignore[arg-type]
            engine_version=__version__,
            uptime_seconds=uptime,
            noise_floor_counts=noise_floor,
            rsam_1min=self._rsam.get_current_rsam(),
            last_trigger_time=self._last_trigger_time,
            total_triggers=self._total_triggers,
            total_confirmed_events=self._total_confirmed,
            buffer_health=buffer_health,
            ml_model_loaded=self._ml_loaded,
            ingest_mode=getattr(self._config, "ingest_mode", "udp"),
            channels_active=list(channels),
        )

    # ------------------------------------------------------------------
    # Dispatch
    # ------------------------------------------------------------------
    async def report(self) -> None:
        """Build and dispatch the current engine status."""
        status = self.build_status()
        await send_status(status)
        log.debug(
            "health.reported",
            uptime_s=round(status.uptime_seconds, 1),
            rsam=round(status.rsam_1min, 2),
        )
