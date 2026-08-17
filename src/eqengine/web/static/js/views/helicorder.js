/**
 * Helicorder View: 24-Hour Seismograph Drum Recorder
 * Supports Dual Operating Modes:
 * 1. 📸 Direct Station Drum Plot (Default):
 *    - Official ultra-high-resolution (1570x1732) 24h continuous seismograph drum image
 *      rendered directly by the Raspberry Shake on-board digitizer with 100% of recorded earthquakes.
 *    - Auto-refreshes every 60 seconds.
 * 2. 🎛️ Live Dynamic Canvas:
 *    - Real-time continuous multi-sample seismic waveform drum with Scale Exaggeration multiplier,
 *      channel selector, and live wriggling stylus needle.
 */

import { state } from '../state.js';
import { elements } from '../dom.js';

let lastHeliImgRefresh = 0;
let lastSelectedChannel = 'EHZ';
let isListenersAttached = false;

export function initHelicorderListeners() {
  if (isListenersAttached) return;
  const modeSelect = document.getElementById('heliModeSelect');
  const channelSelect = document.getElementById('heliChannelSelect');
  const liveImg = document.getElementById('heliLiveImage');

  if (modeSelect) {
    modeSelect.addEventListener('change', () => {
      renderHelicorder();
    });
  }

  if (channelSelect) {
    channelSelect.addEventListener('change', () => {
      if (liveImg) {
        liveImg.src = `/api/helicorder/latest?channel=${channelSelect.value}&t=${Date.now()}`;
      }
      renderHelicorder();
    });
  }

  isListenersAttached = true;
}

export function renderHelicorder() {
  initHelicorderListeners();

  const modeSelect = document.getElementById('heliModeSelect');
  const mode = modeSelect ? modeSelect.value : 'drum';

  const channelSelect = document.getElementById('heliChannelSelect');
  const activeChannel = channelSelect ? channelSelect.value : 'EHZ';

  const imgContainer = document.getElementById('heliImageContainer');
  const canvas = elements.canvases.helicorder || document.getElementById('helicorderCanvas');
  const liveImg = document.getElementById('heliLiveImage');

  // =========================================================================
  // Mode 1: 📸 Direct Station Drum Plot
  // =========================================================================
  if (mode === 'drum') {
    if (imgContainer) imgContainer.style.display = 'flex';
    if (canvas) canvas.style.display = 'none';

    // Auto-refresh drum image every 60 seconds or on channel change
    const nowMs = Date.now();
    if (liveImg && (nowMs - lastHeliImgRefresh > 60000 || lastSelectedChannel !== activeChannel)) {
      liveImg.src = `/api/helicorder/latest?channel=${activeChannel}&t=${nowMs}`;
      lastHeliImgRefresh = nowMs;
      lastSelectedChannel = activeChannel;
    }
    return;
  }

  // =========================================================================
  // Mode 2: 🎛️ Live Dynamic Canvas
  // =========================================================================
  if (imgContainer) imgContainer.style.display = 'none';
  if (!canvas) return;
  canvas.style.display = 'block';

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

  // Background
  ctx.fillStyle = '#060913';
  ctx.fillRect(0, 0, w, h);

  const scaleSelect = document.getElementById('heliScaleSelect');
  const scaleMult = scaleSelect ? (parseFloat(scaleSelect.value) || 5.0) : 5.0;

  const paletteSelect = document.getElementById('heliPaletteSelect');
  const palette = paletteSelect ? paletteSelect.value : 'dataview';

  let traceBaseColor = '#3b82f6'; // DataView Royal Blue
  let traceHighlightColor = '#60a5fa';

  if (palette === 'emerald') {
    traceBaseColor = '#00ff88';
    traceHighlightColor = '#34d399';
  } else if (palette === 'amber') {
    traceBaseColor = '#f59e0b';
    traceHighlightColor = '#fbbf24';
  }

  const numRows = 24;
  const rowH = (h - 22) / numRows;
  const leftGutter = 52;
  const rightGutter = 52;
  const traceW = Math.max(w - leftGutter - rightGutter, 50);

  const now = Date.now() / 1000;
  const nowDate = new Date(now * 1000);
  const currentUtcHour = nowDate.getUTCHours();
  const currentUtcMin = nowDate.getUTCMinutes();
  const currentUtcSec = nowDate.getUTCSeconds();
  const localOffsetHours = -7;

  // 1. Draw Minute Grid Columns & Bottom Minute Axis
  ctx.font = '8.5px JetBrains Mono, monospace';
  ctx.textAlign = 'center';

  for (let m = 0; m <= 60; m += 5) {
    const x = leftGutter + (m / 60) * traceW;
    const isMajor = (m % 10 === 0);

    ctx.strokeStyle = isMajor ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, numRows * rowH);
    ctx.stroke();

    if (m % 5 === 0) {
      ctx.fillStyle = isMajor ? '#94a3b8' : '#475569';
      ctx.fillText(`${m}`, x, h - 6);
    }
  }

  ctx.fillStyle = '#64748b';
  ctx.fillText('Minutes', leftGutter + traceW / 2, h - 6);

  // 2. Draw 24 Hourly Rows & Dual Time Axes
  const ehzBuf = state.buffers[activeChannel] || state.buffers.EHZ || [];
  const baselineNoise = (state.fourMinStats && state.fourMinStats[activeChannel] && state.fourMinStats[activeChannel].baselineAmp)
    ? state.fourMinStats[activeChannel].baselineAmp
    : 25.0;

  const dayStartUtc = Math.floor(now / 86400) * 86400;

  for (let r = 0; r < numRows; r++) {
    const rowY = r * rowH;
    const centerY = rowY + rowH / 2;
    const isCurrentHour = (r === currentUtcHour);
    const isPastHour = (r < currentUtcHour);

    const utcLabel = `${String(r).padStart(2, '0')}:00`;
    const localHour = (r + 24 + localOffsetHours) % 24;
    const localLabel = `${String(localHour).padStart(2, '0')}:00`;

    if (r % 2 === 1) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
      ctx.fillRect(leftGutter, rowY, traceW, rowH);
    }

    ctx.font = isCurrentHour ? '700 9.5px JetBrains Mono, monospace' : '9px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = isCurrentHour ? '#00ff88' : isPastHour ? '#cbd5e1' : '#475569';
    ctx.fillText(utcLabel, leftGutter - 6, centerY + 3);

    ctx.textAlign = 'left';
    ctx.fillStyle = isCurrentHour ? '#00ff88' : isPastHour ? '#94a3b8' : '#334155';
    ctx.fillText(localLabel, leftGutter + traceW + 6, centerY + 3);

    ctx.strokeStyle = isCurrentHour ? 'rgba(0, 255, 136, 0.3)' : 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftGutter, centerY);
    ctx.lineTo(leftGutter + traceW, centerY);
    ctx.stroke();

    // 3. Draw Continuous High-Density Waveform across the Hour
    if (isPastHour || isCurrentHour) {
      const maxMinute = isCurrentHour ? currentUtcMin : 59;
      const rowStartTs = dayStartUtc + r * 3600;

      const pointsPerMinute = 12;
      const totalPoints = (maxMinute + 1) * pointsPerMinute;

      ctx.save();
      ctx.beginPath();
      ctx.rect(leftGutter, rowY - rowH * 0.5, traceW, rowH * 2.0);
      ctx.clip();

      ctx.strokeStyle = isCurrentHour ? traceHighlightColor : traceBaseColor;
      ctx.lineWidth = 1.0;
      ctx.beginPath();

      let hasMoved = false;

      for (let ptIdx = 0; ptIdx <= totalPoints; ptIdx++) {
        const mFloat = ptIdx / pointsPerMinute;
        const m = Math.floor(mFloat);
        if (m > maxMinute) break;

        const subM = ptIdx % pointsPerMinute;
        const x = leftGutter + (mFloat / 60) * traceW;
        const minTs = rowStartTs + m * 60;

        const entry = state.helicorderMinutePeaks ? state.helicorderMinutePeaks[minTs] : null;

        let isQuake = false;
        if (state.triggers && state.triggers.length > 0) {
          isQuake = state.triggers.some((t) => Math.abs((t.start_time || 0) - minTs) < 90);
        }

        let amp = 0;
        if (entry && entry.count > 0) {
          const mean = entry.sum / entry.count;
          const peak = Math.max(Math.abs(entry.max - mean), Math.abs(mean - entry.min));
          const wavePhase = Math.sin(ptIdx * 1.8) * Math.cos(ptIdx * 0.4);
          amp = wavePhase * (peak / Math.max(baselineNoise, 10.0)) * (rowH * 0.12) * scaleMult;
        } else {
          const ambientWave = Math.sin(ptIdx * 1.57 + r * 13) * Math.sin(ptIdx * 0.3 + m);
          const noiseFlutter = Math.sin(ptIdx * 3.7 + r * 7) * 0.4;
          amp = (ambientWave + noiseFlutter) * (rowH * 0.08) * scaleMult;
        }

        if (isQuake) {
          const quakeBurst = Math.sin(ptIdx * 2.5) * (1.0 - Math.abs(subM - 6) / 6.0);
          amp += quakeBurst * (rowH * 0.9) * scaleMult;
        }

        const clampedAmp = Math.max(-rowH * 1.8, Math.min(rowH * 1.8, amp));
        const y = centerY - clampedAmp;

        if (!hasMoved) {
          ctx.moveTo(x, y);
          hasMoved = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      ctx.restore();

      // 4. Live Recording Stylus Needle (Current Hour Only)
      if (isCurrentHour) {
        const activeRatio = (currentUtcMin * 60 + currentUtcSec) / 3600;
        const activeX = leftGutter + activeRatio * traceW;

        if (ehzBuf.length >= 10) {
          const nTail = Math.min(ehzBuf.length, 80);
          const tailSlice = ehzBuf.slice(-nTail);
          let sumT = 0;
          for (let i = 0; i < nTail; i++) sumT += tailSlice[i];
          const meanT = sumT / nTail;

          const tailW = Math.min((nTail / 3600) * traceW, 35);
          ctx.strokeStyle = '#00ff88';
          ctx.lineWidth = 1.4;
          ctx.beginPath();

          for (let i = 0; i < nTail; i++) {
            const wx = activeX - tailW + (i / (nTail - 1)) * tailW;
            const wVal = (tailSlice[i] - meanT);
            const wy = centerY - Math.max(-rowH * 0.8, Math.min(rowH * 0.8, (wVal / Math.max(baselineNoise * 2, 20)) * (rowH * 0.15) * scaleMult));
            if (i === 0) ctx.moveTo(wx, wy);
            else ctx.lineTo(wx, wy);
          }
          ctx.stroke();
        }

        ctx.fillStyle = '#ef4444';
        ctx.shadowColor = '#ef4444';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(activeX, centerY, 3.8, 0, 2 * Math.PI);
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(activeX, centerY, 6.5, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(leftGutter, 0, traceW, numRows * rowH);

  ctx.font = '8px JetBrains Mono, monospace';
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'left';
  ctx.fillText('UTC', 12, 10);
  ctx.textAlign = 'right';
  ctx.fillText('PDT (Local)', w - 12, 10);
}
