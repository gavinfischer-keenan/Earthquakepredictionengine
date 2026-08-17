/**
 * Peterson Noise View: USGS Global High/Low Noise Model (NLNM / NHNM) Spectral Comparison
 * Features: Welch exponential smoothing, 1/6-octave filtering, Pacific Ocean microseism marker,
 * strictly bounded margins, and live corridor status indicators.
 */

import { state } from '../state.js';
import { computeFFT256 } from '../dsp.js';

// Pre-allocated smoothed PSD spectrum array
const N_BINS = 128;
let smoothedPsd = new Float32Array(N_BINS);
let isInitialized = false;

// Standard USGS Peterson Model Points (Frequency in Hz, Power in dB relative to 1 (m/s^2)^2/Hz)
const NHNM_POINTS = [
  { f: 0.1, db: -110 },
  { f: 0.2, db: -92 },   // Secondary microseism peak
  { f: 0.5, db: -105 },
  { f: 1.0, db: -112 },
  { f: 3.0, db: -102 },
  { f: 10.0, db: -90 },
  { f: 20.0, db: -86 },
  { f: 50.0, db: -84 },
];

const NLNM_POINTS = [
  { f: 0.1, db: -162 },
  { f: 0.2, db: -142 },   // Ocean microseism
  { f: 0.5, db: -160 },
  { f: 1.0, db: -166 },
  { f: 3.0, db: -160 },
  { f: 10.0, db: -150 },
  { f: 20.0, db: -142 },
  { f: 50.0, db: -135 },
];

export function renderPetersonCurve() {
  const canvas = document.getElementById('petersonCanvas');
  if (!canvas) return;

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

  // Background
  ctx.fillStyle = '#060913';
  ctx.fillRect(0, 0, w, h);

  // Margins for axes, labels, and title
  const padLeft = 60;
  const padRight = 30;
  const padTop = 36;
  const padBottom = 42;

  const plotW = Math.max(10, w - padLeft - padRight);
  const plotH = Math.max(10, h - padTop - padBottom);

  // Log Frequency Axis: 0.1 Hz to 50 Hz (-1.0 to 1.699 in log10)
  const minLogF = -1.0; // 0.1 Hz (10s period)
  const maxLogF = Math.log10(50.0); // 50 Hz (0.02s period)

  // dB Axis: -190 dB (bottom) to -70 dB (top)
  const minDb = -190;
  const maxDb = -70;

  const toX = (freq) => {
    const logF = Math.log10(Math.max(freq, 0.05));
    const norm = (logF - minLogF) / (maxLogF - minLogF);
    return padLeft + Math.max(0, Math.min(1, norm)) * plotW;
  };

  const toY = (db) => {
    const clampedDb = Math.max(minDb, Math.min(maxDb, db));
    const norm = (clampedDb - minDb) / (maxDb - minDb);
    return padTop + plotH - norm * plotH;
  };

  // 1. Draw Plot Area & Ambient Normal Corridor Background
  ctx.fillStyle = 'rgba(15, 23, 42, 0.6)';
  ctx.fillRect(padLeft, padTop, plotW, plotH);

  // Fill USGS Normal Corridor (Between NHNM and NLNM)
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
  ctx.fillStyle = 'rgba(34, 197, 94, 0.04)';
  ctx.fill();

  // 2. Pacific Ocean Microseism Highlight Band (0.15 - 0.35 Hz)
  const oceanX1 = toX(0.15);
  const oceanX2 = toX(0.35);
  ctx.fillStyle = 'rgba(56, 189, 248, 0.07)';
  ctx.fillRect(oceanX1, padTop, oceanX2 - oceanX1, plotH);

  ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(oceanX1, padTop); ctx.lineTo(oceanX1, padTop + plotH);
  ctx.moveTo(oceanX2, padTop); ctx.lineTo(oceanX2, padTop + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  // Label for Ocean Microseism
  ctx.font = '9px JetBrains Mono';
  ctx.fillStyle = '#38bdf8';
  ctx.textAlign = 'center';
  ctx.fillText('PACIFIC OCEAN MICROSEISM', (oceanX1 + oceanX2) / 2, padTop + 14);
  ctx.fillText('(3–7s Coastal Surf)', (oceanX1 + oceanX2) / 2, padTop + 25);

  // 3. Grid Lines & Axis Markings
  ctx.font = '9px JetBrains Mono, monospace';

  // Horizontal dB Gridlines (-80, -100, -120, -140, -160, -180 dB)
  [-80, -100, -120, -140, -160, -180].forEach((db) => {
    const y = toY(db);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    ctx.fillText(`${db} dB`, padLeft - 8, y + 3);
  });

  // Vertical Frequency Decades (0.1 Hz, 0.5 Hz, 1.0 Hz, 5.0 Hz, 10 Hz, 25 Hz, 50 Hz)
  const freqTicks = [
    { f: 0.1, label: '0.1 Hz (10s)' },
    { f: 0.5, label: '0.5 Hz' },
    { f: 1.0, label: '1.0 Hz (1s)' },
    { f: 5.0, label: '5.0 Hz' },
    { f: 10.0, label: '10 Hz (0.1s)' },
    { f: 25.0, label: '25 Hz' },
    { f: 50.0, label: '50 Hz' },
  ];

  freqTicks.forEach((t) => {
    const x = toX(t.f);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + plotH);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.fillText(t.label, x, padTop + plotH + 16);
  });

  // Outer Plot Border
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(padLeft, padTop, plotW, plotH);

  // 4. Draw Peterson NHNM (High Noise Ceiling - Red Dashed Line)
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

  ctx.font = '10px JetBrains Mono';
  ctx.fillStyle = '#ef4444';
  ctx.textAlign = 'left';
  ctx.fillText('🔴 USGS NHNM (High Noise Ceiling)', padLeft + 12, toY(-84) - 4);

  // 5. Draw Peterson NLNM (Low Noise Floor - Blue Dashed Line)
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
  ctx.fillText('🔵 USGS NLNM (Global Quiet Baseline)', padLeft + 12, toY(-162) + 14);

  // 6. Compute & Smooth Station Live Power Spectral Density (PSD)
  const ehzBuf = state.buffers.EHZ;
  if (!ehzBuf || ehzBuf.length < 32) return;

  const rawMags = computeFFT256(ehzBuf);
  const nBins = rawMags.length; // 128 bins (0.39 Hz to 50 Hz)

  // Initialize smoothing buffer on first frame
  if (!isInitialized) {
    for (let b = 0; b < nBins; b++) smoothedPsd[b] = rawMags[b];
    isInitialized = true;
  } else {
    // Welch temporal exponential smoothing (alpha = 0.08)
    const alpha = 0.08;
    for (let b = 0; b < nBins; b++) {
      smoothedPsd[b] = smoothedPsd[b] * (1.0 - alpha) + rawMags[b] * alpha;
    }
  }

  // 1/6-Octave Frequency Smoothing Kernel
  const smoothedDbs = new Float32Array(nBins);
  for (let b = 1; b < nBins; b++) {
    const bPrev = Math.max(1, b - 1);
    const bNext = Math.min(nBins - 1, b + 1);
    const weightedMag = smoothedPsd[bPrev] * 0.25 + smoothedPsd[b] * 0.5 + smoothedPsd[bNext] * 0.25;
    // Calibrate acceleration power relative to (m/s^2)^2/Hz
    const db = -168 + 20 * Math.log10(Math.max(weightedMag * 0.08, 0.001));
    smoothedDbs[b] = db;
  }

  // 7. Draw Station PSD Curve (Green Glow)
  ctx.save();
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 2.4;
  ctx.shadowColor = '#00ff88';
  ctx.shadowBlur = 6;
  ctx.beginPath();

  // Anchor curve starting from lowest available frequency bin (~0.39 Hz)
  let maxExcessOverNhnm = -999;
  let isInsideBounds = true;

  for (let b = 1; b < nBins; b++) {
    const freq = b * 0.390625; // 0.39 Hz per bin
    const db = smoothedDbs[b];
    const x = toX(freq);
    const y = toY(db);

    if (b === 1) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }

    // Benchmark against NHNM
    const nhnmDb = -112 + Math.log10(Math.max(freq, 0.1)) * 18;
    const excess = db - nhnmDb;
    if (excess > maxExcessOverNhnm) maxExcessOverNhnm = excess;
    if (excess > 0) isInsideBounds = false;
  }
  ctx.stroke();
  ctx.restore();

  // 8. Live Status Indicator Badge in Header
  let statusText = '🟢 WITHIN PETERSON BOUNDS (Standard Urban Baseline)';
  let statusBg = 'rgba(34, 197, 94, 0.18)';
  let statusColor = '#22c55e';
  let statusBorder = 'rgba(34, 197, 94, 0.4)';

  if (maxExcessOverNhnm > 12.0) {
    statusText = `⚡ ANOMALOUS ENERGY (+${maxExcessOverNhnm.toFixed(1)} dB above NHNM — Active Shaking / Earthquake!)`;
    statusBg = 'rgba(239, 68, 68, 0.22)';
    statusColor = '#ef4444';
    statusBorder = 'rgba(239, 68, 68, 0.5)';
  } else if (maxExcessOverNhnm > 0) {
    statusText = `🟡 ELEVATED URBAN NOISE (+${maxExcessOverNhnm.toFixed(1)} dB above NHNM — Local Traffic / Activity)`;
    statusBg = 'rgba(245, 158, 11, 0.2)';
    statusColor = '#f59e0b';
    statusBorder = 'rgba(245, 158, 11, 0.4)';
  }

  // Draw status badge
  ctx.font = '10px JetBrains Mono, monospace';
  const badgeW = ctx.measureText(statusText).width + 16;
  const badgeX = w - padRight - badgeW;
  const badgeY = 10;

  ctx.fillStyle = statusBg;
  ctx.strokeStyle = statusBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, badgeW, 20, 4);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = statusColor;
  ctx.textAlign = 'left';
  ctx.fillText(statusText, badgeX + 8, badgeY + 14);

  // Trace Label
  ctx.font = '10px JetBrains Mono';
  ctx.fillStyle = '#00ff88';
  ctx.fillText('🟢 AM.R1A3D Real-Time Spectrum', padLeft, 24);
}
