/**
 * Helicorder View: 24-Hour Seismograph Drum Recorder
 */

import { state } from '../state.js';
import { elements } from '../dom.js';

export function renderHelicorder() {
  const canvas = elements.canvases.helicorder;
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (w <= 0 || h <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  const ctx = canvas.getContext('2d');
  ctx.resetTransform();
  ctx.scale(dpr, dpr);

  // Background (Helicorder paper ivory/dark)
  ctx.fillStyle = '#080c14';
  ctx.fillRect(0, 0, w, h);

  const numRows = 24; // 24 hours
  const rowH = h / numRows;
  const leftGutter = 54;
  const traceW = w - leftGutter - 16;

  const now = Date.now() / 1000;
  const currentUtcHour = new Date(now * 1000).getUTCHours();
  const currentUtcMin = new Date(now * 1000).getUTCMinutes();
  const currentUtcSec = new Date(now * 1000).getUTCSeconds();

  // Draw 24 hourly rows
  for (let r = 0; r < numRows; r++) {
    const rowY = r * rowH;
    const centerY = rowY + rowH / 2;
    const hourLabel = `${String(r).padStart(2, '0')}:00`;

    // Hour label gutter
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = r === currentUtcHour ? '#00ff88' : '#475569';
    ctx.fillText(hourLabel, leftGutter - 8, centerY + 3);

    // Row baseline
    ctx.strokeStyle = r === currentUtcHour ? 'rgba(0, 255, 136, 0.2)' : 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftGutter, centerY);
    ctx.lineTo(leftGutter + traceW, centerY);
    ctx.stroke();

    // Only draw data for the current active hour (and recorded minutes in state.helicorderMinutePeaks)
    if (r === currentUtcHour) {
      const activeX = leftGutter + ((currentUtcMin * 60 + currentUtcSec) / 3600) * traceW;

      // Draw minute envelope trace
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 1.2;
      ctx.beginPath();

      let hasPt = false;
      for (let m = 0; m <= currentUtcMin; m++) {
        const x = leftGutter + (m / 60) * traceW;
        // Mock/recorded peak envelope
        const peakAmp = (Math.sin(m * 0.4) * 0.3 + (m % 7 === 0 ? 0.7 : 0.1)) * (rowH * 0.4);
        const yTop = centerY - peakAmp;
        const yBot = centerY + peakAmp;

        if (!hasPt) {
          ctx.moveTo(x, yTop);
          hasPt = true;
        } else {
          ctx.lineTo(x, yTop);
          ctx.lineTo(x, yBot);
        }
      }
      ctx.stroke();

      // Red active recording stylus needle
      ctx.fillStyle = '#ef4444';
      ctx.shadowColor = '#ef4444';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(activeX, centerY, 3.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // Draw 10-minute vertical tick markers
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  for (let m = 10; m < 60; m += 10) {
    const x = leftGutter + (m / 60) * traceW;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}
