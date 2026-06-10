"""Recursive STA/LTA trigger-detection engine for Raspberry Shake RS4D.

Wraps ObsPy's ``recursive_sta_lta`` and ``trigger_onset`` into a stateful
:class:`Detector` that emits :class:`TriggerEvent` objects suitable for
downstream magnitude estimation and alerting.

Typical usage:
    >>> from eqengine.processing.detector import Detector
    >>> det = Detector(sta_seconds=0.5, lta_seconds=10.0)
    >>> events = det.process(trace)
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import obspy
import structlog
from obspy import UTCDateTime
from obspy.signal.trigger import recursive_sta_lta, trigger_onset

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class TriggerEvent:
    """A single STA/LTA trigger window detected on one channel.

    Attributes
    ----------
    start_time:
        Absolute time of the trigger-on sample.
    end_time:
        Absolute time of the trigger-off sample, or ``None`` when the
        trigger is still active at the end of the processed data.
    peak_sta_lta:
        Maximum STA/LTA ratio observed within the trigger window.
    start_sample:
        Sample index (0-based) of trigger on.
    end_sample:
        Sample index of trigger off, or ``None`` if still active.
    channel:
        Channel code that produced the trigger (e.g. ``"EHZ"``).
    """

    start_time: UTCDateTime
    end_time: UTCDateTime | None
    peak_sta_lta: float
    start_sample: int
    end_sample: int | None
    channel: str


# ---------------------------------------------------------------------------
# Detector
# ---------------------------------------------------------------------------


class Detector:
    """Recursive STA/LTA earthquake trigger detector.

    Parameters
    ----------
    sta_seconds:
        Short-term average window length in seconds (default 0.5 s).
    lta_seconds:
        Long-term average window length in seconds (default 10.0 s).
    trigger_on:
        STA/LTA ratio threshold to declare a trigger ON (default 3.5).
    trigger_off:
        STA/LTA ratio threshold to declare a trigger OFF (default 1.5).
    sampling_rate:
        Expected sampling rate in Hz (default 100 for RS4D).
    min_trigger_duration_sec:
        Minimum trigger duration in seconds; shorter triggers are
        discarded as spurious transients (default 0.5 s).
    """

    def __init__(
        self,
        sta_seconds: float = 0.5,
        lta_seconds: float = 10.0,
        trigger_on: float = 3.5,
        trigger_off: float = 1.5,
        sampling_rate: float = 100.0,
        min_trigger_duration_sec: float = 0.5,
    ) -> None:
        if sta_seconds <= 0 or lta_seconds <= 0:
            raise ValueError("STA and LTA window lengths must be positive.")
        if sta_seconds >= lta_seconds:
            raise ValueError(
                f"STA window ({sta_seconds} s) must be shorter than "
                f"LTA window ({lta_seconds} s)."
            )
        if trigger_on <= trigger_off:
            raise ValueError(
                f"trigger_on ({trigger_on}) must exceed trigger_off ({trigger_off})."
            )

        self.sta_seconds = sta_seconds
        self.lta_seconds = lta_seconds
        self.trigger_on = trigger_on
        self.trigger_off = trigger_off
        self.sampling_rate = sampling_rate
        self.min_trigger_duration_sec = min_trigger_duration_sec

        # Internal state — updated on each call to ``process``.
        self.is_triggered: bool = False
        self.trigger_start_time: UTCDateTime | None = None
        self.current_sta_lta_ratio: float = 0.0

        self._log = logger.bind(
            sta=sta_seconds,
            lta=lta_seconds,
            trigger_on=trigger_on,
            trigger_off=trigger_off,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def process(self, trace: obspy.Trace) -> list[TriggerEvent]:
        """Run recursive STA/LTA detection on *trace*.

        Parameters
        ----------
        trace:
            Preprocessed (bandpass-filtered) ObsPy Trace.

        Returns
        -------
        list[TriggerEvent]
            Trigger events that satisfy the minimum-duration filter.
            An empty list means no earthquake-like signal was detected.
        """
        sr = trace.stats.sampling_rate
        npts = trace.stats.npts
        channel = trace.stats.channel
        starttime: UTCDateTime = trace.stats.starttime

        sta_samples = int(self.sta_seconds * sr)
        lta_samples = int(self.lta_seconds * sr)

        # Guard: need enough samples for at least one full LTA window.
        min_samples_required = lta_samples + sta_samples
        if npts < min_samples_required:
            self._log.warning(
                "detector.trace_too_short",
                channel=channel,
                npts=npts,
                required=min_samples_required,
            )
            return []

        self._log.debug(
            "detector.process.start",
            channel=channel,
            npts=npts,
            sr=sr,
        )

        # --- Compute characteristic function ---
        cft = recursive_sta_lta(
            trace.data.astype(np.float64),
            sta_samples,
            lta_samples,
        )

        # Update internal telemetry — store last valid ratio.
        if cft.size > 0:
            self.current_sta_lta_ratio = float(cft[-1])

        # --- Find trigger on/off pairs ---
        raw_triggers = trigger_onset(cft, self.trigger_on, self.trigger_off)

        if raw_triggers.size == 0:
            self._log.debug("detector.process.no_triggers", channel=channel)
            self.is_triggered = False
            return []

        # --- Build TriggerEvent objects and apply duration filter ---
        events: list[TriggerEvent] = []
        min_dur_samples = int(self.min_trigger_duration_sec * sr)

        for on_idx, off_idx in raw_triggers:
            on_idx = int(on_idx)
            off_idx = int(off_idx)

            # If trigger_onset returns off_idx == 0, the trigger is still
            # active at the end of the trace.
            still_active = off_idx <= on_idx
            if still_active:
                off_idx_eff = npts - 1
            else:
                off_idx_eff = off_idx

            duration_samples = off_idx_eff - on_idx

            # Duration filter — reject glitches / transients.
            if duration_samples < min_dur_samples:
                self._log.debug(
                    "detector.trigger_too_short",
                    channel=channel,
                    duration_s=duration_samples / sr,
                    min_s=self.min_trigger_duration_sec,
                )
                continue

            # Peak STA/LTA within the trigger window.
            peak_ratio = float(np.max(cft[on_idx : off_idx_eff + 1]))

            event = TriggerEvent(
                start_time=starttime + on_idx / sr,
                end_time=None if still_active else starttime + off_idx / sr,
                peak_sta_lta=peak_ratio,
                start_sample=on_idx,
                end_sample=None if still_active else off_idx,
                channel=channel,
            )
            events.append(event)

        # Update detector state.
        if events:
            last = events[-1]
            self.is_triggered = last.end_time is None
            self.trigger_start_time = last.start_time if self.is_triggered else None

        self._log.info(
            "detector.process.done",
            channel=channel,
            total_triggers=len(events),
            is_triggered=self.is_triggered,
        )

        return events

    def get_current_ratio(self) -> float:
        """Return the most recent STA/LTA characteristic-function value.

        Useful for real-time telemetry dashboards.  The value is updated
        each time :meth:`process` is called.
        """
        return self.current_sta_lta_ratio
