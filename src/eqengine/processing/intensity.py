"""Modified Mercalli Intensity (MMI) estimation via USGS Worden et al. (2012) GMICE."""
from __future__ import annotations

import dataclasses
import math

_ROMAN_NUMERALS: tuple[str, ...] = (
    "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
)

# Official USGS ShakeMap MMI scale labels and hex colors (bins 1..10)
_MMI_SCALE: tuple[tuple[str, str], ...] = (
    ("Not Felt", "#ffffff"),       # I
    ("Weak", "#bfccff"),           # II
    ("Weak", "#a0e6ff"),           # III
    ("Light", "#80ffff"),          # IV
    ("Moderate", "#7aff93"),       # V
    ("Strong", "#ffff00"),         # VI
    ("Very Strong", "#ffc800"),    # VII
    ("Severe", "#ff9100"),         # VIII
    ("Violent", "#ff0000"),        # IX
    ("Extreme", "#c80000"),        # X
)


@dataclasses.dataclass(frozen=True, slots=True)
class MMIResult:
    """Estimated Modified Mercalli Intensity and USGS ShakeMap metadata."""

    mmi: float
    roman: str
    label: str
    color: str
    pga_cm_s2: float | None = None
    pgv_cm_s: float | None = None


def mmi_from_pga(pga_m_s2: float) -> float:
    """Convert Peak Ground Acceleration (m/s²) to MMI using Worden et al. (2012)."""
    pga_cm_s2 = abs(float(pga_m_s2)) * 100.0
    if pga_cm_s2 <= 0.0:
        return 1.0
    log_pga = math.log10(pga_cm_s2)
    if log_pga <= 1.57:
        val = 1.78 + 1.55 * log_pga
    else:
        val = -1.60 + 3.70 * log_pga
    return max(1.0, min(10.0, val))


def mmi_from_pgv(pgv_m_s: float) -> float:
    """Convert Peak Ground Velocity (m/s) to MMI using Worden et al. (2012)."""
    pgv_cm_s = abs(float(pgv_m_s)) * 100.0
    if pgv_cm_s <= 0.0:
        return 1.0
    log_pgv = math.log10(pgv_cm_s)
    if log_pgv <= 0.53:
        val = 3.78 + 1.47 * log_pgv
    else:
        val = 2.89 + 3.16 * log_pgv
    return max(1.0, min(10.0, val))


def compute_mmi(
    pga_m_s2: float | None = None,
    pgv_m_s: float | None = None,
) -> MMIResult:
    """Compute Modified Mercalli Intensity from PGA (m/s²) and/or PGV (m/s).

    Following USGS ShakeMap convention, PGA governs low intensities while PGV
    dominates for damaging shaking (MMI >= 5.0), blending smoothly when both
    measurements are available.
    """
    pga_cm = abs(float(pga_m_s2)) * 100.0 if pga_m_s2 is not None else None
    pgv_cm = abs(float(pgv_m_s)) * 100.0 if pgv_m_s is not None else None

    mmi_pga = mmi_from_pga(pga_m_s2) if pga_m_s2 is not None and pga_m_s2 > 0 else None
    mmi_pgv = mmi_from_pgv(pgv_m_s) if pgv_m_s is not None and pgv_m_s > 0 else None

    if mmi_pga is not None and mmi_pgv is not None:
        raw = 0.65 * mmi_pgv + 0.35 * mmi_pga if max(mmi_pga, mmi_pgv) >= 5.0 else 0.65 * mmi_pga + 0.35 * mmi_pgv
    elif mmi_pgv is not None:
        raw = mmi_pgv
    elif mmi_pga is not None:
        raw = mmi_pga
    else:
        raw = 1.0

    mmi = round(max(1.0, min(10.0, raw)), 2)
    bin_idx = max(0, min(9, round(mmi) - 1))
    roman = _ROMAN_NUMERALS[bin_idx]
    label, color = _MMI_SCALE[bin_idx]

    return MMIResult(
        mmi=mmi,
        roman=roman,
        label=label,
        color=color,
        pga_cm_s2=round(pga_cm, 4) if pga_cm is not None else None,
        pgv_cm_s=round(pgv_cm, 4) if pgv_cm is not None else None,
    )
