"""Production-grade ML dataset logger and event annotation engine.

Builds structured, analysis-ready datasets (JSONL + NPZ arrays) suitable for feeding
into PyTorch, TensorFlow, Scikit-Learn, and automated seismic/acoustic event classification pipelines.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import obspy
import structlog

log = structlog.get_logger(__name__)

# RS4D Physical Calibration Constants
COUNTS_TO_ACCEL = 1.9e-6  # 1 count ≈ 1.9 µm/s² for RS4D accelerometers (ENZ, ENN, ENE)
COUNTS_TO_VELOCITY = 0.05e-6  # 1 count ≈ 0.05 µm/s for EHZ 4.5 Hz geophone


def compute_spectral_features(
    data: np.ndarray, sampling_rate: float = 100.0
) -> dict[str, float]:
    """Extract standard geophysical and vibration spectral features from a 1D signal."""
    if len(data) < 32:
        return {
            "dominant_freq_hz": 0.0,
            "spectral_centroid_hz": 0.0,
            "low_band_power": 0.0,
            "high_band_power": 0.0,
            "spectral_ratio": 1.0,
        }

    # Demean and Hanning window
    demeaned = data - np.mean(data)
    windowed = demeaned * np.hanning(len(demeaned))

    # Real FFT
    fft_vals = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(len(windowed), d=1.0 / sampling_rate)

    # Dominant frequency
    dom_idx = int(np.argmax(fft_vals))
    dominant_freq = float(freqs[dom_idx]) if len(freqs) > dom_idx else 0.0

    # Spectral centroid: sum(f * A) / sum(A)
    total_amp = float(np.sum(fft_vals))
    centroid = float(np.sum(freqs * fft_vals) / total_amp) if total_amp > 1e-9 else 0.0

    # Low band (1–5 Hz) power vs High band (15–45 Hz) power
    low_mask = (freqs >= 1.0) & (freqs <= 5.0)
    high_mask = (freqs >= 15.0) & (freqs <= 45.0)

    low_power = float(np.sum(fft_vals[low_mask] ** 2))
    high_power = float(np.sum(fft_vals[high_mask] ** 2))
    ratio = float(low_power / (high_power + 1e-9))

    return {
        "dominant_freq_hz": round(dominant_freq, 2),
        "spectral_centroid_hz": round(centroid, 2),
        "low_band_power": round(low_power, 2),
        "high_band_power": round(high_power, 2),
        "spectral_ratio": round(ratio, 3),
    }


def compute_polarization_features(
    enz: np.ndarray, enn: np.ndarray, ene: np.ndarray
) -> dict[str, float]:
    """Compute 3D particle motion hodogram polarization (azimuth & rectilinearity)."""
    min_len = min(len(enz), len(enn), len(ene))
    if min_len < 16:
        return {"apparent_azimuth_deg": 0.0, "rectilinearity": 0.0}

    z = enz[:min_len] - np.mean(enz[:min_len])
    n = enn[:min_len] - np.mean(enn[:min_len])
    e = ene[:min_len] - np.mean(ene[:min_len])

    # Covariance matrix for 3D motion
    matrix = np.cov(np.vstack([z, n, e]))
    try:
        eigenvals, eigenvecs = np.linalg.eigh(matrix)
        # Sort descending
        idx = np.argsort(eigenvals)[::-1]
        l1, l2, l3 = eigenvals[idx[0]], eigenvals[idx[1]], eigenvals[idx[2]]
        principal_vec = eigenvecs[:, idx[0]]

        # Rectilinearity: 1 - (l2 + l3) / (2 * l1)
        rect = float(1.0 - (l2 + l3) / (2.0 * max(l1, 1e-9)))
        rect = max(0.0, min(1.0, rect))

        # Horizontal azimuth from principal eigenvector [z, n, e]
        # azimuth = atan2(e, n) in degrees
        azimuth_deg = float(np.degrees(np.arctan2(principal_vec[2], principal_vec[1]))) % 360.0

        return {
            "apparent_azimuth_deg": round(azimuth_deg, 1),
            "rectilinearity": round(rect, 3),
        }
    except Exception:
        return {"apparent_azimuth_deg": 0.0, "rectilinearity": 0.0}


class DatasetLogger:
    """Thread-safe dataset builder and event annotator for ML models."""

    def __init__(self, data_dir: str | Path | None = None) -> None:
        if data_dir is None:
            # Default paths: /opt/berkeley/data/ml_dataset or local repo
            if Path("/opt/berkeley/data").exists():
                self.base_dir = Path("/opt/berkeley/data/ml_dataset")
            else:
                self.base_dir = Path("data/ml_dataset")
        else:
            self.base_dir = Path(data_dir)

        self.snippets_dir = self.base_dir / "snippets"
        self.events_file = self.base_dir / "events.jsonl"
        self.annotations_file = self.base_dir / "annotations.jsonl"
        self.telemetry_file = self.base_dir / "telemetry_1min.jsonl"

        self._lock = asyncio.Lock()
        self._ensure_dirs()

    def _ensure_dirs(self) -> None:
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.snippets_dir.mkdir(parents=True, exist_ok=True)

    async def log_annotated_event(
        self,
        label: str,
        start_time: float,
        end_time: float,
        channel_data: dict[str, list[float] | np.ndarray],
        category: str = "custom",
        annotator: str = "user_gavin",
        notes: str = "",
        confidence: float = 1.0,
        sampling_rate: float = 100.0,
    ) -> dict[str, Any]:
        """Capture a multi-channel waveform snippet, compute features, and save to ML dataset."""
        event_id = f"evt_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}_{os.urandom(3).hex()}"
        iso_utc = datetime.fromtimestamp(start_time, tz=timezone.utc).isoformat()
        duration_sec = max(end_time - start_time, 0.1)

        # 1. Format numpy arrays for each channel
        arrays: dict[str, np.ndarray] = {}
        for ch in ("EHZ", "ENZ", "ENN", "ENE"):
            raw = channel_data.get(ch, [])
            if isinstance(raw, np.ndarray):
                arrays[ch] = raw.astype(np.float32)
            else:
                arrays[ch] = np.array(raw, dtype=np.float32)

        # 2. Extract Physical & Spectral Features
        ehz_arr = arrays.get("EHZ", np.array([], dtype=np.float32))
        enz_arr = arrays.get("ENZ", np.array([], dtype=np.float32))
        enn_arr = arrays.get("ENN", np.array([], dtype=np.float32))
        ene_arr = arrays.get("ENE", np.array([], dtype=np.float32))

        # Peak amplitudes
        pk_ehz_counts = float(np.max(np.abs(ehz_arr))) if len(ehz_arr) > 0 else 0.0
        pga_enz = float(np.max(np.abs(enz_arr)) * COUNTS_TO_ACCEL) if len(enz_arr) > 0 else 0.0
        pga_enn = float(np.max(np.abs(enn_arr)) * COUNTS_TO_ACCEL) if len(enn_arr) > 0 else 0.0
        pga_ene = float(np.max(np.abs(ene_arr)) * COUNTS_TO_ACCEL) if len(ene_arr) > 0 else 0.0
        pga_resultant = math.sqrt(pga_enz**2 + pga_enn**2 + pga_ene**2)

        # RSAM on EHZ (average absolute amplitude)
        rsam = float(np.mean(np.abs(ehz_arr - np.mean(ehz_arr)))) if len(ehz_arr) > 0 else 0.0

        # Spectral analysis on geophone EHZ
        spec_ehz = compute_spectral_features(ehz_arr, sampling_rate=sampling_rate)

        # 3D Polarization analysis on accelerometers
        pol = compute_polarization_features(enz_arr, enn_arr, ene_arr)

        # 3. Save raw 4-channel tensor to compressed NPZ
        snippet_filename = f"{event_id}.npz"
        snippet_path = self.snippets_dir / snippet_filename
        np.savez_compressed(
            snippet_path,
            EHZ=ehz_arr,
            ENZ=enz_arr,
            ENN=enn_arr,
            ENE=ene_arr,
            sampling_rate=sampling_rate,
            start_time=start_time,
            end_time=end_time,
            label=label,
        )

        # 4. Construct ML Record
        record: dict[str, Any] = {
            "event_id": event_id,
            "timestamp_utc": iso_utc,
            "start_time": start_time,
            "end_time": end_time,
            "duration_sec": round(duration_sec, 2),
            "label": label,
            "category": category,
            "annotator": annotator,
            "notes": notes,
            "confidence": confidence,
            "sampling_rate": sampling_rate,
            "channels": ["EHZ", "ENZ", "ENN", "ENE"],
            "snippet_file": str(snippet_filename),
            "sample_counts": {ch: len(arr) for ch, arr in arrays.items()},
            "features": {
                "pga_enz_m_s2": round(pga_enz, 6),
                "pga_enn_m_s2": round(pga_enn, 6),
                "pga_ene_m_s2": round(pga_ene, 6),
                "pga_resultant_m_s2": round(pga_resultant, 6),
                "peak_velocity_counts": round(pk_ehz_counts, 1),
                "rsam": round(rsam, 2),
                "dominant_freq_hz": spec_ehz["dominant_freq_hz"],
                "spectral_centroid_hz": spec_ehz["spectral_centroid_hz"],
                "spectral_ratio": spec_ehz["spectral_ratio"],
                "apparent_azimuth_deg": pol["apparent_azimuth_deg"],
                "rectilinearity": pol["rectilinearity"],
            },
        }

        # 5. Append to events.jsonl and annotations.jsonl (thread-safe)
        async with self._lock:
            with open(self.events_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")

            annotation_record = {
                "event_id": event_id,
                "timestamp_utc": iso_utc,
                "label": label,
                "category": category,
                "annotator": annotator,
                "notes": notes,
                "confidence": confidence,
                "snippet_file": str(snippet_filename),
            }
            with open(self.annotations_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(annotation_record) + "\n")

        log.info(
            "dataset_logger.event_recorded",
            event_id=event_id,
            label=label,
            category=category,
            duration_sec=duration_sec,
            pga=record["features"]["pga_resultant_m_s2"],
            centroid=record["features"]["spectral_centroid_hz"],
        )

        return record

    async def log_1min_telemetry(
        self,
        timestamp: float,
        rsam: float,
        noise_floor: float,
        pga_resultant: float,
        spectral_centroid: float,
    ) -> None:
        """Append continuous 1-minute environmental baseline telemetry for time-series ML models."""
        iso_utc = datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()
        entry = {
            "timestamp_utc": iso_utc,
            "timestamp": timestamp,
            "rsam": round(rsam, 2),
            "noise_floor": round(noise_floor, 2),
            "pga_resultant_m_s2": round(pga_resultant, 6),
            "spectral_centroid_hz": round(spectral_centroid, 2),
        }
        async with self._lock:
            with open(self.telemetry_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")

    def get_recent_events(self, limit: int = 100) -> list[dict[str, Any]]:
        """Read recently logged events for web dashboard display."""
        if not self.events_file.exists():
            return []

        events: list[dict[str, Any]] = []
        try:
            with open(self.events_file, "r", encoding="utf-8") as f:
                lines = f.readlines()
                for line in lines[-limit:]:
                    line = line.strip()
                    if line:
                        events.append(json.loads(line))
        except Exception:
            log.exception("dataset_logger.read_failed")

        return list(reversed(events))

    def get_dataset_summary(self) -> dict[str, Any]:
        """Return dataset statistics, class distributions, and disk usage."""
        event_count = 0
        class_distribution: dict[str, int] = {}
        category_distribution: dict[str, int] = {}

        if self.events_file.exists():
            with open(self.events_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            rec = json.loads(line)
                            event_count += 1
                            lbl = rec.get("label", "unknown")
                            cat = rec.get("category", "unknown")
                            class_distribution[lbl] = class_distribution.get(lbl, 0) + 1
                            category_distribution[cat] = category_distribution.get(cat, 0) + 1
                        except Exception:
                            pass

        # Calculate directory disk size
        total_bytes = 0
        if self.base_dir.exists():
            for p in self.base_dir.rglob("*"):
                if p.is_file():
                    total_bytes += p.stat().st_size

        return {
            "dataset_directory": str(self.base_dir),
            "total_annotated_events": event_count,
            "class_distribution": class_distribution,
            "category_distribution": category_distribution,
            "disk_size_mb": round(total_bytes / (1024 * 1024), 2),
            "events_file": str(self.events_file),
            "annotations_file": str(self.annotations_file),
            "telemetry_file": str(self.telemetry_file),
        }


# ---------------------------------------------------------------------------
# Global singleton
# ---------------------------------------------------------------------------
_dataset_logger: DatasetLogger | None = None


def get_dataset_logger() -> DatasetLogger:
    """Return or initialize the global DatasetLogger singleton."""
    global _dataset_logger
    if _dataset_logger is None:
        _dataset_logger = DatasetLogger()
    return _dataset_logger
