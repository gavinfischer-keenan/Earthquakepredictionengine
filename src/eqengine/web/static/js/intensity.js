const MMI_ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

const MMI_SCALE = [
  ['Not Felt', '#ffffff'],
  ['Weak', '#bfccff'],
  ['Weak', '#a0e6ff'],
  ['Light', '#80ffff'],
  ['Moderate', '#7aff93'],
  ['Strong', '#ffff00'],
  ['Very Strong', '#ffc800'],
  ['Severe', '#ff9100'],
  ['Violent', '#ff0000'],
  ['Extreme', '#c80000'],
];

/**
 * Convert Peak Ground Acceleration (m/s^2) to MMI via Worden et al. (2012).
 */
export function mmiFromPGA(pgaMS2) {
  const pgaCmS2 = Math.abs(Number(pgaMS2) || 0) * 100.0;
  if (pgaCmS2 <= 0) return 1.0;
  const logPga = Math.log10(pgaCmS2);
  const val = logPga <= 1.57
    ? 1.78 + 1.55 * logPga
    : -1.60 + 3.70 * logPga;
  return Math.max(1.0, Math.min(10.0, val));
}

/**
 * Convert Peak Ground Velocity (m/s) to MMI via Worden et al. (2012).
 */
export function mmiFromPGV(pgvMS) {
  const pgvCmS = Math.abs(Number(pgvMS) || 0) * 100.0;
  if (pgvCmS <= 0) return 1.0;
  const logPgv = Math.log10(pgvCmS);
  const val = logPgv <= 0.53
    ? 3.78 + 1.47 * logPgv
    : 2.89 + 3.16 * logPgv;
  return Math.max(1.0, Math.min(10.0, val));
}

/**
 * Compute Modified Mercalli Intensity from PGA (m/s^2) and/or PGV (m/s).
 * Returns { mmi, roman, label, color }.
 */
export function computeMMI(pgaMS2 = null, pgvMS = null) {
  const hasPga = pgaMS2 != null && Number(pgaMS2) > 0;
  const hasPgv = pgvMS != null && Number(pgvMS) > 0;
  const mPga = hasPga ? mmiFromPGA(pgaMS2) : null;
  const mPgv = hasPgv ? mmiFromPGV(pgvMS) : null;

  let raw = 1.0;
  if (mPga !== null && mPgv !== null) {
    raw = Math.max(mPga, mPgv) >= 5.0
      ? 0.65 * mPgv + 0.35 * mPga
      : 0.65 * mPga + 0.35 * mPgv;
  } else if (mPgv !== null) {
    raw = mPgv;
  } else if (mPga !== null) {
    raw = mPga;
  }

  const mmi = Math.round(Math.max(1.0, Math.min(10.0, raw)) * 100) / 100;
  const binIdx = Math.max(0, Math.min(9, Math.round(mmi) - 1));
  const [label, color] = MMI_SCALE[binIdx];
  return {
    mmi,
    roman: MMI_ROMAN[binIdx],
    label,
    color,
  };
}
