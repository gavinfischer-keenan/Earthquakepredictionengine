"""Tests for eqengine CLI replay and configuration commands."""
from __future__ import annotations

import asyncio

import numpy as np
from obspy import Stream, Trace, UTCDateTime

from eqengine.cli import _run_replay
from eqengine.config import Settings


def test_run_replay_processes_synthetic_mseed(tmp_path) -> None:
    sr = 100.0
    n = 3500  # 35s
    rng = np.random.default_rng(12)
    data = rng.normal(0.0, 5.0, size=n)

    # Inject a gradual-onset 4 Hz seismic wave packet starting at t = 22s
    t = np.arange(800) / sr
    env = np.sin(np.pi * t / 8.0) ** 2
    data[2200:3000] += 600.0 * env * np.sin(2 * np.pi * 4.0 * t)

    tr = Trace(
        data=data,
        header={
            "network": "AM",
            "station": "R1A3D",
            "channel": "EHZ",
            "sampling_rate": sr,
            "starttime": UTCDateTime(1700000000),
        },
    )
    mseed_file = tmp_path / "synthetic_quake.mseed"
    Stream([tr]).write(str(mseed_file), format="MSEED")

    cfg = Settings(trigger_on=4.0, trigger_off=1.5, min_trigger_duration_sec=0.5)
    confirmed = asyncio.run(_run_replay(str(mseed_file), cfg))
    assert confirmed >= 1
