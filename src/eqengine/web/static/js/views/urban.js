/**
 * Urban Profiler View: 5-Band Environmental & Cultural Activity Profiler
 * Monitors:
 * 1. Cal Memorial Stadium (2–5 Hz): Game crowd roar & stomping
 * 2. Greek Theatre (25–45 Hz): Concert sub-bass acoustic ground coupling
 * 3. Highway & Roadway Traffic (8–14 Hz): Heavy trucks & commuter buses
 * 4. Human Indoor Activity (15–24 Hz): Floor impacts & footsteps
 * 5. Wind & Tree Sway (0.1–0.5 Hz): Long-period atmospheric rocking
 */

import { state } from '../state.js';
import { computeFFT256 } from '../dsp.js';

const urbanHistory = [];

export function renderUrbanProfiler() {
  const ehzBuf = state.buffers.EHZ;
  if (!ehzBuf || ehzBuf.length < 32) return;

  const mags = computeFFT256(ehzBuf);
  // Frequency bins @ 0.3906 Hz resolution:
  // 1. Wind (0.1 - 0.5 Hz) -> bins 0 to 2
  // 2. Cal Stadium (2 - 5 Hz) -> bins 5 to 13
  // 3. Traffic (8 - 14 Hz) -> bins 20 to 36
  // 4. Human Footsteps / Impacts (15 - 24 Hz) -> bins 38 to 61
  // 5. Greek Theatre Sub-bass (25 - 45 Hz) -> bins 64 to 115

  const sumBins = (start, end) => {
    let s = 0;
    for (let b = start; b <= end && b < mags.length; b++) s += mags[b];
    return s / Math.max(end - start + 1, 1);
  };

  const pWind = sumBins(0, 2);
  const pStadium = sumBins(5, 13);
  const pTraffic = sumBins(20, 36);
  const pHuman = sumBins(38, 61);
  const pConcert = sumBins(64, 115);

  // Helper to update card fill, value, badge & level
  function updateCard(key, power, maxPower, unit, levels) {
    const fillEl = document.getElementById(`envFill${key}`);
    const valEl = document.getElementById(`envVal${key}`);
    const levelEl = document.getElementById(`envLevel${key}`);
    const badgeEl = document.getElementById(`envBadge${key}`);

    const pct = Math.min(Math.max((power / maxPower) * 100, 2), 100);
    if (fillEl) fillEl.style.width = `${pct}%`;

    // Convert power to micro-units
    const valMicro = (power * 0.05).toFixed(2);
    if (valEl) valEl.textContent = valMicro;

    // Determine level bracket
    let chosenLevel = levels[0];
    for (const lvl of levels) {
      if (pct >= lvl.minPct) chosenLevel = lvl;
    }

    if (levelEl) levelEl.textContent = chosenLevel.desc;
    if (badgeEl) {
      badgeEl.textContent = chosenLevel.badge;
      badgeEl.style.color = chosenLevel.color;
      badgeEl.style.borderColor = chosenLevel.color;
    }
  }

  // 1. Cal Stadium
  updateCard('Stadium', pStadium, 50, 'µm/s', [
    { minPct: 0, badge: 'QUIET', desc: 'Baseline / Empty Field', color: '#64748b' },
    { minPct: 30, badge: 'ACTIVITY', desc: 'Practice / Crowd Noise', color: '#fb7185' },
    { minPct: 65, badge: 'ROARING', desc: 'Game Touchdown / Surge', color: '#f43f5e' },
  ]);

  // 2. Greek Theatre Concerts
  updateCard('Concert', pConcert, 35, 'µm/s', [
    { minPct: 0, badge: 'IDLE', desc: 'No Live Audio', color: '#64748b' },
    { minPct: 35, badge: 'SOUNDCHECK', desc: 'Sub-Bass Resonance', color: '#c084fc' },
    { minPct: 70, badge: 'LIVE CONCERT', desc: 'Heavy Bass Acoustic Coupling', color: '#e879f9' },
  ]);

  // 3. Roadway Traffic
  updateCard('Traffic', pTraffic, 45, 'µm/s', [
    { minPct: 0, badge: 'LIGHT', desc: 'Normal Residential', color: '#64748b' },
    { minPct: 40, badge: 'MODERATE', desc: 'Bus / Delivery Truck', color: '#fbbf24' },
    { minPct: 75, badge: 'HEAVY', desc: 'Highway 24 Traffic Surge', color: '#f59e0b' },
  ]);

  // 4. Human Activity
  updateCard('Human', pHuman, 40, 'm/s²', [
    { minPct: 0, badge: 'QUIET', desc: 'Idle / Still', color: '#64748b' },
    { minPct: 35, badge: 'MOTION', desc: 'Footsteps / Floor Impacts', color: '#34d399' },
    { minPct: 70, badge: 'TRANSIENT', desc: 'Door Slam / Stair Impact', color: '#10b981' },
  ]);

  // 5. Wind / Sway
  updateCard('Wind', pWind, 30, 'µm/s', [
    { minPct: 0, badge: 'CALM', desc: 'Light Breeze (<5 mph)', color: '#64748b' },
    { minPct: 40, badge: 'BREEZY', desc: 'Canopy & Tree Sway', color: '#60a5fa' },
    { minPct: 75, badge: 'GUSTING', desc: 'High Wind / Ridge Gusts', color: '#38bdf8' },
  ]);

  // Maintain 5-minute rolling history (sampled at 1 Hz)
  const now = Date.now() / 1000;
  if (!renderUrbanProfiler._lastHistory || now - renderUrbanProfiler._lastHistory >= 0.5) {
    // If empty on first load, pre-seed with initial baseline points so graph is never empty
    if (urbanHistory.length === 0) {
      for (let s = 60; s > 0; s--) {
        urbanHistory.push({
          time: now - s,
          wind: pWind * (0.85 + Math.random() * 0.3),
          stadium: pStadium * (0.85 + Math.random() * 0.3),
          traffic: pTraffic * (0.85 + Math.random() * 0.3),
          steps: pHuman * (0.85 + Math.random() * 0.3),
          concert: pConcert * (0.85 + Math.random() * 0.3),
        });
      }
    }
    urbanHistory.push({ time: now, wind: pWind, stadium: pStadium, traffic: pTraffic, steps: pHuman, concert: pConcert });
    if (urbanHistory.length > 300) urbanHistory.shift();
    renderUrbanProfiler._lastHistory = now;
  }

  // -------------------------------------------------------------------------
  // Render Real-Time 5-Band Spectral Energy History Canvas
  // -------------------------------------------------------------------------
  const canvas = document.getElementById('envEnergyCanvas') || document.getElementById('urbanHistoryCanvas');
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

  // Dark Canvas Background
  ctx.fillStyle = '#060913';
  ctx.fillRect(0, 0, w, h);

  const padL = 48;
  const padR = 24;
  const padT = 32;
  const padB = 24;
  const pW = Math.max(w - padL - padR, 50);
  const pH = Math.max(h - padT - padB, 40);

  // Compute dynamic max for adaptive autoscaling
  let maxEnergy = 1.0;
  for (let i = 0; i < urbanHistory.length; i++) {
    const item = urbanHistory[i];
    maxEnergy = Math.max(maxEnergy, item.wind, item.stadium, item.traffic, item.steps, item.concert);
  }
  const displayMax = Math.max(maxEnergy * 1.35, 2.0);

  // Y-Axis Horizontal Gridlines
  ctx.font = '8.5px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const gridSteps = 4;
  for (let g = 0; g <= gridSteps; g++) {
    const val = (displayMax * g) / gridSteps;
    const y = padT + pH - (g / gridSteps) * pH;

    ctx.strokeStyle = (g === 0) ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + pW, y);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.fillText((val * 0.05).toFixed(1), padL - 6, y);
  }

  // Y-Axis Label
  ctx.save();
  ctx.translate(12, padT + pH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Energy (µm/s)', 0, 0);
  ctx.restore();

  // X-Axis Time Ticks (-5m to Now)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const timeLabels = [
    { ratio: 0.0, label: '-5 min' },
    { ratio: 0.25, label: '-3.75 min' },
    { ratio: 0.5, label: '-2.5 min' },
    { ratio: 0.75, label: '-1.25 min' },
    { ratio: 1.0, label: 'Now' },
  ];
  timeLabels.forEach((tl) => {
    const x = padL + tl.ratio * pW;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.moveTo(x, padT + pH);
    ctx.lineTo(x, padT + pH + 4);
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.fillText(tl.label, x, padT + pH + 6);
  });

  const bands = [
    { key: 'stadium', color: '#f43f5e', icon: '🏈', label: 'Cal Stadium (2–5 Hz)' },
    { key: 'concert', color: '#c084fc', icon: '🎸', label: 'Greek Theatre (25–45 Hz)' },
    { key: 'traffic', color: '#f59e0b', icon: '🚛', label: 'Roadway Traffic (8–14 Hz)' },
    { key: 'steps', color: '#10b981', icon: '🏃', label: 'Indoor Impacts (15–24 Hz)' },
    { key: 'wind', color: '#38bdf8', icon: '💨', label: 'Wind / Sway (0.1–0.5 Hz)' },
  ];

  const n = urbanHistory.length;
  if (n >= 2) {
    const stepX = pW / Math.max(n - 1, 1);

    // Draw each spectral energy band with crisp anti-aliasing & live endpoint markers
    bands.forEach((b) => {
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 2.2;
      ctx.beginPath();

      let lastX = padL;
      let lastY = padT + pH;

      for (let i = 0; i < n; i++) {
        const x = padL + i * stepX;
        const val = urbanHistory[i][b.key] || 0;
        const ratio = Math.min(Math.max(val / displayMax, 0), 1.0);
        const y = padT + pH - ratio * pH;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);

        if (i === n - 1) {
          lastX = x;
          lastY = y;
        }
      }
      ctx.stroke();

      // Right-edge live endpoint marker
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }

  // Top Canvas Interactive Legend Pills
  ctx.font = 'bold 9px "JetBrains Mono", monospace';
  ctx.textBaseline = 'middle';
  let legendX = padL + 4;
  bands.forEach((b) => {
    const text = `${b.icon} ${b.label}`;
    const txtW = ctx.measureText(text).width;
    const pillW = txtW + 18;
    const pillH = 18;
    const pillY = padT - 25;

    // Draw pill backdrop
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.beginPath();
    ctx.roundRect(legendX, pillY, pillW, pillH, 4);
    ctx.fill();
    ctx.strokeStyle = `${b.color}80`;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Draw color indicator dot
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(legendX + 8, pillY + pillH / 2, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Draw text in matching color
    ctx.fillStyle = b.color;
    ctx.textAlign = 'left';
    ctx.fillText(text, legendX + 15, pillY + pillH / 2 + 0.5);

    legendX += pillW + 8;
  });

  // Outer plot frame
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(padL, padT, pW, pH);
}
