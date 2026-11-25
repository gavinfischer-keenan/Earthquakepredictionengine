"""Spectral-band, kurtosis, PGA, and Nakamura H/V forensics DSP calculations."""
from __future__ import annotations

from typing import Any

import numpy as np

from eqengine.constants import COUNTS_TO_ACCEL, COUNTS_TO_VELOCITY_UM_S


def compute_block_kurtosis(demeaned: np.ndarray, sampling_rate: float) -> tuple[float, float]:
    """Compute (median, worst-case) excess kurtosis across 3-second sub-windows."""
    block_len = max(16, round(3.0 * sampling_rate))
    n_blocks = max(1, len(demeaned) // block_len)
    k_vals: list[float] = []

    for i in range(n_blocks):
        seg = demeaned[i * block_len : (i + 1) * block_len] if n_blocks > 1 else demeaned
        if len(seg) < 16:
            continue
        seg_c = seg - np.mean(seg)
        m2 = float(np.mean(seg_c ** 2))
        if m2 <= 1e-12:
            k_vals.append(0.0)
            continue
        m4 = float(np.mean(seg_c ** 4))
        k_vals.append((m4 / (m2 * m2)) - 3.0)

    if not k_vals:
        return 0.0, 0.0

    k_arr = np.asarray(k_vals, dtype=np.float64)
    k_med = float(np.median(k_arr))
    worst_idx = int(np.argmax(np.abs(k_arr)))
    return k_med, float(k_arr[worst_idx])


def compute_hv_metrics(
    enz: np.ndarray | None,
    enn: np.ndarray | None,
    ene: np.ndarray | None,
    sampling_rate: float,
) -> tuple[float, float]:
    """Compute Nakamura H/V site amplification ratio & dominant resonance peak frequency."""
    if enz is None or enn is None or ene is None:
        return 1.0, 0.0
    m = min(len(enz), len(enn), len(ene))
    if m < 64:
        return 1.0, 0.0

    win = np.hanning(m)
    z_f = np.abs(np.fft.rfft((enz[-m:].astype(np.float64) - np.mean(enz[-m:])) * win))
    n_f = np.abs(np.fft.rfft((enn[-m:].astype(np.float64) - np.mean(enn[-m:])) * win))
    e_f = np.abs(np.fft.rfft((ene[-m:].astype(np.float64) - np.mean(ene[-m:])) * win))
    freqs = np.fft.rfftfreq(m, d=1.0 / sampling_rate)

    mask = (freqs >= 0.8) & (freqs <= 15.0)
    if not np.any(mask):
        return 1.0, 0.0

    h_spec = np.sqrt(n_f[mask] ** 2 + e_f[mask] ** 2)
    v_spec = np.maximum(z_f[mask], 1e-6)
    ratio = h_spec / v_spec

    if len(ratio) >= 3:
        kernel = np.array([0.25, 0.5, 0.25], dtype=np.float64)
        ratio = np.convolve(ratio, kernel, mode="same")

    f_band = freqs[mask]
    best_idx = int(np.argmax(ratio))
    return round(float(ratio[best_idx]), 2), round(float(f_band[best_idx]), 2)


def compute_minute_forensics(
    ehz: np.ndarray,
    enz: np.ndarray | None = None,
    enn: np.ndarray | None = None,
    ene: np.ndarray | None = None,
    sampling_rate: float = 100.0,
    sta_lta_max: float = 1.0,
) -> dict[str, Any]:
    """Compute calibrated physical ground-motion, spectral-band, and impulsiveness metrics."""
    if ehz is None or len(ehz) < 32:
        return {
            "ehz_rms_counts": 0.0,
            "ehz_mad_counts": 0.0,
            "pga_m_s2": 0.0,
            "kurtosis": 0.0,
            "kurtosis_median": 0.0,
            "sta_lta_max": round(float(sta_lta_max), 3),
            "is_quiet_candidate": False,
            "cultural_noise_um_s": 0.0,
            "ocean_df_freq_hz": 0.16,
            "seismic_swell_s": 12.5,
            "ocean_microseism_nm_s": 0.0,
            "wind_um_s": 0.0,
            "stadium_um_s": 0.0,
            "rail_um_s": 0.0,
            "traffic_um_s": 0.0,
            "human_um_s": 0.0,
            "concert_um_s": 0.0,
            "hv_ratio": 1.0,
            "hv_peak_hz": 0.0,
        }

    ehz_f = np.asarray(ehz, dtype=np.float64)
    ehz_d = ehz_f - np.mean(ehz_f)
    ehz_rms = float(np.sqrt(np.mean(ehz_d ** 2)))
    ehz_mad = float(1.4826 * np.median(np.abs(ehz_d - np.median(ehz_d))))

    k_med, k_worst = compute_block_kurtosis(ehz_d, sampling_rate)
    kurtosis_eff = k_worst

    n = len(ehz_d)
    win = np.hanning(n)
    fft_mag = np.abs(np.fft.rfft(ehz_d * win))
    freqs = np.fft.rfftfreq(n, d=1.0 / sampling_rate)

    coherent_gain = max(0.25 * n, 1.0)
    amp_um_s = (fft_mag / coherent_gain) * COUNTS_TO_VELOCITY_UM_S

    def band_mean_um_s(f_lo: float, f_hi: float) -> float:
        mask = (freqs >= f_lo) & (freqs <= f_hi)
        if not np.any(mask):
            return 0.0
        return float(np.mean(amp_um_s[mask]))

    ocean_mask = (freqs >= 0.10) & (freqs <= 0.35)
    if np.any(ocean_mask):
        ocean_freqs = freqs[ocean_mask]
        ocean_vals = amp_um_s[ocean_mask]
        pk_idx = int(np.argmax(ocean_vals))
        ocean_df_freq = float(ocean_freqs[pk_idx])
        ocean_amp_nm_s = float(ocean_vals[pk_idx] * 1000.0)
    else:
        ocean_df_freq = 0.16
        ocean_amp_nm_s = 0.0

    seismic_swell_s = max(6.0, min(22.0, 2.0 / max(ocean_df_freq, 0.09)))
    wind_um_s = band_mean_um_s(0.38, 0.85)
    stadium_um_s = band_mean_um_s(2.0, 5.0)
    rail_um_s = band_mean_um_s(4.0, 8.0)
    traffic_um_s = band_mean_um_s(8.0, 14.0)
    human_um_s = band_mean_um_s(15.0, 24.0)
    concert_um_s = band_mean_um_s(25.0, 45.0)

    cultural_noise = (
        0.35 * traffic_um_s
        + 0.30 * human_um_s
        + 0.20 * stadium_um_s
        + 0.15 * concert_um_s
    )

    acc_arrays: list[np.ndarray] = []
    for arr in (enz, enn, ene):
        if arr is not None and len(arr) > 0:
            arr_f = np.asarray(arr, dtype=np.float64)
            acc_arrays.append((arr_f - np.mean(arr_f)) * COUNTS_TO_ACCEL)
    if len(acc_arrays) == 3:
        m_acc = min(len(a) for a in acc_arrays)
        pga_m_s2 = float(
            np.max(
                np.sqrt(
                    acc_arrays[0][-m_acc:] ** 2
                    + acc_arrays[1][-m_acc:] ** 2
                    + acc_arrays[2][-m_acc:] ** 2
                )
            )
        )
    elif acc_arrays:
        pga_m_s2 = float(max(np.max(np.abs(a)) for a in acc_arrays))
    else:
        pga_m_s2 = 0.0

    hv_ratio, hv_peak_hz = compute_hv_metrics(enz, enn, ene, sampling_rate)
    is_quiet = bool(abs(kurtosis_eff) < 2.5 and sta_lta_max < 2.5)

    return {
        "ehz_rms_counts": round(ehz_rms, 3),
        "ehz_mad_counts": round(ehz_mad, 3),
        "pga_m_s2": round(pga_m_s2, 6),
        "kurtosis": round(kurtosis_eff, 3),
        "kurtosis_median": round(k_med, 3),
        "sta_lta_max": round(float(sta_lta_max), 3),
        "is_quiet_candidate": is_quiet,
        "cultural_noise_um_s": round(cultural_noise, 4),
        "ocean_df_freq_hz": round(ocean_df_freq, 4),
        "seismic_swell_s": round(seismic_swell_s, 2),
        "ocean_microseism_nm_s": round(ocean_amp_nm_s, 1),
        "wind_um_s": round(wind_um_s, 4),
        "stadium_um_s": round(stadium_um_s, 4),
        "rail_um_s": round(rail_um_s, 4),
        "traffic_um_s": round(traffic_um_s, 4),
        "human_um_s": round(human_um_s, 4),
        "concert_um_s": round(concert_um_s, 4),
        "hv_ratio": hv_ratio,
        "hv_peak_hz": hv_peak_hz,
    }
