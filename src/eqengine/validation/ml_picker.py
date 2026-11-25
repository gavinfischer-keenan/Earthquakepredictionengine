"""ML-based P/S-wave validation supporting lightweight ONNX PhaseNet or SeisBench.

Gracefully degrades when neither ``onnxruntime`` (with a PhaseNet ``.onnx``
model) nor ``seisbench`` + ``torch`` is available: :pymethod:`is_available`
returns ``False`` and :pymethod:`validate_p_wave` returns ``None``.
"""
from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import structlog

if TYPE_CHECKING:
    import obspy
    from obspy import UTCDateTime

log = structlog.get_logger(__name__)

_PHASENET_SAMPLES: int = 3001  # Standard 30s @ 100 Hz PhaseNet tensor length


@dataclasses.dataclass(frozen=True, slots=True)
class MLPickResult:
    """Result of ML-based P/S-wave classification."""

    p_probability: float
    p_time: UTCDateTime | None
    model_name: str
    s_probability: float = 0.0
    s_time: UTCDateTime | None = None
    backend: str = "seisbench"


class MLPicker:
    """Wrapper supporting lightweight ONNX PhaseNet and SeisBench PyTorch models."""

    def __init__(
        self,
        model_name: str = "PhaseNet",
        p_threshold: float = 0.3,
        s_threshold: float = 0.3,
        backend: str = "auto",
        onnx_model_path: str | Path | None = None,
    ) -> None:
        self.model_name = model_name
        self.p_threshold = p_threshold
        self.s_threshold = s_threshold
        self.backend = backend.lower()
        self.onnx_model_path = (
            Path(onnx_model_path)
            if onnx_model_path is not None
            else Path("./data/models/phasenet.onnx")
        )
        self._model: Any = None
        self._onnx_session: Any = None
        self._loaded_backend: str | None = None

    @staticmethod
    def is_seisbench_available() -> bool:
        """Return ``True`` if both *seisbench* and *torch* are importable."""
        try:
            import seisbench  # noqa: F401
            import torch  # noqa: F401
        except ImportError:
            return False
        return True

    def is_onnx_available(self) -> bool:
        """Return ``True`` if *onnxruntime* is importable and the ONNX file exists."""
        try:
            import onnxruntime  # noqa: F401
        except ImportError:
            return False
        return self.onnx_model_path.exists()

    def is_available(self) -> bool:
        """Return ``True`` if at least one ML picking backend is ready."""
        if self.backend == "onnx":
            return self.is_onnx_available()
        if self.backend == "seisbench":
            return self.is_seisbench_available()
        return self.is_onnx_available() or self.is_seisbench_available()

    @property
    def active_backend(self) -> str:
        """Return currently active backend ('onnx', 'seisbench', or 'heuristic')."""
        return self._loaded_backend or "heuristic"

    @property
    def picker_label(self) -> str:
        """Human-readable label describing the active PhaseNet mode."""
        if self._loaded_backend == "onnx":
            return "PhaseNet ONNX AI"
        if self._loaded_backend == "seisbench":
            return f"SeisBench {self.model_name} AI"
        return "Z/H Polarization Heuristic"

    def load_model(self) -> None:
        """Load the configured ONNX or SeisBench model into memory."""
        if not self.is_available():
            raise RuntimeError(
                "Neither onnxruntime (with model file) nor seisbench/torch is available."
            )

        if self.backend in ("auto", "onnx") and self.is_onnx_available():
            import onnxruntime as ort

            self._onnx_session = ort.InferenceSession(
                str(self.onnx_model_path),
                providers=["CPUExecutionProvider"],
            )
            self._loaded_backend = "onnx"
            log.info("ml_picker.onnx_loaded", path=str(self.onnx_model_path))
            return

        if self.backend in ("auto", "seisbench") and self.is_seisbench_available():
            import seisbench.models as sbm

            model_cls = getattr(sbm, self.model_name, None)
            if model_cls is None:
                raise ValueError(f"Unknown SeisBench model: {self.model_name!r}")
            self._model = model_cls.from_pretrained("original")
            self._loaded_backend = "seisbench"
            log.info("ml_picker.model_loaded", model=self.model_name)
            return

        raise RuntimeError(f"Requested ML backend {self.backend!r} is unavailable.")

    def _prepare_onnx_tensor(self, stream: obspy.Stream) -> tuple[np.ndarray, UTCDateTime, float]:
        """Build demeaned/normalized (1, 3, 3001) float32 tensor [E, N, Z] from *stream*."""
        sr = float(stream[0].stats.sampling_rate or 100.0)
        start_time = min(tr.stats.starttime for tr in stream)

        by_comp: dict[str, np.ndarray] = {}
        fallback: np.ndarray | None = None
        for tr in stream:
            arr = np.asarray(tr.data, dtype=np.float32)
            ch = tr.stats.channel.upper()
            if fallback is None:
                fallback = arr
            if ch.endswith("E"):
                by_comp["E"] = arr
            elif ch.endswith("N"):
                by_comp["N"] = arr
            elif ch.endswith("Z"):
                by_comp["Z"] = arr

        base = fallback if fallback is not None else np.zeros(_PHASENET_SAMPLES, dtype=np.float32)
        tensor = np.zeros((1, 3, _PHASENET_SAMPLES), dtype=np.float32)
        for idx, comp in enumerate(("E", "N", "Z")):
            src = by_comp.get(comp, base)
            n = min(len(src), _PHASENET_SAMPLES)
            if n > 0:
                seg = src[:n].astype(np.float32)
                seg = seg - float(np.mean(seg))
                std = float(np.std(seg))
                if std > 1e-6:
                    seg = seg / std
                tensor[0, idx, :n] = seg
        return tensor, start_time, sr

    def _classify_onnx(self, stream: obspy.Stream) -> MLPickResult | None:
        if self._onnx_session is None or not stream:
            return None

        tensor, t0, sr = self._prepare_onnx_tensor(stream)
        input_name = self._onnx_session.get_inputs()[0].name
        outputs = self._onnx_session.run(None, {input_name: tensor})
        probs = np.asarray(outputs[0], dtype=np.float32)
        # Expected shape: (1, 3, N) -> channels [Noise, P, S]
        if probs.ndim != 3 or probs.shape[1] < 3:
            log.warning("ml_picker.onnx_unexpected_shape", shape=probs.shape)
            return None

        p_curve = probs[0, 1]
        s_curve = probs[0, 2]
        p_idx = int(np.argmax(p_curve))
        s_idx = int(np.argmax(s_curve))
        best_p = float(p_curve[p_idx])
        best_s = float(s_curve[s_idx])

        return MLPickResult(
            p_probability=best_p,
            p_time=(t0 + p_idx / sr) if best_p >= self.p_threshold else None,
            s_probability=best_s,
            s_time=(t0 + s_idx / sr) if best_s >= self.s_threshold else None,
            model_name=f"{self.model_name}-ONNX",
            backend="onnx",
        )

    def validate_p_wave(
        self,
        stream: obspy.Stream,
        trigger_time: UTCDateTime,
    ) -> MLPickResult | None:
        """Classify a 30-second waveform window around *trigger_time*."""
        if self._onnx_session is None and self._model is None:
            log.debug("ml_picker.skip", reason="model_not_loaded")
            return None

        t_start = trigger_time - 15.0
        t_end = trigger_time + 15.0
        windowed = stream.slice(starttime=t_start, endtime=t_end).copy()
        if not windowed:
            log.warning("ml_picker.empty_window", trigger_time=str(trigger_time))
            return None

        if self._onnx_session is not None:
            try:
                res = self._classify_onnx(windowed)
                if res is not None:
                    log.info(
                        "ml_picker.result",
                        backend="onnx",
                        p_probability=round(res.p_probability, 4),
                        s_probability=round(res.s_probability, 4),
                    )
                return res
            except Exception:
                log.exception("ml_picker.onnx_classify_failed")
                return None

        try:
            annotations = self._model.classify(windowed)
        except Exception:
            log.exception("ml_picker.classify_failed")
            return None

        best_p_prob = 0.0
        best_p_time: UTCDateTime | None = None
        best_s_prob = 0.0
        best_s_time: UTCDateTime | None = None

        for pick in annotations:
            phase = getattr(pick, "phase", "")
            prob = float(getattr(pick, "peak_value", 0.0))
            ptime = getattr(pick, "peak_time", None)
            if phase == "P" and prob > best_p_prob:
                best_p_prob = prob
                best_p_time = ptime
            elif phase == "S" and prob > best_s_prob:
                best_s_prob = prob
                best_s_time = ptime

        result = MLPickResult(
            p_probability=best_p_prob,
            p_time=best_p_time if best_p_prob >= self.p_threshold else None,
            s_probability=best_s_prob,
            s_time=best_s_time if best_s_prob >= self.s_threshold else None,
            model_name=self.model_name,
            backend="seisbench",
        )
        log.info(
            "ml_picker.result",
            backend="seisbench",
            p_probability=round(result.p_probability, 4),
            s_probability=round(result.s_probability, 4),
            accepted=best_p_prob >= self.p_threshold,
        )
        return result
