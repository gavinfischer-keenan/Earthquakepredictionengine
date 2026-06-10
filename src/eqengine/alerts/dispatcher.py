"""Pluggable alert dispatch — async hook registry with built-in hooks.

Hooks are plain ``async`` callables with the signature::

    async def my_hook(alert: EarthquakeAlert) -> None: ...

They are registered once at startup and invoked concurrently via
:func:`send_alert`.  A failing hook is logged but never blocks other hooks.

Three built-in hooks are registered by default:
  * **dashboard_hook** — HTTP POST to the configured dashboard endpoint.
  * **log_hook** — append the alert as a JSON line to an events log file.
  * **console_hook** — emit a structured-log message at the appropriate level.
"""
from __future__ import annotations

import json
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TypeAlias

import httpx
import structlog

from eqengine import __version__
from eqengine.alerts.schema import EarthquakeAlert, EngineStatus

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Hook type & registry
# ---------------------------------------------------------------------------
AlertHook: TypeAlias = Callable[[EarthquakeAlert], Awaitable[None]]
StatusHook: TypeAlias = Callable[[EngineStatus], Awaitable[None]]

ALERT_HOOKS: list[AlertHook] = []
STATUS_HOOKS: list[StatusHook] = []


def register_hook(hook: AlertHook) -> None:
    """Add *hook* to the alert dispatch list."""
    ALERT_HOOKS.append(hook)
    log.debug("dispatcher.hook_registered", hook=hook.__qualname__)


def register_status_hook(hook: StatusHook) -> None:
    """Add *hook* to the status dispatch list."""
    STATUS_HOOKS.append(hook)
    log.debug("dispatcher.status_hook_registered", hook=hook.__qualname__)


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
async def send_alert(alert: EarthquakeAlert) -> None:
    """Invoke every registered alert hook, logging failures individually."""
    for hook in ALERT_HOOKS:
        try:
            await hook(alert)
        except Exception:
            log.exception(
                "dispatcher.hook_failed",
                hook=hook.__qualname__,
                alert_id=alert.alert_id,
            )


async def send_status(status: EngineStatus) -> None:
    """Invoke every registered status hook, logging failures individually."""
    for hook in STATUS_HOOKS:
        try:
            await hook(status)
        except Exception:
            log.exception(
                "dispatcher.status_hook_failed",
                hook=hook.__qualname__,
            )


# ===================================================================
# Built-in hooks
# ===================================================================

# Configuration from environment (overridable)
DASHBOARD_URL: str = os.getenv("EQ_DASHBOARD_URL", "http://localhost:8080/api/events")
EVENT_LOG_DIR: str = os.getenv("EQ_EVENT_LOG_DIR", "./data/events")


# 1. Dashboard HTTP POST --------------------------------------------------
async def dashboard_hook(alert: EarthquakeAlert) -> None:
    """POST the alert payload to the dashboard REST endpoint."""
    payload = {
        "data": alert.model_dump(),
        "metadata": {
            "source": "eqengine",
            "version": __version__,
        },
    }
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.post(DASHBOARD_URL, json=payload)
        resp.raise_for_status()
    log.debug(
        "dispatcher.dashboard_sent",
        alert_id=alert.alert_id,
        status_code=resp.status_code,
    )


# 2. JSONL file log -------------------------------------------------------
async def log_hook(alert: EarthquakeAlert) -> None:
    """Append the alert as a single JSON line to ``events.jsonl``."""
    log_dir = Path(EVENT_LOG_DIR)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "events.jsonl"

    line = json.dumps(alert.model_dump(), default=str) + "\n"
    # Blocking file I/O is fine here — the file is local and tiny.
    with log_path.open("a", encoding="utf-8") as fh:
        fh.write(line)

    log.debug("dispatcher.log_written", path=str(log_path), alert_id=alert.alert_id)


# 3. Console / structlog --------------------------------------------------
async def console_hook(alert: EarthquakeAlert) -> None:
    """Emit a structured-log message at the severity-appropriate level."""
    msg_kwargs = {
        "alert_id": alert.alert_id,
        "severity": alert.severity,
        "sta_lta": round(alert.sta_lta_ratio, 2),
        "magnitude": alert.estimated_magnitude,
        "station": alert.station,
        "channel": alert.channel,
    }
    if alert.severity == "critical":
        log.critical("🚨 EARTHQUAKE ALERT", **msg_kwargs)
    elif alert.severity == "warning":
        log.warning("⚠️  Seismic event detected", **msg_kwargs)
    else:
        log.info("ℹ️  Minor seismic event", **msg_kwargs)


# 4. Dashboard status POST ------------------------------------------------
async def dashboard_status_hook(status: EngineStatus) -> None:
    """POST engine status to the dashboard."""
    payload = {
        "data": status.model_dump(),
        "metadata": {
            "source": "eqengine",
            "version": __version__,
        },
    }
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.post(
            DASHBOARD_URL.replace("/events", "/status"), json=payload,
        )
        resp.raise_for_status()


async def console_status_hook(status: EngineStatus) -> None:
    """Log engine status to the console."""
    log.info(
        "engine.status",
        status=status.status,
        uptime_s=round(status.uptime_seconds, 1),
        rsam=round(status.rsam_1min, 2),
        triggers=status.total_triggers,
        confirmed=status.total_confirmed_events,
    )


# ---------------------------------------------------------------------------
# Auto-register built-in hooks on module import
# ---------------------------------------------------------------------------
def _register_defaults() -> None:
    """Register the three built-in alert hooks and two status hooks."""
    register_hook(dashboard_hook)
    register_hook(log_hook)
    register_hook(console_hook)
    register_status_hook(dashboard_status_hook)
    register_status_hook(console_status_hook)


_register_defaults()
