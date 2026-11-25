"""Automatic Shake Highlights recorder for earthquakes, Cal touchdowns, and Greek Theatre concerts."""
from __future__ import annotations

import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import structlog

from eqengine.constants import RS4D_CHANNELS

log = structlog.get_logger(__name__)


class HighlightsRecorder:
    """Captures 60-second Notable Moment waveform clips & metadata with category cooldowns."""

    def __init__(
        self,
        highlights_dir: str | Path = "./data/highlights",
        cooldown_sec: float = 180.0,
        sampling_rate: float = 100.0,
    ) -> None:
        self.base_dir = Path(highlights_dir)
        self.clips_dir = self.base_dir / "clips"
        self.index_file = self.base_dir / "highlights.jsonl"
        self.cooldown_sec = float(cooldown_sec)
        self.sampling_rate = float(sampling_rate)

        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.clips_dir.mkdir(parents=True, exist_ok=True)
        self._last_capture_by_cat: dict[str, float] = {}

    def _in_cooldown(self, category: str, now_ts: float) -> bool:
        last = self._last_capture_by_cat.get(category, 0.0)
        return (now_ts - last) < self.cooldown_sec

    def capture_highlight(
        self,
        *,
        category: str,
        title: str,
        subtitle: str,
        channel_data: dict[str, np.ndarray],
        start_time: float,
        end_time: float,
        peak_metric: float = 0.0,
        metric_unit: str = "",
        metadata: dict[str, Any] | None = None,
        force: bool = False,
    ) -> dict[str, Any] | None:
        """Save a compressed 4-channel highlight `.npz` clip and append index JSONL."""
        now_ts = time.time()
        if not force and self._in_cooldown(category, now_ts):
            return None

        ehz = channel_data.get("EHZ")
        if ehz is None or len(ehz) < 32:
            return None

        hl_id = f"hl_{category}_{datetime.now(tz=UTC).strftime('%Y%m%d_%H%M%S')}_{os.urandom(2).hex()}"
        clip_path = self.clips_dir / f"{hl_id}.npz"

        arrays: dict[str, np.ndarray] = {}
        for ch in RS4D_CHANNELS:
            arr = channel_data.get(ch)
            arrays[ch] = np.asarray(arr, dtype=np.float32) if arr is not None else np.zeros(0, dtype=np.float32)

        np.savez_compressed(
            clip_path,
            EHZ=arrays["EHZ"],
            ENZ=arrays["ENZ"],
            ENN=arrays["ENN"],
            ENE=arrays["ENE"],
            sampling_rate=self.sampling_rate,
            start_time=start_time,
            end_time=end_time,
        )

        record: dict[str, Any] = {
            "id": hl_id,
            "category": category,
            "title": title,
            "subtitle": subtitle,
            "timestamp": round(end_time, 2),
            "timestamp_utc": datetime.fromtimestamp(end_time, tz=UTC).isoformat(),
            "start_time": round(start_time, 2),
            "end_time": round(end_time, 2),
            "duration_sec": round(max(0.1, end_time - start_time), 1),
            "sampling_rate": self.sampling_rate,
            "peak_metric": round(float(peak_metric), 3),
            "metric_unit": metric_unit,
            "metadata": metadata or {},
        }

        with open(self.index_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

        self._last_capture_by_cat[category] = now_ts
        log.info("highlights.captured", id=hl_id, category=category, title=title)
        return record

    def _extract_recent_channels(self, ring_buffer: Any, duration_sec: float = 60.0) -> tuple[dict[str, np.ndarray], float, float]:
        channel_data: dict[str, np.ndarray] = {}
        now_ts = time.time()
        start_t = now_ts - duration_sec
        end_t = now_ts
        for ch in RS4D_CHANNELS:
            try:
                tr = ring_buffer.get_latest(ch, duration_sec=duration_sec)
            except KeyError:
                tr = None
            if tr is not None and len(tr.data) > 0:
                channel_data[ch] = np.asarray(tr.data, dtype=np.float32)
                start_t = float(tr.stats.starttime.timestamp)
                end_t = float(tr.stats.endtime.timestamp)
        return channel_data, start_t, end_t

    def evaluate_external_tick(
        self,
        *,
        ring_buffer: Any,
        forensics_metrics: dict[str, Any],
        external_events_manager: Any | None,
        quiet_baseline: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """Auto-capture Cal Touchdown or Greek Theatre highlight if live band spikes > 3x baseline."""
        if ring_buffer is None or external_events_manager is None:
            return None

        live_events = [e for e in external_events_manager.all_events() if e.status == "live"]
        if not live_events:
            return None

        base_stad = float((quiet_baseline or {}).get("stadium_um_s") or 0.15)
        base_conc = float((quiet_baseline or {}).get("concert_um_s") or 0.10)

        stad_val = float(forensics_metrics.get("stadium_um_s", 0.0))
        conc_val = float(forensics_metrics.get("concert_um_s", 0.0))

        for ev in live_events:
            if ev.category == "football" and stad_val >= max(base_stad * 3.0, 0.8):
                ch_data, st, et = self._extract_recent_channels(ring_buffer, 60.0)
                score_detail = ev.metadata.get("status_detail") or "Live Game"
                return self.capture_highlight(
                    category="touchdown",
                    title=f"🏈 {ev.title} Surge",
                    subtitle=f"{score_detail} · {stad_val:.2f} µm/s in 2–5 Hz band",
                    channel_data=ch_data,
                    start_time=st,
                    end_time=et,
                    peak_metric=stad_val,
                    metric_unit="µm/s",
                    metadata=ev.metadata,
                )

            if ev.category == "concert" and conc_val >= max(base_conc * 3.0, 0.6):
                ch_data, st, et = self._extract_recent_channels(ring_buffer, 60.0)
                phase = "Soundcheck" if ev.metadata.get("phase") == "soundcheck" else "Live Set"
                return self.capture_highlight(
                    category="concert",
                    title=f"🎸 {ev.title}",
                    subtitle=f"Greek Theatre {phase} · {conc_val:.2f} µm/s sub-bass (25–45 Hz)",
                    channel_data=ch_data,
                    start_time=st,
                    end_time=et,
                    peak_metric=conc_val,
                    metric_unit="µm/s",
                    metadata=ev.metadata,
                )
        return None

    def capture_earthquake(
        self,
        *,
        ring_buffer: Any,
        title: str,
        magnitude: float | None,
        distance_km: float | None,
        mmi_label: str | None = None,
        mmi_roman: str | None = None,
        witness_verdict: str | None = None,
    ) -> dict[str, Any] | None:
        """Auto-capture a 60s highlight for a confirmed earthquake trigger."""
        if ring_buffer is None:
            return None
        ch_data, st, et = self._extract_recent_channels(ring_buffer, 60.0)
        mag_str = f"M{magnitude:.1f}" if magnitude is not None else "Seismic"
        dist_str = f"{distance_km:.0f} km" if distance_km is not None else "Local"
        mmi_str = f" · MMI {mmi_roman} ({mmi_label})" if mmi_roman else ""
        wit_str = f" · {witness_verdict}" if witness_verdict else ""
        return self.capture_highlight(
            category="earthquake",
            title=f"⚡ {mag_str} — {title}",
            subtitle=f"{dist_str}{mmi_str}{wit_str}",
            channel_data=ch_data,
            start_time=st,
            end_time=et,
            peak_metric=float(magnitude or 0.0),
            metric_unit="M",
            metadata={
                "magnitude": magnitude,
                "distance_km": distance_km,
                "mmi_roman": mmi_roman,
                "mmi_label": mmi_label,
                "witness_verdict": witness_verdict,
            },
        )

    def list_highlights(self, limit: int = 30) -> list[dict[str, Any]]:
        """Return newest highlights from index file."""
        if not self.index_file.exists():
            return []
        items: list[dict[str, Any]] = []
        try:
            with open(self.index_file, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        items.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        except OSError:
            return []
        return list(reversed(items[-limit:]))

    def get_highlight_clip(self, highlight_id: str, max_points: int = 1200) -> dict[str, Any] | None:
        """Load clip metadata and EHZ waveform samples for instant modal playback."""
        clip_path = self.clips_dir / f"{highlight_id}.npz"
        if not clip_path.exists():
            return None

        meta: dict[str, Any] = {}
        if self.index_file.exists():
            with open(self.index_file, encoding="utf-8") as f:
                for line in f:
                    if highlight_id in line:
                        try:
                            meta = json.loads(line.strip())
                            break
                        except json.JSONDecodeError:
                            pass

        try:
            with np.load(clip_path) as data:
                ehz = np.asarray(data["EHZ"], dtype=np.float64) if "EHZ" in data else np.zeros(0)
                sr = float(meta.get("sampling_rate", self.sampling_rate))
                start_t = float(meta.get("start_time", 0.0))
                if ehz.size > 0:
                    ehz_c = ehz - float(np.mean(ehz))
                    step = max(1, len(ehz_c) // max_points)
                    samples = np.round(ehz_c[::step], 2).tolist()
                    times = [round(start_t + (i * step) / sr, 3) for i in range(len(samples))]
                else:
                    samples = []
                    times = []
                return {
                    **meta,
                    "id": highlight_id,
                    "samples": samples,
                    "times": times,
                }
        except OSError:
            return None


_recorder: HighlightsRecorder | None = None


def get_highlights_recorder(config: Any | None = None) -> HighlightsRecorder:
    """Return or initialize the global HighlightsRecorder singleton."""
    global _recorder
    if _recorder is None:
        from eqengine.config import get_config

        cfg = config or get_config()
        _recorder = HighlightsRecorder(
            highlights_dir=getattr(cfg, "highlights_dir", "./data/highlights"),
            cooldown_sec=float(getattr(cfg, "highlights_cooldown_sec", 180.0)),
            sampling_rate=float(getattr(cfg, "sampling_rate", 100.0)),
        )
    return _recorder
