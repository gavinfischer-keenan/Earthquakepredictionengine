"""Single-station magnitude estimation for earthquake early warning.

Implements τc (predominant period) and Pd (peak displacement) methods
described in the EEW literature (Kanamori 2005, Wu & Kanamori 2005).
Also extracts PGA from the RS4D 3-axis accelerometer and PGV from the
geophone for ground-motion intensity characterization.

Typical usage:
    >>> from eqengine.processing.magnitude import MagnitudeEstimator
    >>> est = MagnitudeEstimator()
    >>> result = est.estimate(velocity_trace, accel_traces, p_arrival)
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import obspy
import structlog
from obspy import UTCDateTime

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Physical constants
# ---------------------------------------------------------------------------
_VP_KM_S: float = 6.0   # Average P-wave velocity (km/s)
_VS_KM_S: float = 3.5   # Average S-wave velocity (km/s)

# Derived: D ≈ Δt_sp × Vp×Vs / (Vp - Vs) ≈ Δt × 8.4 km
_VP_VS_FACTOR: float = (_VP_KM_S * _VS_KM_S) / (_VP_KM_S - _VS_KM_S)

# Magnitude clamp range — avoids nonsensical extrapolations.
_MAG_MIN: float = 0.5
_MAG_MAX: float = 8.0

# Empirical coefficients for Pd-distance magnitude (Southern California).
# log10(Pd) = A + B×M + C×log10(R)
_PD_A: float = -3.463
_PD_B: float = 0.729
_PD_C: float = -1.374


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class MagnitudeEstimate:
    """Container for single-station magnitude & ground-motion parameters.

    All fields are ``None`` when a measurement could not be made (e.g.
    insufficient window length, missing accelerometer channels).
    """

    tau_c: float | None                 # Predominant period (seconds)
    pd: float | None                    # Peak displacement (meters)
    pga: float | None                   # Peak ground acceleration (m/s²)
    pgv: float | None                   # Peak ground velocity (m/s)
    magnitude_from_tau_c: float | None  # M estimated from τc
    magnitude_from_pd: float | None     # M estimated from Pd + distance
    estimated_distance_km: float | None
    estimated_s_arrival: float | None   # Unix epoch seconds
    seconds_until_s_wave: float | None


# ---------------------------------------------------------------------------
# Estimator
# ---------------------------------------------------------------------------


class MagnitudeEstimator:
    """Estimate earthquake magnitude from the first few seconds after P.

    This class is **stateless** — every call to :meth:`estimate` is
    independent, making it safe for concurrent use from multiple channels.
    """

    def __init__(self) -> None:
        self._log = logger.bind(component="MagnitudeEstimator")

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    def estimate(
        self,
        velocity_trace: obspy.Trace,
        accel_traces: dict[str, obspy.Trace] | None,
        p_arrival: UTCDateTime,
        window_sec: float = 3.0,
        s_arrival: UTCDateTime | None = None,
    ) -> MagnitudeEstimate:
        """Produce a best-effort magnitude estimate from early P-wave data.

        Parameters
        ----------
        velocity_trace:
            Geophone (EHZ) trace — velocity waveform.
        accel_traces:
            Optional dict mapping channel codes (``"ENZ"``, ``"ENN"``,
            ``"ENE"``) to accelerometer traces.
        p_arrival:
            Detected P-wave arrival time.
        window_sec:
            Analysis window length in seconds after ``p_arrival``
            (default 3.0 s).
        s_arrival:
            Optional S-wave arrival time.  When provided, enables
            S–P distance estimation and Pd-based magnitude.

        Returns
        -------
        MagnitudeEstimate
        """
        self._log.info(
            "estimate.start",
            p_arrival=str(p_arrival),
            window_sec=window_sec,
            has_accel=accel_traces is not None,
        )

        # --- τc (predominant period) ---
        tau_c = self.compute_tau_c(velocity_trace, p_arrival, window_sec)

        # --- Pd (peak displacement) ---
        pd = self.compute_pd(velocity_trace, p_arrival, window_sec)

        # --- PGA from accelerometer ---
        pga: float | None = None
        if accel_traces:
            pga = self.compute_pga(accel_traces, p_arrival, window_sec)

        # --- PGV from geophone ---
        pgv = self._compute_pgv(velocity_trace, p_arrival, window_sec)

        # --- Magnitude from τc ---
        mag_tc: float | None = None
        if tau_c is not None:
            mag_tc = self.magnitude_from_tau_c_value(tau_c)

        # --- Distance / S-arrival / Pd magnitude ---
        distance_km: float | None = None
        s_arrival_epoch: float | None = None
        seconds_until_s: float | None = None
        mag_pd: float | None = None

        if s_arrival is not None:
            distance_km = self.estimate_distance_sp(
                float(p_arrival.timestamp),
                float(s_arrival.timestamp),
            )
        # If we have distance, derive Pd-based magnitude and S-wave timing.
        if distance_km is not None and distance_km > 0:
            if pd is not None:
                mag_pd = self.magnitude_from_pd_distance(pd, distance_km)
            s_arrival_epoch = self.predict_s_arrival(
                float(p_arrival.timestamp), distance_km
            )
            seconds_until_s = s_arrival_epoch - float(UTCDateTime.now().timestamp)
            if seconds_until_s < 0:
                seconds_until_s = 0.0

        result = MagnitudeEstimate(
            tau_c=tau_c,
            pd=pd,
            pga=pga,
            pgv=pgv,
            magnitude_from_tau_c=mag_tc,
            magnitude_from_pd=mag_pd,
            estimated_distance_km=distance_km,
            estimated_s_arrival=s_arrival_epoch,
            seconds_until_s_wave=seconds_until_s,
        )

        self._log.info(
            "estimate.done",
            tau_c=tau_c,
            pd=pd,
            pga=pga,
            pgv=pgv,
            mag_tc=mag_tc,
            mag_pd=mag_pd,
            distance_km=distance_km,
        )
        return result

    # ------------------------------------------------------------------
    # τc — predominant period
    # ------------------------------------------------------------------

    def compute_tau_c(
        self,
        velocity_trace: obspy.Trace,
        p_arrival: UTCDateTime,
        window_sec: float,
    ) -> float | None:
        """Compute the predominant period τc from a velocity trace.

        τc = 2π × √( Σ displacement² / Σ velocity² )

        Both sums are taken over the window starting at *p_arrival*.

        Parameters
        ----------
        velocity_trace:
            EHZ velocity trace.
        p_arrival:
            P-wave arrival time.
        window_sec:
            Window length (seconds).

        Returns
        -------
        float | None
            τc in seconds, or ``None`` if the window is too short or
            contains zero energy.
        """
        vel_win = self._extract_window(velocity_trace, p_arrival, window_sec)
        if vel_win is None or vel_win.size == 0:
            self._log.warning("compute_tau_c.empty_window")
            return None

        sr = velocity_trace.stats.sampling_rate

        # Integrate velocity → displacement via cumulative trapezoidal rule.
        displacement = np.cumsum(vel_win) / sr

        sum_disp_sq = np.sum(displacement ** 2)
        sum_vel_sq = np.sum(vel_win ** 2)

        if sum_vel_sq == 0.0:
            self._log.warning("compute_tau_c.zero_velocity_energy")
            return None

        tau_c = 2.0 * math.pi * math.sqrt(sum_disp_sq / sum_vel_sq)

        self._log.debug("compute_tau_c.result", tau_c=tau_c)
        return tau_c

    # ------------------------------------------------------------------
    # Pd — peak displacement
    # ------------------------------------------------------------------

    def compute_pd(
        self,
        velocity_trace: obspy.Trace,
        p_arrival: UTCDateTime,
        window_sec: float,
    ) -> float | None:
        """Compute peak displacement Pd in the initial P-wave window.

        Parameters
        ----------
        velocity_trace:
            EHZ velocity trace.
        p_arrival:
            P-wave arrival time.
        window_sec:
            Window length (seconds).

        Returns
        -------
        float | None
            Pd in the same units as the integrated trace (meters if the
            input is in m/s), or ``None`` if the window is unusable.
        """
        vel_win = self._extract_window(velocity_trace, p_arrival, window_sec)
        if vel_win is None or vel_win.size == 0:
            self._log.warning("compute_pd.empty_window")
            return None

        sr = velocity_trace.stats.sampling_rate
        displacement = np.cumsum(vel_win) / sr

        pd = float(np.max(np.abs(displacement)))

        self._log.debug("compute_pd.result", pd=pd)
        return pd

    # ------------------------------------------------------------------
    # PGA — peak ground acceleration (3-component vector)
    # ------------------------------------------------------------------

    def compute_pga(
        self,
        accel_traces: dict[str, obspy.Trace],
        p_arrival: UTCDateTime,
        window_sec: float,
    ) -> float | None:
        """Compute peak ground acceleration from the RS4D accelerometer.

        PGA is the maximum of the 3-component vector magnitude
        √(ENZ² + ENN² + ENE²) within the analysis window.

        Parameters
        ----------
        accel_traces:
            Dict with keys ``"ENZ"``, ``"ENN"``, ``"ENE"`` → ObsPy Traces.
        p_arrival:
            P-wave arrival time.
        window_sec:
            Window length (seconds).

        Returns
        -------
        float | None
            PGA in the same units as the traces (m/s² if properly
            calibrated), or ``None`` if data is incomplete.
        """
        required_channels = {"ENZ", "ENN", "ENE"}
        available = set(accel_traces.keys()) & required_channels

        if available != required_channels:
            self._log.warning(
                "compute_pga.missing_channels",
                expected=sorted(required_channels),
                available=sorted(available),
            )
            return None

        windows: dict[str, np.ndarray | None] = {}
        for ch in required_channels:
            w = self._extract_window(accel_traces[ch], p_arrival, window_sec)
            if w is None or w.size == 0:
                self._log.warning("compute_pga.empty_window", channel=ch)
                return None
            windows[ch] = w

        # Ensure equal lengths (trim to shortest).
        min_len = min(w.size for w in windows.values() if w is not None)
        enz = windows["ENZ"][:min_len]  # type: ignore[index]
        enn = windows["ENN"][:min_len]  # type: ignore[index]
        ene = windows["ENE"][:min_len]  # type: ignore[index]

        vector_mag = np.sqrt(enz ** 2 + enn ** 2 + ene ** 2)
        pga = float(np.max(vector_mag))

        self._log.debug("compute_pga.result", pga=pga)
        return pga

    # ------------------------------------------------------------------
    # PGV — peak ground velocity (geophone)
    # ------------------------------------------------------------------

    def _compute_pgv(
        self,
        velocity_trace: obspy.Trace,
        p_arrival: UTCDateTime,
        window_sec: float,
    ) -> float | None:
        """Compute peak ground velocity from the geophone trace.

        Parameters
        ----------
        velocity_trace:
            EHZ velocity trace.
        p_arrival:
            P-wave arrival time.
        window_sec:
            Window length (seconds).

        Returns
        -------
        float | None
            PGV in the same units as the trace (m/s if calibrated).
        """
        vel_win = self._extract_window(velocity_trace, p_arrival, window_sec)
        if vel_win is None or vel_win.size == 0:
            self._log.warning("compute_pgv.empty_window")
            return None

        pgv = float(np.max(np.abs(vel_win)))
        self._log.debug("compute_pgv.result", pgv=pgv)
        return pgv

    # ------------------------------------------------------------------
    # Empirical magnitude relations
    # ------------------------------------------------------------------

    @staticmethod
    def magnitude_from_tau_c_value(tau_c: float) -> float:
        """Estimate magnitude from predominant period τc.

        Empirical relation (Kanamori 2005):
            M ≈ (log10(τc) + 1.0) / 0.3

        The result is clamped to [0.5, 8.0].

        Parameters
        ----------
        tau_c:
            Predominant period in seconds (must be > 0).

        Returns
        -------
        float
            Estimated magnitude.
        """
        if tau_c <= 0:
            return _MAG_MIN

        mag = (math.log10(tau_c) + 1.0) / 0.3
        return float(np.clip(mag, _MAG_MIN, _MAG_MAX))

    @staticmethod
    def magnitude_from_pd_distance(pd: float, distance_km: float) -> float:
        """Estimate magnitude from Pd and hypocentral distance.

        Empirical (Wu & Kanamori 2005, Southern California calibration):
            log10(Pd) = A + B×M + C×log10(R)
        Solving for M:
            M = (log10(Pd) - A - C×log10(R)) / B

        Parameters
        ----------
        pd:
            Peak displacement in meters (must be > 0).
        distance_km:
            Hypocentral distance in km (must be > 0).

        Returns
        -------
        float
            Estimated magnitude, clamped to [0.5, 8.0].
        """
        if pd <= 0 or distance_km <= 0:
            return _MAG_MIN

        mag = (math.log10(pd) - _PD_A - _PD_C * math.log10(distance_km)) / _PD_B
        return float(np.clip(mag, _MAG_MIN, _MAG_MAX))

    # ------------------------------------------------------------------
    # S–P distance and S-arrival prediction
    # ------------------------------------------------------------------

    @staticmethod
    def estimate_distance_sp(p_time: float, s_time: float) -> float | None:
        """Estimate hypocentral distance from the S–P time interval.

        D = Δt_sp × (Vp × Vs) / (Vp - Vs)

        With Vp = 6.0 km/s, Vs = 3.5 km/s → D ≈ Δt × 8.4 km.

        Parameters
        ----------
        p_time:
            P-arrival time (Unix epoch seconds).
        s_time:
            S-arrival time (Unix epoch seconds).

        Returns
        -------
        float | None
            Distance in km, or ``None`` if ``s_time <= p_time``.
        """
        dt = s_time - p_time
        if dt <= 0:
            return None
        return dt * _VP_VS_FACTOR

    @staticmethod
    def predict_s_arrival(p_time: float, distance_km: float) -> float:
        """Predict the S-wave arrival time given P time and distance.

        s_arrival = p_time + distance_km / Vs

        Parameters
        ----------
        p_time:
            P-arrival time (Unix epoch seconds).
        distance_km:
            Hypocentral distance in km.

        Returns
        -------
        float
            Predicted S-arrival time as Unix epoch seconds.
        """
        return p_time + distance_km / _VS_KM_S

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_window(
        trace: obspy.Trace,
        start: UTCDateTime,
        duration_sec: float,
    ) -> np.ndarray | None:
        """Slice a fixed-length window from *trace* without modifying it.

        Returns
        -------
        np.ndarray | None
            1-D float64 array of samples, or ``None`` when the requested
            window falls outside the trace's time span.
        """
        tr_start = trace.stats.starttime
        tr_end = trace.stats.endtime
        sr = trace.stats.sampling_rate

        if start < tr_start or start > tr_end:
            return None

        idx_start = int((start - tr_start) * sr)
        idx_end = idx_start + int(duration_sec * sr)

        # Clamp to trace bounds — we may get a slightly shorter window if
        # the trace ends early, which is acceptable for real-time use.
        idx_end = min(idx_end, trace.stats.npts)

        if idx_start >= idx_end:
            return None

        return trace.data[idx_start:idx_end].astype(np.float64)
