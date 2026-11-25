"""Simulation endpoints for testing trigger and USGS wavefront overlays."""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter

from eqengine.config import get_config
from eqengine.constants import KM_TO_MILES
from eqengine.ingest.usgs_poller import (
    calculate_seismic_travel_times,
    classify_distance_km,
    classify_magnitude,
    is_observable_on_shake,
)
from eqengine.processing.intensity import compute_mmi
from eqengine.web.broadcaster import get_broadcaster

router = APIRouter(prefix="/api", tags=["simulation"])


@router.post("/simulate-trigger")
async def simulate_trigger(magnitude: float = 3.5, distance_km: float = 25.0) -> dict[str, Any]:
    """Simulate an earthquake trigger to test instant warning symbology on the dashboard."""
    config = get_config()
    broadcaster = get_broadcaster()
    now = time.time()

    sim_trigger = {
        "channel": config.shake_channel,
        "start_time": now - 1.0,
        "end_time": now + 4.0,
        "peak_sta_lta": 8.5,
        "sta_lta_ratio": 8.5,
        "start_sample": 0,
        "end_sample": 500,
        "is_simulation": True,
    }
    await broadcaster.broadcast_trigger(sim_trigger)

    s_delay_sec = round(max(distance_km * (1.0 / 3.5 - 1.0 / 6.0), 3.0), 2)
    sim_pga = round(
        0.0018 * (10 ** (0.45 * (magnitude - 2.0))) * (25.0 / max(distance_km, 5.0)),
        4,
    )
    sim_pgv = round(sim_pga / 9.81, 4)
    mmi_res = compute_mmi(pga_m_s2=sim_pga, pgv_m_s=sim_pgv)

    sim_alert = {
        "alert_id": f"sim-{int(now)}",
        "alert_type": "earthquake",
        "severity": "warning" if magnitude >= 3.5 else "advisory",
        "timestamp": now,
        "p_wave_time": now - 1.0,
        "sta_lta_ratio": 8.5,
        "estimated_magnitude": magnitude,
        "estimated_distance_km": distance_km,
        "distance_miles": round(distance_km * KM_TO_MILES, 1),
        "distance_class": "LOCAL",
        "mag_class": "LIGHT" if magnitude < 4.0 else "MODERATE",
        "peak_ground_acceleration": sim_pga,
        "peak_ground_velocity": sim_pgv,
        "mmi": mmi_res.mmi,
        "mmi_roman": mmi_res.roman,
        "mmi_label": mmi_res.label,
        "mmi_color": mmi_res.color,
        "estimated_s_arrival": now - 1.0 + s_delay_sec,
        "seconds_until_s_wave": round(max(s_delay_sec - 1.0, 0.5), 2),
        "station": config.shake_station,
        "channel": config.shake_channel,
        "tts_message": (
            f"Earthquake Warning. Simulated magnitude {magnitude} detected "
            f"{round(distance_km * KM_TO_MILES, 1)} miles away."
        ),
        "is_simulation": True,
    }
    await broadcaster.broadcast_alert(sim_alert)

    return {"status": "ok", "message": "Simulation trigger & alert dispatched to connected browsers"}


@router.post("/simulate-usgs")
async def simulate_usgs(
    magnitude: float = 4.7,
    place: str = "Off Coast of Northern California",
    distance_km: float = 320.0,
) -> dict[str, Any]:
    """Simulate an external regional USGS earthquake with incoming theoretical wavefronts."""
    broadcaster = get_broadcaster()
    now = time.time()

    travel = calculate_seismic_travel_times(distance_km, 10.0)
    origin_time = now - 15.0
    theor_p = origin_time + travel["p_travel_sec"]
    theor_s = origin_time + travel["s_travel_sec"]
    theor_surf = origin_time + travel["surface_travel_sec"]

    sim_usgs = {
        "id": f"sim-usgs-{int(now)}",
        "magnitude": magnitude,
        "event_type": "earthquake",
        "place": place,
        "time": origin_time,
        "distance_km": distance_km,
        "distance_miles": round(distance_km * KM_TO_MILES, 1),
        "distance_class": classify_distance_km(distance_km),
        "mag_class": classify_magnitude(magnitude),
        "latitude": 40.3,
        "longitude": -124.6,
        "depth_km": 10.0,
        "url": "https://earthquake.usgs.gov/",
        "fetched_at": now,
        "p_travel_sec": travel["p_travel_sec"],
        "s_travel_sec": travel["s_travel_sec"],
        "p_arrival": round(theor_p, 2),
        "s_arrival": round(theor_s, 2),
        "surf_arrival": round(theor_surf, 2),
        "is_observable": is_observable_on_shake(magnitude, distance_km),
        "is_simulation": True,
    }
    await broadcaster.broadcast_usgs_event(sim_usgs)
    return {"status": "ok", "event": sim_usgs}
