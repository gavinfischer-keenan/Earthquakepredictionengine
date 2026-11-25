/**
 * Peterson Noise View: USGS Global High/Low Noise Model (NLNM / NHNM) Spectral Comparison
 * Features:
 * - True 10x Decimated Sub-Hz FFT (0.10–0.80 Hz) merged with 256-pt High-Freq FFT (0.80–50 Hz)
 * - Exact Velocity-to-Acceleration Derivative Weighting (+20 log10(2πf))
 * - Exact Piecewise Log10 Interpolation for NLNM / NHNM Benchmarking
 * - Interactive Hover Crosshair & Frequency Source Interpretation
 */

import { state } from '../state.js';
import { computeFFT256, computeLowFreqFFT } from '../dsp.js';

const N_HIGH_BINS = 128;
const N_LOW_BINS = 128;
const smoothedHighPsd = new Float32Array(N_HIGH_BINS);
const smoothedLowPsd = new Float32Array(N_LOW_BINS);
const highScratch = new Float32Array(N_HIGH_BINS);
const lowScratch = new Float32Array(N_LOW_BINS);
let isInitialized = false;

// Standard USGS Peterson (1993) Model Points (Frequency in Hz, PSD in dB rel. 1 (m/s^2)^2/Hz)
const NHNM_POINTS = [
  { f: 0.1, db: -110 },
  { f: 0.2, db: -92 },
  { f: 0.5, db: -105 },
  { f: 1.0, db: -112 },
  { f: 3.0, db: -102 },
  { f: 10.0, db: -90 },
  { f: 20.0, db: -86 },
  { f: 50.0, db: -84 },
];

const NLNM_POINTS = [
  { f: 0.1, db: -162 },
  { f: 0.2, db: -142 },
  { f: 0.5, db: -160 },
  { f: 1.0, db: -166 },
  { f: 3.0, db: -160 },
  { f: 10.0, db: -150 },
  { f: 20.0, db: -142 },
  { f: 50.0, db: -135 },
];

let hoverState = { active: false, x: 0, y: 0 };
let petersonListenersAttached = false;
let lastFullSpectrum = [];

function initPetersonHover(canvas) {
  if (petersonListenersAttached || !canvas) return;
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    hoverState.active = true;
    hoverState.x = e.clientX - rect.left;
    hoverState.y = e.clientY - rect.top;
  });
  canvas.addEventListener('mouseleave', () => {
    hoverState.active = false;
  });
  petersonListenersAttached = true;
}

export function interpModelDb(points, freq) {
  if (freq <= points[0].f) return points[0].db;
  const last = points[points.length - 1];
  if (freq >= last.f) return last.db;

  const logF = Math.log10(freq);
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    if (freq >= p0.f && freq <= p1.f) {
      const l0 = Math.log10(p0.f);
      const l1 = Math.log10(p1.f);
      const t = (logF - l0) / Math.max(l1 - l0, 1e-9);
      return p0.db + t * (p1.db - p0.db);
    }
  }
  return last.db;
}

function describeFrequencyBand(freq) {
  if (freq < 0.5) return 'Pacific Ocean Microseism (3–10s Coastal Surf Swell)';
  if (freq < 10.0) return 'Local Earthquakes, Crustal & Infrastructure Energy';
  return 'Urban Cultural Noise (Traffic, HVAC, Footsteps)';
}

export function renderPetersonCurve() {
  const canvas = document.getElementById('petersonCanvas');
  if (!canvas) return;

  initPetersonHover(canvas);

  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (w <= 0 || h <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  const ctx = canvas.getContext('2d');
  ctx.resetTransform();
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#060913';
  ctx.fillRect(0, 0, w, h);

  const compact = w < 560;
  const padLeft = compact ? 48 : 65;
  const padRight = compact ? 14 : 30;
  const padTop = compact ? 48 : 40;
  const padBottom = compact ? 42 : 46;

  const plotW = Math.max(10, w - padLeft - padRight);
  const plotH = Math.max(10, h - padTop - padBottom);

  const minLogF = -1.0; // 0.1 Hz
  const maxLogF = Math.log10(50.0); // 50 Hz
  const minDb = -180;
  const maxDb = -70;

  const toX = (freq) => {
    const logF = Math.log10(Math.max(freq, 0.08));
    const norm = (logF - minLogF) / (maxLogF - minLogF);
    return padLeft + Math.max(0, Math.min(1, norm)) * plotW;
  };

  const toY = (db) => {
    const clampedDb = Math.max(minDb, Math.min(maxDb, db));
    const norm = (clampedDb - minDb) / (maxDb - minDb);
    return padTop + plotH - norm * plotH;
  };

  // 1. Plot Area Background
  ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
  ctx.fillRect(padLeft, padTop, plotW, plotH);

  // USGS Normal Healthy Corridor (Between NHNM and NLNM)
  ctx.beginPath();
  NHNM_POINTS.forEach((pt, i) => {
    const x = toX(pt.f);
    const y = toY(pt.db);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  for (let i = NLNM_POINTS.length - 1; i >= 0; i--) {
    const pt = NLNM_POINTS[i];
    ctx.lineTo(toX(pt.f), toY(pt.db));
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(34, 197, 94, 0.05)';
  ctx.fill();

  // 2. Three Interpretation Bands
  const oceanX1 = toX(0.1);
  const oceanX2 = toX(0.5);
  ctx.fillStyle = 'rgba(56, 189, 248, 0.06)';
  ctx.fillRect(oceanX1, padTop, oceanX2 - oceanX1, plotH);

  const eqX1 = toX(0.5);
  const eqX2 = toX(10.0);
  ctx.fillStyle = 'rgba(245, 158, 11, 0.04)';
  ctx.fillRect(eqX1, padTop, eqX2 - eqX1, plotH);

  const urbanX1 = toX(10.0);
  const urbanX2 = toX(50.0);
  ctx.fillStyle = 'rgba(168, 85, 247, 0.05)';
  ctx.fillRect(urbanX1, padTop, urbanX2 - urbanX1, plotH);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  [oceanX2, eqX2].forEach((x) => {
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + plotH);
    ctx.stroke();
  });
  ctx.setLineDash([]);

  ctx.font = compact ? '7.5px JetBrains Mono, monospace' : '8.5px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#38bdf8';
  ctx.fillText(compact ? '🌊 OCEAN' : '🌊 PACIFIC OCEAN MICROSEISM', (oceanX1 + oceanX2) / 2, padTop + 14);
  if (!compact) ctx.fillText('(3–10s Coastal Surf Swell)', (oceanX1 + oceanX2) / 2, padTop + 24);

  ctx.fillStyle = '#f59e0b';
  ctx.fillText(compact ? '⚡ QUAKES' : '⚡ LOCAL EARTHQUAKES & CRUST', (eqX1 + eqX2) / 2, padTop + 14);
  if (!compact) ctx.fillText('(P & S Wave Fault Energy)', (eqX1 + eqX2) / 2, padTop + 24);

  ctx.fillStyle = '#c084fc';
  ctx.fillText(compact ? '🏙️ URBAN' : '🏙️ URBAN CULTURAL NOISE', (urbanX1 + urbanX2) / 2, padTop + 14);
  if (!compact) ctx.fillText('(Traffic, Trucks, Footsteps)', (urbanX1 + urbanX2) / 2, padTop + 24);

  // 3. Grid Lines & Axis Markings
  ctx.font = '9px JetBrains Mono, monospace';

  [-80, -100, -120, -140, -160].forEach((db) => {
    const y = toY(db);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    ctx.fillText(`${db} dB`, padLeft - 6, y + 3);
  });

  const freqTicks = compact
    ? [
        { f: 0.1, label: '0.1Hz' },
        { f: 0.5, label: '0.5Hz' },
        { f: 1.0, label: '1Hz' },
        { f: 5.0, label: '5Hz' },
        { f: 10.0, label: '10Hz' },
        { f: 50.0, label: '50Hz' },
      ]
    : [
        { f: 0.1, label: '0.1 Hz (10s)' },
        { f: 0.2, label: '0.2 Hz (5s)' },
        { f: 0.5, label: '0.5 Hz (2s)' },
        { f: 1.0, label: '1.0 Hz (1s)' },
        { f: 5.0, label: '5.0 Hz' },
        { f: 10.0, label: '10 Hz (0.1s)' },
        { f: 25.0, label: '25 Hz' },
        { f: 50.0, label: '50 Hz' },
      ];

  freqTicks.forEach((t) => {
    const x = toX(t.f);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + plotH);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.fillText(t.label, x, padTop + plotH + 15);
  });

  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'center';
  ctx.fillText('Frequency (Hz) — Log Scale', padLeft + plotW / 2, padTop + plotH + 31);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(padLeft, padTop, plotW, plotH);

  // 4. NHNM & NLNM Benchmarks
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 2.0;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  NHNM_POINTS.forEach((pt, i) => {
    const x = toX(pt.f);
    const y = toY(pt.db);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = '9px JetBrains Mono, monospace';
  ctx.fillStyle = '#ef4444';
  ctx.textAlign = 'left';
  ctx.fillText(compact ? '🔴 NHNM' : '🔴 USGS NHNM (High Noise Ceiling)', padLeft + 10, toY(-84) - 4);

  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2.0;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  NLNM_POINTS.forEach((pt, i) => {
    const x = toX(pt.f);
    const y = toY(pt.db);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#38bdf8';
  ctx.textAlign = 'left';
  ctx.fillText(compact ? '🔵 NLNM' : '🔵 USGS NLNM (Global Quiet Baseline)', padLeft + 10, toY(-162) + 14);

  // 5. Compute Dual-Resolution Station PSD (Sub-Hz 0.1–0.8 Hz + High-Freq 0.8–50 Hz)
  const ehzBuf = state.buffers.EHZ;
  if (!ehzBuf || ehzBuf.length < 32) return;

  const highMags = computeFFT256(ehzBuf, highScratch);
  const lf = computeLowFreqFFT(ehzBuf, 10, lowScratch);
  const lowMags = lf.magnitudes;

  if (!isInitialized) {
    for (let b = 0; b < N_HIGH_BINS; b++) smoothedHighPsd[b] = highMags[b];
    for (let b = 0; b < N_LOW_BINS; b++) smoothedLowPsd[b] = lowMags[b];
    isInitialized = true;
  } else {
    const alpha = 0.08;
    for (let b = 0; b < N_HIGH_BINS; b++) {
      smoothedHighPsd[b] = smoothedHighPsd[b] * (1.0 - alpha) + highMags[b] * alpha;
    }
    for (let b = 0; b < N_LOW_BINS; b++) {
      smoothedLowPsd[b] = smoothedLowPsd[b] * (1.0 - alpha) + lowMags[b] * alpha;
    }
  }

  // Convert velocity FFT magnitude to acceleration PSD in dB rel. 1 (m/s^2)^2/Hz
  // a(f) = 2πf * v(f) -> +20 log10(2πf); calibrated for RS4D EHZ 0.05 µm/s per count
  const velCountToAccelDb = (mag, freqHz) => {
    const omega = 2.0 * Math.PI * Math.max(freqHz, 0.08);
    // 1/sqrt(N*fs) spectral density normalization + RS4D sensitivity
    const velMsHz = Math.max(mag * 0.05e-6 * 0.14, 1e-11);
    const accPsd = (omega * velMsHz) ** 2;
    return Math.max(-178, Math.min(-72, 10.0 * Math.log10(accPsd)));
  };

  const fullSpectrum = [];

  // Low-frequency bins (0.10 Hz to 0.78 Hz) from 10x decimated FFT
  if (lf.nBlocks >= 32) {
    const minLfBin = Math.max(2, Math.round(0.1 / lf.binWidthHz));
    const maxLfBin = Math.min(N_LOW_BINS - 1, Math.floor(0.75 / lf.binWidthHz));
    for (let b = minLfBin; b <= maxLfBin; b++) {
      const freq = b * lf.binWidthHz;
      const db = velCountToAccelDb(smoothedLowPsd[b] / 4.0, freq);
      fullSpectrum.push({ f: freq, db });
    }
  }

  // High-frequency bins (0.78 Hz to 50 Hz) with 5-point triangular smoothing
  const startHighBin = fullSpectrum.length > 0 ? 2 : 1;
  for (let b = startHighBin; b < N_HIGH_BINS; b++) {
    let sumWeight = 0;
    let weightedMag = 0;
    for (let k = -2; k <= 2; k++) {
      const idx = Math.max(1, Math.min(N_HIGH_BINS - 1, b + k));
      const wt = 3 - Math.abs(k);
      weightedMag += smoothedHighPsd[idx] * wt;
      sumWeight += wt;
    }
    weightedMag /= sumWeight;
    const freq = b * 0.390625;
    fullSpectrum.push({ f: freq, db: velCountToAccelDb(weightedMag, freq) });
  }

  lastFullSpectrum = fullSpectrum;

  // 6. Plot Live Station PSD Curve & Compute Exact Excess Over NHNM
  ctx.save();
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 2.4;
  ctx.shadowColor = '#00ff88';
  ctx.shadowBlur = 6;
  ctx.beginPath();

  let maxExcessOverNhnm = -999;
  fullSpectrum.forEach((pt, idx) => {
    const x = toX(pt.f);
    const y = toY(pt.db);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);

    const nhnmDb = interpModelDb(NHNM_POINTS, pt.f);
    const excess = pt.db - nhnmDb;
    if (excess > maxExcessOverNhnm) maxExcessOverNhnm = excess;
  });

  ctx.stroke();
  ctx.restore();

  // 7. Live Status Indicator Badge (Clamped cleanly inside canvas width)
  let statusText = compact
    ? '🟢 WITHIN PETERSON BOUNDS'
    : '🟢 WITHIN PETERSON BOUNDS (Healthy Station Baseline)';
  let statusBg = 'rgba(34, 197, 94, 0.18)';
  let statusColor = '#22c55e';
  let statusBorder = 'rgba(34, 197, 94, 0.4)';

  if (maxExcessOverNhnm > 12.0) {
    statusText = compact
      ? `⚡ +${maxExcessOverNhnm.toFixed(1)} dB > NHNM`
      : `⚡ ANOMALOUS (+${maxExcessOverNhnm.toFixed(1)} dB above NHNM — Active Shaking!)`;
    statusBg = 'rgba(239, 68, 68, 0.22)';
    statusColor = '#ef4444';
    statusBorder = 'rgba(239, 68, 68, 0.5)';
  } else if (maxExcessOverNhnm > 0) {
    statusText = compact
      ? `🟡 +${maxExcessOverNhnm.toFixed(1)} dB > NHNM`
      : `🟡 ELEVATED (+${maxExcessOverNhnm.toFixed(1)} dB above NHNM — Local Activity)`;
    statusBg = 'rgba(245, 158, 11, 0.2)';
    statusColor = '#f59e0b';
    statusBorder = 'rgba(245, 158, 11, 0.4)';
  }

  ctx.font = compact ? '9px JetBrains Mono, monospace' : '10px JetBrains Mono, monospace';
  const badgeW = Math.min(w - padLeft - padRight, ctx.measureText(statusText).width + 16);
  const badgeX = Math.max(padLeft, w - padRight - badgeW);
  const badgeY = 8;

  ctx.fillStyle = statusBg;
  ctx.strokeStyle = statusBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, badgeW, 20, 4);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = statusColor;
  ctx.textAlign = 'left';
  ctx.fillText(statusText, badgeX + 8, badgeY + 14, badgeW - 14);

  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillStyle = '#00ff88';
  ctx.fillText(compact ? '🟢 Real-Time PSD' : '🟢 AM.R1A3D Real-Time Spectrum (Dual Welch PSD)', padLeft, compact ? 42 : 22);

  // 8. Interactive Hover Crosshair & Frequency Readout
  if (
    hoverState.active &&
    hoverState.x >= padLeft &&
    hoverState.x <= padLeft + plotW &&
    hoverState.y >= padTop &&
    hoverState.y <= padTop + plotH &&
    lastFullSpectrum.length > 0
  ) {
    const normX = (hoverState.x - padLeft) / plotW;
    const hoverLogF = minLogF + normX * (maxLogF - minLogF);
    const hoverFreq = Math.pow(10, hoverLogF);
    const hoverPeriod = 1.0 / hoverFreq;

    let closestPt = lastFullSpectrum[0];
    let bestDiff = Infinity;
    for (let i = 0; i < lastFullSpectrum.length; i++) {
      const d = Math.abs(lastFullSpectrum[i].f - hoverFreq);
      if (d < bestDiff) {
        bestDiff = d;
        closestPt = lastFullSpectrum[i];
      }
    }

    const nlnmVal = interpModelDb(NLNM_POINTS, hoverFreq);
    const nhnmVal = interpModelDb(NHNM_POINTS, hoverFreq);
    const ptX = toX(closestPt.f);
    const ptY = toY(closestPt.db);

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(ptX, padTop);
    ctx.lineTo(ptX, padTop + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#00ff88';
    ctx.beginPath();
    ctx.arc(ptX, ptY, 4.5, 0, Math.PI * 2);
    ctx.fill();

    const line1 = `${closestPt.f.toFixed(2)} Hz (${hoverPeriod.toFixed(2)}s) · Station: ${closestPt.db.toFixed(1)} dB`;
    const line2 = `NLNM: ${nlnmVal.toFixed(0)} dB | NHNM: ${nhnmVal.toFixed(0)} dB`;
    const line3 = describeFrequencyBand(closestPt.f);

    ctx.font = '600 10px JetBrains Mono, monospace';
    const boxW = Math.min(
      w - 20,
      Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width, ctx.measureText(line3).width) + 20
    );
    const boxH = 54;
    const boxX = ptX + 12 + boxW > padLeft + plotW ? Math.max(padLeft + 4, ptX - boxW - 12) : ptX + 12;
    const boxY = Math.max(padTop + 4, Math.min(padTop + plotH - boxH - 4, ptY - boxH / 2));

    ctx.fillStyle = 'rgba(10, 15, 28, 0.94)';
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 5);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(line1, boxX + 10, boxY + 15);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '500 9.5px JetBrains Mono, monospace';
    ctx.fillText(line2, boxX + 10, boxY + 30);
    ctx.fillStyle = '#38bdf8';
    ctx.font = '500 9.5px Inter, sans-serif';
    ctx.fillText(line3, boxX + 10, boxY + 45);
  }
}
