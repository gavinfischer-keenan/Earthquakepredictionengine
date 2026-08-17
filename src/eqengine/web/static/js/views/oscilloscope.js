/**
 * Oscilloscope View: 4-Channel Real-Time Seismograms with UTC Time Axis
 */

import { state, CHANNELS, CH_COLORS, SAMPLING_RATE } from '../state.js';
import { elements } from '../dom.js';
import { filterData } from '../dsp.js';

export function renderOscilloscope() {
  const windowSec = state.windowSec || 30;
  const now = Date.now() / 1000;
  const endT = state.paused
    ? state.lastPausedTimestamp || now + (state.smoothClockOffset || 0)
    : now + (state.smoothClockOffset || 0);
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
    const xSpan = Math.max(w - 32, 10);

    // 1. Clear background
    ctx.fillStyle = '#0a0e17';
    ctx.fillRect(0, 0, w, h);

    // 2. Draw Zero Axis
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

        // Subtle relative marker near top
        ctx.fillStyle = '#334155';
        ctx.fillText(relLabel, x, 11);
      }
    }

    // Time Axis baseline bar
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
    ctx.fillText('LIVE 🔴', w - 4, plotH + 16);

    const rawBuf = state.buffers[ch];
    const rawTs = state.timestamps[ch];
    if (!rawBuf || rawBuf.length === 0) return;

    // Slice visible samples for [startT - 1, endT]
    const nTotal = rawBuf.length;
    let startIdx = 0;
    for (let i = nTotal - 1; i >= 0; i--) {
      if (rawTs && rawTs[i] < startT - 0.5) {
        startIdx = Math.max(0, i);
        break;
      }
    }

    const visibleRaw = rawBuf.slice(startIdx);
    const visibleTs = rawTs ? rawTs.slice(startIdx) : [];
    const filtered = filterData(visibleRaw, state.filterMode);
    const nVisible = filtered.length;
    if (nVisible < 2) return;

    // Calculate peak amplitude for scaling
    let pk = 15;
    for (let i = 0; i < nVisible; i++) {
      const abs = Math.abs(filtered[i]);
      if (abs > pk) pk = abs;
    }

    let maxVal = 100;
    if (state.gainMode === 'auto') {
      maxVal = Math.max(pk * 1.3, 20.0);
    } else {
      maxVal = Math.max(parseFloat(state.gainMode), 10.0);
    }

    // Maintain 4-minute rolling baseline statistics (24,000 samples @ 100 Hz = 240s)
    if (!state.fourMinStats[ch]) state.fourMinStats[ch] = { baselineAmp: 35, history: [] };
    const stats = state.fourMinStats[ch];

    if (Math.random() < 0.2) {
      stats.history.push(pk);
      if (stats.history.length > 240) stats.history.shift();
      let sumAmp = 0;
      stats.history.forEach((v) => (sumAmp += v));
      stats.baselineAmp = Math.max(sumAmp / Math.max(stats.history.length, 1), 12.0);
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
    const normYHeight = Math.min((baselineNormal / maxVal) * (plotH / 2) * 0.88, plotH / 2 - 4);
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

    // 5. Draw Seismic Trace (mapped strictly to UTC time)
    ctx.save();
    ctx.strokeStyle = CH_COLORS[ch] || '#00ff88';
    ctx.lineWidth = 1.6;
    ctx.shadowColor = CH_COLORS[ch] || '#00ff88';
    ctx.shadowBlur = 2;
    ctx.beginPath();

    const dt = 1.0 / SAMPLING_RATE;
    let hasStarted = false;

    for (let i = 0; i < nVisible; i++) {
      const sTime = visibleTs && visibleTs.length > i ? visibleTs[i] : endT - (nVisible - 1 - i) * dt;

      const x = ((sTime - startT) / windowSec) * xSpan;
      if (x < -5 || x > xSpan + 5) continue;

      const val = filtered[i];
      const normalizedY = val / maxVal;
      const clampedY = Math.max(-0.95, Math.min(0.95, normalizedY));
      const y = plotH / 2 - clampedY * (plotH / 2) * 0.85;

      if (!hasStarted) {
        ctx.moveTo(x, y);
        hasStarted = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.restore();

    // 6. Draw Floating 4-Min Normal Bar & Needle on Right Edge
    const barW = 6;
    const barX = w - 16;
    const barTop = plotH / 2 - normYHeight;
    const barBottom = plotH / 2 + normYHeight;
    const barH = Math.max(barBottom - barTop, 6);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillRect(barX - 2, 4, barW + 4, plotH - 8);

    ctx.fillStyle = devRatio > 3.0 ? 'rgba(239, 68, 68, 0.4)' : 'rgba(0, 255, 136, 0.35)';
    ctx.fillRect(barX, barTop, barW, barH);

    ctx.strokeStyle = devRatio > 3.0 ? '#ef4444' : '#00ff88';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barTop, barW, barH);

    // Current excursion needle
    const curNormY = Math.max(-1.0, Math.min(1.0, lastVal / maxVal));
    const needleY = plotH / 2 - curNormY * (plotH / 2) * 0.88;
    ctx.fillStyle = devRatio > 3.0 ? '#ef4444' : devRatio > 1.8 ? '#f59e0b' : '#fff';
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(barX - 5, needleY);
    ctx.lineTo(barX + barW + 3, needleY);
    ctx.lineTo(barX + barW + 1, needleY - 2);
    ctx.lineTo(barX - 3, needleY - 2);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.font = '8px JetBrains Mono';
    ctx.fillStyle = '#64748b';
    ctx.fillText('4m', barX - 14, plotH / 2 + 3);

    // 7. Drop Symbology & Annotations on Live Traces
    if (overlay) {
      overlay.innerHTML = '';

      // Trigger pins
      state.triggers.forEach((trig) => {
        const trigTime = trig.start_time;
        if (trigTime >= startT && trigTime <= endT) {
          const xPercent = ((trigTime - startT) / windowSec) * 100;
          if (xPercent >= 0 && xPercent <= 95) {
            const flag = document.createElement('div');
            flag.className = 'trigger-flag';
            flag.style.left = `${xPercent}%`;

            const badge = document.createElement('div');
            badge.className = 'trigger-badge';
            badge.textContent = `📍 P-Wave [STA/LTA: ${(trig.peak_sta_lta || trig.sta_lta_ratio || 4.0).toFixed(1)}x]`;
            flag.appendChild(badge);

            overlay.appendChild(flag);
          }
        }
      });

      // USGS External Earthquakes & Theoretical Wavefronts
      state.usgsEvents.forEach((uEvt) => {
        const pArrival = uEvt.p_arrival;
        if (pArrival && pArrival >= startT && pArrival <= endT) {
          const xPercent = ((pArrival - startT) / windowSec) * 100;
          if (xPercent >= 0 && xPercent <= 95) {
            const flag = document.createElement('div');
            flag.className = 'trigger-flag usgs-flag';
            flag.style.left = `${xPercent}%`;

            const badge = document.createElement('div');
            badge.className = 'trigger-badge usgs-badge';
            const mag = uEvt.magnitude ? `M${uEvt.magnitude.toFixed(1)}` : 'Quake';
            badge.textContent = `🌊 USGS P-Arrival: ${mag}`;
            flag.appendChild(badge);

            overlay.appendChild(flag);
          }
        }
      });
    }
  });
}
