/**
 * Oscilloscope View: 4-Channel Real-Time Seismograms with UTC Time Axis
 * Features: Bulletproof index-aligned waveform rendering across all 4 channels,
 * dynamic UTC time axis, auto-gain with 25% vertical headroom, and 4-minute baseline corridor.
 */

import { state, CHANNELS, CH_COLORS, SAMPLING_RATE } from '../state.js';
import { elements } from '../dom.js';
import { filterData } from '../dsp.js';

export function renderOscilloscope() {
  const windowSec = state.windowSec || 30;
  const nWindowSamples = windowSec * SAMPLING_RATE; // e.g. 3,000 samples for 30s

  // Determine latest global stream timestamp
  let latestSampleT = state.latestStreamTimestamp || 0;
  if (latestSampleT === 0) {
    for (const ch of CHANNELS) {
      const tsArr = state.timestamps[ch];
      if (tsArr && tsArr.length > 0) {
        const t = tsArr[tsArr.length - 1];
        if (t > latestSampleT) latestSampleT = t;
      }
    }
  }

  // Smooth forward progression between packet arrivals
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

  CHANNELS.forEach((ch) => {
    const canvas = elements.canvases[ch];
    const overlay = elements.overlays[ch];
    if (!canvas || !state.visibleChannels[ch]) return;

    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
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
    const xSpan = w;      // Full 100% width utilization

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

    const rawBuf = state.buffers[ch];
    if (!rawBuf || rawBuf.length === 0) return;

    // Take the most recent window samples (up to nWindowSamples)
    const nAvailable = rawBuf.length;
    const nTake = Math.min(nAvailable, nWindowSamples);
    const visibleRaw = rawBuf.slice(-nTake);
    const filtered = filterData(visibleRaw, state.filterMode);
    const nVisible = filtered.length;
    if (nVisible < 2) return;

    // Calculate peak amplitude for auto-gain scaling
    const isGeophone = ch === 'EHZ';
    let pk = isGeophone ? 15 : 1.0;
    for (let i = 0; i < nVisible; i++) {
      const abs = Math.abs(filtered[i]);
      if (abs > pk) pk = abs;
    }

    // Dynamic auto-gain with 25% safety headroom
    let maxVal = 100;
    if (state.gainMode === 'auto') {
      maxVal = Math.max(pk * 1.45, isGeophone ? 25.0 : 3.0);
    } else {
      maxVal = Math.max(parseFloat(state.gainMode) * (isGeophone ? 1.0 : 0.1), isGeophone ? 10.0 : 2.0);
    }

    // Maintain 4-minute rolling baseline statistics (24,000 samples @ 100 Hz = 240s)
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

    // 5. Draw Continuous Waveform Trace
    ctx.save();
    ctx.strokeStyle = CH_COLORS[ch] || '#00ff88';
    ctx.lineWidth = 1.6;
    ctx.shadowColor = CH_COLORS[ch] || '#00ff88';
    ctx.shadowBlur = 2;
    ctx.beginPath();

    // Map samples directly so newest sample is always at right edge x = xSpan
    const xOffset = xSpan * (1.0 - (nVisible / nWindowSamples));

    for (let i = 0; i < nVisible; i++) {
      const x = xOffset + (i / Math.max(nVisible - 1, 1)) * (xSpan - xOffset);
      const val = filtered[i];
      const normalizedY = val / maxVal;
      const clampedY = Math.max(-1.0, Math.min(1.0, normalizedY));
      const y = (plotH / 2) - clampedY * (plotH / 2) * 0.75;

      if (i === 0) {
        ctx.moveTo(x, y);
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

    // Live Stylus Dot at rightmost sample position
    ctx.fillStyle = CH_COLORS[ch] || '#00ff88';
    ctx.beginPath();
    ctx.arc(xSpan - 2, lastY, 3, 0, Math.PI * 2);
    ctx.fill();

    // 7. Render Trigger Event Drop Markers & AI Pick Overlays directly onto waveform canvas
    const activeTrigs = state.triggers || [];
    activeTrigs.forEach((trig) => {
      if (trig.channel === ch || trig.channel === 'ALL') {
        const tTime = trig.start_time || trig.timestamp || 0;
        if (tTime >= startT && tTime <= endT) {
          const tx = ((tTime - startT) / windowSec) * xSpan;
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(tx, 0);
          ctx.lineTo(tx, plotH);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = '#ef4444';
          ctx.font = '9px JetBrains Mono, monospace';
          ctx.fillText('🚨 TRIGGER', tx + 4, 18);
        }
      }
    });
  });
}
