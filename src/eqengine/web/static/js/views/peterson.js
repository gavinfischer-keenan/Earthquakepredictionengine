/**
 * Peterson Noise View: USGS Global High/Low Noise Model (NLNM / NHNM) Spectral Comparison
 */

import { state } from '../state.js';
import { computeFFT256 } from '../dsp.js';

export function renderPetersonCurve() {
  const canvas = document.getElementById('petersonCanvas');
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  if (w <= 0 || h <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  const ctx = canvas.getContext('2d');
  ctx.resetTransform();
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#0a0e17';
  ctx.fillRect(0, 0, w, h);

  // Log Frequency Axis: 0.01 Hz to 50 Hz (-2 to +1.7 in log10)
  // dB Axis: -200 dB (bottom) to -80 dB (top)
  const minLogF = -1.5, maxLogF = 1.7; // ~0.03 Hz to 50 Hz
  const minDb = -200, maxDb = -80;

  const toX = (freq) => {
    const logF = Math.log10(Math.max(freq, 0.01));
    return ((logF - minLogF) / (maxLogF - minLogF)) * w;
  };

  const toY = (db) => {
    return h - ((db - minDb) / (maxDb - minDb)) * h;
  };

  // 1. Draw Peterson NHNM (High Noise Model)
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  const nhnmPts = [
    [0.03, -115], [0.1, -100], [0.2, -90], [1.0, -110], [5.0, -100], [10.0, -90], [50.0, -85]
  ];
  nhnmPts.forEach(([f, db], idx) => {
    const x = toX(f), y = toY(db);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // 2. Draw Peterson NLNM (Low Noise Model)
  ctx.strokeStyle = '#38bdf8';
  ctx.beginPath();
  const nlnmPts = [
    [0.03, -185], [0.1, -165], [0.2, -145], [1.0, -168], [5.0, -155], [10.0, -145], [50.0, -135]
  ];
  nlnmPts.forEach(([f, db], idx) => {
    const x = toX(f), y = toY(db);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);

  // Labels
  ctx.font = '10px JetBrains Mono';
  ctx.fillStyle = '#ef4444';
  ctx.fillText('USGS NHNM (High Noise)', 12, toY(-88));
  ctx.fillStyle = '#38bdf8';
  ctx.fillText('USGS NLNM (Low Noise)', 12, toY(-180));

  // 3. Draw Station Live Power Spectral Density (PSD)
  const ehzBuf = state.buffers.EHZ;
  if (ehzBuf && ehzBuf.length >= 32) {
    const mags = computeFFT256(ehzBuf);
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2.0;
    ctx.shadowColor = '#00ff88';
    ctx.shadowBlur = 4;
    ctx.beginPath();

    let started = false;
    for (let b = 1; b < mags.length; b++) {
      const freq = b * 0.39; // 0.39 Hz per bin
      const mag = Math.max(mags[b], 0.001);
      // Empirical calibration to dB (acceleration power relative to 1 (m/s^2)^2/Hz)
      const db = -160 + 20 * Math.log10(mag * 0.05);
      const x = toX(freq);
      const y = toY(Math.max(-195, Math.min(-85, db)));

      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}
