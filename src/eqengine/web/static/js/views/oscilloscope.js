/**
 * Oscilloscope View: Multi-Channel Real-Time Seismogram Display
 * Features:
 * - Phase-Locked Loop (PLL) Playhead Clock for 100% Stutter-Free 60 FPS Gliding
 * - True Timestamp-Aligned Coordinate Mapping
 * - Multi-Channel Auto-Gain (Geophone vs Accelerometer)
 * - 4-Minute Dynamic Normal Baseline Corridors
 * - Real UTC Time Grid & Interactive Markers
 */

import { state, CHANNELS, SAMPLING_RATE } from '../state.js';
import { elements } from '../dom.js';
import { filterData } from '../dsp.js';

const CH_COLORS = {
  EHZ: '#00ff88', // Emerald Green (Velocity Geophone)
  ENZ: '#00d2ff', // Cyan Blue (Vertical Acceleration)
  ENN: '#ffaa00', // Amber Orange (North-South Acceleration)
  ENE: '#d080ff', // Vivid Purple (East-West Acceleration)
};

// Phase-Locked Loop (PLL) smooth playhead clock state
let pllPlayheadT = 0;
let lastFramePerfNow = performance.now();

export function renderOscilloscope() {
  const windowSec = state.windowSec || 30;
  const nWindowSamples = Math.round(windowSec * SAMPLING_RATE);

  // -------------------------------------------------------------------------
  // 1. Advance Phase-Locked Loop (PLL) Playhead Clock
  // -------------------------------------------------------------------------
  const nowPerf = performance.now();
  const dtSec = Math.max(0, Math.min((nowPerf - lastFramePerfNow) / 1000.0, 0.1));
  lastFramePerfNow = nowPerf;

  const ehzTs = state.timestamps.EHZ || [];
  const latestReceivedT = state.latestStreamTimestamp || (ehzTs.length > 0 ? ehzTs[ehzTs.length - 1] : 0);

  if (state.paused) {
    // Retain paused position
  } else if (latestReceivedT > 0) {
    if (pllPlayheadT === 0 || Math.abs(pllPlayheadT - latestReceivedT) > 4.0) {
      // Sync playhead with a tiny 150ms buffer for seamless jitter absorption
      pllPlayheadT = latestReceivedT - 0.15;
    } else {
      // Advance playhead smoothly at real-time clock speed with micro-drift compensation
      const drift = (latestReceivedT - 0.15) - pllPlayheadT;
      const rateTrim = Math.max(-0.25, Math.min(0.25, drift * 0.6));
      pllPlayheadT += dtSec * (1.0 + rateTrim);
    }
  } else {
    pllPlayheadT = Date.now() / 1000;
  }

  const endT = state.paused ? (state.lastPausedTimestamp || pllPlayheadT) : pllPlayheadT;
  const startT = endT - windowSec;

  // -------------------------------------------------------------------------
  // 2. Render Channels
  // -------------------------------------------------------------------------
  CHANNELS.forEach((ch) => {
    const canvas = elements.canvases[ch];
    if (!canvas || !state.visibleChannels[ch]) return;

    const rect = canvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (w <= 0 || h <= 0) return;

    // Handle Retina pixel ratio
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }

    const ctx = canvas.getContext('2d');
    ctx.resetTransform();
    ctx.scale(dpr, dpr);

    const plotH = h - 22; // Leave bottom 22px for X-axis time markings
    const xSpan = w;

    // 1. Clear background
    ctx.fillStyle = '#0a0e17';
    ctx.fillRect(0, 0, w, h);

    // 2. Draw Center Zero Baseline Axis
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, plotH / 2);
    ctx.lineTo(xSpan, plotH / 2);
    ctx.stroke();

    // 3. Draw Time Grid & Real UTC Timestamps on X-Axis
    const secStep = windowSec <= 15 ? 2 : windowSec <= 30 ? 5 : windowSec <= 120 ? 15 : 60;
    const firstSec = Math.ceil(startT / secStep) * secStep;

    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'center';

    for (let t = firstSec; t <= endT; t += secStep) {
      const x = ((t - startT) / windowSec) * xSpan;
      if (x >= 0 && x <= xSpan) {
        // Vertical grid line through waveform
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, plotH);
        ctx.stroke();

        // Time tick mark on axis
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.beginPath();
        ctx.moveTo(x, plotH);
        ctx.lineTo(x, plotH + 5);
        ctx.stroke();

        // Real UTC time label (HH:MM:SS)
        const d = new Date(t * 1000);
        const timeLabel = d.toISOString().substring(11, 19);
        const relSec = Math.round(t - endT);
        const relLabel = relSec === 0 ? 'NOW' : `${relSec}s`;

        ctx.fillStyle = '#64748b';
        ctx.fillText(timeLabel, x, plotH + 16);

        // Relative second marker near top
        ctx.fillStyle = '#334155';
        ctx.fillText(relLabel, x, 11);
      }
    }

    // Time Axis bottom line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, plotH);
    ctx.lineTo(w, plotH);
    ctx.stroke();

    // Rightmost Live Indicator badge on X-axis
    ctx.font = '8px JetBrains Mono';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#00ff88';
    ctx.fillText('LIVE 🔴', w - 6, plotH + 16);

    const rawBuf = state.buffers[ch] || [];
    const tsBuf = state.timestamps[ch] || [];
    const nAvailable = rawBuf.length;
    if (nAvailable < 2 || tsBuf.length !== nAvailable) return;

    // Extract visible samples matching the timestamp window [startT - 0.2s, endT + 0.2s]
    let startIdx = 0;
    while (startIdx < nAvailable && tsBuf[startIdx] < startT - 0.2) {
      startIdx++;
    }

    const visibleRaw = [];
    const visibleTs = [];
    for (let i = startIdx; i < nAvailable; i++) {
      if (tsBuf[i] <= endT + 0.2) {
        visibleRaw.push(rawBuf[i]);
        visibleTs.push(tsBuf[i]);
      }
    }

    const nVisible = visibleRaw.length;
    if (nVisible < 2) return;

    const filtered = filterData(visibleRaw, state.filterMode);

    // Calculate peak amplitude for auto-gain scaling
    const isGeophone = ch === 'EHZ';
    let pk = isGeophone ? 15 : 1.0;
    for (let i = 0; i < nVisible; i++) {
      const abs = Math.abs(filtered[i]);
      if (abs > pk) pk = abs;
    }

    // Dynamic auto-gain with safety headroom
    let maxVal = 100;
    if (state.gainMode === 'auto') {
      maxVal = Math.max(pk * 1.45, isGeophone ? 25.0 : 3.0);
    } else {
      maxVal = Math.max(parseFloat(state.gainMode) * (isGeophone ? 1.0 : 0.1), isGeophone ? 10.0 : 2.0);
    }

    // Maintain 4-minute rolling baseline statistics
    if (!state.fourMinStats[ch]) state.fourMinStats[ch] = { baselineAmp: isGeophone ? 35 : 2.0, history: [] };
    const stats = state.fourMinStats[ch];

    if (Math.random() < 0.2) {
      stats.history.push(pk);
      if (stats.history.length > 240) stats.history.shift();
      let sumAmp = 0;
      stats.history.forEach((v) => (sumAmp += v));
      stats.baselineAmp = Math.max(sumAmp / Math.max(stats.history.length, 1), isGeophone ? 12.0 : 1.0);
    }

    const baselineNormal = stats.baselineAmp;
    const devRatio = pk / baselineNormal;

    // Update telemetry & deviation badges in channel header
    const lastVal = filtered[nVisible - 1] || 0;
    if (elements.values[ch]) {
      elements.values[ch].textContent = Math.round(lastVal).toLocaleString();
    }

    const baseEl = document.getElementById(`base-${ch}`);
    if (baseEl) baseEl.textContent = `±${Math.round(baselineNormal)}`;

    const devEl = document.getElementById(`dev-${ch}`);
    if (devEl) {
      if (devRatio > 4.0) {
        devEl.textContent = `⚡ WEIRD (+${devRatio.toFixed(1)}x)`;
        devEl.className = 'dev-badge dev-anomalous';
      } else if (devRatio > 2.0) {
        devEl.textContent = `🟡 ELEVATED (+${devRatio.toFixed(1)}x)`;
        devEl.className = 'dev-badge dev-elevated';
      } else {
        devEl.textContent = `🟢 NORMAL (${devRatio.toFixed(1)}x)`;
        devEl.className = 'dev-badge dev-normal';
      }
    }

    if (ch === 'EHZ' && elements.staEHZ) {
      elements.staEHZ.textContent = (state.staLtaRatios.EHZ || 1.0).toFixed(2);
    } else if (ch === 'ENZ' && elements.pgaENZ) {
      elements.pgaENZ.textContent = (maxVal * 1.9e-6).toFixed(4);
    } else if (ch === 'ENN' && elements.pgaENN) {
      elements.pgaENN.textContent = (maxVal * 1.9e-6).toFixed(4);
    } else if (ch === 'ENE' && elements.pgaENE) {
      elements.pgaENE.textContent = (maxVal * 1.9e-6).toFixed(4);
    }

    // 4. Draw 4-Minute Dynamic Normal Baseline Corridor (±baselineNormal)
    const normYHeight = Math.min((baselineNormal / maxVal) * (plotH / 2) * 0.75, plotH / 2 - 6);
    ctx.fillStyle = 'rgba(0, 255, 136, 0.04)';
    ctx.fillRect(0, plotH / 2 - normYHeight, xSpan, normYHeight * 2);

    ctx.strokeStyle = 'rgba(0, 255, 136, 0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, plotH / 2 - normYHeight);
    ctx.lineTo(xSpan, plotH / 2 - normYHeight);
    ctx.moveTo(0, plotH / 2 + normYHeight);
    ctx.lineTo(xSpan, plotH / 2 + normYHeight);
    ctx.stroke();
    ctx.setLineDash([]);

    // 5. Draw Continuous Waveform Trace (True Timestamp-Aligned Gliding)
    ctx.save();
    ctx.strokeStyle = CH_COLORS[ch] || '#00ff88';
    ctx.lineWidth = 1.6;
    ctx.shadowColor = CH_COLORS[ch] || '#00ff88';
    ctx.shadowBlur = 2;
    ctx.beginPath();

    let hasStartedPath = false;

    for (let i = 0; i < nVisible; i++) {
      const sampleT = visibleTs[i];
      const x = ((sampleT - startT) / windowSec) * xSpan;
      const val = filtered[i];
      const normalizedY = val / maxVal;
      const clampedY = Math.max(-1.0, Math.min(1.0, normalizedY));
      const y = (plotH / 2) - clampedY * (plotH / 2) * 0.75;

      if (!hasStartedPath) {
        ctx.moveTo(x, y);
        hasStartedPath = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.restore();

    // 6. Floating Deviation Annotation & Live Stylus
    const lastY = (plotH / 2) - Math.max(-1.0, Math.min(1.0, lastVal / maxVal)) * (plotH / 2) * 0.75;
    const bracketX = xSpan - 14;

    ctx.strokeStyle = devRatio > 3.0 ? '#ef4444' : devRatio > 1.8 ? '#f59e0b' : 'rgba(0, 255, 136, 0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bracketX, plotH / 2 - normYHeight);
    ctx.lineTo(bracketX + 4, plotH / 2 - normYHeight);
    ctx.moveTo(bracketX + 2, plotH / 2 - normYHeight);
    ctx.lineTo(bracketX + 2, plotH / 2 + normYHeight);
    ctx.moveTo(bracketX, plotH / 2 + normYHeight);
    ctx.lineTo(bracketX + 4, plotH / 2 + normYHeight);
    ctx.stroke();

    // Amplitude scale indicators on Y-Axis
    ctx.font = '8.5px JetBrains Mono';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'left';
    ctx.fillText(`+${Math.round(maxVal)}`, 6, 12);
    ctx.fillText(`-${Math.round(maxVal)}`, 6, plotH - 4);
  });
}
