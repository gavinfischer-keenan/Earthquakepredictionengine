/**
 * High-Definition DataView Spectrogram & Synchronized Seismogram View
 * Inspired by Raspberry Shake DataView:
 * 1. Top Panel: Live EHZ Ground Velocity Seismogram with real UTC time-axis ticks and amplitude scale.
 * 2. Bottom Panel: High-Resolution 0–50 Hz STFT Waterfall Spectrogram with Inferno/Magma colormap,
 *    continuous frequency gridlines (0, 10, 20, 30, 40, 50 Hz), and matching UTC timestamps.
 * 3. 100% Gap-Free & Stutter-Free: Continuous direct-buffer STFT synchronized with PLL Playhead Clock.
 */

import { state, SAMPLING_RATE } from '../state.js';
import { filterData, computeFFT256, getMagColor32 } from '../dsp.js';

let specPllPlayheadT = 0;
let lastSpecPerfNow = performance.now();

let offscreenCanvas = null;
let offscreenCtx = null;
let offscreenImgData = null;
let offscreenData32 = null;
let lastCols = 0;
let lastRows = 0;

export function renderSpectrogram() {
  const specCanvas = document.getElementById('spectrogramCanvas');
  const waveCanvas = document.getElementById('specWaveformCanvas');
  if (!specCanvas) return;

  const windowSec = state.windowSec || 30;
  const rawBuf = state.buffers.EHZ || [];
  const tsBuf = state.timestamps.EHZ || [];
  const nBuf = rawBuf.length;
  if (nBuf < 10) return;

  // -------------------------------------------------------------------------
  // 1. Advance Phase-Locked Loop (PLL) Playhead Clock
  // -------------------------------------------------------------------------
  const nowPerf = performance.now();
  const dtSec = Math.max(0, Math.min((nowPerf - lastSpecPerfNow) / 1000.0, 0.1));
  lastSpecPerfNow = nowPerf;

  const latestReceivedT = state.latestStreamTimestamp || (tsBuf.length > 0 ? tsBuf[tsBuf.length - 1] : 0);

  if (state.paused) {
    // Retain paused position
  } else if (latestReceivedT > 0) {
    if (specPllPlayheadT === 0 || Math.abs(specPllPlayheadT - latestReceivedT) > 4.0) {
      specPllPlayheadT = latestReceivedT - 0.15;
    } else {
      const drift = (latestReceivedT - 0.15) - specPllPlayheadT;
      const rateTrim = Math.max(-0.25, Math.min(0.25, drift * 0.6));
      specPllPlayheadT += dtSec * (1.0 + rateTrim);
    }
  } else {
    specPllPlayheadT = Date.now() / 1000;
  }

  const endT = state.paused ? (state.lastPausedTimestamp || specPllPlayheadT) : specPllPlayheadT;
  const startT = endT - windowSec;

  // Extract visible window samples matching [startT - 1.5s, endT + 0.5s]
  let startIdx = 0;
  while (startIdx < nBuf && tsBuf[startIdx] < startT - 1.5) {
    startIdx++;
  }

  const visibleRaw = [];
  const visibleTs = [];
  for (let i = startIdx; i < nBuf; i++) {
    if (tsBuf[i] <= endT + 0.5) {
      visibleRaw.push(rawBuf[i]);
      visibleTs.push(tsBuf[i]);
    }
  }

  const nVis = visibleRaw.length;
  if (nVis < 2) return;

  const filteredSamples = filterData(visibleRaw, state.filterMode || 'bandpass');

  // -------------------------------------------------------------------------
  // 2. Render Top Seismogram Waveform (EHZ Ground Velocity)
  // -------------------------------------------------------------------------
  if (waveCanvas) {
    const wRect = waveCanvas.getBoundingClientRect();
    const wW = Math.floor(wRect.width);
    const wH = Math.floor(wRect.height);

    if (wW > 0 && wH > 0) {
      const dpr = window.devicePixelRatio || 1;
      if (waveCanvas.width !== Math.round(wW * dpr) || waveCanvas.height !== Math.round(wH * dpr)) {
        waveCanvas.width = Math.round(wW * dpr);
        waveCanvas.height = Math.round(wH * dpr);
      }

      const ctxW = waveCanvas.getContext('2d');
      ctxW.resetTransform();
      ctxW.scale(dpr, dpr);

      // Deep Obsidian background
      ctxW.fillStyle = '#060913';
      ctxW.fillRect(0, 0, wW, wH);

      const plotH = wH - 18;
      const midY = plotH / 2;

      // Center baseline
      ctxW.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctxW.lineWidth = 1;
      ctxW.beginPath();
      ctxW.moveTo(40, midY);
      ctxW.lineTo(wW - 10, midY);
      ctxW.stroke();

      // Peak amplitude auto-gain
      let peak = 10;
      for (let i = 0; i < filteredSamples.length; i++) {
        const abs = Math.abs(filteredSamples[i]);
        if (abs > peak) peak = abs;
      }
      const maxAmp = state.gainMode === 'auto' ? Math.max(peak * 1.35, 40) : (parseFloat(state.gainMode) || 2000);

      // Time Grid Lines
      const secStep = windowSec <= 15 ? 2 : windowSec <= 30 ? 5 : windowSec <= 120 ? 15 : 60;
      const firstSec = Math.ceil(startT / secStep) * secStep;

      for (let t = firstSec; t <= endT; t += secStep) {
        const x = 40 + ((t - startT) / windowSec) * (wW - 50);
        if (x >= 40 && x <= wW - 10) {
          ctxW.strokeStyle = 'rgba(255, 255, 255, 0.05)';
          ctxW.beginPath();
          ctxW.moveTo(x, 0);
          ctxW.lineTo(x, plotH);
          ctxW.stroke();
        }
      }

      // Draw Waveform Trace (Continuous PLL-interpolated)
      ctxW.strokeStyle = '#00ff88';
      ctxW.lineWidth = 1.5;
      ctxW.beginPath();

      let hasStarted = false;
      for (let i = 0; i < nVis; i++) {
        const sampleT = visibleTs[i];
        const x = 40 + ((sampleT - startT) / windowSec) * (wW - 50);
        const y = midY - (filteredSamples[i] / maxAmp) * (plotH / 2 - 4);

        if (!hasStarted) {
          ctxW.moveTo(x, y);
          hasStarted = true;
        } else {
          ctxW.lineTo(x, y);
        }
      }
      ctxW.stroke();

      // Amplitude Scale Label
      ctxW.font = '9px JetBrains Mono, monospace';
      ctxW.fillStyle = '#94a3b8';
      ctxW.textAlign = 'right';
      ctxW.fillText(`+${Math.round(maxAmp)}`, 36, 12);
      ctxW.fillText(`0`, 36, midY + 3);
      ctxW.fillText(`-${Math.round(maxAmp)}`, 36, plotH - 2);

      // Channel Badge
      ctxW.font = '700 10px JetBrains Mono, monospace';
      ctxW.fillStyle = '#00ff88';
      ctxW.textAlign = 'left';
      ctxW.fillText('EHZ (Ground Velocity)', 46, 14);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Render High-Resolution STFT Waterfall Spectrogram (Continuous & Gap-Free)
  // -------------------------------------------------------------------------
  const sRect = specCanvas.getBoundingClientRect();
  const sW = Math.floor(sRect.width);
  const sH = Math.floor(sRect.height);
  if (sW <= 0 || sH <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  const canvasW = Math.round(sW * dpr);
  const canvasH = Math.round(sH * dpr);

  if (specCanvas.width !== canvasW || specCanvas.height !== canvasH) {
    specCanvas.width = canvasW;
    specCanvas.height = canvasH;
  }

  const ctxS = specCanvas.getContext('2d');
  ctxS.resetTransform();
  ctxS.scale(dpr, dpr);

  // Background
  ctxS.fillStyle = '#060913';
  ctxS.fillRect(0, 0, sW, sH);

  const padL = 40;
  const padR = 10;
  const padB = 22;
  const padT = 6;
  const plotW = Math.max(sW - padL - padR, 10);
  const plotH = Math.max(sH - padT - padB, 10);

  // Resolution: 200 STFT columns across the screen (~7 columns/sec @ 30s)
  const nCols = Math.min(Math.floor(plotW / 2), 240);
  const nFreqRows = 128; // 128 frequency bins (0 to 50 Hz)

  if (!offscreenCanvas || lastCols !== nCols || lastRows !== nFreqRows) {
    offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = nCols;
    offscreenCanvas.height = nFreqRows;
    offscreenCtx = offscreenCanvas.getContext('2d');
    offscreenImgData = offscreenCtx.createImageData(nCols, nFreqRows);
    offscreenData32 = new Uint32Array(offscreenImgData.data.buffer);
    lastCols = nCols;
    lastRows = nFreqRows;
  }

  // Compute STFT directly across continuous visible samples
  const fftChunk = new Float64Array(256);
  const gainMultiplier = state.gainMode === 'auto' ? 2.5 : (parseFloat(state.gainMode) ? 1000.0 / parseFloat(state.gainMode) : 1.2);

  for (let c = 0; c < nCols; c++) {
    const colTime = startT + (c / (nCols - 1)) * windowSec;

    // Find sample index in visibleTs closest to colTime
    const targetIdx = Math.floor(((colTime - visibleTs[0]) / Math.max(visibleTs[nVis - 1] - visibleTs[0], 0.01)) * (nVis - 1));
    const sCenter = Math.max(0, Math.min(nVis - 1, targetIdx));
    const sStart = Math.max(0, sCenter - 128);
    const sEnd = Math.min(nVis, sStart + 256);

    fftChunk.fill(0);
    let chunkIdx = 0;
    for (let i = sStart; i < sEnd; i++) {
      fftChunk[chunkIdx++] = visibleRaw[i];
    }

    const mags = computeFFT256(fftChunk);
    const nBins = mags.length;

    for (let y = 0; y < nFreqRows; y++) {
      const normY = 1.0 - (y / (nFreqRows - 1));
      const binIdx = Math.min(Math.floor(normY * nBins), nBins - 1);
      offscreenData32[y * nCols + c] = getMagColor32(mags[binIdx], gainMultiplier);
    }
  }

  offscreenCtx.putImageData(offscreenImgData, 0, 0);

  // Smooth bilinear interpolation onto high-DPI display canvas
  ctxS.imageSmoothingEnabled = true;
  ctxS.imageSmoothingQuality = 'high';
  ctxS.drawImage(offscreenCanvas, padL, padT, plotW, plotH);

  // -------------------------------------------------------------------------
  // 4. Draw Clean Frequency Axis (Y) & UTC Time Axis (X)
  // -------------------------------------------------------------------------
  ctxS.font = '9px JetBrains Mono, monospace';
  ctxS.textAlign = 'right';

  // Frequency Gridlines: 0, 10, 20, 30, 40, 50 Hz
  [0, 10, 20, 30, 40, 50].forEach((freq) => {
    const yRatio = freq / 50.0;
    const y = Math.round(padT + plotH - yRatio * plotH);

    ctxS.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctxS.lineWidth = 1;
    ctxS.setLineDash([2, 4]);
    ctxS.beginPath();
    ctxS.moveTo(padL, y);
    ctxS.lineTo(padL + plotW, y);
    ctxS.stroke();

    ctxS.fillStyle = '#94a3b8';
    ctxS.fillText(`${freq} Hz`, padL - 6, y + 3);
  });
  ctxS.setLineDash([]);

  // Time Grid & UTC Timestamps on X-Axis
  const secStep = windowSec <= 15 ? 2 : windowSec <= 30 ? 5 : windowSec <= 120 ? 15 : 60;
  const firstSec = Math.ceil(startT / secStep) * secStep;

  ctxS.textAlign = 'center';

  for (let t = firstSec; t <= endT; t += secStep) {
    const x = padL + ((t - startT) / windowSec) * plotW;
    if (x >= padL && x <= padL + plotW) {
      // Vertical gridline
      ctxS.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctxS.beginPath();
      ctxS.moveTo(x, padT);
      ctxS.lineTo(x, padT + plotH);
      ctxS.stroke();

      // Tick mark
      ctxS.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctxS.beginPath();
      ctxS.moveTo(x, padT + plotH);
      ctxS.lineTo(x, padT + plotH + 5);
      ctxS.stroke();

      // UTC Timestamp
      const d = new Date(t * 1000);
      const timeStr = d.toISOString().substring(11, 19);
      ctxS.fillStyle = '#94a3b8';
      ctxS.fillText(timeStr, x, padT + plotH + 16);
    }
  }

  // Spectrogram Outer Border
  ctxS.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctxS.lineWidth = 1;
  ctxS.strokeRect(padL, padT, plotW, plotH);
}
