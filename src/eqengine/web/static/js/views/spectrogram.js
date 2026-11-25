/**
 * High-Definition DataView Spectrogram & Synchronized Seismogram View
 * Features:
 * 1. Top Panel: Live EHZ Ground Velocity Seismogram with O(log N) window lookup & min/max envelope rendering.
 * 2. Bottom Panel: High-Resolution 0–50 Hz STFT Waterfall Spectrogram with Inferno/Magma colormap,
 *    memoized STFT column cache, and interactive hover crosshair readout.
 */

import { state, BUFFER_DELAY_SEC } from '../state.js';
import { filterData, computeFFT256, getMagColor32, lowerBound, upperBound, getExternalEvents } from '../dsp.js';
import { fetchExternalEvents } from '../external_events_client.js';

let specPllPlayheadT = 0;
let lastSpecPerfNow = performance.now();

let offscreenCanvas = null;
let offscreenCtx = null;
let offscreenImgData = null;
let offscreenData32 = null;
let lastCols = 0;
let lastRows = 0;

// Memoized STFT column cache: Map<quantizedTimeKey, Float32Array(128)>
const STFT_CACHE_MAX = 600;
const stftCache = new Map();
const fftScratch = new Float32Array(128);

// Interactive hover state
let hoverState = { active: false, x: 0, y: 0 };
let specListenersAttached = false;
let lastSpectrogramColumns = [];

function initSpectrogramHover(canvas) {
  if (specListenersAttached || !canvas) return;
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    hoverState.active = true;
    hoverState.x = e.clientX - rect.left;
    hoverState.y = e.clientY - rect.top;
  });
  canvas.addEventListener('mouseleave', () => {
    hoverState.active = false;
  });
  specListenersAttached = true;
}

function classifyFrequencyBand(freqHz) {
  if (freqHz < 0.8) return 'Ocean Microseism / Wind Sway';
  if (freqHz < 5.0) return 'Tectonic P/S / Stadium Resonance';
  if (freqHz < 8.0) return 'Fault Crustal / Rail Harmonic';
  if (freqHz < 14.5) return 'Highway & Vehicle Traffic';
  if (freqHz < 24.5) return 'Indoor Footsteps & Impacts';
  return 'Sub-Bass / High-Freq Mechanical';
}

export function renderSpectrogram() {
  const specCanvas = document.getElementById('spectrogramCanvas');
  const waveCanvas = document.getElementById('specWaveformCanvas');
  if (!specCanvas) return;

  initSpectrogramHover(specCanvas);
  fetchExternalEvents(false);

  const windowSec = state.windowSec || 30;
  const rawBuf = state.buffers.EHZ || [];
  const tsBuf = state.timestamps.EHZ || [];
  const nBuf = rawBuf.length;
  if (nBuf < 10 || tsBuf.length !== nBuf) return;

  // -------------------------------------------------------------------------
  // 1. Advance Phase-Locked Loop (PLL) Playhead Clock
  // -------------------------------------------------------------------------
  const nowPerf = performance.now();
  const dtSec = Math.max(0, Math.min((nowPerf - lastSpecPerfNow) / 1000.0, 0.1));
  lastSpecPerfNow = nowPerf;

  const latestReceivedT = state.latestStreamTimestamp || (tsBuf.length > 0 ? tsBuf[tsBuf.length - 1] : 0);

  if (state.paused) {
    // Retain paused position
  } else if (!state.buffering.isBuffering && latestReceivedT > 0) {
    const targetT = latestReceivedT - BUFFER_DELAY_SEC;
    if (specPllPlayheadT === 0 || Math.abs(specPllPlayheadT - targetT) > 15.0) {
      specPllPlayheadT = targetT;
    } else {
      const drift = targetT - specPllPlayheadT;
      const rateTrim = Math.max(-0.15, Math.min(0.15, drift * 0.25));
      specPllPlayheadT += dtSec * (1.0 + rateTrim);
    }
  } else if (!state.buffering.isBuffering) {
    specPllPlayheadT = Date.now() / 1000 - BUFFER_DELAY_SEC;
  }

  const endT = state.paused ? (state.lastPausedTimestamp || specPllPlayheadT) : specPllPlayheadT;
  const startT = endT - windowSec;

  // O(log N) binary search extraction for top waveform panel
  const startIdx = lowerBound(tsBuf, startT - 1.5);
  const endIdx = upperBound(tsBuf, endT + 0.5);
  const nVis = endIdx - startIdx;
  if (nVis < 2) return;

  const visibleRaw = rawBuf.slice(startIdx, endIdx);
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

      ctxW.fillStyle = '#060913';
      ctxW.fillRect(0, 0, wW, wH);

      const padL = wW < 450 ? 32 : 40;
      const padR = 10;
      const traceW = Math.max(wW - padL - padR, 10);
      const plotH = wH - 18;
      const midY = plotH / 2;

      ctxW.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctxW.lineWidth = 1;
      ctxW.beginPath();
      ctxW.moveTo(padL, midY);
      ctxW.lineTo(padL + traceW, midY);
      ctxW.stroke();

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
        const x = padL + ((t - startT) / windowSec) * traceW;
        if (x >= padL && x <= padL + traceW) {
          ctxW.strokeStyle = 'rgba(255, 255, 255, 0.05)';
          ctxW.beginPath();
          ctxW.moveTo(x, 0);
          ctxW.lineTo(x, plotH);
          ctxW.stroke();
        }
      }

      ctxW.strokeStyle = '#00ff88';
      ctxW.lineWidth = 1.5;
      ctxW.beginPath();

      // Decimate to pixel columns if very large window
      if (nVis > traceW * 2) {
        const pxBins = new Array(Math.ceil(traceW));
        for (let i = 0; i < nVis; i++) {
          const sampleT = tsBuf[startIdx + i];
          const px = Math.floor(((sampleT - startT) / windowSec) * traceW);
          if (px < 0 || px >= pxBins.length) continue;
          const v = filteredSamples[i];
          if (!pxBins[px]) pxBins[px] = { min: v, max: v };
          else {
            if (v < pxBins[px].min) pxBins[px].min = v;
            if (v > pxBins[px].max) pxBins[px].max = v;
          }
        }
        for (let px = 0; px < pxBins.length; px++) {
          const bin = pxBins[px];
          if (!bin) continue;
          const x = padL + px;
          const yTop = midY - Math.max(-1, Math.min(1, bin.max / maxAmp)) * (plotH / 2 - 4);
          const yBot = midY - Math.max(-1, Math.min(1, bin.min / maxAmp)) * (plotH / 2 - 4);
          ctxW.moveTo(x, yTop);
          ctxW.lineTo(x, Math.abs(yBot - yTop) < 1 ? yTop + 1 : yBot);
        }
      } else {
        let hasStarted = false;
        for (let i = 0; i < nVis; i++) {
          const sampleT = tsBuf[startIdx + i];
          const x = padL + ((sampleT - startT) / windowSec) * traceW;
          const y = midY - Math.max(-1, Math.min(1, filteredSamples[i] / maxAmp)) * (plotH / 2 - 4);
          if (!hasStarted) {
            ctxW.moveTo(x, y);
            hasStarted = true;
          } else {
            ctxW.lineTo(x, y);
          }
        }
      }
      ctxW.stroke();

      ctxW.font = '9px JetBrains Mono, monospace';
      ctxW.fillStyle = '#94a3b8';
      ctxW.textAlign = 'right';
      ctxW.fillText(`+${Math.round(maxAmp)}`, padL - 4, 12);
      ctxW.fillText('0', padL - 4, midY + 3);
      ctxW.fillText(`-${Math.round(maxAmp)}`, padL - 4, plotH - 2);

      ctxW.font = '700 10px JetBrains Mono, monospace';
      ctxW.fillStyle = '#00ff88';
      ctxW.textAlign = 'left';
      ctxW.fillText('EHZ (Ground Velocity)', padL + 6, 14);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Render High-Resolution STFT Waterfall Spectrogram (Memoized Columns)
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

  ctxS.fillStyle = '#060913';
  ctxS.fillRect(0, 0, sW, sH);

  const padL = sW < 450 ? 32 : 40;
  const padR = 10;
  const padB = 22;
  const padT = 6;
  const plotW = Math.max(sW - padL - padR, 10);
  const plotH = Math.max(sH - padT - padB, 10);

  const nCols = Math.max(40, Math.min(Math.floor(plotW / 2), 240));
  const nFreqRows = 128;

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

  const gainMultiplier =
    state.gainMode === 'auto'
      ? 2.5
      : parseFloat(state.gainMode)
        ? 1000.0 / parseFloat(state.gainMode)
        : 1.2;

  lastSpectrogramColumns = new Array(nCols);

  for (let c = 0; c < nCols; c++) {
    const colTime = startT + (c / Math.max(nCols - 1, 1)) * windowSec;
    const centerIdx = Math.min(nBuf - 1, lowerBound(tsBuf, colTime));
    const sampleT = tsBuf[centerIdx];
    const cacheKey = Math.round(sampleT * 25); // 40ms quantized key

    let mags = stftCache.get(cacheKey);
    if (!mags) {
      const sStart = Math.max(0, centerIdx - 128);
      const sEnd = Math.min(nBuf, sStart + 256);
      computeFFT256(rawBuf, fftScratch, sStart, sEnd - sStart);
      mags = new Float32Array(fftScratch);
      stftCache.set(cacheKey, mags);
      if (stftCache.size > STFT_CACHE_MAX) {
        const oldestKey = stftCache.keys().next().value;
        stftCache.delete(oldestKey);
      }
    }

    lastSpectrogramColumns[c] = mags;

    for (let y = 0; y < nFreqRows; y++) {
      const normY = 1.0 - y / (nFreqRows - 1);
      const binIdx = Math.min(Math.floor(normY * nFreqRows), nFreqRows - 1);
      offscreenData32[y * nCols + c] = getMagColor32(mags[binIdx], gainMultiplier);
    }
  }

  offscreenCtx.putImageData(offscreenImgData, 0, 0);

  ctxS.imageSmoothingEnabled = true;
  ctxS.imageSmoothingQuality = 'high';
  ctxS.drawImage(offscreenCanvas, padL, padT, plotW, plotH);

  // -------------------------------------------------------------------------
  // 4. Frequency Axis (Y) & UTC Time Axis (X)
  // -------------------------------------------------------------------------
  ctxS.font = '9px JetBrains Mono, monospace';
  ctxS.textAlign = 'right';

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
    ctxS.fillText(`${freq}Hz`, padL - 4, y + 3);
  });
  ctxS.setLineDash([]);

  const minLabelSpacing = sW < 450 ? 64 : 56;
  const secStep = windowSec <= 15 ? 2 : windowSec <= 30 ? 5 : windowSec <= 120 ? 15 : 60;
  const firstSec = Math.ceil(startT / secStep) * secStep;
  let lastLabelX = -999;

  ctxS.textAlign = 'center';
  for (let t = firstSec; t <= endT; t += secStep) {
    const x = padL + ((t - startT) / windowSec) * plotW;
    if (x >= padL && x <= padL + plotW) {
      ctxS.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctxS.beginPath();
      ctxS.moveTo(x, padT);
      ctxS.lineTo(x, padT + plotH);
      ctxS.stroke();

      if (x - lastLabelX >= minLabelSpacing && x <= padL + plotW - 24) {
        ctxS.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        ctxS.beginPath();
        ctxS.moveTo(x, padT + plotH);
        ctxS.lineTo(x, padT + plotH + 5);
        ctxS.stroke();

        const d = new Date(t * 1000);
        const timeStr = d.toISOString().substring(11, 19);
        ctxS.fillStyle = '#94a3b8';
        ctxS.fillText(timeStr, x, padT + plotH + 16);
        lastLabelX = x;
      }
    }
  }

  ctxS.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctxS.lineWidth = 1;
  ctxS.strokeRect(padL, padT, plotW, plotH);

  // Overhead Helicopter / Low Aircraft ADS-B Callout Pill + Header Badge
  const air = getExternalEvents()?.aircraft;
  const specAirBadge = document.getElementById('specAircraftBadge');
  const closestAir = air?.closest_aircraft || (Array.isArray(air?.aircraft) && air.aircraft[0]) || null;
  if (air && Number(air.low_overhead_count || 0) > 0 && closestAir) {
    const icon = closestAir.is_helicopter ? '🚁' : '✈️';
    const altStr = closestAir.altitude_ft != null ? `${Math.round(closestAir.altitude_ft).toLocaleString()} ft` : 'low alt';
    const airLabel = closestAir.is_helicopter
      ? `${icon} Low helicopter overhead (${altStr})`
      : `${icon} Low aircraft overhead (${altStr})`;
    if (specAirBadge) {
      specAirBadge.textContent = `${icon} ${closestAir.callsign || closestAir.aircraft_type || 'ADS-B'} · ${altStr}`;
      specAirBadge.style.display = 'inline-flex';
    }
    ctxS.save();
    ctxS.font = 'bold 10px JetBrains Mono, monospace';
    const pillW = Math.min(plotW - 16, ctxS.measureText(airLabel).width + 20);
    const pillX = padL + plotW - pillW - 8;
    const pillY = padT + 8;
    ctxS.fillStyle = 'rgba(8, 22, 40, 0.86)';
    ctxS.strokeStyle = closestAir.is_helicopter ? '#fbbf24' : '#38bdf8';
    ctxS.lineWidth = 1.2;
    ctxS.beginPath();
    ctxS.roundRect(pillX, pillY, pillW, 22, 5);
    ctxS.fill();
    ctxS.stroke();
    ctxS.fillStyle = closestAir.is_helicopter ? '#fde68a' : '#bae6fd';
    ctxS.textAlign = 'left';
    ctxS.fillText(airLabel, pillX + 10, pillY + 14.5);
    ctxS.restore();
  } else if (specAirBadge) {
    specAirBadge.style.display = 'none';
  }

  // -------------------------------------------------------------------------
  // 5. Interactive Hover Crosshair & Spectral Band Readout
  // -------------------------------------------------------------------------
  if (
    hoverState.active &&
    hoverState.x >= padL &&
    hoverState.x <= padL + plotW &&
    hoverState.y >= padT &&
    hoverState.y <= padT + plotH
  ) {
    const normX = (hoverState.x - padL) / plotW;
    const normY = 1.0 - (hoverState.y - padT) / plotH;
    const hoverTime = startT + normX * windowSec;
    const hoverFreq = Math.max(0, Math.min(50, normY * 50));
    const colIdx = Math.min(nCols - 1, Math.max(0, Math.round(normX * (nCols - 1))));
    const binIdx = Math.min(127, Math.max(0, Math.round((hoverFreq / 50) * 127)));
    const mags = lastSpectrogramColumns[colIdx];
    const magVal = mags ? mags[binIdx] : 0;
    const dbVal = 20.0 * Math.log10(Math.max(magVal * gainMultiplier, 0.05));
    const timeStr = new Date(hoverTime * 1000).toISOString().substring(11, 21);
    const bandDesc = classifyFrequencyBand(hoverFreq);

    ctxS.strokeStyle = 'rgba(56, 189, 248, 0.7)';
    ctxS.lineWidth = 1;
    ctxS.setLineDash([3, 3]);
    ctxS.beginPath();
    ctxS.moveTo(hoverState.x, padT);
    ctxS.lineTo(hoverState.x, padT + plotH);
    ctxS.moveTo(padL, hoverState.y);
    ctxS.lineTo(padL + plotW, hoverState.y);
    ctxS.stroke();
    ctxS.setLineDash([]);

    const line1 = `${timeStr} UTC · ${hoverFreq.toFixed(1)} Hz · ${dbVal.toFixed(1)} dB`;
    const line2 = bandDesc;
    ctxS.font = '600 10px JetBrains Mono, monospace';
    const boxW = Math.min(sW - 20, Math.max(ctxS.measureText(line1).width, ctxS.measureText(line2).width) + 18);
    const boxH = 38;
    const boxX = hoverState.x + 12 + boxW > padL + plotW ? Math.max(padL + 4, hoverState.x - boxW - 12) : hoverState.x + 12;
    const boxY = hoverState.y - boxH - 10 < padT ? hoverState.y + 10 : hoverState.y - boxH - 10;

    ctxS.fillStyle = 'rgba(10, 15, 28, 0.92)';
    ctxS.strokeStyle = 'rgba(56, 189, 248, 0.55)';
    ctxS.lineWidth = 1;
    ctxS.beginPath();
    ctxS.roundRect(boxX, boxY, boxW, boxH, 5);
    ctxS.fill();
    ctxS.stroke();

    ctxS.textAlign = 'left';
    ctxS.fillStyle = '#f8fafc';
    ctxS.fillText(line1, boxX + 9, boxY + 15);
    ctxS.fillStyle = '#38bdf8';
    ctxS.font = '500 9.5px Inter, sans-serif';
    ctxS.fillText(line2, boxX + 9, boxY + 29);
  }
}
