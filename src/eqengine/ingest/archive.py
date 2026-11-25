"""24–48h rolling MiniSEED archive and 'Did My Sensor See That Quake?' replay analyzer."""
from __future__ import annotations

import contextlib
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import obspy
import structlog
from obspy import Stream, Trace, UTCDateTime

from eqengine.constants import RS4D_CHANNELS
from eqengine.processing.preprocessor import preprocess

log = structlog.get_logger(__name__)


def _write_compressed_mseed(stream: Stream, path: Path) -> None:
    """Write *stream* as MiniSEED using Steim2 for integer counts or FLOAT32 otherwise."""
    out_stream = Stream()
    all_int = True
    for tr in stream:
        tr_copy = tr.copy()
        if np.issubdtype(tr_copy.data.dtype, np.integer):
            tr_copy.data = tr_copy.data.astype(np.int32)
        else:
            rounded = np.round(tr_copy.data)
            if np.allclose(tr_copy.data, rounded, atol=1e-4):
                tr_copy.data = rounded.astype(np.int32)
            else:
                all_int = False
                tr_copy.data = tr_copy.data.astype(np.float32)
        out_stream.append(tr_copy)

    encoding = "STEIM2" if all_int else "FLOAT32"
    out_stream.write(str(path), format="MSEED", encoding=encoding)


def analyze_quake_replay(
    trace: obspy.Trace,
    *,
    p_arrival: float,
    s_arrival: float | None = None,
    surf_arrival: float | None = None,
    max_points: int = 800,
) -> dict[str, Any]:
    """Measure pre-arrival noise floor vs arrival SNR and decimate trace for replay plotting."""
    sr = float(trace.stats.sampling_rate or 100.0)
    t0 = float(trace.stats.starttime.timestamp)

    try:
        filtered = preprocess(
            trace,
            bandpass_low=0.5,
            bandpass_high=min(10.0, max(2.0, sr * 0.45)),
        )
        data = np.asarray(filtered.data, dtype=np.float64)
    except ValueError:
        data = np.asarray(trace.data, dtype=np.float64)
        if data.size > 0:
            data = data - float(np.mean(data))

    if data.size == 0:
        return {
            "has_data": False,
            "detected": False,
            "verdict": "NO ARCHIVE DATA",
            "snr_peak": 0.0,
            "snr_rms": 0.0,
            "baseline_rms": 0.0,
            "peak_counts": 0.0,
            "start_time": t0,
            "sampling_rate": sr,
            "samples": [],
            "times": [],
        }

    base_i0 = max(0, round((p_arrival - 20.0 - t0) * sr))
    base_i1 = max(base_i0 + 1, min(len(data), round((p_arrival - 3.0 - t0) * sr)))
    if base_i1 <= base_i0:
        base_i0 = 0
        base_i1 = max(1, len(data) // 4)

    sig_end_ts = max(
        (surf_arrival + 30.0) if surf_arrival else 0.0,
        (s_arrival + 35.0) if s_arrival else 0.0,
        p_arrival + 60.0,
    )
    sig_i0 = max(0, round((p_arrival - 2.0 - t0) * sr))
    sig_i1 = min(len(data), max(sig_i0 + 1, round((sig_end_ts - t0) * sr)))

    baseline_rms = float(np.sqrt(np.mean(data[base_i0:base_i1] ** 2)))
    sig_slice = data[sig_i0:sig_i1] if sig_i1 > sig_i0 else data
    sig_rms = float(np.sqrt(np.mean(sig_slice ** 2)))
    peak_counts = float(np.max(np.abs(sig_slice)))

    snr_rms = sig_rms / max(baseline_rms, 1e-6)
    snr_peak = peak_counts / max(baseline_rms, 1e-6)

    if snr_peak >= 4.0 or snr_rms >= 2.0:
        detected = True
        verdict = "CLEARLY RECORDED"
    elif snr_peak >= 2.5:
        detected = True
        verdict = "WEAK SIGNAL"
    else:
        detected = False
        verdict = "BELOW NOISE FLOOR"

    # Min/max envelope decimation so peaks survive downsampling
    n = len(data)
    if n <= max_points:
        samples_out = np.round(data, 2).tolist()
        times_out = [round(t0 + i / sr, 3) for i in range(n)]
    else:
        n_bins = max(40, max_points // 2)
        step = n / n_bins
        samples_out = []
        times_out = []
        for b in range(n_bins):
            i0 = int(b * step)
            i1 = max(i0 + 1, int((b + 1) * step))
            seg = data[i0:i1]
            idx_min = int(np.argmin(seg))
            idx_max = int(np.argmax(seg))
            if idx_min <= idx_max:
                samples_out.extend([round(float(seg[idx_min]), 2), round(float(seg[idx_max]), 2)])
                times_out.extend([round(t0 + (i0 + idx_min) / sr, 3), round(t0 + (i0 + idx_max) / sr, 3)])
            else:
                samples_out.extend([round(float(seg[idx_max]), 2), round(float(seg[idx_min]), 2)])
                times_out.extend([round(t0 + (i0 + idx_max) / sr, 3), round(t0 + (i0 + idx_min) / sr, 3)])

    return {
        "has_data": True,
        "detected": detected,
        "verdict": verdict,
        "snr_peak": round(snr_peak, 2),
        "snr_rms": round(snr_rms, 2),
        "baseline_rms": round(baseline_rms, 2),
        "peak_counts": round(peak_counts, 2),
        "start_time": t0,
        "end_time": t0 + (n - 1) / sr,
        "sampling_rate": sr,
        "samples": samples_out,
        "times": times_out,
    }


class MiniSeedArchiver:
    """Rolling hourly MiniSEED archiver with retention pruning and window slicing."""

    def __init__(
        self,
        archive_dir: str | Path = "./data/archive",
        retention_hours: int = 48,
        sampling_rate: int = 100,
    ) -> None:
        self.archive_dir = Path(archive_dir)
        self.archive_dir.mkdir(parents=True, exist_ok=True)
        self.retention_hours = max(1, int(retention_hours))
        self.sampling_rate = sampling_rate

    def _hour_path(self, ts: float) -> Path:
        dt = datetime.fromtimestamp(ts, tz=UTC)
        return self.archive_dir / f"{dt.strftime('%Y%m%d_%H')}.mseed"

    def flush_traces(self, traces: list[Trace]) -> int:
        """Persist *traces* into UTC-hour MiniSEED files and prune expired chunks."""
        valid = [tr for tr in traces if tr is not None and len(tr.data) > 0]
        if not valid:
            return 0

        by_hour: dict[Path, list[Trace]] = {}
        for tr in valid:
            t_start = float(tr.stats.starttime.timestamp)
            t_end = float(tr.stats.endtime.timestamp)
            h_start = int(t_start // 3600) * 3600
            h_end = int(t_end // 3600) * 3600
            cur = h_start
            while cur <= h_end:
                seg = tr.slice(
                    starttime=UTCDateTime(max(t_start, float(cur))),
                    endtime=UTCDateTime(min(t_end, float(cur + 3599.995))),
                ).copy()
                if len(seg.data) > 0:
                    by_hour.setdefault(self._hour_path(float(cur)), []).append(seg)
                cur += 3600

        written_files = 0
        for path, segs in by_hour.items():
            stream = Stream()
            if path.exists():
                with contextlib.suppress(Exception):
                    stream += obspy.read(str(path))
            for seg in segs:
                stream.append(seg)
            # Normalize dtypes before ObsPy merge so existing int32 STEIM2 chunks
            # merge cleanly with float64 ring-buffer snapshots.
            for tr_m in stream:
                tr_m.data = np.asarray(tr_m.data, dtype=np.float64)
            stream.merge(method=1, fill_value=0)
            _write_compressed_mseed(stream, path)
            written_files += 1

        self.prune_old_files()
        return written_files

    def flush_from_ring_buffer(self, ring_buffer: Any, duration_sec: float = 65.0) -> int:
        """Snapshot the last *duration_sec* from *ring_buffer* into hourly MiniSEED files."""
        if ring_buffer is None:
            return 0
        traces: list[Trace] = []
        for ch in getattr(ring_buffer, "channels", RS4D_CHANNELS):
            tr = ring_buffer.get_latest(ch, duration_sec=duration_sec)
            if tr is not None and len(tr.data) > 0:
                traces.append(tr)
        return self.flush_traces(traces)

    def prune_old_files(self, now_ts: float | None = None) -> int:
        """Delete hourly archive files older than ``retention_hours``."""
        now_ref = float(now_ts if now_ts is not None else time.time())
        cutoff_ts = now_ref - self.retention_hours * 3600.0
        removed = 0
        for p in sorted(self.archive_dir.glob("*.mseed")):
            try:
                file_dt = datetime.strptime(p.stem, "%Y%m%d_%H").replace(tzinfo=UTC)
                if file_dt.timestamp() + 3600.0 < cutoff_ts:
                    p.unlink()
                    removed += 1
            except (ValueError, OSError):
                continue
        return removed

    def read_window(
        self,
        start_ts: float,
        end_ts: float,
        *,
        ring_buffer: Any | None = None,
        channels: tuple[str, ...] = ("EHZ",),
    ) -> dict[str, Trace]:
        """Load waveform window [start_ts, end_ts] from RingBuffer or hourly MiniSEED files."""
        result: dict[str, Trace] = {}

        if ring_buffer is not None and hasattr(ring_buffer, "get_time_range"):
            for ch in channels:
                with contextlib.suppress(KeyError):
                    arr, act_start = ring_buffer.get_time_range(ch, start_ts, end_ts)
                    if len(arr) >= 20 and abs(act_start - start_ts) <= 5.0:
                        sr = float(getattr(ring_buffer, "sampling_rate", self.sampling_rate))
                        tr = Trace(
                            data=arr,
                            header={
                                "network": getattr(ring_buffer, "network", "AM"),
                                "station": getattr(ring_buffer, "station", "R1A3D"),
                                "channel": ch,
                                "sampling_rate": sr,
                                "starttime": UTCDateTime(act_start),
                            },
                        )
                        result[ch] = tr

        missing = [ch for ch in channels if ch not in result]
        if not missing:
            return result

        h_start = int(start_ts // 3600) * 3600
        h_end = int(end_ts // 3600) * 3600
        stream = Stream()
        cur = h_start
        while cur <= h_end:
            path = self._hour_path(float(cur))
            if path.exists():
                with contextlib.suppress(Exception):
                    stream += obspy.read(str(path))
            cur += 3600

        if not stream:
            return result

        stream.merge(method=1, fill_value=0)
        sliced = stream.slice(starttime=UTCDateTime(start_ts), endtime=UTCDateTime(end_ts))
        for ch in missing:
            ch_st = sliced.select(channel=ch)
            if ch_st:
                result[ch] = ch_st[0]

        return result

    def get_status(self) -> dict[str, Any]:
        """Return archive file count, total size, and oldest/newest hours."""
        files = sorted(self.archive_dir.glob("*.mseed"))
        total_bytes = sum(p.stat().st_size for p in files if p.is_file())
        return {
            "archive_dir": str(self.archive_dir),
            "retention_hours": self.retention_hours,
            "file_count": len(files),
            "size_mb": round(total_bytes / (1024 * 1024), 2),
            "oldest_file": files[0].name if files else None,
            "newest_file": files[-1].name if files else None,
        }


_archiver: MiniSeedArchiver | None = None


def get_archiver(config: Any | None = None) -> MiniSeedArchiver:
    """Return or initialize the global MiniSeedArchiver singleton."""
    global _archiver
    if _archiver is None:
        from eqengine.config import get_config

        cfg = config or get_config()
        _archiver = MiniSeedArchiver(
            archive_dir=getattr(cfg, "archive_dir", "./data/archive"),
            retention_hours=int(getattr(cfg, "archive_retention_hours", 48)),
            sampling_rate=int(getattr(cfg, "sampling_rate", 100)),
        )
    return _archiver
