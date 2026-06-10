"""Signal preprocessing for Raspberry Shake RS4D waveforms.

Provides bandpass filtering, displacement integration, and envelope
computation — the first stage of the real-time processing pipeline.

Typical usage:
    >>> from eqengine.processing.preprocessor import preprocess
    >>> clean = preprocess(raw_trace, bandpass_low=1.0, bandpass_high=10.0)
"""

from __future__ import annotations

import numpy as np
import obspy
import structlog
from scipy.signal import hilbert

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_DEFAULT_BANDPASS_LOW: float = 1.0   # Hz
_DEFAULT_BANDPASS_HIGH: float = 10.0  # Hz
_HIGHPASS_DRIFT_FREQ: float = 0.075   # Hz — remove long-period drift after integration
_TAPER_MAX_PERCENT: float = 0.05
_FILTER_CORNERS: int = 4


def preprocess(
    trace: obspy.Trace,
    bandpass_low: float = _DEFAULT_BANDPASS_LOW,
    bandpass_high: float = _DEFAULT_BANDPASS_HIGH,
) -> obspy.Trace:
    """Apply standard preprocessing chain to a seismic trace.

    The pipeline:
        1. Copy the input (non-destructive).
        2. Remove the mean (demean detrend).
        3. Apply a cosine taper (5 % edges).
        4. Zero-phase Butterworth bandpass filter.

    Parameters
    ----------
    trace:
        Raw ObsPy Trace (EHZ, ENZ, ENN, or ENE).
    bandpass_low:
        Low corner frequency in Hz (default 1.0).
    bandpass_high:
        High corner frequency in Hz (default 10.0).

    Returns
    -------
    obspy.Trace
        A *new* Trace containing the filtered data.

    Raises
    ------
    ValueError
        If the trace has no data or ``bandpass_low >= bandpass_high``.
    """
    if trace.stats.npts == 0:
        raise ValueError("Cannot preprocess an empty trace (npts == 0).")
    if bandpass_low >= bandpass_high:
        raise ValueError(
            f"bandpass_low ({bandpass_low}) must be less than "
            f"bandpass_high ({bandpass_high})."
        )

    log = logger.bind(
        channel=trace.stats.channel,
        npts=trace.stats.npts,
        sampling_rate=trace.stats.sampling_rate,
    )
    log.debug(
        "preprocess.start",
        bandpass_low=bandpass_low,
        bandpass_high=bandpass_high,
    )

    tr = trace.copy()
    tr.detrend("demean")
    tr.taper(max_percentage=_TAPER_MAX_PERCENT, type="cosine")
    tr.filter(
        "bandpass",
        freqmin=bandpass_low,
        freqmax=bandpass_high,
        corners=_FILTER_CORNERS,
        zerophase=True,
    )

    log.debug("preprocess.done")
    return tr


def preprocess_for_displacement(trace: obspy.Trace) -> obspy.Trace:
    """Convert a velocity trace to displacement for Pd measurement.

    The pipeline:
        1. Copy the input.
        2. Demean + cosine taper.
        3. Bandpass 0.075–10 Hz (remove microseism noise and high-freq).
        4. Integrate velocity → displacement (trapezoidal rule via ObsPy).
        5. Highpass at 0.075 Hz to suppress long-period drift introduced
           by integration.

    Parameters
    ----------
    trace:
        Velocity trace (typically EHZ channel, counts or m/s).

    Returns
    -------
    obspy.Trace
        Displacement trace.

    Raises
    ------
    ValueError
        If the trace has no data.
    """
    if trace.stats.npts == 0:
        raise ValueError("Cannot process an empty trace (npts == 0).")

    log = logger.bind(
        channel=trace.stats.channel,
        npts=trace.stats.npts,
        sampling_rate=trace.stats.sampling_rate,
    )
    log.debug("preprocess_for_displacement.start")

    tr = trace.copy()

    # Basic cleanup
    tr.detrend("demean")
    tr.taper(max_percentage=_TAPER_MAX_PERCENT, type="cosine")

    # Pre-integration bandpass — keep seismically relevant band
    tr.filter(
        "bandpass",
        freqmin=_HIGHPASS_DRIFT_FREQ,
        freqmax=_DEFAULT_BANDPASS_HIGH,
        corners=_FILTER_CORNERS,
        zerophase=True,
    )

    # Integrate velocity → displacement
    tr.integrate(method="cumtrapz")

    # Post-integration drift suppression
    tr.filter(
        "highpass",
        freq=_HIGHPASS_DRIFT_FREQ,
        corners=_FILTER_CORNERS,
        zerophase=True,
    )

    log.debug("preprocess_for_displacement.done")
    return tr


def compute_envelope(trace: obspy.Trace) -> np.ndarray:
    """Compute the signal envelope via the analytic signal (Hilbert transform).

    Parameters
    ----------
    trace:
        Input ObsPy Trace (any channel).

    Returns
    -------
    np.ndarray
        1-D array of envelope amplitudes (same length as ``trace.data``).

    Raises
    ------
    ValueError
        If the trace has no data.
    """
    if trace.stats.npts == 0:
        raise ValueError("Cannot compute envelope of an empty trace (npts == 0).")

    log = logger.bind(
        channel=trace.stats.channel,
        npts=trace.stats.npts,
    )
    log.debug("compute_envelope.start")

    analytic_signal = hilbert(trace.data.astype(np.float64))
    envelope: np.ndarray = np.abs(analytic_signal)

    log.debug(
        "compute_envelope.done",
        envelope_max=float(np.max(envelope)),
        envelope_mean=float(np.mean(envelope)),
    )
    return envelope
