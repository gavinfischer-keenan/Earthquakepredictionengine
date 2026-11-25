"""Tests for BK.BKS Witness, rolling MiniSEED archive & replay, Shake Highlights, and ONNX MLPicker."""
from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import obspy
from obspy import Stream, Trace, UTCDateTime

from eqengine.ingest.archive import MiniSeedArchiver, analyze_quake_replay
from eqengine.ingest.ring_buffer import RingBuffer
from eqengine.telemetry.highlights import HighlightsRecorder
from eqengine.validation.ml_picker import MLPicker
from eqengine.validation.witness import MultiStationWitness, evaluate_witness_trace


def _make_trace(
    channel: str = "EHZ",
    start: float = 1795000000.0,
    duration_sec: float = 120.0,
    spike_at_sec: float | None = None,
    spike_amp: float = 4000.0,
    sr: float = 100.0,
) -> obspy.Trace:
    n = int(duration_sec * sr)
    rng = np.random.default_rng(42)
    data = rng.normal(0.0, 8.0, size=n)
    if spike_at_sec is not None:
        idx0 = int(spike_at_sec * sr)
        idx1 = min(n, idx0 + int(6.0 * sr))
        t_seg = np.arange(idx1 - idx0) / sr
        data[idx0:idx1] += spike_amp * np.sin(2 * np.pi * 2.5 * t_seg)
    return Trace(
        data=np.round(data).astype(np.int32),
        header={
            "network": "AM",
            "station": "R1A3D",
            "channel": channel,
            "sampling_rate": sr,
            "starttime": UTCDateTime(start),
        },
    )


def test_witness_evaluate_trace_confirmed_vs_local() -> None:
    base = 1795000000.0
    trig_t = base + 40.0

    tectonic_tr = _make_trace(start=base, duration_sec=60.0, spike_at_sec=41.0, spike_amp=600.0)
    verdict_ok, sta_ok, snr_ok, _delta = evaluate_witness_trace(
        tectonic_tr,
        trig_t,
        snr_threshold=2.2,
    )
    assert verdict_ok == "CONFIRMED_TECTONIC"
    assert sta_ok > 0.0
    assert snr_ok >= 2.2

    quiet_tr = _make_trace(start=base, duration_sec=60.0, spike_at_sec=None)
    verdict_local, _, snr_quiet, _ = evaluate_witness_trace(
        quiet_tr,
        trig_t,
        snr_threshold=3.5,
    )
    assert verdict_local == "LOCAL_ONLY"
    assert snr_quiet < 3.5


async def test_witness_unavailable_when_fdsn_fails(monkeypatch) -> None:
    import httpx

    class _FailResp:
        status_code = 204
        content = b""

    class _FailClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, *args, **kwargs):
            return _FailResp()

    monkeypatch.setattr(httpx, "AsyncClient", _FailClient)
    witness = MultiStationWitness()
    v_miss = await witness.verify_trigger(time.time())
    assert v_miss.verdict == "UNAVAILABLE"


def test_archive_write_prune_and_quake_replay(tmp_path: Path) -> None:
    archiver = MiniSeedArchiver(archive_dir=tmp_path / "archive", retention_hours=48, sampling_rate=100)
    t0 = time.time() - 300.0

    # Write integer chunk using Steim2
    tr = _make_trace(start=t0, duration_sec=100.0, spike_at_sec=45.0, spike_amp=2500.0)
    written = archiver.flush_traces([tr])
    assert written == 1
    assert archiver.get_status()["file_count"] == 1

    traces = archiver.read_window(t0 + 10.0, t0 + 90.0, channels=("EHZ",))
    assert "EHZ" in traces
    replay = analyze_quake_replay(traces["EHZ"], p_arrival=t0 + 45.0, s_arrival=t0 + 50.0, surf_arrival=t0 + 55.0)
    assert replay["has_data"] is True
    assert replay["detected"] is True
    assert replay["snr_peak"] >= 5.0
    assert replay["verdict"] == "CLEARLY RECORDED"

    # Ring buffer flush check
    rb = RingBuffer(channels=("EHZ", "ENZ", "ENN", "ENE"), buffer_duration_sec=120, sampling_rate=100)
    rb.append("EHZ", np.arange(3000, dtype=np.float64), timestamp=t0 + 200.0)
    assert archiver.flush_from_ring_buffer(rb, duration_sec=25.0) >= 1


def test_highlights_recorder_quake_and_external_captures(tmp_path: Path) -> None:
    rec = HighlightsRecorder(highlights_dir=tmp_path / "hl", cooldown_sec=60.0, sampling_rate=100.0)
    rb = RingBuffer(channels=("EHZ", "ENZ", "ENN", "ENE"), buffer_duration_sec=120, sampling_rate=100)
    t0 = time.time() - 60.0
    for ch in ("EHZ", "ENZ", "ENN", "ENE"):
        rb.append(ch, np.sin(np.linspace(0, 20, 6000)) * 500.0, timestamp=t0)

    ev = rec.capture_earthquake(
        ring_buffer=rb,
        title="M3.2 Hayward Fault",
        magnitude=3.2,
        distance_km=6.5,
        mmi_label="Weak",
        mmi_roman="III",
        witness_verdict="CONFIRMED_TECTONIC",
    )
    assert ev is not None
    assert ev["category"] == "earthquake"

    # Cooldown prevents immediate second earthquake capture
    ev2 = rec.capture_earthquake(ring_buffer=rb, title="Dup", magnitude=2.8, distance_km=10.0)
    assert ev2 is None

    # External event touchdown spike should capture independently in "touchdown" category
    ext_mgr = MagicMock()
    live_game = MagicMock()
    live_game.category = "football"
    live_game.title = "Cal vs. Stanford"
    live_game.metadata = {"status_detail": "Q4 2:10"}
    ext_mgr.all_events.return_value = [MagicMock(status="live", category="football", title=live_game.title, metadata=live_game.metadata)]

    td = rec.evaluate_external_tick(
        ring_buffer=rb,
        forensics_metrics={"stadium_um_s": 2.4, "concert_um_s": 0.1},
        external_events_manager=ext_mgr,
        quiet_baseline={"stadium_um_s": 0.2, "concert_um_s": 0.1},
    )
    assert td is not None
    assert td["category"] == "touchdown"

    listing = rec.list_highlights()
    assert len(listing) == 2
    clip = rec.get_highlight_clip(td["id"])
    assert clip is not None
    assert len(clip["samples"]) > 100


def test_ml_picker_onnx_mode_and_labels(tmp_path: Path) -> None:
    # Default heuristic label when no model loaded
    picker_none = MLPicker(backend="heuristic")
    assert picker_none.picker_label == "Z/H Polarization Heuristic"

    # Mock ONNX session to verify 3-component inference path without heavy weights
    fake_onnx = tmp_path / "phasenet.onnx"
    fake_onnx.write_bytes(b"fake")
    picker_onnx = MLPicker(backend="onnx", onnx_model_path=fake_onnx, p_threshold=0.3)

    mock_session = MagicMock()
    probs = np.zeros((1, 3, 600), dtype=np.float32)
    probs[0, 1, 200] = 0.88  # P channel
    probs[0, 2, 340] = 0.77  # S channel
    mock_session.run.return_value = [probs]
    mock_input = MagicMock()
    mock_input.name = "input"
    mock_session.get_inputs.return_value = [mock_input]

    picker_onnx._onnx_session = mock_session
    picker_onnx._loaded_backend = "onnx"
    assert picker_onnx.picker_label == "PhaseNet ONNX AI"

    t0 = 1795000000.0
    stream = Stream([_make_trace("EHZ", start=t0, duration_sec=6.0)])
    res = picker_onnx.validate_p_wave(stream, UTCDateTime(t0 + 2.0))
    assert res is not None
    assert res.p_probability >= 0.85
    assert res.s_probability >= 0.75
    assert res.p_time is not None
    assert res.s_time is not None
