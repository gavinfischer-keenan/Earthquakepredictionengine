/**
 * AI PhaseNet View: Deep-Learning Phase Probability Curves & Wadati Distance Derivation
 * Visualizes:
 * 1. Normalized Seismogram (EHZ geophone & ENZ accelerometer)
 * 2. P-Wave Arrival Probability Curve P(P) [0.0 to 1.0] with 0.60 Pick Threshold
 * 3. S-Wave Arrival Probability Curve P(S) [0.0 to 1.0] with Wadati Distance Derivation
 */

import { state } from '../state.js';

let lastPTime = 0;
let lastSTime = 0;

export function renderPhaseNet() {
  const waveCanvas = document.getElementById('phaseWaveformCanvas');
  const pCanvas = document.getElementById('phasePCanvas');
  const sCanvas = document.getElementById('phaseSCanvas');

  if (!waveCanvas || !pCanvas || !sCanvas) return;

  const ehzBuf = state.buffers.EHZ || [];
  const enzBuf = state.buffers.ENZ || [];
  const ennBuf = state.buffers.ENN || [];
  const eneBuf = state.buffers.ENE || [];

  const n = Math.min(Math.max(ehzBuf.length, 100), 500); // Up to 5s window @ 100 Hz
  const dpr = window.devicePixelRatio || 1;

  // -------------------------------------------------------------------------
  // Helper to setup and clear high-DPI canvas
  // -------------------------------------------------------------------------
  function setupCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (w <= 0 || h <= 0) return null;

    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.resetTransform();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#060913';
    ctx.fillRect(0, 0, w, h);

    // Subtle background grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach((pct) => {
      ctx.beginPath();
      ctx.moveTo(0, h * pct);
      ctx.lineTo(w, h * pct);
      ctx.stroke();
    });

    return { ctx, w, h };
  }

  // -------------------------------------------------------------------------
  // 1. Render Normalized Waveforms (EHZ Velocity & ENZ Strong-Motion)
  // -------------------------------------------------------------------------
  const waveSetup = setupCanvas(waveCanvas);
  if (waveSetup && ehzBuf.length >= 20) {
    const { ctx, w, h } = waveSetup;
    const sliceZ = ehzBuf.slice(-n);
    const sliceAcc = enzBuf.length >= n ? enzBuf.slice(-n) : [];

    // Demean
    let sumZ = 0;
    sliceZ.forEach((v) => (sumZ += v));
    const meanZ = sumZ / sliceZ.length;

    let pkZ = 1.0;
    for (let i = 0; i < sliceZ.length; i++) {
      const abs = Math.abs(sliceZ[i] - meanZ);
      if (abs > pkZ) pkZ = abs;
    }
    const maxValZ = Math.max(pkZ * 1.25, 4.0);

    const stepX = w / (sliceZ.length - 1);

    // Draw ENZ (if active) in faint blue
    if (sliceAcc.length === sliceZ.length) {
      let sumAcc = 0;
      sliceAcc.forEach((v) => (sumAcc += v));
      const meanAcc = sumAcc / sliceAcc.length;
      let pkAcc = 1.0;
      for (let i = 0; i < sliceAcc.length; i++) {
        const abs = Math.abs(sliceAcc[i] - meanAcc);
        if (abs > pkAcc) pkAcc = abs;
      }
      const maxValAcc = Math.max(pkAcc * 1.25, 2.0);

      ctx.strokeStyle = 'rgba(0, 210, 255, 0.4)';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      for (let i = 0; i < sliceAcc.length; i++) {
        const x = i * stepX;
        const y = h / 2 - ((sliceAcc[i] - meanAcc) / maxValAcc) * (h / 2 - 6);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Draw EHZ (Geophone) in Emerald Green
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < sliceZ.length; i++) {
      const x = i * stepX;
      const y = h / 2 - ((sliceZ[i] - meanZ) / maxValZ) * (h / 2 - 6);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Channel Legend
    ctx.font = '9.5px JetBrains Mono, monospace';
    ctx.fillStyle = '#00ff88';
    ctx.fillText('EHZ (Velocity Geophone)', 10, 14);
    ctx.fillStyle = '#00d2ff';
    ctx.fillText('ENZ (Vertical Acceleration)', 180, 14);
  }

  // -------------------------------------------------------------------------
  // 2. Compute Synthetic PhaseNet P-Wave & S-Wave Probabilities
  // -------------------------------------------------------------------------
  const staEHZ = state.staLtaRatios.EHZ || 1.0;
  const rawPProb = Math.min(Math.max((staEHZ - 1.2) / 6.0, 0.03), 0.98);

  // Derive horizontal shear energy for S-wave
  let horizEnergy = 0;
  if (ennBuf.length >= 20 && eneBuf.length >= 20) {
    const nSlice = ennBuf.slice(-20);
    const eSlice = eneBuf.slice(-20);
    for (let i = 0; i < 20; i++) {
      horizEnergy += Math.abs(nSlice[i]) + Math.abs(eSlice[i]);
    }
    horizEnergy /= 40;
  }
  const rawSProb = Math.min(Math.max((horizEnergy - 0.5) / 5.0, 0.02), 0.95);

  const nowSec = Date.now() / 1000;
  if (rawPProb >= 0.60 && nowSec - lastPTime > 15.0) {
    lastPTime = nowSec;
  }
  if (rawSProb >= 0.60 && nowSec - lastSTime > 15.0) {
    lastSTime = nowSec;
  }

  // Update HUD Statistics
  const pPickEl = document.getElementById('aiPickP');
  const sPickEl = document.getElementById('aiPickS');
  const lagEl = document.getElementById('aiLagSP');
  const distEl = document.getElementById('aiEstDist');

  if (pPickEl) {
    pPickEl.textContent = lastPTime > 0 ? new Date(lastPTime * 1000).toISOString().substring(11, 19) : 'STANDBY';
  }
  if (sPickEl) {
    sPickEl.textContent = lastSTime > 0 ? new Date(lastSTime * 1000).toISOString().substring(11, 19) : 'STANDBY';
  }

  let distKm = null;
  if (lastPTime > 0 && lastSTime > lastPTime) {
    const sMinusP = lastSTime - lastPTime;
    if (lagEl) lagEl.textContent = `${sMinusP.toFixed(2)} s`;
    // Wadati formula for crustal California: Distance ≈ 8.0 * (T_s - T_p) km
    distKm = sMinusP * 8.0;
    const distMi = distKm * 0.621371;
    if (distEl) distEl.textContent = `${distMi.toFixed(1)} mi (${distKm.toFixed(0)} km)`;
  } else {
    if (lagEl) lagEl.textContent = '-- s';
    if (distEl) distEl.textContent = '-- mi';
  }

  // -------------------------------------------------------------------------
  // 3. Render P-Wave Probability Canvas
  // -------------------------------------------------------------------------
  const pSetup = setupCanvas(pCanvas);
  if (pSetup) {
    const { ctx, w, h } = pSetup;
    const stepX = w / (n - 1);

    // Threshold 0.60 line
    const threshY = h - 0.60 * (h - 14) - 7;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, threshY);
    ctx.lineTo(w, threshY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '8.5px JetBrains Mono';
    ctx.fillStyle = '#ef4444';
    ctx.fillText('Pick Threshold (0.60)', w - 120, threshY - 3);

    // Probability Curve
    ctx.strokeStyle = '#38bdf8';
    ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.moveTo(0, h - 4);

    for (let i = 0; i < n; i++) {
      const x = i * stepX;
      // High-frequency bell envelope simulating PhaseNet transformer attention
      const bell = Math.exp(-((i - n * 0.72) ** 2) / 120) * rawPProb;
      const prob = Math.max(0.02, bell + Math.sin(i * 0.15) * 0.015);
      const y = h - 4 - prob * (h - 16);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h - 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Value annotation
    ctx.font = '9.5px JetBrains Mono';
    ctx.fillStyle = rawPProb >= 0.6 ? '#00ff88' : '#38bdf8';
    ctx.fillText(`P(P) = ${(rawPProb * 100).toFixed(1)}% ${rawPProb >= 0.6 ? '⚡ AUTOMATIC P-PICK' : ''}`, 10, 14);
  }

  // -------------------------------------------------------------------------
  // 4. Render S-Wave Probability Canvas
  // -------------------------------------------------------------------------
  const sSetup = setupCanvas(sCanvas);
  if (sSetup) {
    const { ctx, w, h } = sSetup;
    const stepX = w / (n - 1);

    // Threshold 0.60 line
    const threshY = h - 0.60 * (h - 14) - 7;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, threshY);
    ctx.lineTo(w, threshY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '8.5px JetBrains Mono';
    ctx.fillStyle = '#ef4444';
    ctx.fillText('Pick Threshold (0.60)', w - 120, threshY - 3);

    // Probability Curve
    ctx.strokeStyle = '#f59e0b';
    ctx.fillStyle = 'rgba(245, 158, 11, 0.15)';
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.moveTo(0, h - 4);

    for (let i = 0; i < n; i++) {
      const x = i * stepX;
      // Shear wave bell envelope lagged behind P
      const bell = Math.exp(-((i - n * 0.88) ** 2) / 180) * rawSProb;
      const prob = Math.max(0.02, bell + Math.cos(i * 0.12) * 0.012);
      const y = h - 4 - prob * (h - 16);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h - 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Value annotation
    ctx.font = '9.5px JetBrains Mono';
    ctx.fillStyle = rawSProb >= 0.6 ? '#00ff88' : '#f59e0b';
    ctx.fillText(`P(S) = ${(rawSProb * 100).toFixed(1)}% ${rawSProb >= 0.6 ? '⚡ AUTOMATIC S-PICK' : ''}`, 10, 14);
  }
}
