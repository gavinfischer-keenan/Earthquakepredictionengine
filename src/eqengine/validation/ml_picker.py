"""ML-based P-wave validation using SeisBench (Phase 2 stub).

This module provides an optional PhaseNet/EQTransformer integration via
the `SeisBench <https://github.com/seisbench/seisbench>`_ library.  If
SeisBench and PyTorch are not installed the picker gracefully degrades:
:pymethod:`is_available` returns ``False`` and :pymethod:`validate_p_wave`
returns ``None``.
"""
from __future__ import annotations

import dataclasses
from typing import TYPE_CHECKING

import structlog

if TYPE_CHECKING:
    import obspy
    from obspy import UTCDateTime

log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------
@dataclasses.dataclass(frozen=True, slots=True)
class MLPickResult:
    """Result of ML-based P-wave classification."""

    p_probability: float
    """Probability assigned to the P-phase pick (0–1)."""

    p_time: UTCDateTime | None
    """Estimated P-wave arrival time, or ``None`` if below threshold."""

    model_name: str
    """Name of the SeisBench model that produced this result."""


# ---------------------------------------------------------------------------
# Picker
# ---------------------------------------------------------------------------
class MLPicker:
    """Thin wrapper around SeisBench phase-picking models.

    Parameters
    ----------
    model_name:
        SeisBench model identifier, e.g. ``"PhaseNet"`` or ``"EQTransformer"``.
    p_threshold:
        Minimum P-phase probability to consider a valid pick.
    """

    def __init__(
        self,
        model_name: str = "PhaseNet",
        p_threshold: float = 0.3,
    ) -> None:
        self.model_name = model_name
        self.p_threshold = p_threshold
        self._model: object | None = None  # lazily loaded

    # ------------------------------------------------------------------
    # Availability
    # ------------------------------------------------------------------
    @staticmethod
    def is_available() -> bool:
        """Return ``True`` only if both *seisbench* and *torch* are importable."""
        try:
            import seisbench  # noqa: F401
            import torch  # noqa: F401
        except ImportError:
            return False
        return True

    # ------------------------------------------------------------------
    # Model loading
    # ------------------------------------------------------------------
    def load_model(self) -> None:
        """Load the SeisBench model into memory (deferred import).

        Raises
        ------
        RuntimeError
            If SeisBench / PyTorch are not installed.
        """
        if not self.is_available():
            raise RuntimeError(
                "seisbench and/or torch are not installed — "
                "ML picker is unavailable"
            )

        import seisbench.models as sbm  # deferred

        model_cls = getattr(sbm, self.model_name, None)
        if model_cls is None:
            raise ValueError(
                f"Unknown SeisBench model: {self.model_name!r}"
            )

        self._model = model_cls.from_pretrained("original")
        log.info("ml_picker.model_loaded", model=self.model_name)

    # ------------------------------------------------------------------
    # Prediction
    # ------------------------------------------------------------------
    def validate_p_wave(
        self,
        stream: obspy.Stream,
        trigger_time: UTCDateTime,
    ) -> MLPickResult | None:
        """Classify a waveform window around *trigger_time*.

        Parameters
        ----------
        stream:
            3-component (or single-channel) ``obspy.Stream`` containing the
            trigger window.
        trigger_time:
            The STA/LTA trigger onset time — used to centre the analysis
            window.

        Returns
        -------
        MLPickResult | None
            ``None`` when SeisBench is not installed or the model has not been
            loaded.
        """
        if not self.is_available() or self._model is None:
            log.debug("ml_picker.skip", reason="model_not_loaded")
            return None

        from obspy import UTCDateTime as _UTC

        # Cut a 30-second window centred on the trigger
        window_half = 15.0  # seconds
        t_start = trigger_time - window_half
        t_end = trigger_time + window_half
        windowed = stream.slice(starttime=t_start, endtime=t_end).copy()

        if not windowed:
            log.warning("ml_picker.empty_window", trigger_time=str(trigger_time))
            return None

        # Run classification
        try:
            annotations = self._model.classify(windowed)  # type: ignore[union-attr]
        except Exception:
            log.exception("ml_picker.classify_failed")
            return None

        # Extract best P pick
        best_p_prob = 0.0
        best_p_time: _UTC | None = None

        for pick in annotations:
            if getattr(pick, "phase", "") == "P":
                prob = getattr(pick, "peak_value", 0.0)
                if prob > best_p_prob:
                    best_p_prob = prob
                    best_p_time = getattr(pick, "peak_time", None)

        result = MLPickResult(
            p_probability=best_p_prob,
            p_time=best_p_time if best_p_prob >= self.p_threshold else None,
            model_name=self.model_name,
        )

        log.info(
            "ml_picker.result",
            p_probability=round(result.p_probability, 4),
            p_time=str(result.p_time),
            model=result.model_name,
            accepted=best_p_prob >= self.p_threshold,
        )
        return result
