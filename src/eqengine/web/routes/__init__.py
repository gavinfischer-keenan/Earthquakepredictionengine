"""FastAPI route modules for the Seismic Observatory web server."""
from __future__ import annotations

from eqengine.web.routes.environmental import router as environmental_router
from eqengine.web.routes.external_events import router as external_events_router
from eqengine.web.routes.ml import router as ml_router
from eqengine.web.routes.observatory import router as observatory_router
from eqengine.web.routes.simulation import router as simulation_router
from eqengine.web.routes.telemetry import router as telemetry_router

__all__ = [
    "environmental_router",
    "external_events_router",
    "ml_router",
    "observatory_router",
    "simulation_router",
    "telemetry_router",
]
