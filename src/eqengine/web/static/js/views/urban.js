/**
 * Urban Profiler View: 5-Band Environmental & Cultural Energy Tracker
 */

import { state } from '../state.js';
import { computeFFT256 } from '../dsp.js';

const urbanHistory = [];

export function renderUrbanProfiler() {
  const ehzBuf = state.buffers.EHZ;
  if (!ehzBuf || ehzBuf.length < 32) return;

  const mags = computeFFT256(ehzBuf);
  // Bins @ 0.39 Hz resolution
  // 1. Wind (0.1 - 0.5 Hz) -> bins 0 to 2
  // 2. Cal Stadium (2 - 5 Hz) -> bins 5 to 13
  // 3. Traffic (8 - 14 Hz) -> bins 20 to 36
  // 4. Footsteps / Stairs (15 - 24 Hz) -> bins 38 to 61
  // 5. Greek Theatre Sub-bass (25 - 45 Hz) -> bins 64 to 115

  const sumBins = (start, end) => {
    let s = 0;
    for (let b = start; b <= end && b < mags.length; b++) s += mags[b];
    return s / Math.max(end - start + 1, 1);
  };

  const pWind = sumBins(0, 2);
  const pStadium = sumBins(5, 13);
  const pTraffic = sumBins(20, 36);
  const pSteps = sumBins(38, 61);
  const pConcert = sumBins(64, 115);

  // Update UI power meters
  const setMeter = (id, val, max = 50) => {
    const el = document.getElementById(id);
    if (el) {
      const pct = Math.min(Math.max((val / max) * 100, 0), 100);
      el.style.width = `${pct}%`;
    }
  };

  setMeter('meterWind', pWind, 40);
  setMeter('meterStadium', pStadium, 60);
  setMeter('meterTraffic', pTraffic, 50);
  setMeter('meterFootsteps', pSteps, 40);
  setMeter('meterConcert', pConcert, 30);

  // Maintain 5-minute rolling history
  const now = Date.now() / 1000;
  urbanHistory.push({ time: now, wind: pWind, stadium: pStadium, traffic: pTraffic, steps: pSteps, concert: pConcert });
  if (urbanHistory.length > 300) urbanHistory.shift();

  // Render History Canvas
  const canvas = document.getElementById('urbanHistoryCanvas');
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  if (w <= 0 || h <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  const ctx = canvas.getContext('2d');
  ctx.resetTransform();
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#0a0e17';
  ctx.fillRect(0, 0, w, h);

  // Zero axis & grid
  ctx.strokeStyle = '#182234';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - 1); ctx.lineTo(w, h - 1);
  ctx.stroke();

  if (urbanHistory.length < 2) return;

  const bands = [
    { key: 'stadium', color: '#ffaa00', label: 'Cal Stadium' },
    { key: 'concert', color: '#d080ff', label: 'Greek Theatre' },
    { key: 'traffic', color: '#00d2ff', label: 'Traffic' },
    { key: 'steps', color: '#00ff88', label: 'Footsteps' },
  ];

  const n = urbanHistory.length;
  const stepX = w / Math.max(n - 1, 1);

  bands.forEach((b) => {
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();

    for (let i = 0; i < n; i++) {
      const x = i * stepX;
      const val = urbanHistory[i][b.key] || 0;
      const y = h - Math.min((val / 60.0) * (h - 10), h - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
}
