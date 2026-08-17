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
    { minPct: 30, badge: 'ACTIVITY', desc: 'Practice / Crowd Noise', color: '#eab308' },
    { minPct: 65, badge: 'ROARING', desc: 'Game Touchdown / Surge', color: '#ef4444' },
  ]);

  // 2. Greek Theatre Concerts
  updateCard('Concert', pConcert, 35, 'µm/s', [
    { minPct: 0, badge: 'IDLE', desc: 'No Live Audio', color: '#64748b' },
    { minPct: 35, badge: 'SOUNDCHECK', desc: 'Sub-Bass Resonance', color: '#c084fc' },
    { minPct: 70, badge: 'LIVE CONCERT', desc: 'Heavy Bass Acoustic Coupling', color: '#ec4899' },
  ]);

  // 3. Roadway Traffic
  updateCard('Traffic', pTraffic, 45, 'µm/s', [
    { minPct: 0, badge: 'LIGHT', desc: 'Normal Residential', color: '#22c55e' },
    { minPct: 40, badge: 'MODERATE', desc: 'Bus / Delivery Truck', color: '#f59e0b' },
    { minPct: 75, badge: 'HEAVY', desc: 'Highway 24 Traffic Surge', color: '#ef4444' },
  ]);

  // 4. Human Activity
  updateCard('Human', pHuman, 40, 'm/s²', [
    { minPct: 0, badge: 'QUIET', desc: 'Idle / Still', color: '#64748b' },
    { minPct: 35, badge: 'MOTION', desc: 'Footsteps / Floor Impacts', color: '#00ff88' },
    { minPct: 70, badge: 'TRANSIENT', desc: 'Door Slam / Stair Impact', color: '#f59e0b' },
  ]);

  // 5. Wind / Sway
  updateCard('Wind', pWind, 30, 'µm/s', [
    { minPct: 0, badge: 'CALM', desc: 'Light Breeze (<5 mph)', color: '#38bdf8' },
    { minPct: 40, badge: 'BREEZY', desc: 'Canopy & Tree Sway', color: '#3b82f6' },
    { minPct: 75, badge: 'GUSTING', desc: 'High Wind / Ridge Gusts', color: '#f59e0b' },
  ]);

  // Maintain 5-minute rolling history (sampled at 1 Hz)
  const now = Date.now() / 1000;
  if (!renderUrbanProfiler._lastHistory || now - renderUrbanProfiler._lastHistory >= 1.0) {
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

  // Background
  ctx.fillStyle = '#060913';
  ctx.fillRect(0, 0, w, h);

  // Horizontal Gridlines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach((pct) => {
    ctx.beginPath();
    ctx.moveTo(0, h * pct);
    ctx.lineTo(w, h * pct);
    ctx.stroke();
  });

  if (urbanHistory.length < 2) {
    ctx.font = '10px JetBrains Mono';
    ctx.fillStyle = '#64748b';
    ctx.fillText('Accumulating 5-band environmental energy history...', 14, h / 2);
    return;
  }

  const bands = [
    { key: 'stadium', color: '#ffaa00', label: '🏈 Cal Stadium (2–5 Hz)' },
    { key: 'concert', color: '#d080ff', label: '🎸 Greek Theatre (25–45 Hz)' },
    { key: 'traffic', color: '#38bdf8', label: '🚛 Traffic (8–14 Hz)' },
    { key: 'steps', color: '#00ff88', label: '🏃 Footsteps (15–24 Hz)' },
    { key: 'wind', color: '#3b82f6', label: '💨 Wind Sway (0.1–0.5 Hz)' },
  ];

  const n = urbanHistory.length;
  const stepX = w / Math.max(n - 1, 1);

  // Draw each spectral energy trace
  bands.forEach((b) => {
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();

    for (let i = 0; i < n; i++) {
      const x = i * stepX;
      const val = urbanHistory[i][b.key] || 0;
      const y = h - 6 - Math.min((val / 45.0) * (h - 16), h - 12);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });

  // Top Canvas Legend
  ctx.font = '9px JetBrains Mono, monospace';
  let legendX = 12;
  bands.forEach((b) => {
    ctx.fillStyle = b.color;
    ctx.fillText(b.label, legendX, 14);
    legendX += ctx.measureText(b.label).width + 16;
  });
}
