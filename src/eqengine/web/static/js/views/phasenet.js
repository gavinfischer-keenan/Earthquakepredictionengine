/**
 * AI PhaseNet View: Real-Time Sliding-Window Phase Probability Curves & Wadati Distance Derivation
 * Computes authentic temporal probability envelopes from live waveforms:
 * 1. Normalized Seismogram (EHZ geophone & ENZ accelerometer)
 * 2. P-Wave Arrival Probability Curve P(P) from sliding vertical STA/LTA * Z-dominance
 * 3. S-Wave Arrival Probability Curve P(S) from sliding horizontal shear STA/LTA * H-dominance
 */

import { state } from '../state.js';
import { applyPickerModeBadge } from '../station.js';

let lastPTime = 0;
let lastSTime = 0;
const pProbArr = new Float32Array(500);
const sProbArr = new Float32Array(500);

export function renderPhaseNet() {
  const waveCanvas = document.getElementById('phaseWaveformCanvas');
  const pCanvas = document.getElementById('phasePCanvas');
  const sCanvas = document.getElementById('phaseSCanvas');

  if (!waveCanvas || !pCanvas || !sCanvas) return;

  const ehzBuf = state.buffers.EHZ || [];
  const enzBuf = state.buffers.ENZ || [];
  const ennBuf = state.buffers.ENN || [];
  const eneBuf = state.buffers.ENE || [];

  const n = Math.min(Math.max(ehzBuf.length, 100), 500); // 5.0s window @ 100 Hz
  const dpr = window.devicePixelRatio || 1;

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
  const sliceZ = ehzBuf.length >= 20 ? ehzBuf.slice(-n) : [];
  const nActual = sliceZ.length;

  const waveSetup = setupCanvas(waveCanvas);
  if (waveSetup && nActual >= 20) {
    const { ctx, w, h } = waveSetup;
    const sliceAcc = enzBuf.length >= nActual ? enzBuf.slice(-nActual) : [];

    let sumZ = 0;
    for (let i = 0; i < nActual; i++) sumZ += sliceZ[i];
    const meanZ = sumZ / nActual;

    let pkZ = 1.0;
    for (let i = 0; i < nActual; i++) {
      const abs = Math.abs(sliceZ[i] - meanZ);
      if (abs > pkZ) pkZ = abs;
    }
    const maxValZ = Math.max(pkZ * 1.25, 4.0);
    const stepX = w / (nActual - 1);

    if (sliceAcc.length === nActual) {
      let sumAcc = 0;
      for (let i = 0; i < nActual; i++) sumAcc += sliceAcc[i];
      const meanAcc = sumAcc / nActual;
      let pkAcc = 1.0;
      for (let i = 0; i < nActual; i++) {
        const abs = Math.abs(sliceAcc[i] - meanAcc);
        if (abs > pkAcc) pkAcc = abs;
      }
      const maxValAcc = Math.max(pkAcc * 1.25, 2.0);

      ctx.strokeStyle = 'rgba(0, 210, 255, 0.45)';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      for (let i = 0; i < nActual; i++) {
        const x = i * stepX;
        const y = h / 2 - ((sliceAcc[i] - meanAcc) / maxValAcc) * (h / 2 - 6);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < nActual; i++) {
      const x = i * stepX;
      const y = h / 2 - ((sliceZ[i] - meanZ) / maxValZ) * (h / 2 - 6);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.font = '9.5px JetBrains Mono, monospace';
    ctx.fillStyle = '#00ff88';
    ctx.fillText('EHZ (Velocity)', 10, 14);
    ctx.fillStyle = '#00d2ff';
    ctx.fillText('ENZ (Vert Accel)', Math.min(w - 115, 130), 14);
  }

  // -------------------------------------------------------------------------
  // 2. Compute Authentic Sliding-Window P & S Phase Probabilities
  // -------------------------------------------------------------------------
  let maxPProb = 0.02;
  let maxSProb = 0.02;
  let peakPIdx = -1;
  let peakSIdx = -1;

  if (nActual >= 30) {
    const sliceN = ennBuf.length >= nActual ? ennBuf.slice(-nActual) : null;
    const sliceE = eneBuf.length >= nActual ? eneBuf.slice(-nActual) : null;

    let meanZ = 0;
    for (let i = 0; i < nActual; i++) meanZ += sliceZ[i];
    meanZ /= nActual;

    let meanN = 0;
    let meanE = 0;
    if (sliceN && sliceE) {
      for (let i = 0; i < nActual; i++) {
        meanN += sliceN[i];
        meanE += sliceE[i];
      }
      meanN /= nActual;
      meanE /= nActual;
    }

    // Long-term baseline energy across the window
    const baselineZ =
      (state.fourMinStats && state.fourMinStats.EHZ && state.fourMinStats.EHZ.baselineAmp) || 35.0;
    let ltaZ = Math.max(baselineZ * baselineZ * 0.35, 25.0);
    let ltaH = 2.0;

    let staZ = ltaZ;
    let staH = ltaH;
    const alphaSta = 1.0 / 20.0; // ~0.2s STA
    const alphaLta = 1.0 / 300.0; // ~3.0s LTA

    for (let i = 0; i < nActual; i++) {
      const zVal = sliceZ[i] - meanZ;
      const eZ = zVal * zVal;
      staZ = alphaSta * eZ + (1.0 - alphaSta) * staZ;
      ltaZ = alphaLta * eZ + (1.0 - alphaLta) * ltaZ;

      let eH = 0;
      if (sliceN && sliceE) {
        const nVal = sliceN[i] - meanN;
        const evVal = sliceE[i] - meanE;
        eH = nVal * nVal + evVal * evVal;
      } else {
        // Fallback horizontal proxy from vertical derivative energy
        const prev = i > 0 ? sliceZ[i - 1] - meanZ : zVal;
        eH = (zVal - prev) * (zVal - prev) * 0.25;
      }
      staH = alphaSta * eH + (1.0 - alphaSta) * staH;
      ltaH = alphaLta * eH + (1.0 - alphaLta) * ltaH;

      const ratioZ = staZ / Math.max(ltaZ, 1.0);
      const ratioH = staH / Math.max(ltaH, 1.0);

      // Vertical dominance favors P-wave onset; horizontal shear ratio favors S-wave
      const zDom = eZ / Math.max(eZ + eH * 15.0, 1.0);
      const hDom = 1.0 - zDom * 0.65;

      // Logistic compression of characteristic ratios into [0.02, 0.98]
      const pLogit = (ratioZ * (0.6 + 0.6 * zDom) - 4.2) * 0.75;
      const sLogit = (ratioH * (0.6 + 0.6 * hDom) - 4.5) * 0.75;

      const pProb = 0.02 + 0.96 / (1.0 + Math.exp(-pLogit));
      const sProb = 0.02 + 0.96 / (1.0 + Math.exp(-sLogit));

      pProbArr[i] = pProb;
      sProbArr[i] = sProb;

      if (pProb > maxPProb) {
        maxPProb = pProb;
        peakPIdx = i;
      }
      if (sProb > maxSProb) {
        maxSProb = sProb;
        peakSIdx = i;
      }
    }
  }

  const ehzTs = state.timestamps.EHZ || [];
  const latestTs = ehzTs.length > 0 ? ehzTs[ehzTs.length - 1] : Date.now() / 1000;
  const dtPerSample = 0.01;

  if (maxPProb >= 0.6 && peakPIdx >= 0) {
    const pTimeEst = latestTs - (nActual - 1 - peakPIdx) * dtPerSample;
    if (Math.abs(pTimeEst - lastPTime) > 3.0) lastPTime = pTimeEst;
  }
  if (maxSProb >= 0.6 && peakSIdx >= 0) {
    const sTimeEst = latestTs - (nActual - 1 - peakSIdx) * dtPerSample;
    if (Math.abs(sTimeEst - lastSTime) > 3.0) lastSTime = sTimeEst;
  }

  // Update transparent picker mode badge & authoritative backend picks when available
  const mlPick = state.latestMlPick;
  const backendActive = Boolean(mlPick || state.station.ml_enabled);
  applyPickerModeBadge(mlPick?.label || state.station.ml_label || 'heuristic');

  // Update HUD Statistics
  const pPickEl = document.getElementById('aiPickP');
  const sPickEl = document.getElementById('aiPickS');
  const lagEl = document.getElementById('aiLagSP');
  const distEl = document.getElementById('aiEstDist');

  const authP = mlPick?.p_time ? new Date(mlPick.p_time).getTime() / 1000 : null;
  const authS = mlPick?.s_time ? new Date(mlPick.s_time).getTime() / 1000 : null;
  const showP = Number.isFinite(authP) ? authP : lastPTime;
  const showS = Number.isFinite(authS) ? authS : lastSTime;

  if (pPickEl) {
    pPickEl.textContent = showP > 0 ? new Date(showP * 1000).toISOString().substring(11, 19) : 'STANDBY';
  }
  if (sPickEl) {
    sPickEl.textContent = showS > 0 ? new Date(showS * 1000).toISOString().substring(11, 19) : 'STANDBY';
  }

  if (showP > 0 && showS > showP) {
    const sMinusP = showS - showP;
    if (lagEl) lagEl.textContent = `${sMinusP.toFixed(2)} s`;
    const distKm = sMinusP * 8.4; // Vp=6.0, Vs=3.5 -> 21/2.5 = 8.4 km/s
    const distMi = distKm * 0.621371;
    if (distEl) distEl.textContent = `${distMi.toFixed(1)} mi (${distKm.toFixed(0)} km)`;
  } else {
    if (lagEl) lagEl.textContent = '-- s';
    if (distEl) distEl.textContent = '-- mi';
  }

  const pSuffix = backendActive && mlPick?.p_probability != null
    ? ` · Backend P=${(mlPick.p_probability * 100).toFixed(0)}%`
    : ' (Z/H Heuristic)';
  const sSuffix = backendActive && mlPick?.s_probability != null
    ? ` · Backend S=${(mlPick.s_probability * 100).toFixed(0)}%`
    : ' (Z/H Heuristic)';

  // Helper to plot either P or S sliding-window probability array
  const renderProbCurve = (canvas, probArr, len, peakProb, color, fillRgba, labelPrefix, pickLabel) => {
    const setup = setupCanvas(canvas);
    if (!setup) return;
    const { ctx, w, h } = setup;
    const count = Math.max(len, 2);
    const stepX = w / (count - 1);

    const threshY = h - 0.6 * (h - 14) - 7;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, threshY);
    ctx.lineTo(w, threshY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '8.5px JetBrains Mono, monospace';
    ctx.fillStyle = '#ef4444';
    ctx.textAlign = 'right';
    ctx.fillText('Pick Threshold (0.60)', w - 8, threshY - 3);
    ctx.textAlign = 'left';

    ctx.strokeStyle = color;
    ctx.fillStyle = fillRgba;
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.moveTo(0, h - 4);

    for (let i = 0; i < count; i++) {
      const x = i * stepX;
      const prob = len >= 30 ? probArr[i] : 0.03;
      const y = h - 4 - prob * (h - 16);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h - 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.font = '9.5px JetBrains Mono, monospace';
    ctx.fillStyle = peakProb >= 0.6 ? '#00ff88' : color;
    ctx.fillText(`${labelPrefix} = ${(peakProb * 100).toFixed(1)}% ${peakProb >= 0.6 ? pickLabel : ''}`, 10, 14);
  };

  renderProbCurve(pCanvas, pProbArr, nActual, maxPProb, '#38bdf8', 'rgba(56, 189, 248, 0.15)', 'P(P)', `⚡ P-PICK${pSuffix}`);
  renderProbCurve(sCanvas, sProbArr, nActual, maxSProb, '#f59e0b', 'rgba(245, 158, 11, 0.15)', 'P(S)', `⚡ S-PICK${sSuffix}`);
}
