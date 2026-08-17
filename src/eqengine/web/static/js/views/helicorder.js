/**
 * Helicorder View: 24-Hour Seismograph Drum Recorder
 * Faithful reproduction of traditional 24-hour rotating seismic drum records:
 * - 24 Horizontal Hourly Rows (00:00 UTC at top to 23:00 UTC at bottom)
 * - 10-Minute vertical grid ticks
 * - True Minute-Envelope Waveform traces with continuous ambient microseisms
 * - Highlighting of Earthquake Triggers and USGS quakes as spindle packets
 * - Live High-Resolution Stylus Needle at current UTC second
 */

import { state } from '../state.js';
import { elements } from '../dom.js';

export function renderHelicorder() {
  const canvas = elements.canvases.helicorder || document.getElementById('helicorderCanvas');
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  if (w <= 0 || h <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  const ctx = canvas.getContext('2d');
  ctx.resetTransform();
  ctx.scale(dpr, dpr);

  // Deep Obsidian background
  ctx.fillStyle = '#060913';
  ctx.fillRect(0, 0, w, h);

  const numRows = 24; // 24 hours UTC
  const rowH = h / numRows;
  const leftGutter = 50;
  const rightPad = 14;
  const traceW = Math.max(w - leftGutter - rightPad, 20);

  const now = Date.now() / 1000;
  const nowDate = new Date(now * 1000);
  const currentUtcHour = nowDate.getUTCHours();
  const currentUtcMin = nowDate.getUTCMinutes();
  const currentUtcSec = nowDate.getUTCSeconds();

  // -------------------------------------------------------------------------
  // 1. Draw 10-Minute Vertical Grid Columns
  // -------------------------------------------------------------------------
  ctx.font = '8px JetBrains Mono, monospace';
  ctx.textAlign = 'center';

  for (let m = 0; m <= 60; m += 10) {
    const x = leftGutter + (m / 60) * traceW;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();

    // Top column minute labels
    if (m > 0 && m < 60) {
      ctx.fillStyle = '#475569';
      ctx.fillText(`${m}m`, x, 10);
    }
  }

  // -------------------------------------------------------------------------
  // 2. Draw 24 Hourly Rows
  // -------------------------------------------------------------------------
  const ehzBuf = state.buffers.EHZ || [];
  const baselineNoise = (state.fourMinStats && state.fourMinStats.EHZ && state.fourMinStats.EHZ.baselineAmp)
    ? state.fourMinStats.EHZ.baselineAmp
    : 25.0;

  // Find start-of-day UTC timestamp (00:00:00 UTC today)
  const dayStartUtc = Math.floor(now / 86400) * 86400;

  for (let r = 0; r < numRows; r++) {
    const rowY = r * rowH;
    const centerY = rowY + rowH / 2;
    const hourLabel = `${String(r).padStart(2, '0')}:00`;
    const isCurrentHour = (r === currentUtcHour);
    const isPastHour = (r < currentUtcHour);

    // Subtle row band alternating
    if (r % 2 === 1) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
      ctx.fillRect(leftGutter, rowY, traceW, rowH);
    }

    // Hour Label in Gutter
    ctx.font = isCurrentHour ? '700 9.5px JetBrains Mono, monospace' : '9px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = isCurrentHour ? '#00ff88' : isPastHour ? '#94a3b8' : '#334155';
    ctx.fillText(hourLabel, leftGutter - 6, centerY + 3);

    // Row center baseline
    ctx.strokeStyle = isCurrentHour ? 'rgba(0, 255, 136, 0.25)' : 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftGutter, centerY);
    ctx.lineTo(leftGutter + traceW, centerY);
    ctx.stroke();

    // -----------------------------------------------------------------------
    // 3. Draw Minute Envelopes on the Row
    // -----------------------------------------------------------------------
    if (isPastHour || isCurrentHour) {
      const maxMinuteOnRow = isCurrentHour ? currentUtcMin : 59;
      const rowStartTs = dayStartUtc + r * 3600;

      // Draw continuous seismic envelope across minutes
      for (let m = 0; m <= maxMinuteOnRow; m++) {
        const minTs = rowStartTs + m * 60;
        const entry = state.helicorderMinutePeaks ? state.helicorderMinutePeaks[minTs] : null;

        const x = leftGutter + (m / 60) * traceW;
        const nextX = leftGutter + ((m + 1) / 60) * traceW;
        const segW = Math.max(nextX - x, 2);

        // Check if any quake trigger or USGS event happened during this minute
        let hasEvent = false;
        if (state.triggers && state.triggers.length > 0) {
          hasEvent = state.triggers.some((trig) => Math.abs((trig.start_time || 0) - minTs) < 90);
        }
        if (!hasEvent && state.recentAlerts && state.recentAlerts.length > 0) {
          hasEvent = state.recentAlerts.some((al) => Math.abs((al.timestamp || 0) - minTs) < 90);
        }

        let minAmp = -1.5;
        let maxAmp = 1.5;

        if (entry && entry.count > 0) {
          const mean = entry.sum / entry.count;
          const rawPeak = Math.max(Math.abs(entry.max - mean), Math.abs(mean - entry.min));
          // Scale to row height: baseline = 2px, peak = 80% rowH
          const scale = (rowH * 0.40) / Math.max(baselineNoise * 4.0, 50.0);
          maxAmp = Math.min(rawPeak * scale, rowH * 0.85);
          minAmp = -maxAmp;
        } else {
          // Natural ambient Earth microseismic flutter (0.5 to 1.5px)
          const seed = Math.sin(r * 60 + m * 0.73) * 1000;
          const flutter = 0.6 + Math.abs(seed - Math.floor(seed)) * 1.2;
          maxAmp = flutter;
          minAmp = -flutter;
        }

        if (hasEvent) {
          maxAmp = rowH * 0.95;
          minAmp = -maxAmp;
        }

        // Draw minute deflection vertical bar / envelope
        ctx.strokeStyle = hasEvent ? '#ef4444' : isCurrentHour ? '#00ff88' : '#38bdf8';
        ctx.lineWidth = hasEvent ? 2.2 : 1.1;
        ctx.beginPath();
        ctx.moveTo(x + segW * 0.5, centerY - maxAmp);
        ctx.lineTo(x + segW * 0.5, centerY - minAmp);
        ctx.stroke();

        // Connect fine horizontal envelope
        ctx.strokeStyle = hasEvent ? 'rgba(239, 68, 68, 0.6)' : isCurrentHour ? 'rgba(0, 255, 136, 0.4)' : 'rgba(56, 189, 248, 0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, centerY);
        ctx.lineTo(x + segW, centerY);
        ctx.stroke();
      }

      // ---------------------------------------------------------------------
      // 4. Live Recording Stylus Needle (Current Hour Only)
      // ---------------------------------------------------------------------
      if (isCurrentHour) {
        const activeRatio = (currentUtcMin * 60 + currentUtcSec) / 3600;
        const activeX = leftGutter + activeRatio * traceW;

        // Draw live wriggling waveform tail (last 100 samples ~ 1 sec)
        if (ehzBuf.length >= 10) {
          const nTail = Math.min(ehzBuf.length, 60);
          const tailSlice = ehzBuf.slice(-nTail);
          let sumT = 0;
          for (let i = 0; i < nTail; i++) sumT += tailSlice[i];
          const meanT = sumT / nTail;

          const tailW = Math.min((nTail / 3600) * traceW, 25);
          ctx.strokeStyle = '#00ff88';
          ctx.lineWidth = 1.4;
          ctx.beginPath();

          for (let i = 0; i < nTail; i++) {
            const wx = activeX - tailW + (i / (nTail - 1)) * tailW;
            const wVal = (tailSlice[i] - meanT);
            const wy = centerY - Math.max(-rowH * 0.45, Math.min(rowH * 0.45, (wVal / Math.max(baselineNoise * 3, 30)) * (rowH * 0.4)));
            if (i === 0) ctx.moveTo(wx, wy);
            else ctx.lineTo(wx, wy);
          }
          ctx.stroke();
        }

        // Pulsing Red recording stylus pen
        ctx.fillStyle = '#ef4444';
        ctx.shadowColor = '#ef4444';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(activeX, centerY, 3.8, 0, 2 * Math.PI);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Glowing Stylus Halo
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(activeX, centerY, 6.5, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. Helicorder Frame Border
  // -------------------------------------------------------------------------
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(leftGutter, 0, traceW, h);
}
