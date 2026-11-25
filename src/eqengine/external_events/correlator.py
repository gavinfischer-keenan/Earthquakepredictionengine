"""Live correlation between RS4D spectral bands and active external events."""
from __future__ import annotations

from typing import Any

from eqengine.external_events.schema import (
    AircraftSnapshot,
    BartTransitSnapshot,
    ExternalCorrelation,
    ExternalEvent,
    WeatherSnapshot,
)


def correlate_external_events(
    forensics: dict[str, Any] | None,
    events: list[ExternalEvent],
    weather: WeatherSnapshot | None = None,
    bart: BartTransitSnapshot | None = None,
    aircraft: AircraftSnapshot | None = None,
) -> ExternalCorrelation:
    """Match current 1-minute or live spectral band energy against active local events."""
    metrics = forensics or {}
    stadium_um_s = float(metrics.get("stadium_um_s", 0.0))
    concert_um_s = float(metrics.get("concert_um_s", 0.0))
    rail_um_s = float(metrics.get("rail_um_s", 0.0))
    wind_um_s = float(metrics.get("wind_um_s", 0.0))
    traffic_um_s = float(metrics.get("traffic_um_s", 0.0))
    human_um_s = float(metrics.get("human_um_s", 0.0))

    live_events = [e for e in events if e.status == "live"]

    # 1. Cal Memorial Stadium home football (highest cultural/tectonic overlap)
    for ev in live_events:
        if ev.category == "football" and stadium_um_s >= 0.4:
            conf = min(98, int(72 + stadium_um_s * 12))
            return ExternalCorrelation(
                matched=True,
                active_event_id=ev.id,
                active_event_title=ev.title,
                active_category="football",
                matched_band="stadium",
                confidence=conf,
                reason=f"Live Cal home game ({ev.title}) aligns with {stadium_um_s:.2f} µm/s in 2–5 Hz band.",
            )

    # 2. Greek Theatre concert / soundcheck
    for ev in live_events:
        if ev.category == "concert" and concert_um_s >= 0.3:
            conf = min(96, int(70 + concert_um_s * 15))
            return ExternalCorrelation(
                matched=True,
                active_event_id=ev.id,
                active_event_title=ev.title,
                active_category="concert",
                matched_band="concert",
                confidence=conf,
                reason=f"Greek Theatre show ({ev.title}) aligns with {concert_um_s:.2f} µm/s sub-bass (25–45 Hz).",
            )

    # 3. Overhead helicopter / low-altitude aircraft acoustic coupling (10–35 Hz)
    if aircraft is not None and aircraft.low_overhead_count > 0 and aircraft.closest_aircraft is not None:
        ac = aircraft.closest_aircraft
        if human_um_s >= 0.25 or concert_um_s >= 0.2 or traffic_um_s >= 0.4:
            kind = "Helicopter" if ac.is_helicopter else "Low Aircraft"
            conf = min(96, int(74 + max(0.0, 5.0 - ac.distance_km) * 4))
            return ExternalCorrelation(
                matched=True,
                active_event_id="aircraft-overhead-live",
                active_event_title=f"{kind} {ac.callsign} ({ac.altitude_ft:,} ft)",
                active_category="aircraft",
                matched_band="aircraft",
                confidence=conf,
                reason=f"ADS-B {kind.lower()} {ac.callsign} ({ac.aircraft_type or 'AC'}) at {ac.altitude_ft:,} ft, {ac.distance_km:.1f} km.",
            )

    # 4. BART Berkeley Hills Tunnel
    if bart is not None and bart.tunnel_active and rail_um_s >= 0.5:
        conf = min(92, int(68 + bart.trains_imminent_count * 8))
        return ExternalCorrelation(
            matched=True,
            active_event_id="bart-hills-tunnel-live",
            active_event_title=f"BART Tunnel ({bart.trains_imminent_count} imminent)",
            active_category="transit",
            matched_band="rail",
            confidence=conf,
            reason=f"{bart.trains_imminent_count} BART train(s) near DBRK/ROCK align with {rail_um_s:.2f} µm/s (4–8 Hz).",
        )

    # 4. Berkeley Hills gusty/storm winds
    if weather is not None and weather.regime in ("GUSTY", "STORM") and wind_um_s >= 0.4:
        conf = min(94, int(70 + weather.wind_gusts_mps * 1.2))
        return ExternalCorrelation(
            matched=True,
            active_event_id="weather-berkeley-wind",
            active_event_title=f"{weather.regime.title()} Winds ({weather.wind_gusts_mph:.0f} mph gusts)",
            active_category="weather",
            matched_band="wind",
            confidence=conf,
            reason=f"Open-Meteo {weather.wind_gusts_mph:.0f} mph gusts align with {wind_um_s:.2f} µm/s sway (0.38–0.85 Hz).",
        )

    # No active band spike, but report if a major scheduled event is live on standby
    for ev in live_events:
        if ev.category in ("football", "concert"):
            return ExternalCorrelation(
                matched=False,
                active_event_id=ev.id,
                active_event_title=ev.title,
                active_category=ev.category,
                matched_band=ev.expected_band_key,
                confidence=40,
                reason=f"{ev.title} is live/active; monitoring {ev.expected_bands_hz[0]}–{ev.expected_bands_hz[1]} Hz band.",
            )

    return ExternalCorrelation()
