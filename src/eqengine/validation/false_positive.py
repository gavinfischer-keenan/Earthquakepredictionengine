"""Multi-parameter event validation to reject false-positive triggers.

Each trigger is subjected to four independent checks (duration, frequency,
envelope shape, noise floor).  **All** checks must pass for the event to be
considered valid.  Detailed per-check results are returned in a
`ValidationResult` so callers can inspect *why* an event was rejected.
"""
from __future__ import annotations

import dataclasses
from typing import TYPE_CHECKING

import numpy as np
import structlog
from scipy.signal import welch

if TYPE_CHECKING:
    import obspy

    from eqengine.validation.noise_model import NoiseModel

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Configuration defaults
# ---------------------------------------------------------------------------
_DEFAULT_MIN_TRIGGER_DURATION_SEC: float = 0.5
_EARTHQUAKE_FREQ_LO: float = 1.0   # Hz
_EARTHQUAKE_FREQ_HI: float = 15.0  # Hz
_ENVELOPE_ONSET_RATIO_MAX: float = 0.8
_NOISE_FLOOR_MIN_FACTOR: float = 3.0
_NOISE_FLOOR_MAX_FACTOR: float = 1000.0


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------
@dataclasses.dataclass(frozen=True, slots=True)
class ValidationResult:
    """Outcome of the false-positive filter battery."""

    passed: bool
    rejection_reason: str | None
    checks: dict[str, bool]


# ---------------------------------------------------------------------------
# Trigger protocol (structural typing for loose coupling)
# ---------------------------------------------------------------------------
class _TriggerLike:
    """Minimal shape expected of a trigger event object."""

    on_time: float      # trigger start as UTC timestamp
    off_time: float     # trigger end as UTC timestamp
    sta_lta_ratio: float


# ---------------------------------------------------------------------------
# Main filter
# ---------------------------------------------------------------------------
class FalsePositiveFilter:
    """Run a battery of physics-informed checks on a candidate trigger.

    Parameters
    ----------
    min_trigger_duration_sec:
        Reject triggers shorter than this many seconds.
    eq_freq_lo / eq_freq_hi:
        Earthquake-band frequency window (Hz).
    envelope_onset_ratio_max:
        Maximum ratio of first-quarter amplitude to peak amplitude allowed
        for a "gradual onset" event.  Impulsive spikes exceed this.
    noise_floor_min_factor / noise_floor_max_factor:
        Amplitude must be between ``min_factor × noise_floor`` and
        ``max_factor × noise_floor`` to pass the noise check.
    """

    def __init__(
        self,
        *,
        min_trigger_duration_sec: float = _DEFAULT_MIN_TRIGGER_DURATION_SEC,
        eq_freq_lo: float = _EARTHQUAKE_FREQ_LO,
        eq_freq_hi: float = _EARTHQUAKE_FREQ_HI,
        envelope_onset_ratio_max: float = _ENVELOPE_ONSET_RATIO_MAX,
        noise_floor_min_factor: float = _NOISE_FLOOR_MIN_FACTOR,
        noise_floor_max_factor: float = _NOISE_FLOOR_MAX_FACTOR,
    ) -> None:
        self.min_trigger_duration_sec = min_trigger_duration_sec
        self.eq_freq_lo = eq_freq_lo
        self.eq_freq_hi = eq_freq_hi
        self.envelope_onset_ratio_max = envelope_onset_ratio_max
        self.noise_floor_min_factor = noise_floor_min_factor
        self.noise_floor_max_factor = noise_floor_max_factor

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def validate(
        self,
        trigger: _TriggerLike,  # duck-typed — any object with the right attrs
        trace: obspy.Trace,
        noise_model: NoiseModel | None = None,
    ) -> ValidationResult:
        """Run all checks and return a consolidated result.

        Parameters
        ----------
        trigger:
            Object carrying ``on_time``, ``off_time``, ``sta_lta_ratio``.
        trace:
            The raw (or minimally filtered) waveform containing the trigger
            window.
        noise_model:
            Optional site noise characterisation.  If ``None`` the noise-floor
            check is automatically passed.

        Returns
        -------
        ValidationResult
        """
        checks: dict[str, bool] = {}

        # 1. Duration ---------------------------------------------------
        checks["duration"] = self._check_duration(trigger)

        # 2. Dominant-frequency -----------------------------------------
        triggered_data = self._extract_segment(trigger, trace)
        checks["frequency"] = self._check_frequency(
            triggered_data, trace.stats.sampling_rate,
        )

        # 3. Envelope / onset shape -------------------------------------
        checks["envelope"] = self._check_envelope(triggered_data)

        # 4. Noise floor ------------------------------------------------
        checks["noise_floor"] = self._check_noise_floor(
            triggered_data, noise_model,
        )

        # Aggregate
        passed = all(checks.values())
        rejection_reason: str | None = None
        if not passed:
            failed = [name for name, ok in checks.items() if not ok]
            rejection_reason = f"failed checks: {', '.join(failed)}"

        log.info(
            "false_positive_filter.result",
            passed=passed,
            checks=checks,
            rejection_reason=rejection_reason,
        )
        return ValidationResult(
            passed=passed,
            rejection_reason=rejection_reason,
            checks=checks,
        )

    # ------------------------------------------------------------------
    # Individual checks
    # ------------------------------------------------------------------
    def _check_duration(self, trigger: _TriggerLike) -> bool:
        duration = trigger.off_time - trigger.on_time
        ok = duration >= self.min_trigger_duration_sec
        log.debug(
            "check.duration",
            duration_s=round(duration, 4),
            min_required=self.min_trigger_duration_sec,
            passed=ok,
        )
        return ok

    def _check_frequency(
        self, data: np.ndarray, sampling_rate: float,
    ) -> bool:
        """Dominant frequency of the triggered segment must be in the EQ band."""
        if len(data) < 4:
            log.debug("check.frequency", passed=False, reason="segment_too_short")
            return False

        freqs, psd = welch(data, fs=sampling_rate, nperseg=min(256, len(data)))
        dominant_freq = float(freqs[np.argmax(psd)])
        ok = self.eq_freq_lo <= dominant_freq <= self.eq_freq_hi
        log.debug(
            "check.frequency",
            dominant_freq_hz=round(dominant_freq, 2),
            band=f"{self.eq_freq_lo}-{self.eq_freq_hi}",
            passed=ok,
        )
        return ok

    def _check_envelope(self, data: np.ndarray) -> bool:
        """Gradual onset — first-quarter amplitude < threshold × peak."""
        abs_data = np.abs(data)
        if len(abs_data) < 4:
            log.debug("check.envelope", passed=False, reason="segment_too_short")
            return False

        quarter = len(abs_data) // 4
        first_quarter_amp = float(np.max(abs_data[:quarter]))
        peak_amp = float(np.max(abs_data))
        if peak_amp == 0:
            log.debug("check.envelope", passed=False, reason="zero_peak")
            return False

        ratio = first_quarter_amp / peak_amp
        ok = ratio < self.envelope_onset_ratio_max
        log.debug(
            "check.envelope",
            first_quarter_amp=round(first_quarter_amp, 4),
            peak_amp=round(peak_amp, 4),
            ratio=round(ratio, 4),
            threshold=self.envelope_onset_ratio_max,
            passed=ok,
        )
        return ok

    def _check_noise_floor(
        self, data: np.ndarray, noise_model: NoiseModel | None,
    ) -> bool:
        """Current amplitude must be 3–1000× the noise floor."""
        if noise_model is None:
            log.debug("check.noise_floor", passed=True, reason="no_noise_model")
            return True

        current_rms = float(np.sqrt(np.mean(data.astype(np.float64) ** 2)))
        floor = noise_model.get_noise_floor()
        if floor <= 0:
            log.debug("check.noise_floor", passed=True, reason="zero_floor")
            return True

        ratio = current_rms / floor
        ok = self.noise_floor_min_factor <= ratio <= self.noise_floor_max_factor
        log.debug(
            "check.noise_floor",
            current_rms=round(current_rms, 2),
            noise_floor=round(floor, 2),
            ratio=round(ratio, 2),
            passed=ok,
        )
        return ok

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _extract_segment(trigger: _TriggerLike, trace: obspy.Trace) -> np.ndarray:
        """Slice the trace data between trigger on/off times."""
        from obspy import UTCDateTime

        t_start = UTCDateTime(trigger.on_time)
        t_end = UTCDateTime(trigger.off_time)
        sliced = trace.slice(starttime=t_start, endtime=t_end)
        return np.asarray(sliced.data, dtype=np.float64)
