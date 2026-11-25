/**
 * High-Performance Digital Signal Processing & Geophysical Forensics Math
 */

// ---------------------------------------------------------------------------
// Precomputed 256-Point FFT Tables (Zero Trig / Allocation Overhead)
// ---------------------------------------------------------------------------
const FFT_SIZE = 256;
const LOG2_FFT = 8;
const BLACKMAN_HARRIS_256 = new Float32Array(FFT_SIZE);
const HANN_256 = new Float32Array(FFT_SIZE);
const BIT_REV_256 = new Uint8Array(FFT_SIZE);

for (let i = 0; i < FFT_SIZE; i++) {
  const term = (2 * Math.PI * i) / (FFT_SIZE - 1);
  BLACKMAN_HARRIS_256[i] =
    0.35875 - 0.48829 * Math.cos(term) + 0.14128 * Math.cos(2 * term) - 0.01168 * Math.cos(3 * term);
  HANN_256[i] = 0.5 * (1.0 - Math.cos(term));

  let rev = 0;
  let x = i;
  for (let b = 0; b < LOG2_FFT; b++) {
    rev = (rev << 1) | (x & 1);
    x >>= 1;
  }
  BIT_REV_256[i] = rev;
}

// Precompute twiddle factors for stages 1..8
const TWIDDLE_COS = new Array(LOG2_FFT + 1);
const TWIDDLE_SIN = new Array(LOG2_FFT + 1);
for (let s = 1; s <= LOG2_FFT; s++) {
  const len = 1 << s;
  const half = len >> 1;
  const cosArr = new Float32Array(half);
  const sinArr = new Float32Array(half);
  const angleStep = (-2.0 * Math.PI) / len;
  for (let m = 0; m < half; m++) {
    cosArr[m] = Math.cos(angleStep * m);
    sinArr[m] = Math.sin(angleStep * m);
  }
  TWIDDLE_COS[s] = cosArr;
  TWIDDLE_SIN[s] = sinArr;
}

// Pre-allocated real/imag scratch buffers for FFT
const fftReal = new Float32Array(FFT_SIZE);
const fftImag = new Float32Array(FFT_SIZE);
const lowFreqBuf = new Float32Array(FFT_SIZE);

// ---------------------------------------------------------------------------
// O(log N) Binary Search Utilities for Monotonic Timestamp Buffers
// ---------------------------------------------------------------------------
export function lowerBound(arr, target) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function upperBound(arr, target) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Exact Zero-Offset Time-Domain Filters (100 Hz RS4D)
// ---------------------------------------------------------------------------
// 2nd-order Butterworth 1.0–10.0 Hz bandpass @ 100 Hz (unity passband gain SOS)
const BP_SOS = [
  [0.05644846, 0.11289692, 0.05644846, -1.24532221, 0.49035942],
  [1.0, -2.0, 1.0, -1.91414109, 0.91860259],
];

export function filterData(data, mode) {
  if (!data || data.length === 0 || mode === 'raw') return data;

  const n = data.length;
  const out = new Float64Array(n);

  // Mean removal (DC offset suppression)
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i];
  const mean = sum / n;
  for (let i = 0; i < n; i++) out[i] = data[i] - mean;

  if (mode === 'demean') {
    return out;
  }

  if (mode === 'bandpass') {
    // 2nd-order Butterworth bandpass (1.0–10.0 Hz @ 100 Hz SR), Direct Form II Transposed SOS
    for (let s = 0; s < BP_SOS.length; s++) {
      const b0 = BP_SOS[s][0];
      const b1 = BP_SOS[s][1];
      const b2 = BP_SOS[s][2];
      const a1 = BP_SOS[s][3];
      const a2 = BP_SOS[s][4];
      let z1 = 0.0;
      let z2 = 0.0;
      for (let i = 0; i < n; i++) {
        const x = out[i];
        const y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        out[i] = y;
      }
    }
    return out;
  }

  if (mode === 'highpass') {
    // Exact 1st-order Butterworth highpass (>1.0 Hz @ 100 Hz SR)
    const b0 = 0.969531;
    const a1 = -0.939063;
    let xPrev = out[0];
    let yPrev = 0.0;
    out[0] = 0.0;
    for (let i = 1; i < n; i++) {
      const x = out[i];
      const y = b0 * (x - xPrev) - a1 * yPrev;
      xPrev = x;
      yPrev = y;
      out[i] = y;
    }
    return out;
  }

  if (mode === 'lowpass') {
    // 1-pole lowpass (~5 Hz @ 100 Hz SR)
    const alpha = 0.24;
    let y = out[0];
    for (let i = 0; i < n; i++) {
      y += alpha * (out[i] - y);
      out[i] = y;
    }
    return out;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Core Precomputed-Table Radix-2 FFT (256-Point)
// ---------------------------------------------------------------------------
function runRadix2FFT256(outMagnitudes) {
  const n = FFT_SIZE;
  for (let s = 1; s <= LOG2_FFT; s++) {
    const len = 1 << s;
    const half = len >> 1;
    const cosArr = TWIDDLE_COS[s];
    const sinArr = TWIDDLE_SIN[s];

    for (let i = 0; i < n; i += len) {
      for (let m = 0; m < half; m++) {
        const idxU = i + m;
        const idxV = idxU + half;
        const wr = cosArr[m];
        const wi = sinArr[m];

        const uR = fftReal[idxU];
        const uI = fftImag[idxU];
        const vR = fftReal[idxV] * wr - fftImag[idxV] * wi;
        const vI = fftReal[idxV] * wi + fftImag[idxV] * wr;

        fftReal[idxU] = uR + vR;
        fftImag[idxU] = uI + vI;
        fftReal[idxV] = uR - vR;
        fftImag[idxV] = uI - vI;
      }
    }
  }

  const halfBins = n >> 1;
  const mags = outMagnitudes || new Float32Array(halfBins);
  for (let i = 0; i < halfBins; i++) {
    const re = fftReal[i];
    const im = fftImag[i];
    mags[i] = Math.sqrt(re * re + im * im);
  }
  return mags;
}

/**
 * Radix-2 In-Place Cooley-Tukey Fast Fourier Transform (256-point)
 * Returns magnitudes array of length 128 (0 to 50 Hz, 0.390625 Hz resolution).
 * Optionally writes into a pre-allocated Float32Array `outMagnitudes` and reads
 * directly from `[startIdx, startIdx + count)` without temporary slice copies.
 */
export function computeFFT256(samples, outMagnitudes = null, startIdx = -1, sliceCount = -1) {
  const n = FFT_SIZE;
  const totalLen = samples ? samples.length : 0;
  const start = startIdx >= 0 ? startIdx : Math.max(0, totalLen - n);
  const count = sliceCount >= 0 ? Math.min(sliceCount, n, totalLen - start) : Math.min(n, totalLen - start);

  let sum = 0;
  for (let i = 0; i < count; i++) sum += samples[start + i];
  const mean = count > 0 ? sum / count : 0;

  // Populate directly in bit-reversed order (zero separate swap pass)
  fftReal.fill(0);
  fftImag.fill(0);
  for (let i = 0; i < count; i++) {
    fftReal[BIT_REV_256[i]] = (samples[start + i] - mean) * BLACKMAN_HARRIS_256[i];
  }

  return runRadix2FFT256(outMagnitudes);
}

/**
 * 10x Decimated Sub-Hz FFT (Effective SR = 10 Hz, 0.0390625 Hz bin width).
 * Resolves 0.04–5.0 Hz Pacific Ocean primary/secondary microseisms and wind sway.
 */
export function computeLowFreqFFT(samples, decimation = 10, outMagnitudes = null) {
  const nTotal = samples ? samples.length : 0;
  const maxBlocks = FFT_SIZE;
  const nBlocks = Math.min(maxBlocks, Math.floor(nTotal / decimation));
  const fsEff = 100.0 / decimation;
  const binWidthHz = fsEff / FFT_SIZE;

  if (nBlocks < 8) {
    const empty = outMagnitudes || new Float32Array(FFT_SIZE >> 1);
    empty.fill(0);
    return { magnitudes: empty, binWidthHz, nBlocks: 0 };
  }

  const startSample = nTotal - nBlocks * decimation;
  let globalSum = 0;
  for (let b = 0; b < nBlocks; b++) {
    let blockSum = 0;
    const base = startSample + b * decimation;
    for (let k = 0; k < decimation; k++) {
      blockSum += samples[base + k];
    }
    const avg = blockSum / decimation;
    lowFreqBuf[b] = avg;
    globalSum += avg;
  }

  const mean = globalSum / nBlocks;
  const normGain = nBlocks < FFT_SIZE ? FFT_SIZE / nBlocks : 1.0;

  fftReal.fill(0);
  fftImag.fill(0);
  for (let i = 0; i < nBlocks; i++) {
    // Hann window over actual nBlocks length to prevent truncation leakage
    const w = nBlocks > 1 ? 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / (nBlocks - 1))) : 1.0;
    fftReal[BIT_REV_256[i]] = (lowFreqBuf[i] - mean) * w * normGain;
  }

  const magnitudes = runRadix2FFT256(outMagnitudes);
  return { magnitudes, binWidthHz, nBlocks };
}

// ---------------------------------------------------------------------------
// Real-World Signal Forensics & Source Deduction Engine
// ---------------------------------------------------------------------------
const COUNTS_TO_VELOCITY_NM = 50.0; // 1 count ≈ 0.05 µm/s = 50 nm/s (EHZ)
let prevTrafficCentroidHz = null;
let prevTrafficTimestampMs = 0;
let smoothedDopplerHzPerSec = 0;
let cachedForensics = null;
let lastForensicsTimeMs = 0;
let latestEnvironmentalIntel = null;
let latestExternalEvents = null;
let latestBandThresholds = null;

export function setEnvironmentalIntelligence(intel) {
  latestEnvironmentalIntel = intel || null;
  lastForensicsTimeMs = 0; // force fresh recompute on next frame
}

export function setExternalEvents(extData) {
  latestExternalEvents = extData || null;
  lastForensicsTimeMs = 0;
}

export function getExternalEvents() {
  return latestExternalEvents;
}

const BAND_THRESHOLD_ALIASES = {
  stadium: 'stadium_um_s',
  concert: 'concert_um_s',
  traffic: 'traffic_um_s',
  human: 'human_um_s',
  wind: 'wind_um_s',
  rail: 'rail_um_s',
  ocean: 'ocean_microseism_nm_s',
  cultural: 'cultural_noise_um_s',
};

export function setBandThresholds(thresholds) {
  latestBandThresholds = thresholds || null;
}

export function getBandLevel(bandKey, value) {
  const mappedKey = BAND_THRESHOLD_ALIASES[bandKey] || bandKey;
  const th = latestBandThresholds && latestBandThresholds[mappedKey];
  if (!th || Number(th.sample_count || 0) < 5 || value == null || !Number.isFinite(Number(value))) {
    return null;
  }
  const v = Number(value);
  if (v <= th.p25) return { level: 'LIGHT', color: '#38bdf8' };
  if (v <= th.p75) return { level: 'NORMAL', color: '#00ff88' };
  if (v <= th.p95) return { level: 'HEAVY', color: '#f59e0b' };
  return { level: 'EXTREME', color: '#ef4444' };
}

const highFreqScratch = new Float32Array(128);
const lowFreqScratch = new Float32Array(128);
const ennScratch = new Float32Array(128);
const eneScratch = new Float32Array(128);
const enzScratch = new Float32Array(128);

/**
 * Deduce real-world physical phenomena from live 4-channel waveforms:
 * - Pacific Ocean double-frequency microseism & primary swell period (T_swell)
 * - Excess Kurtosis (κ) for sharp footsteps/impacts vs continuous hum
 * - Traffic Doppler (df/dt Hz/s) & 4–8 Hz BART/rail harmonic indicator
 * - Nakamura H/V site resonance peak frequency (f0) & amplification
 * - Triaxial horizontal back-azimuth & rectilinearity
 * - Primary deduced environmental / seismic source
 */
export function computeEnvironmentalForensics(buffers, staLtaRatio = 1.0) {
  const nowMs = performance.now();
  if (cachedForensics && nowMs - lastForensicsTimeMs < 250) {
    return cachedForensics;
  }

  const ehz = buffers ? buffers.EHZ : null;
  if (!ehz || ehz.length < 64) {
    return null;
  }

  // 1. High-resolution spectral breakdown (0.39 Hz/bin, 0–50 Hz)
  const mags = computeFFT256(ehz, highFreqScratch);
  const sumBand = (arr, b0, b1) => {
    let s = 0;
    const end = Math.min(b1, arr.length - 1);
    for (let b = b0; b <= end; b++) s += arr[b];
    // Divide by Hann coherent gain factor (~64 for 256-pt FFT) so band values represent count amplitude
    return s / (Math.max(end - b0 + 1, 1) * 64.0);
  };

  const pWind = sumBand(mags, 1, 2);
  const pStadium = sumBand(mags, 5, 13);    // 2–5 Hz
  const pRail = sumBand(mags, 10, 20);      // 4–8 Hz
  const pTraffic = sumBand(mags, 20, 36);   // 8–14 Hz
  const pHuman = sumBand(mags, 38, 61);     // 15–24 Hz
  const pConcert = sumBand(mags, 64, 115);  // 25–45 Hz

  // 2. Sub-Hz Pacific Ocean Microseism & Swell Period (0.11–0.32 Hz double-freq peak)
  const lf = computeLowFreqFFT(ehz, 10, lowFreqScratch);
  let oceanPeakFreqHz = 0.16;
  let oceanPeakMag = 0;
  if (lf.nBlocks >= 32) {
    const minBin = Math.max(2, Math.floor(0.10 / lf.binWidthHz));
    const maxBin = Math.min(127, Math.ceil(0.35 / lf.binWidthHz));
    for (let b = minBin; b <= maxBin; b++) {
      if (lf.magnitudes[b] > oceanPeakMag) {
        oceanPeakMag = lf.magnitudes[b];
        oceanPeakFreqHz = b * lf.binWidthHz;
      }
    }
  }
  const oceanSwellPeriodSec = Math.max(6.0, Math.min(22.0, 2.0 / Math.max(oceanPeakFreqHz, 0.09)));
  // Approximate velocity amplitude in nm/s (normalize 256-pt Hann coherent gain ~64)
  const oceanAmpNmS = lf.nBlocks >= 32 ? (oceanPeakMag / 64.0) * COUNTS_TO_VELOCITY_NM : pWind * 25.0;
  let oceanState = 'Calm Pacific Swell';
  if (oceanAmpNmS > 320) oceanState = 'Heavy Long-Period Groundswell';
  else if (oceanAmpNmS > 120) oceanState = 'Moderate Coastal Surf';

  // 3. Excess Kurtosis κ over latest 3.0s window (300 samples)
  const kCount = Math.min(300, ehz.length);
  const kStart = ehz.length - kCount;
  let kSum = 0;
  for (let i = kStart; i < ehz.length; i++) kSum += ehz[i];
  const kMean = kSum / kCount;
  let m2 = 0;
  let m4 = 0;
  for (let i = kStart; i < ehz.length; i++) {
    const d = ehz[i] - kMean;
    const d2 = d * d;
    m2 += d2;
    m4 += d2 * d2;
  }
  m2 /= kCount;
  m4 /= kCount;
  const kurtosis = m2 > 1e-9 ? m4 / (m2 * m2) - 3.0 : 0.0;
  let impulseClass = 'Continuous / Ambient';
  if (kurtosis > 6.0) impulseClass = 'Sharp Impact / Footstep';
  else if (kurtosis > 2.0) impulseClass = 'Intermittent Transient';

  // 4. Traffic Spectral Centroid & Doppler Trend (6–18 Hz -> bins 15..46)
  let numF = 0;
  let denF = 0;
  for (let b = 15; b <= 46 && b < mags.length; b++) {
    const f = b * 0.390625;
    numF += f * mags[b];
    denF += mags[b];
  }
  const trafficCentroidHz = denF > 1e-6 ? numF / denF : 10.5;
  if (prevTrafficCentroidHz !== null && prevTrafficTimestampMs > 0) {
    const dt = (nowMs - prevTrafficTimestampMs) / 1000.0;
    if (dt > 0.1 && dt < 5.0) {
      const instRate = (trafficCentroidHz - prevTrafficCentroidHz) / dt;
      smoothedDopplerHzPerSec = smoothedDopplerHzPerSec * 0.7 + instRate * 0.3;
    }
  }
  prevTrafficCentroidHz = trafficCentroidHz;
  prevTrafficTimestampMs = nowMs;

  let dopplerState = 'Steady Flow';
  if (smoothedDopplerHzPerSec > 0.15) dopplerState = 'Approaching ▲';
  else if (smoothedDopplerHzPerSec < -0.15) dopplerState = 'Receding ▼';

  const railLikely = pRail > pTraffic * 1.15 && kurtosis < 2.5 && pRail > 25.0;

  // 5. Nakamura H/V Site Resonance & 2D Horizontal Polarization
  const enn = buffers.ENN;
  const ene = buffers.ENE;
  const enz = buffers.ENZ;
  let hvPeakFreqHz = 0;
  let hvPeakRatio = 1.0;
  let azimuthDeg = 0;
  let rectilinearityPct = 0;

  if (enn && ene && enn.length >= 64 && ene.length >= 64) {
    // 2D horizontal covariance over latest 150 samples (1.5s)
    const pN = Math.min(150, enn.length, ene.length);
    const sN = enn.length - pN;
    const sE = ene.length - pN;
    let sumN = 0;
    let sumE = 0;
    for (let i = 0; i < pN; i++) {
      sumN += enn[sN + i];
      sumE += ene[sE + i];
    }
    const muN = sumN / pN;
    const muE = sumE / pN;
    let cNN = 0;
    let cEE = 0;
    let cNE = 0;
    for (let i = 0; i < pN; i++) {
      const dn = enn[sN + i] - muN;
      const de = ene[sE + i] - muE;
      cNN += dn * dn;
      cEE += de * de;
      cNE += dn * de;
    }
    cNN /= pN;
    cEE /= pN;
    cNE /= pN;

    const trace = cNN + cEE;
    const diff = cEE - cNN;
    const disc = Math.sqrt(Math.max(0, diff * diff + 4 * cNE * cNE));
    const l1 = 0.5 * (trace + disc);
    const l2 = 0.5 * (trace - disc);
    if (l1 > 1e-9) {
      rectilinearityPct = Math.max(0, Math.min(100, (1.0 - l2 / l1) * 100.0));
      // Principal eigenvector orientation [E, N] -> atan2(E, N)
      const vecE = Math.abs(cNE) > 1e-9 ? l1 - cNN : cEE >= cNN ? 1.0 : 0.0;
      const vecN = Math.abs(cNE) > 1e-9 ? cNE : cNN > cEE ? 1.0 : 0.0;
      azimuthDeg = ((Math.atan2(vecE, vecN) * 180.0) / Math.PI + 360.0) % 360.0;
    }

    // Nakamura H/V using ENN/ENE vs ENZ (if ENZ available)
    if (enz && enz.length >= 64) {
      computeFFT256(enn, ennScratch);
      computeFFT256(ene, eneScratch);
      computeFFT256(enz, enzScratch);
      for (let b = 2; b <= 31; b++) {
        const hAmp = Math.sqrt(ennScratch[b] * ennScratch[b] + eneScratch[b] * eneScratch[b]);
        const vAmp = Math.max(enzScratch[b], 1.0);
        const ratio = hAmp / vAmp;
        if (ratio > hvPeakRatio) {
          hvPeakRatio = ratio;
          hvPeakFreqHz = b * 0.390625;
        }
      }
    }
  }

  // 6. Primary Source Deduction Classifier (with NOAA Buoy Swell vs Wind Disambiguation)
  const intel = latestEnvironmentalIntel;
  const buoy = intel ? intel.buoy : null;
  const baseline = intel && intel.quiet_hunter ? intel.quiet_hunter.baseline : null;
  const buoyPeriodS = buoy ? (buoy.dpd_s ?? buoy.apd_s ?? null) : null;
  const swellPeriodMatch =
    buoy && buoyPeriodS != null && buoy.wvht_m != null &&
    buoy.wvht_m >= 1.5 && Math.abs(oceanSwellPeriodSec - buoyPeriodS) <= 3.5;
  const calmLocalWind = !buoy || buoy.wspd_mps == null || buoy.wspd_mps < 8.0;
  const buoyConfirmedSwell = Boolean(swellPeriodMatch && calmLocalWind);

  // Separate ocean microseism bleed from wind/tree-sway meter when buoy confirms calm-wind Pacific swells
  const pWindAdjusted = buoyConfirmedSwell ? pWind * 0.25 : pWind;

  const ext = latestExternalEvents;
  const liveExtEvents = Array.isArray(ext?.live_events) ? ext.live_events : [];
  const liveCalGame = liveExtEvents.find((e) => e.category === 'football') || null;
  const liveGreekShow = liveExtEvents.find((e) => e.category === 'concert') || null;
  const extWeather = ext?.weather || null;
  const extBart = ext?.bart || null;
  const extAircraft = ext?.aircraft || null;
  const closestAir = (extAircraft && Number(extAircraft.low_overhead_count || 0) > 0)
    ? (extAircraft.closest_aircraft || (Array.isArray(extAircraft.aircraft) && extAircraft.aircraft[0]) || null)
    : null;

  let primarySource = {
    icon: '🌊',
    label: buoyConfirmedSwell ? 'Pacific Ocean Groundswell' : 'Pacific Ocean Microseism',
    color: '#38bdf8',
    confidence: buoyConfirmedSwell ? Math.max(82, intel?.correlation?.match_pct || 88) : 82,
    detail: buoyConfirmedSwell
      ? `Confirmed by NOAA ${buoy.buoy_id}: ${buoy.wvht_m}m (${buoy.wvht_ft ?? (buoy.wvht_m * 3.28084).toFixed(1)}ft) @ ${buoyPeriodS}s ${buoy.mwd_cardinal || ''} (${buoy.wspd_mps ?? '--'} m/s wind).`
      : `Steady ${oceanSwellPeriodSec.toFixed(1)}s coastal groundswell with low kurtosis (κ=${kurtosis.toFixed(1)}).`,
  };

  if (staLtaRatio >= 4.0 && kurtosis >= 1.5 && pStadium + pTraffic > 40) {
    primarySource = {
      icon: '⚡',
      label: 'Seismic P/S Wave Arrival',
      color: '#ef4444',
      confidence: Math.min(98, Math.round(65 + staLtaRatio * 3)),
      detail: `High STA/LTA (${staLtaRatio.toFixed(1)}x) across fault band (1–10 Hz).`,
    };
  } else if (kurtosis > 5.5 && pHuman > 14) {
    primarySource = {
      icon: '🏃',
      label: 'Indoor Footstep / Impact',
      color: '#10b981',
      confidence: Math.min(96, Math.round(70 + kurtosis * 2.5)),
      detail: `Sharp impulsive transient (κ=${kurtosis.toFixed(1)}) in 15–24 Hz structural floor band.`,
    };
  } else if (liveCalGame && pStadium > 18 && kurtosis < 4.0) {
    const scoreMeta = liveCalGame.metadata?.status_detail ? ` (${liveCalGame.metadata.status_detail})` : '';
    primarySource = {
      icon: '🏈',
      label: `${liveCalGame.title}${scoreMeta}`,
      color: '#f43f5e',
      confidence: Math.min(96, Math.round(74 + pStadium * 0.4)),
      detail: `Live Memorial Stadium 2–5 Hz crowd resonance matching scheduled Cal home game.`,
    };
  } else if (liveGreekShow && pConcert > 14 && kurtosis < 3.0) {
    const phaseLabel = liveGreekShow.metadata?.phase === 'soundcheck' ? 'Soundcheck' : 'Live Show';
    primarySource = {
      icon: '🎸',
      label: `Greek Theatre: ${liveGreekShow.title}`,
      color: '#c084fc',
      confidence: Math.min(95, Math.round(72 + pConcert * 0.5)),
      detail: `${phaseLabel} · 25–45 Hz acoustic sub-bass coupling from The Greek Theatre.`,
    };
  } else if (pConcert > 24 && kurtosis < 2.5) {
    primarySource = {
      icon: '🎸',
      label: 'Sub-Bass Acoustic Coupling',
      color: '#c084fc',
      confidence: 84,
      detail: `Sustained 25–45 Hz sub-bass resonance without vertical impact spike.`,
    };
  } else if (closestAir && (pTraffic + pHuman) > 18 && kurtosis < 3.5) {
    const isHeli = Boolean(closestAir.is_helicopter);
    const altLabel = closestAir.altitude_ft != null ? `${Math.round(closestAir.altitude_ft).toLocaleString()} ft` : 'low alt';
    primarySource = {
      icon: isHeli ? '🚁' : '✈️',
      label: isHeli ? `Low Helicopter Overhead (${altLabel})` : `Low Aircraft Overhead (${altLabel})`,
      color: '#38bdf8',
      confidence: isHeli ? 89 : 82,
      detail: `${closestAir.callsign || closestAir.hex_id || 'Aircraft'} (${closestAir.aircraft_type || 'ADS-B'}) at ${Number(closestAir.distance_km || 0).toFixed(1)} km · 10–35 Hz acoustic comb.`,
    };
  } else if (railLikely) {
    const bartNote = extBart && extBart.tunnel_active
      ? ` · BART: ${extBart.trains_imminent_count} train(s) near DBRK/ROCK`
      : '';
    primarySource = {
      icon: '🚇',
      label: extBart?.tunnel_active ? 'BART Hills Tunnel Transit' : 'Rail / Infrastructure Harmonic',
      color: '#fbbf24',
      confidence: extBart?.tunnel_active ? 88 : 78,
      detail: `Sustained 4–8 Hz harmonic tremor (κ=${kurtosis.toFixed(1)}) azimuth ~${Math.round(azimuthDeg)}°${bartNote}.`,
    };
  } else if (pTraffic > 26 && pTraffic >= pHuman) {
    primarySource = {
      icon: '🚛',
      label: 'Roadway Vehicle Passby',
      color: '#f59e0b',
      confidence: Math.min(94, Math.round(65 + (pTraffic / 60) * 25)),
      detail: `8–14 Hz vehicle vibration (${dopplerState}, centroid ${trafficCentroidHz.toFixed(1)} Hz).`,
    };
  } else if (pStadium > 30) {
    primarySource = {
      icon: '🏈',
      label: 'Crowd / Stadium Resonance',
      color: '#f43f5e',
      confidence: 80,
      detail: `Elevated 2–5 Hz rhythmic ground coupling.`,
    };
  } else if (pWindAdjusted > 20 || (extWeather && (extWeather.regime === 'GUSTY' || extWeather.regime === 'STORM') && pWindAdjusted > 12)) {
    const wxNote = extWeather
      ? ` · Berkeley Hills ${extWeather.wind_speed_mph} mph (gusts ${extWeather.wind_gusts_mph} mph ${extWeather.wind_direction_cardinal})`
      : '';
    primarySource = {
      icon: '💨',
      label: extWeather && extWeather.regime !== 'CALM' ? `Wind & Canopy Rocking (${extWeather.regime})` : 'Wind & Canopy Rocking',
      color: '#38bdf8',
      confidence: extWeather && extWeather.regime !== 'CALM' ? 88 : 79,
      detail: `Long-period 0.1–0.5 Hz atmospheric tilt & tree root sway${wxNote}.`,
    };
  }

  cachedForensics = {
    bands: { wind: pWindAdjusted, stadium: pStadium, rail: pRail, traffic: pTraffic, human: pHuman, concert: pConcert },
    ocean: {
      peakFreqHz: oceanPeakFreqHz,
      swellPeriodSec: oceanSwellPeriodSec,
      ampNmS: oceanAmpNmS,
      state: oceanState,
    },
    buoy,
    externalEvents: ext,
    correlation: intel ? intel.correlation : null,
    baseline,
    kurtosis,
    impulseClass,
    traffic: {
      centroidHz: trafficCentroidHz,
      dopplerHzPerSec: smoothedDopplerHzPerSec,
      dopplerState,
      railLikely,
    },
    hv: {
      peakFreqHz: hvPeakFreqHz,
      peakRatio: hvPeakRatio,
    },
    polarization: {
      azimuthDeg,
      rectilinearityPct,
    },
    primarySource,
  };
  lastForensicsTimeMs = nowMs;
  return cachedForensics;
}

// ---------------------------------------------------------------------------
// Precomputed 256-level Inferno/Magma Geophysical Colormap
// ---------------------------------------------------------------------------
export const COLOR_LUT_RGBA_32 = new Uint32Array(256);
export const COLOR_LUT_RGB_STR = new Array(256);

for (let i = 0; i < 256; i++) {
  const t = i / 255.0;
  let r = 0, g = 0, b = 0;

  if (t < 0.25) {
    const k = t / 0.25;
    r = Math.floor(8 + k * 55);
    g = Math.floor(5 + k * 15);
    b = Math.floor(20 + k * 95);
  } else if (t < 0.55) {
    const k = (t - 0.25) / 0.3;
    r = Math.floor(63 + k * 135);
    g = Math.floor(20 + k * 30);
    b = Math.floor(115 - k * 55);
  } else if (t < 0.85) {
    const k = (t - 0.55) / 0.3;
    r = Math.floor(198 + k * 54);
    g = Math.floor(50 + k * 135);
    b = Math.floor(60 - k * 35);
  } else {
    const k = (t - 0.85) / 0.15;
    r = Math.floor(252 + k * 3);
    g = Math.floor(185 + k * 70);
    b = Math.floor(25 + k * 215);
  }

  // Pack as Little-Endian 0xAABBGGRR for direct 32-bit Uint32Array blitting
  COLOR_LUT_RGBA_32[i] = (255 << 24) | (b << 16) | (g << 8) | r;
  COLOR_LUT_RGB_STR[i] = `rgb(${r},${g},${b})`;
}

/**
 * Fast lookup for 32-bit packed color from seismic power
 */
export function getMagColor32(mag, gain = 1.0) {
  const db = 20.0 * Math.log10(Math.max(mag * gain, 0.05));
  // Map 15 dB (ambient baseline ~6 counts) to 75 dB (intense ~6000 counts)
  const norm = Math.max(0.0, Math.min(1.0, (db - 15.0) / 60.0));
  const idx = Math.floor(norm * 255);
  return COLOR_LUT_RGBA_32[idx];
}
