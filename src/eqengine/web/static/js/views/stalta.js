/**
 * STA/LTA & RSAM Real-Time Telemetry View
 * Visualizes Short-Term/Long-Term Average ratios and 1-minute RSAM seismic amplitude bars.
 */

import { state } from '../state.js';
import { elements } from '../dom.js';

export function renderStaLta() {
  const staltaCanvas = document.getElementById('staltaCanvas');
  const rsamCanvas = document.getElementById('rsamCanvas');

  // 1. Render STA/LTA Ratio History
  if (staltaCanvas) {
    const rect = staltaCanvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (w > 0 && h > 0) {
      const dpr = window.devicePixelRatio || 1;
      if (staltaCanvas.width !== Math.round(w * dpr) || staltaCanvas.height !== Math.round(h * dpr)) {
        staltaCanvas.width = Math.round(w * dpr);
        staltaCanvas.height = Math.round(h * dpr);
      }

      const ctx = staltaCanvas.getContext('2d');
      ctx.resetTransform();
      ctx.scale(dpr, dpr);

      // Background
      ctx.fillStyle = '#060913';
      ctx.fillRect(0, 0, w, h);

      const padL = 40, padR = 20, padT = 20, padB = 25;
      const pW = w - padL - padR;
      const pH = h - padT - padB;

      // Max Y scale: at least 10x or dynamic peak
      let maxRatio = 10.0;
      state.staLtaHistory.forEach((pt) => {
        if (pt.ratio > maxRatio) maxRatio = pt.ratio * 1.2;
      });

      const toY = (r) => padT + pH - (Math.min(r, maxRatio) / maxRatio) * pH;

      // Grid lines
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'right';

      [1.0, 2.0, 4.0, 6.5, 8.0, 10.0].forEach((r) => {
        if (r <= maxRatio) {
          const y = toY(r);
          ctx.strokeStyle = r === 6.5 ? 'rgba(239, 68, 68, 0.4)' : r === 2.0 ? 'rgba(245, 158, 11, 0.3)' : 'rgba(255, 255, 255, 0.07)';
          ctx.lineWidth = r === 6.5 ? 1.5 : 1;
          ctx.setLineDash(r === 6.5 || r === 2.0 ? [4, 4] : []);
          ctx.beginPath();
          ctx.moveTo(padL, y);
          ctx.lineTo(padL + pW, y);
          ctx.stroke();

          ctx.fillStyle = r === 6.5 ? '#ef4444' : r === 2.0 ? '#f59e0b' : '#64748b';
          ctx.fillText(`${r.toFixed(1)}x`, padL - 6, y + 3);
        }
      });
      ctx.setLineDash([]);

      // Trigger ON & OFF Threshold Labels
      ctx.textAlign = 'left';
      ctx.font = '8px JetBrains Mono';
      ctx.fillStyle = '#ef4444';
      ctx.fillText('TRIGGER ON (6.5x)', padL + 6, toY(6.5) - 4);
      ctx.fillStyle = '#f59e0b';
      ctx.fillText('TRIGGER OFF (2.0x)', padL + 6, toY(2.0) - 4);

      // Plot STA/LTA History Line
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

      // Border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      ctx.strokeRect(padL, padT, pW, pH);
    }
  }

  // 2. Render RSAM (Real-time Seismic Amplitude Measurement)
  if (rsamCanvas) {
    const rect = rsamCanvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (w > 0 && h > 0) {
      const dpr = window.devicePixelRatio || 1;
      if (rsamCanvas.width !== Math.round(w * dpr) || rsamCanvas.height !== Math.round(h * dpr)) {
        rsamCanvas.width = Math.round(w * dpr);
        rsamCanvas.height = Math.round(h * dpr);
      }

      const ctx = rsamCanvas.getContext('2d');
      ctx.resetTransform();
      ctx.scale(dpr, dpr);

      // Background
      ctx.fillStyle = '#060913';
      ctx.fillRect(0, 0, w, h);

      const padL = 45, padR = 20, padT = 20, padB = 25;
      const pW = w - padL - padR;
      const pH = h - padT - padB;

      // Extract last 60 minutes of RSAM data from helicorder minute peaks
      const minuteKeys = Object.keys(state.helicorderMinutePeaks)
        .map(Number)
        .sort((a, b) => a - b);
      const recentKeys = minuteKeys.slice(-60);

      let maxRsam = 100.0;
      recentKeys.forEach((k) => {
        const entry = state.helicorderMinutePeaks[k];
        if (entry) {
          const val = Math.max(Math.abs(entry.min), Math.abs(entry.max));
          if (val > maxRsam) maxRsam = val;
        }
      });
      maxRsam = Math.max(maxRsam * 1.25, 80.0);

      const toY = (v) => padT + pH - (Math.min(v, maxRsam) / maxRsam) * pH;

      // Current RSAM Value badge
      const lastK = recentKeys[recentKeys.length - 1];
      const curRsam = lastK && state.helicorderMinutePeaks[lastK]
        ? Math.round(Math.max(Math.abs(state.helicorderMinutePeaks[lastK].min), Math.abs(state.helicorderMinutePeaks[lastK].max)))
        : (state.fourMinStats.EHZ ? Math.round(state.fourMinStats.EHZ.baselineAmp) : 35);

      const rsamBadge = document.getElementById('rsamValue');
      if (rsamBadge) {
        rsamBadge.textContent = `RSAM: ${curRsam} counts`;
      }

      // Horizontal reference lines (50 counts quiet, 200 counts traffic, 500 counts)
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'right';

      [50, 100, 200, 500, 1000].forEach((v) => {
        if (v <= maxRsam) {
          const y = toY(v);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(padL, y);
          ctx.lineTo(padL + pW, y);
          ctx.stroke();

          ctx.fillStyle = '#64748b';
          ctx.fillText(`${v}`, padL - 6, y + 3);
        }
      });

      // Draw RSAM Minute Bars
      if (recentKeys.length > 0) {
        const barW = Math.max(2, (pW / 60) - 2);
        recentKeys.forEach((k, idx) => {
          const entry = state.helicorderMinutePeaks[k];
          const val = entry ? Math.max(Math.abs(entry.min), Math.abs(entry.max)) : 20;
          const x = padL + (idx / 60) * pW;
          const y = toY(val);
          const barH = padT + pH - y;

          ctx.fillStyle = val > 300 ? '#ef4444' : val > 120 ? '#f59e0b' : '#00d2ff';
          ctx.fillRect(x, y, barW, barH);
        });
      }

      // Border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      ctx.strokeRect(padL, padT, pW, pH);
    }
  }
}
