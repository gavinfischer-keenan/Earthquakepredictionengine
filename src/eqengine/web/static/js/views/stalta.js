/**
 * STA/LTA & RSAM Real-Time Telemetry View
 * Visualizes:
 * 1. Left Panel: Short-Term/Long-Term Average (STA/LTA) ratio with explicit color-coded zones:
 *    - 🟢 Ambient Normal (0.0x–2.0x)
 *    - 🟡 Elevated Activity (2.0x–6.5x)
 *    - 🔴 Earthquake Trigger Threshold (6.5x+)
 * 2. Right Panel: 60-Minute Real-Time Seismic Amplitude Measurement (RSAM):
 *    - Demeaned RMS ground velocity amplitude per 1-minute bucket.
 *    - Dynamic calibration against station's ambient baseline noise floor.
 *    - Color-coded: 🟢 Normal Quiet (<2x baseline), 🟡 Elevated Activity (2–5x baseline), 🔴 Seismic Anomaly (>5x baseline).
 *    - Clear Y-axis scale (counts RMS), X-axis time marks (-60m to Now), and reference lines.
 */

import { state } from '../state.js';
import { elements } from '../dom.js';

export function renderStaLta() {
  const staltaCanvas = document.getElementById('staltaCanvas');
  const rsamCanvas = document.getElementById('rsamCanvas');

  const baselineNoise = (state.fourMinStats && state.fourMinStats.EHZ && state.fourMinStats.EHZ.baselineAmp)
    ? Math.max(state.fourMinStats.EHZ.baselineAmp, 15.0)
    : 35.0;

  // =========================================================================
  // 1. Render STA/LTA Ratio History (Left Panel)
  // =========================================================================
  if (staltaCanvas) {
    const rect = staltaCanvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);

    if (w > 0 && h > 0) {
      const dpr = window.devicePixelRatio || 1;
      if (staltaCanvas.width !== Math.round(w * dpr) || staltaCanvas.height !== Math.round(h * dpr)) {
        staltaCanvas.width = Math.round(w * dpr);
        staltaCanvas.height = Math.round(h * dpr);
      }

      const ctx = staltaCanvas.getContext('2d');
      ctx.resetTransform();
      ctx.scale(dpr, dpr);

      // Deep Obsidian background
      ctx.fillStyle = '#060913';
      ctx.fillRect(0, 0, w, h);

      const padL = 48;
      const padR = 16;
      const padT = 24;
      const padB = 26;
      const pW = Math.max(w - padL - padR, 10);
      const pH = Math.max(h - padT - padB, 10);

      // Dynamic max Y scale: at least 10.0x or peak + 20%
      let maxRatio = 10.0;
      state.staLtaHistory.forEach((pt) => {
        if (pt.ratio > maxRatio) maxRatio = pt.ratio * 1.25;
      });

      const toY = (r) => padT + pH - (Math.min(Math.max(r, 0), maxRatio) / maxRatio) * pH;

      // 1a. Shaded Background Bands
      // Normal Zone (0 to 2.0x)
      const y2 = toY(2.0);
      const y0 = toY(0.0);
      ctx.fillStyle = 'rgba(0, 255, 136, 0.04)';
      ctx.fillRect(padL, y2, pW, y0 - y2);

      // Trigger Alert Zone (> 6.5x)
      const y65 = toY(6.5);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.06)';
      ctx.fillRect(padL, padT, pW, y65 - padT);

      // 1b. Horizontal Grid Lines & Ratio Thresholds
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'right';

      [1.0, 2.0, 4.0, 6.5, 8.0, 10.0].forEach((r) => {
        if (r <= maxRatio) {
          const y = toY(r);
          const isTriggerOn = (r === 6.5);
          const isTriggerOff = (r === 2.0);

          ctx.strokeStyle = isTriggerOn
            ? 'rgba(239, 68, 68, 0.5)'
            : isTriggerOff
              ? 'rgba(245, 158, 11, 0.4)'
              : 'rgba(255, 255, 255, 0.07)';
          ctx.lineWidth = isTriggerOn ? 1.5 : 1;
          ctx.setLineDash(isTriggerOn || isTriggerOff ? [4, 4] : []);
          ctx.beginPath();
          ctx.moveTo(padL, y);
          ctx.lineTo(padL + pW, y);
          ctx.stroke();

          ctx.fillStyle = isTriggerOn ? '#ef4444' : isTriggerOff ? '#f59e0b' : '#64748b';
          ctx.fillText(`${r.toFixed(1)}x`, padL - 6, y + 3);
        }
      });
      ctx.setLineDash([]);

      // Threshold Text Annotations
      ctx.textAlign = 'left';
      ctx.font = '700 8.5px JetBrains Mono, monospace';
      ctx.fillStyle = '#ef4444';
      ctx.fillText('🔴 TRIGGER ON (6.5x)', padL + 8, toY(6.5) - 4);
      ctx.fillStyle = '#f59e0b';
      ctx.fillText('🟡 TRIGGER OFF (2.0x)', padL + 8, toY(2.0) - 4);
      ctx.fillStyle = '#00ff88';
      ctx.fillText('🟢 AMBIENT BASELINE (1.0x)', padL + 8, toY(1.0) - 4);

      // 1c. Plot STA/LTA Ratio History Line
      const pts = state.staLtaHistory;
      if (pts.length > 1) {
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 2.0;
        ctx.shadowColor = '#00ff88';
        ctx.shadowBlur = 4;
        ctx.beginPath();

        pts.forEach((pt, i) => {
          const x = padL + (i / Math.max(pts.length - 1, 1)) * pW;
          const y = toY(pt.ratio);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // 1d. X-Axis Time Ticks
      ctx.font = '8.5px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#64748b';
      const xLabels = [
        { ratio: 0.0, label: '-5 min' },
        { ratio: 0.25, label: '-3.75m' },
        { ratio: 0.5, label: '-2.5m' },
        { ratio: 0.75, label: '-1.25m' },
        { ratio: 1.0, label: 'Live' },
      ];
      xLabels.forEach((xl) => {
        const x = padL + xl.ratio * pW;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.beginPath();
        ctx.moveTo(x, padT + pH);
        ctx.lineTo(x, padT + pH + 4);
        ctx.stroke();
        ctx.fillText(xl.label, x, padT + pH + 14);
      });

      // Border & Y-Axis Title
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      ctx.strokeRect(padL, padT, pW, pH);

      // Current STA/LTA Badge in Header
      const curRatio = (state.staLtaRatios && state.staLtaRatios.EHZ) ? state.staLtaRatios.EHZ : 1.0;
      const curStatusText = curRatio >= 6.5
        ? '🔴 TRIGGER ACTIVE'
        : curRatio >= 2.0
          ? '🟡 ELEVATED'
          : '🟢 NORMAL';

      const staBadge = document.getElementById('staBadge') || document.querySelector('.threshold-badge');
      if (staBadge) {
        staBadge.innerHTML = `STA/LTA: <b>${curRatio.toFixed(2)}x</b> · ${curStatusText}`;
        staBadge.style.color = curRatio >= 6.5 ? '#ef4444' : curRatio >= 2.0 ? '#f59e0b' : '#00ff88';
      }
    }
  }

  // =========================================================================
  // 2. Render RSAM (Real-time Seismic Amplitude Measurement - Right Panel)
  // =========================================================================
  if (rsamCanvas) {
    const rect = rsamCanvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);

    if (w > 0 && h > 0) {
      const dpr = window.devicePixelRatio || 1;
      if (rsamCanvas.width !== Math.round(w * dpr) || rsamCanvas.height !== Math.round(h * dpr)) {
        rsamCanvas.width = Math.round(w * dpr);
        rsamCanvas.height = Math.round(h * dpr);
      }

      const ctx = rsamCanvas.getContext('2d');
      ctx.resetTransform();
      ctx.scale(dpr, dpr);

      // Deep Obsidian background
      ctx.fillStyle = '#060913';
      ctx.fillRect(0, 0, w, h);

      const padL = 55; // Space for count labels
      const padR = 16;
      const padT = 24;
      const padB = 26;
      const pW = Math.max(w - padL - padR, 10);
      const pH = Math.max(h - padT - padB, 10);

      // 2a. Extract last 60 minutes of Demeaned RMS RSAM data
      const minuteKeys = Object.keys(state.helicorderMinutePeaks)
        .map(Number)
        .sort((a, b) => a - b);
      const recentKeys = minuteKeys.slice(-60);

      // Compute true RMS amplitude for each minute
      const rsamValues = [];
      recentKeys.forEach((k) => {
        const entry = state.helicorderMinutePeaks[k];
        if (entry && entry.count > 0) {
          const mean = entry.sum / entry.count;
          let rms = 0;
          if (entry.sumSq && entry.sumSq > 0) {
            const variance = Math.max((entry.sumSq / entry.count) - (mean * mean), 0);
            rms = Math.sqrt(variance);
          } else {
            // Fallback: estimate from peak-to-peak
            rms = Math.max(Math.abs(entry.max - mean), Math.abs(mean - entry.min)) / 2.5;
          }
          rsamValues.push({ time: k, rms: Math.max(rms, 1.0) });
        }
      });

      // Calibrate max Y scale dynamically (at least 3x baseline or peak)
      let peakRms = baselineNoise * 3.0;
      rsamValues.forEach((item) => {
        if (item.rms > peakRms) peakRms = item.rms;
      });
      const maxRsamY = Math.max(peakRms * 1.3, baselineNoise * 3.5, 100.0);

      const toRsamY = (v) => padT + pH - (Math.min(Math.max(v, 0), maxRsamY) / maxRsamY) * pH;

      // 2b. Shaded Baseline Normal Corridor
      const yNormalTop = toRsamY(baselineNoise * 2.0);
      const yBottom = toRsamY(0);
      ctx.fillStyle = 'rgba(0, 210, 255, 0.05)';
      ctx.fillRect(padL, yNormalTop, pW, yBottom - yNormalTop);

      // 2c. Reference Thresholds (1x Baseline, 2x Elevated, 5x Quake)
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'right';

      const normThreshold = baselineNoise;
      const elevatedThreshold = baselineNoise * 2.0;
      const quakeThreshold = baselineNoise * 5.0;

      // Draw standard count gridlines
      const gridSteps = maxRsamY > 500 ? [50, 100, 250, 500, 1000] : maxRsamY > 200 ? [25, 50, 100, 200] : [20, 40, 60, 80, 100];
      gridSteps.forEach((v) => {
        if (v <= maxRsamY) {
          const y = toRsamY(v);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(padL, y);
          ctx.lineTo(padL + pW, y);
          ctx.stroke();

          ctx.fillStyle = '#64748b';
          ctx.fillText(`${v}`, padL - 6, y + 3);
        }
      });

      // Draw Ambient Baseline Line (1.0x)
      const yBase = toRsamY(normThreshold);
      ctx.strokeStyle = 'rgba(0, 255, 136, 0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, yBase);
      ctx.lineTo(padL + pW, yBase);
      ctx.stroke();

      // Draw Elevated Line (2.0x)
      const yElev = toRsamY(elevatedThreshold);
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.4)';
      ctx.beginPath();
      ctx.moveTo(padL, yElev);
      ctx.lineTo(padL + pW, yElev);
      ctx.stroke();

      ctx.setLineDash([]);

      // Reference Labels
      ctx.textAlign = 'left';
      ctx.font = '700 8.5px JetBrains Mono, monospace';
      ctx.fillStyle = '#00ff88';
      ctx.fillText(`🟢 BASELINE (${Math.round(normThreshold)} counts)`, padL + 8, yBase - 4);
      ctx.fillStyle = '#f59e0b';
      ctx.fillText(`🟡 ELEVATED 2x (${Math.round(elevatedThreshold)} counts)`, padL + 8, yElev - 4);

      if (quakeThreshold <= maxRsamY) {
        const yQuake = toRsamY(quakeThreshold);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(padL, yQuake);
        ctx.lineTo(padL + pW, yQuake);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ef4444';
        ctx.fillText(`🔴 QUAKE 5x (${Math.round(quakeThreshold)} counts)`, padL + 8, yQuake - 4);
      }

      // 2d. Draw RSAM Minute Bars with Proper Scientific Color Gradient
      const nBars = Math.max(rsamValues.length, 60);
      const barW = Math.max(2, (pW / 60) - 2);

      let curRsamRms = baselineNoise;

      if (rsamValues.length > 0) {
        const startIndex = 60 - rsamValues.length;
        rsamValues.forEach((item, idx) => {
          const slot = startIndex + idx;
          const x = padL + (slot / 60) * pW;
          const y = toRsamY(item.rms);
          const barH = padT + pH - y;

          // Color scale based on multiplier of your home's ambient baseline
          const multiplier = item.rms / baselineNoise;
          let barColor = '#00d2ff'; // Soft Cyan (Normal Ambient)
          if (multiplier >= 5.0) {
            barColor = '#ef4444'; // Red (Seismic Tremor / Quake)
          } else if (multiplier >= 2.0) {
            barColor = '#f59e0b'; // Amber (Elevated Traffic / Steps)
          } else if (multiplier >= 1.2) {
            barColor = '#00ff88'; // Green (Gentle Ambient)
          }

          ctx.fillStyle = barColor;
          ctx.fillRect(x, y, barW, barH);
        });

        curRsamRms = rsamValues[rsamValues.length - 1].rms;
      }

      // 2e. X-Axis Time Ticks (-60m to Now)
      ctx.font = '8.5px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#64748b';
      const timeMarks = [
        { ratio: 0.0, label: '-60 min' },
        { ratio: 0.25, label: '-45 min' },
        { ratio: 0.5, label: '-30 min' },
        { ratio: 0.75, label: '-15 min' },
        { ratio: 1.0, label: 'Now' },
      ];
      timeMarks.forEach((tm) => {
        const x = padL + tm.ratio * pW;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.beginPath();
        ctx.moveTo(x, padT + pH);
        ctx.lineTo(x, padT + pH + 4);
        ctx.stroke();
        ctx.fillText(tm.label, x, padT + pH + 14);
      });

      // Border & Y-Axis Scale Unit
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      ctx.strokeRect(padL, padT, pW, pH);

      // 2f. Update RSAM Header Badge
      const curMultiplier = curRsamRms / baselineNoise;
      const rsamStatusText = curMultiplier >= 5.0
        ? '🔴 ANOMALY'
        : curMultiplier >= 2.0
          ? '🟡 ELEVATED (2x)'
          : '🟢 NORMAL';

      const rsamBadge = document.getElementById('rsamValue');
      if (rsamBadge) {
        rsamBadge.innerHTML = `RSAM: <b>${Math.round(curRsamRms)} counts RMS</b> · ${rsamStatusText}`;
        rsamBadge.style.color = curMultiplier >= 5.0 ? '#ef4444' : curMultiplier >= 2.0 ? '#f59e0b' : '#00d2ff';
      }

      // 2g. Top Legend Swatches
      ctx.font = '8px JetBrains Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = '#00d2ff';
      ctx.fillText('■ Quiet (<1.2x)', padL + pW - 140, padT + 12);
      ctx.fillStyle = '#00ff88';
      ctx.fillText('■ Normal (1.2-2x)', padL + pW - 65, padT + 12);
      ctx.fillStyle = '#f59e0b';
      ctx.fillText('■ Elevated (2x+)', padL + pW, padT + 12);
    }
  }
}
