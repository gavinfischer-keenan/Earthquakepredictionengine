"""Multi-station coincidence witness using nearby FDSN stations (e.g. UC Berkeley BK.BKS)."""
from __future__ import annotations

import io
from collections import deque
from datetime import UTC, datetime
from typing import Any, Literal

import httpx
import numpy as np
import obspy
import structlog
from obspy import UTCDateTime
from obspy.signal.trigger import recursive_sta_lta
from pydantic import BaseModel

from eqengine.config import get_config
from eqengine.ingest.usgs_poller import haversine_km
from eqengine.processing.preprocessor import preprocess

log = structlog.get_logger(__name__)


class WitnessVerdict(BaseModel):
    """Cross-check verdict comparing a local RS4D trigger against a reference vault."""

    verdict: Literal["CONFIRMED_TECTONIC", "LOCAL_ONLY", "UNAVAILABLE"]
    witness_station: str
    trigger_time: float
    distance_km: float
    witness_sta_lta: float | None = None
    witness_snr: float | None = None
    arrival_delta_sec: float | None = None
    checked_at_utc: str
    detail: str


def evaluate_witness_trace(
    trace: obspy.Trace,
    trigger_time: float,
    *,
    sta_threshold: float = 3.5,
    snr_threshold: float = 3.0,
) -> tuple[Literal["CONFIRMED_TECTONIC", "LOCAL_ONLY"], float, float, float | None]:
    """Check whether *trace* exhibits a coincident seismic arrival near *trigger_time*."""
    sr = float(trace.stats.sampling_rate or 40.0)
    filtered = preprocess(
        trace,
        bandpass_low=1.0,
        bandpass_high=min(10.0, max(2.0, sr * 0.45)),
    )
    data = np.asarray(filtered.data, dtype=np.float64)
    t0 = float(filtered.stats.starttime.timestamp)

    # Pre-event baseline RMS [-18s, -4s] vs coincidence window [-3s, +5s]
    base_i0 = max(0, round((trigger_time - 18.0 - t0) * sr))
    base_i1 = max(base_i0 + 1, min(len(data), round((trigger_time - 4.0 - t0) * sr)))
    win_i0 = max(0, round((trigger_time - 3.0 - t0) * sr))
    win_i1 = min(len(data), round((trigger_time + 5.0 - t0) * sr))

    if win_i1 - win_i0 < 8:
        return "LOCAL_ONLY", 1.0, 1.0, None

    base_rms = float(np.sqrt(np.mean(data[base_i0:base_i1] ** 2))) if base_i1 > base_i0 else 1.0
    win_peak = float(np.max(np.abs(data[win_i0:win_i1])))
    snr = win_peak / max(base_rms, 1e-6)

    nsta = max(4, int(0.5 * sr))
    nlta = max(nsta + 8, int(10.0 * sr))
    peak_cft = 1.0
    delta_sec: float | None = None
    if len(data) >= nlta + nsta:
        cft = recursive_sta_lta(data, nsta, nlta)
        seg = cft[win_i0:win_i1]
        if seg.size > 0:
            pk_rel = int(np.argmax(seg))
            peak_cft = float(seg[pk_rel])
            pk_time = t0 + (win_i0 + pk_rel) / sr
            delta_sec = round(pk_time - trigger_time, 2)

    confirmed = (peak_cft >= sta_threshold) or (snr >= snr_threshold)
    verdict: Literal["CONFIRMED_TECTONIC", "LOCAL_ONLY"] = (
        "CONFIRMED_TECTONIC" if confirmed else "LOCAL_ONLY"
    )
    return verdict, round(peak_cft, 2), round(snr, 2), delta_sec


class MultiStationWitness:
    """Queries nearby FDSN broadband vault (default BK.BKS) to vet local triggers."""

    def __init__(
        self,
        *,
        network: str = "BK",
        station: str = "BKS",
        channel: str = "BHZ",
        fdsn_url: str = "https://service.ncedc.org/fdsnws/dataselect/1/query",
        station_lat: float = 37.8696,
        station_lon: float = -122.2491,
        witness_lat: float = 37.8762,
        witness_lon: float = -122.2356,
    ) -> None:
        self.network = network
        self.station = station
        self.channel = channel
        self.fdsn_url = fdsn_url
        self.distance_km = round(
            haversine_km(station_lat, station_lon, witness_lat, witness_lon),
            2,
        )
        self.latest_verdict: WitnessVerdict | None = None
        self.history: deque[WitnessVerdict] = deque(maxlen=50)

    @property
    def witness_id(self) -> str:
        return f"{self.network}.{self.station}..{self.channel}"

    async def verify_trigger(self, trigger_time: float) -> WitnessVerdict:
        """Fetch witness waveform around *trigger_time* and compute coincidence verdict."""
        t_start = UTCDateTime(trigger_time - 20.0).isoformat()
        t_end = UTCDateTime(trigger_time + 8.0).isoformat()
        checked_utc = datetime.now(tz=UTC).isoformat()

        params = {
            "net": self.network,
            "sta": self.station,
            "cha": self.channel,
            "start": t_start,
            "end": t_end,
            "format": "miniseed",
        }
        try:
            async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
                resp = await client.get(self.fdsn_url, params=params)
                if resp.status_code != 200 or not resp.content:
                    verdict = WitnessVerdict(
                        verdict="UNAVAILABLE",
                        witness_station=self.witness_id,
                        trigger_time=trigger_time,
                        distance_km=self.distance_km,
                        checked_at_utc=checked_utc,
                        detail=f"FDSN returned HTTP {resp.status_code} (vault stream unavailable for window).",
                    )
                else:
                    st = obspy.read(io.BytesIO(resp.content))
                    if not st:
                        verdict = WitnessVerdict(
                            verdict="UNAVAILABLE",
                            witness_station=self.witness_id,
                            trigger_time=trigger_time,
                            distance_km=self.distance_km,
                            checked_at_utc=checked_utc,
                            detail="Empty MiniSEED stream returned by FDSN.",
                        )
                    else:
                        v_str, sta_lta, snr, delta = evaluate_witness_trace(st[0], trigger_time)
                        detail = (
                            f"Coincident arrival on {self.witness_id} ({self.distance_km} km away): "
                            f"STA/LTA {sta_lta:.1f}x, SNR {snr:.1f}x."
                            if v_str == "CONFIRMED_TECTONIC"
                            else f"No coincident wave on {self.witness_id} (STA/LTA {sta_lta:.1f}x, SNR {snr:.1f}x) — likely local cultural/structural vibration."
                        )
                        verdict = WitnessVerdict(
                            verdict=v_str,
                            witness_station=self.witness_id,
                            trigger_time=trigger_time,
                            distance_km=self.distance_km,
                            witness_sta_lta=sta_lta,
                            witness_snr=snr,
                            arrival_delta_sec=delta,
                            checked_at_utc=checked_utc,
                            detail=detail,
                        )
        except Exception as exc:  # noqa: BLE001
            log.warning("witness.fetch_failed", station=self.witness_id, error=str(exc))
            verdict = WitnessVerdict(
                verdict="UNAVAILABLE",
                witness_station=self.witness_id,
                trigger_time=trigger_time,
                distance_km=self.distance_km,
                checked_at_utc=checked_utc,
                detail=f"Witness query failed: {exc}",
            )

        self.latest_verdict = verdict
        self.history.append(verdict)
        return verdict

    def get_status(self) -> dict[str, Any]:
        return {
            "witness_station": self.witness_id,
            "distance_km": self.distance_km,
            "latest_verdict": self.latest_verdict.model_dump() if self.latest_verdict else None,
            "history": [v.model_dump() for v in self.history],
        }


_witness: MultiStationWitness | None = None


def get_witness(config: Any | None = None) -> MultiStationWitness:
    """Return or initialize the global MultiStationWitness singleton."""
    global _witness
    if _witness is None:
        cfg = config or get_config()
        _witness = MultiStationWitness(
            network=str(getattr(cfg, "witness_network", "BK")),
            station=str(getattr(cfg, "witness_station", "BKS")),
            channel=str(getattr(cfg, "witness_channel", "BHZ")),
            fdsn_url=str(getattr(cfg, "witness_fdsn_url", "https://service.ncedc.org/fdsnws/dataselect/1/query")),
            station_lat=float(getattr(cfg, "station_lat", 37.8696)),
            station_lon=float(getattr(cfg, "station_lon", -122.2491)),
            witness_lat=float(getattr(cfg, "witness_lat", 37.8762)),
            witness_lon=float(getattr(cfg, "witness_lon", -122.2356)),
        )
    return _witness
