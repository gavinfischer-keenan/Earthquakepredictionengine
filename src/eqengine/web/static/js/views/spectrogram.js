/**
 * High-Definition DataView Spectrogram & Synchronized Seismogram View
 * Inspired by Raspberry Shake DataView:
 * 1. Top Panel: Live EHZ Ground Velocity Seismogram with UTC time-axis ticks and amplitude scale.
 * 2. Bottom Panel: High-Resolution 0–50 Hz STFT Waterfall Spectrogram with Inferno/Magma colormap,
 *    continuous frequency gridlines (10, 20, 30, 40, 50 Hz), and matching UTC timestamps.
 * 3. 100% Viewport-Fit: Zero vertical/horizontal scrolling, auto-scaling to screen dimensions.
 */

import { state, SAMPLING_RATE } from '../state.js';
import { elements } from '../dom.js';
import { filterData, computeFFT256, getMagColor32 } from '../dsp.js';

let offscreenCanvas = null;
let offscreenCtx = null;
let offscreenImgData = null;
let offscreenData32 = null;
let lastFftW = 0;
let lastFftH = 0;

export function renderSpectrogram() {
  const specCanvas = document.getElementById('spectrogramCanvas');
  const waveCanvas = document.getElementById('specWaveformCanvas');
  if (!specCanvas) return;

  const windowSec = state.windowSec || 30;
  const rawBuf = state.buffers.EHZ || [];
  const tsBuf = state.timestamps.EHZ || [];
  const nBuf = rawBuf.length;

  // -------------------------------------------------------------------------
  // 1. Time Synchronization
  // -------------------------------------------------------------------------
  let latestSampleT = state.latestStreamTimestamp || 0;
  if (latestSampleT === 0 && tsBuf.length > 0) {
    latestSampleT = tsBuf[tsBuf.length - 1];
  }

  let endT;
  if (state.paused) {
    endT = state.lastPausedTimestamp || latestSampleT || (Date.now() / 1000);
  } else if (latestSampleT > 0) {
    const elapsed = Math.max((Date.now() - (state.lastPacketArrivalLocalMs || Date.now())) / 1000.0, 0.0);
    endT = latestSampleT + Math.min(elapsed, 0.5);
  } else {
    endT = Date.now() / 1000;
  }
  const startT = endT - windowSec;

  // Extract visible window samples
  const visibleSamples = [];
  const visibleTimes = [];
  if (nBuf > 0 && tsBuf.length === nBuf) {
    // Binary search or linear scan for start index
    let startIdx = 0;
    while (startIdx < nBuf && tsBuf[startIdx] < startT) {
      startIdx++;
    }
    for (let i = startIdx; i < nBuf; i++) {
      if (tsBuf[i] <= endT + 0.1) {
        visibleSamples.push(rawBuf[i]);
        visibleTimes.push(tsBuf[i]);
      }
    }
  }

  const filteredSamples = filterData(visibleSamples, state.filterMode || 'bandpass');

  // -------------------------------------------------------------------------
  // 2. Render Top Seismogram Waveform (if container exists)
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

      const plotH = wH - 18; // Leave 18px for tick labels
      const midY = plotH / 2;

      // Center baseline
      ctxW.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctxW.lineWidth = 1;
      ctxW.beginPath();
      ctxW.moveTo(40, midY);
      ctxW.lineTo(wW - 10, midY);
      ctxW.stroke();

      // Determine Amplitude Scale (Auto-gain or fixed)
      let maxAmp = 100;
      if (state.gainMode === 'auto') {
        let peak = 10;
        for (let i = 0; i < filteredSamples.length; i++) {
          const absVal = Math.abs(filteredSamples[i]);
          if (absVal > peak) peak = absVal;
        }
        maxAmp = Math.max(peak * 1.3, 50);
      } else {
        maxAmp = parseFloat(state.gainMode) || 2000;
      }

      // Draw Time Grid Lines
      const secStep = windowSec <= 15 ? 2 : windowSec <= 30 ? 5 : windowSec <= 120 ? 15 : 60;
      const firstSec = Math.ceil(startT / secStep) * secStep;

      ctxW.font = '9px JetBrains Mono, monospace';
      ctxW.textAlign = 'center';

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

      // Draw Waveform Trace
      if (filteredSamples.length > 1) {
        ctxW.strokeStyle = '#00ff88';
        ctxW.lineWidth = 1.4;
        ctxW.beginPath();

        let hasMoved = false;
        for (let i = 0; i < filteredSamples.length; i++) {
          const t = visibleTimes[i];
          const x = 40 + ((t - startT) / windowSec) * (wW - 50);
          const y = midY - (filteredSamples[i] / maxAmp) * (plotH / 2);

          if (!hasMoved) {
            ctxW.moveTo(x, y);
            hasMoved = true;
          } else {
            ctxW.lineTo(x, y);
          }
        }
        ctxW.stroke();
      }

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
      ctxW.fillText('EHZ (Velocity)', 46, 14);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Render High-Resolution STFT Waterfall Spectrogram
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

  // Deep Obsidian background
  ctxS.fillStyle = '#060913';
  ctxS.fillRect(0, 0, sW, sH);

  const padL = 40;
  const padR = 10;
  const padB = 22; // For UTC Time axis
  const padT = 6;
  const plotW = Math.max(sW - padL - padR, 10);
  const plotH = Math.max(sH - padT - padB, 10);

  // Compute STFT Overlapping Columns across the visible window
  const fftCols = Math.min(Math.floor(plotW), 512);
  const fftH = Math.min(Math.floor(plotH), 256);

  if (!offscreenCanvas || lastFftW !== fftCols || lastFftH !== fftH) {
    offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = fftCols;
    offscreenCanvas.height = fftH;
    offscreenCtx = offscreenCanvas.getContext('2d');
    offscreenImgData = offscreenCtx.createImageData(fftCols, fftH);
    offscreenData32 = new Uint32Array(offscreenImgData.data.buffer);
    lastFftW = fftCols;
    lastFftH = fftH;
  }

  // Clear offscreen buffer to background (0xFF130906 Little Endian RGBA)
  offscreenData32.fill(0xFF130906);

  const nVis = visibleSamples.length;
  if (nVis >= 16) {
    const fftWinSize = 256;
    const halfWin = fftWinSize / 2;
    const gainMultiplier = state.gainMode === 'auto' ? 1.8 : (parseFloat(state.gainMode) ? 1000.0 / parseFloat(state.gainMode) : 1.0);

    const chunk = new Float64Array(fftWinSize);

    for (let c = 0; c < fftCols; c++) {
      // Map column to timestamp
      const colRatio = c / (fftCols - 1);
      const colTime = startT + colRatio * windowSec;

      // Find nearest sample index in visibleTimes
      const centerIdx = Math.floor(colRatio * (nVis - 1));
      const sStart = Math.max(0, centerIdx - halfWin);
      const sEnd = Math.min(nVis, sStart + fftWinSize);

      chunk.fill(0);
      let chunkIdx = 0;
      for (let i = sStart; i < sEnd; i++) {
        chunk[chunkIdx++] = visibleSamples[i];
      }

      // Compute 256-point FFT
      const mags = computeFFT256(chunk);
      const nBins = mags.length; // 128 bins (0 - 50 Hz)

      // Render vertical column from 0 Hz (bottom) to 50 Hz (top)
      for (let y = 0; y < fftH; y++) {
        const normY = 1.0 - (y / Math.max(fftH - 1, 1));
        const binFloat = normY * (nBins - 1);
        const b0 = Math.floor(binFloat);
        const b1 = Math.min(nBins - 1, b0 + 1);
        const frac = binFloat - b0;

        const magInterp = mags[b0] * (1.0 - frac) + mags[b1] * frac;
        offscreenData32[y * fftCols + c] = getMagColor32(magInterp, gainMultiplier);
      }
    }

    offscreenCtx.putImageData(offscreenImgData, 0, 0);

    // Blit smooth interpolated heatmap to main canvas
    ctxS.imageSmoothingEnabled = true;
    ctxS.imageSmoothingQuality = 'high';
    ctxS.drawImage(offscreenCanvas, padL, padT, plotW, plotH);
  }

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

  // Spectrogram Border
  ctxS.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctxS.lineWidth = 1;
  ctxS.strokeRect(padL, padT, plotW, plotH);
}
