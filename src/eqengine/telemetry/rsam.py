"""Real-time Seismic Amplitude Measurement (RSAM).

RSAM is the standard volcanic / seismic monitoring metric: the RMS amplitude
of the raw waveform computed over fixed intervals (typically 1 minute).  A
sustained increase in RSAM flags elevated background seismicity.

The calculator maintains a rolling history of the last 60 values (1 hour at
the default 1-minute cadence) for trend analysis.
"""
from __future__ import annotations

from collections import deque

import numpy as np
import structlog

log = structlog.get_logger(__name__)

_DEFAULT_INTERVAL_SEC: float = 60.0
_DEFAULT_HISTORY_LEN: int = 60  # 1 hour at 1-minute intervals


class RSAMCalculator:
    """Compute and track RSAM (RMS amplitude) over fixed intervals.

    Parameters
    ----------
    interval_sec:
        Nominal RSAM window length in seconds.  This is informational — the
        actual window is determined by the data array passed to :meth:`compute`.
    history_len:
        Number of past RSAM values to retain.
    """

    def __init__(
        self,
        *,
        interval_sec: float = _DEFAULT_INTERVAL_SEC,
        history_len: int = _DEFAULT_HISTORY_LEN,
    ) -> None:
        self.interval_sec = interval_sec
        self._history: deque[float] = deque(maxlen=history_len)
        self._current: float = 0.0

    # ------------------------------------------------------------------
    # Computation
    # ------------------------------------------------------------------
    def compute(self, data: np.ndarray) -> float:
        """Compute the RMS amplitude of *data* and push to history.

        Parameters
        ----------
        data:
            1-D array of waveform samples (raw counts or physical units).

        Returns
        -------
        float
            RMS amplitude.
        """
        if len(data) == 0:
            return 0.0

        rms = float(np.sqrt(np.mean(np.asarray(data, dtype=np.float64) ** 2)))
        self._current = rms
        self._history.append(rms)

        log.debug("rsam.computed", rms=round(rms, 2), history_len=len(self._history))
        return rms

    # ------------------------------------------------------------------
    # Accessors
    # ------------------------------------------------------------------
    def get_current_rsam(self) -> float:
        """Return the most recently computed RSAM value."""
        return self._current

    @property
    def history(self) -> list[float]:
        """Return a copy of the RSAM history (oldest → newest)."""
        return list(self._history)

    @property
    def mean_rsam(self) -> float:
        """Mean RSAM over the retained history window."""
        if not self._history:
            return 0.0
        return float(np.mean(self._history))
