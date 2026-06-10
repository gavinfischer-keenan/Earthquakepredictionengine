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


# ===================================================================
# 5. MQTT Message Bus  ── multi-agent home intelligence architecture
# ===================================================================
# MQTT is the backbone for the broader home intelligence platform.
# Multiple AI agents publish to topic namespaces; multiple consumers
# subscribe.  The topic schema follows:
#
#   home/alerts/{agent}        — urgent alerts (earthquake, fire, intrusion)
#   home/status/{agent}        — health/heartbeat (earthquake-engine, birdnet)
#   home/sensors/{agent}       — continuous telemetry (RSAM, bird detections)
#   home/events/{agent}        — confirmed events (earthquakes, bird sightings)
#   home/commands/{target}     — outbound commands (alexa-say, display-mode)
#
# This hook publishes to the first two.  Future agents (birdnet, cameras)
# will follow the same schema.
#
# Requires: pip install paho-mqtt  (optional dependency)

MQTT_BROKER: str = os.getenv("MQTT_BROKER", "localhost")
MQTT_PORT: int = int(os.getenv("MQTT_PORT", "1883"))
MQTT_TOPIC_ALERTS: str = os.getenv("MQTT_TOPIC_ALERTS", "home/alerts/earthquake")
MQTT_TOPIC_STATUS: str = os.getenv("MQTT_TOPIC_STATUS", "home/status/earthquake-engine")
MQTT_TOPIC_EVENTS: str = os.getenv("MQTT_TOPIC_EVENTS", "home/events/earthquake")
MQTT_TOPIC_COMMANDS: str = os.getenv("MQTT_TOPIC_COMMANDS", "home/commands/display")
MQTT_ENABLED: bool = os.getenv("MQTT_ENABLED", "false").lower() in ("true", "1", "yes")

_mqtt_client = None


def _get_mqtt_client():
    """Lazy-init MQTT client.  Returns None if paho-mqtt is not installed."""
    global _mqtt_client
    if _mqtt_client is not None:
        return _mqtt_client
    try:
        import paho.mqtt.client as mqtt  # type: ignore[import-untyped]
        _mqtt_client = mqtt.Client(
            client_id="eqengine",
            protocol=mqtt.MQTTv311,
        )
        _mqtt_client.connect(MQTT_BROKER, MQTT_PORT, keepalive=60)
        _mqtt_client.loop_start()
        log.info(
            "dispatcher.mqtt_connected",
            broker=MQTT_BROKER,
            port=MQTT_PORT,
        )
        return _mqtt_client
    except ImportError:
        log.warning("dispatcher.mqtt_unavailable", reason="paho-mqtt not installed")
        return None
    except Exception:
        log.exception("dispatcher.mqtt_connect_failed")
        return None


async def mqtt_alert_hook(alert: EarthquakeAlert) -> None:
    """Publish alert to MQTT topic ``home/alerts/earthquake``."""
    client = _get_mqtt_client()
    if client is None:
        return
    payload = json.dumps(alert.model_dump(), default=str)
    client.publish(MQTT_TOPIC_ALERTS, payload, qos=1, retain=False)
    # Also publish a display command so any listener knows to show the alert
    client.publish(MQTT_TOPIC_COMMANDS, json.dumps({
        "command": "earthquake_alert",
        "message": "EARTHQUAKE EXPECTED",
        "severity": alert.severity,
        "magnitude": alert.estimated_magnitude,
    }), qos=1, retain=False)
    log.debug(
        "dispatcher.mqtt_alert_sent",
        topic=MQTT_TOPIC_ALERTS,
        alert_id=alert.alert_id,
    )


async def mqtt_status_hook(status: EngineStatus) -> None:
    """Publish engine status to MQTT topic ``home/status/earthquake-engine``."""
    client = _get_mqtt_client()
    if client is None:
        return
    payload = json.dumps(status.model_dump(), default=str)
    client.publish(MQTT_TOPIC_STATUS, payload, qos=0, retain=True)


# ---------------------------------------------------------------------------
# Auto-register built-in hooks on module import
# ---------------------------------------------------------------------------
def _register_defaults() -> None:
    """Register built-in hooks.  MQTT hooks only if MQTT_ENABLED=true."""
    register_hook(dashboard_hook)
    register_hook(log_hook)
    register_hook(console_hook)
    register_status_hook(dashboard_status_hook)
    register_status_hook(console_status_hook)
    if MQTT_ENABLED:
        register_hook(mqtt_alert_hook)
        register_status_hook(mqtt_status_hook)
        log.info("dispatcher.mqtt_hooks_enabled")


_register_defaults()
