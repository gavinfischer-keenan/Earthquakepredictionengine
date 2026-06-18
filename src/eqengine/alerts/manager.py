"""Alert lifecycle management — creation, tracking, cooldown, cancellation.

`AlertManager` is the single point of truth for alert state.  It enforces a
cooldown window between successive alerts to prevent alert-storms from
sustained shaking and maintains a bounded history ring for diagnostics.
"""
from __future__ import annotations

import time
from collections import deque
from typing import Any

import structlog

from eqengine.alerts.schema import EarthquakeAlert

log = structlog.get_logger(__name__)

_DEFAULT_COOLDOWN_SEC: float = 30.0
_MAX_HISTORY: int = 100


class AlertManager:
    """Track active alerts and enforce cooldown between emissions.

    Parameters
    ----------
    cooldown_sec:
        Minimum seconds between two successive alerts.
    max_history:
        Number of recent alerts to retain for diagnostics.
    """

    def __init__(
        self,
        *,
        cooldown_sec: float = _DEFAULT_COOLDOWN_SEC,
        max_history: int = _MAX_HISTORY,
    ) -> None:
        self.cooldown_sec = cooldown_sec
        self._active: dict[str, EarthquakeAlert] = {}
        self._history: deque[EarthquakeAlert] = deque(maxlen=max_history)
        self._last_alert_time: float = 0.0
        self._total_triggers: int = 0
        self._total_confirmed: int = 0

    # ------------------------------------------------------------------
    # Creation
    # ------------------------------------------------------------------
    def create_alert(
        self,
        trigger: Any,
        magnitude_est: float | None,
        ml_result: Any | None,
        config: Any,
        *,
        distance_km: float | None = None,
        usgs_event: dict | None = None,
        data_source: str = "rs4d",
    ) -> EarthquakeAlert:
        """Build and register a new :class:`EarthquakeAlert`.

        Parameters
        ----------
        trigger:
            Trigger event object (duck-typed: needs ``on_time``,
            ``sta_lta_ratio``, ``channel``).  Can be ``None`` for
            USGS-only alerts with no local RS4D trigger.
        magnitude_est:
            Estimated local magnitude, or ``None``.
        ml_result:
            Optional :class:`MLPickResult` from the ML picker.
        config:
            Engine configuration object (needs ``station``, ``detection_method``).
        distance_km:
            Distance from station in km (from S-P or USGS).
        usgs_event:
            Optional USGS event dict from the poller's correlation.
        data_source:
            One of ``"rs4d"``, ``"usgs"``, or ``"fused"``.

        Returns
        -------
        EarthquakeAlert
            Fully populated alert, already stored in the active set
            (unless severity is ``"ignore"``).
        """
        now = time.time()

        # Use USGS magnitude if fused and available
        magnitude = magnitude_est
        if usgs_event and data_source == "fused":
            magnitude = usgs_event.get("magnitude", magnitude_est)

        # Distance-aware severity classification
        severity = EarthquakeAlert.classify_severity(magnitude, distance_km)

        # Distance conversion and classification
        distance_miles = (
            round(distance_km * 0.621371, 1) if distance_km is not None else None
        )
        distance_class = EarthquakeAlert.classify_distance_km(distance_km)
        mag_class = EarthquakeAlert.classify_magnitude(magnitude)

        alert = EarthquakeAlert(
            severity=severity,
            timestamp=now,
            p_wave_time=trigger.on_time if trigger else now,
            sta_lta_ratio=trigger.sta_lta_ratio if trigger else 0.0,
            ml_confidence=(
                ml_result.p_probability if ml_result is not None else None
            ),
            detection_method=getattr(config, "detection_method", "classic_sta_lta"),
            estimated_magnitude=magnitude,
            estimated_distance_km=distance_km,
            station=getattr(config, "station", "UNKNOWN"),
            channel=getattr(trigger, "channel", "EHZ") if trigger else "EHZ",
            distance_miles=distance_miles,
            distance_class=distance_class,
            mag_class=mag_class,
            usgs_event_id=usgs_event.get("id") if usgs_event else None,
            usgs_magnitude=usgs_event.get("magnitude") if usgs_event else None,
            place=usgs_event.get("place") if usgs_event else None,
            data_source=data_source,
        )
        alert.tts_message = alert.generate_tts_message()

        # Skip ignore-severity alerts — return but don't track
        if severity == "ignore":
            log.info(
                "alert.ignored",
                magnitude=magnitude,
                distance_km=distance_km,
                mag_class=mag_class,
                distance_class=distance_class,
            )
            return alert

        self._active[alert.alert_id] = alert
        self._history.append(alert)
        self._last_alert_time = now
        self._total_triggers += 1

        log.info(
            "alert.created",
            alert_id=alert.alert_id,
            severity=severity,
            magnitude=magnitude,
            distance_km=distance_km,
            distance_class=distance_class,
            data_source=data_source,
        )
        return alert

    # ------------------------------------------------------------------
    # Mutation
    # ------------------------------------------------------------------
    def update_alert(self, alert_id: str, **updates: Any) -> EarthquakeAlert | None:
        """Apply field updates to an existing alert.

        Uses Pydantic's ``model_copy(update=...)`` to produce a new immutable
        snapshot.  Returns ``None`` if the alert is not found.
        """
        alert = self._active.get(alert_id)
        if alert is None:
            log.warning("alert.update_not_found", alert_id=alert_id)
            return None

        updated = alert.model_copy(update=updates)
        self._active[alert_id] = updated

        if updates.get("status") == "confirmed":
            self._total_confirmed += 1

        log.info("alert.updated", alert_id=alert_id, fields=list(updates))
        return updated

    def cancel_alert(self, alert_id: str, reason: str) -> None:
        """Mark an alert as cancelled and remove from the active set."""
        alert = self._active.pop(alert_id, None)
        if alert is None:
            log.warning("alert.cancel_not_found", alert_id=alert_id)
            return

        cancelled = alert.model_copy(update={"status": "cancelled"})
        self._history.append(cancelled)
        log.info("alert.cancelled", alert_id=alert_id, reason=reason)

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------
    def should_alert(self) -> bool:
        """Return ``True`` if the cooldown period has elapsed."""
        return (time.time() - self._last_alert_time) >= self.cooldown_sec

    def get_active_alerts(self) -> list[EarthquakeAlert]:
        """Return a snapshot of all currently-active alerts."""
        return list(self._active.values())

    @property
    def recent_history(self) -> list[EarthquakeAlert]:
        """Return the last *max_history* alerts (active + cancelled)."""
        return list(self._history)

    @property
    def total_triggers(self) -> int:
        return self._total_triggers

    @property
    def total_confirmed(self) -> int:
        return self._total_confirmed

    @property
    def last_alert_time(self) -> float:
        return self._last_alert_time
