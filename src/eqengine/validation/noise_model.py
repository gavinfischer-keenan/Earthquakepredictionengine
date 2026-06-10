"""Site noise characterisation model.

Captures baseline seismic noise statistics (RMS, spectral density, 95th-
percentile amplitude) so downstream components can judge whether a new
signal is anomalous.  Supports JSON serialisation for persistence between
engine restarts.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import structlog
from scipy.signal import welch

log = structlog.get_logger(__name__)


class NoiseModel:
    """Compact representation of site background noise.

    Parameters
    ----------
    baseline_rms:
        RMS amplitude of the calibration window (counts).
    baseline_spectrum:
        One-sided power spectral density estimate.
    frequency_axis:
        Frequency values corresponding to *baseline_spectrum* (Hz).
    percentile_95:
        95th-percentile absolute amplitude of the calibration window.
    computed_at:
        When this model was computed.
    """

    __slots__ = (
        "baseline_rms",
        "baseline_spectrum",
        "frequency_axis",
        "percentile_95",
        "computed_at",
    )

    def __init__(
        self,
        *,
        baseline_rms: float,
        baseline_spectrum: np.ndarray,
        frequency_axis: np.ndarray,
        percentile_95: float,
        computed_at: datetime,
    ) -> None:
        self.baseline_rms = baseline_rms
        self.baseline_spectrum = np.asarray(baseline_spectrum, dtype=np.float64)
        self.frequency_axis = np.asarray(frequency_axis, dtype=np.float64)
        self.percentile_95 = percentile_95
        self.computed_at = computed_at

    # ------------------------------------------------------------------
    # Construction helpers
    # ------------------------------------------------------------------
    @classmethod
    def from_trace(cls, trace: "obspy.Trace") -> NoiseModel:  # noqa: F821
        """Build a noise model from a quiet-period ObsPy ``Trace``.

        The caller is responsible for selecting a window known to be free of
        seismic events — typically several minutes of background noise.

        Parameters
        ----------
        trace:
            Waveform to characterise.  Should contain ≥ several seconds of
            data at the native sampling rate.
        """
        data = np.asarray(trace.data, dtype=np.float64)
        rms = float(np.sqrt(np.mean(data ** 2)))
        p95 = float(np.percentile(np.abs(data), 95))

        nperseg = min(256, len(data))
        freqs, psd = welch(data, fs=trace.stats.sampling_rate, nperseg=nperseg)

        model = cls(
            baseline_rms=rms,
            baseline_spectrum=psd,
            frequency_axis=freqs,
            percentile_95=p95,
            computed_at=datetime.now(tz=timezone.utc),
        )
        log.info(
            "noise_model.computed",
            rms=round(rms, 4),
            p95=round(p95, 4),
            spectrum_len=len(psd),
        )
        return model

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------
    def save(self, path: str) -> None:
        """Serialise to JSON (numpy arrays → lists)."""
        payload = {
            "baseline_rms": self.baseline_rms,
            "baseline_spectrum": self.baseline_spectrum.tolist(),
            "frequency_axis": self.frequency_axis.tolist(),
            "percentile_95": self.percentile_95,
            "computed_at": self.computed_at.isoformat(),
        }
        out = Path(path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        log.info("noise_model.saved", path=str(out))

    @classmethod
    def load(cls, path: str) -> NoiseModel:
        """Deserialise from JSON."""
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        model = cls(
            baseline_rms=float(raw["baseline_rms"]),
            baseline_spectrum=np.asarray(raw["baseline_spectrum"], dtype=np.float64),
            frequency_axis=np.asarray(raw["frequency_axis"], dtype=np.float64),
            percentile_95=float(raw["percentile_95"]),
            computed_at=datetime.fromisoformat(raw["computed_at"]),
        )
        log.info("noise_model.loaded", path=path, rms=round(model.baseline_rms, 4))
        return model

    # ------------------------------------------------------------------
    # Query API
    # ------------------------------------------------------------------
    def is_noisy(self, current_rms: float) -> bool:
        """Return ``True`` if *current_rms* exceeds 3× the baseline."""
        return current_rms > 3.0 * self.baseline_rms

    def get_noise_floor(self) -> float:
        """Return the baseline RMS used as the site noise floor."""
        return self.baseline_rms

    # ------------------------------------------------------------------
    # Dunder helpers
    # ------------------------------------------------------------------
    def __repr__(self) -> str:
        return (
            f"NoiseModel(rms={self.baseline_rms:.2f}, "
            f"p95={self.percentile_95:.2f}, "
            f"computed_at={self.computed_at.isoformat()})"
        )
