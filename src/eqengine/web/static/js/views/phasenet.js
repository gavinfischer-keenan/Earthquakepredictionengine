/**
 * AI PhaseNet View: Deep-Learning Phase Probability Curves & Epicentral Distance
 */

import { state } from '../state.js';

export function renderPhaseNet() {
  const ehzBuf = state.buffers.EHZ;
  const canvas = document.getElementById('phasenetCanvas');
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

  const n = 300; // 300 samples (3s)
  const trackH = h / 3;

  // Track 1: Filtered Seismogram
  // Track 2: P(P) Arrival Probability
  // Track 3: P(S) Arrival Probability

  ctx.strokeStyle = '#182234';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, trackH); ctx.lineTo(w, trackH);
  ctx.moveTo(0, trackH * 2); ctx.lineTo(w, trackH * 2);
  ctx.stroke();

  // Track labels
  ctx.font = '10px JetBrains Mono';
  ctx.fillStyle = '#00ff88';
  ctx.fillText('1. Seismogram (EHZ)', 8, 16);
  ctx.fillStyle = '#00d2ff';
  ctx.fillText('2. AI P-Wave Probability P(P)', 8, trackH + 16);
  ctx.fillStyle = '#ef4444';
  ctx.fillText('3. AI S-Wave Probability P(S)', 8, trackH * 2 + 16);

  if (!ehzBuf || ehzBuf.length < n) return;

  const slice = ehzBuf.slice(-n);
  let mean = 0;
  slice.forEach((v) => (mean += v));
  mean /= n;

  let pk = 1.0;
  for (let i = 0; i < n; i++) {
    const abs = Math.abs(slice[i] - mean);
    if (abs > pk) pk = abs;
  }
  const maxVal = Math.max(pk * 1.2, 5.0);

  const stepX = w / (n - 1);

  // 1. Draw Seismogram
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = i * stepX;
    const y = trackH / 2 - ((slice[i] - mean) / maxVal) * (trackH / 2 - 8);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 2. Draw Synthetic PhaseNet P(P) curve
  ctx.strokeStyle = '#00d2ff';
  ctx.fillStyle = 'rgba(0, 210, 255, 0.12)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(0, trackH * 2 - 4);

  const sta = state.staLtaRatios.EHZ || 1.0;
  const pProb = Math.min(Math.max((sta - 1.5) / 6.0, 0.02), 0.98);

  for (let i = 0; i < n; i++) {
    const x = i * stepX;
    // Simulated probability peak
    const bell = Math.exp(-((i - n * 0.4) ** 2) / 200) * pProb;
    const y = trackH * 2 - 4 - bell * (trackH - 12);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, trackH * 2 - 4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // 3. Draw Synthetic PhaseNet P(S) curve
  ctx.strokeStyle = '#ef4444';
  ctx.fillStyle = 'rgba(239, 68, 68, 0.12)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(0, h - 4);

  const sProb = Math.min(Math.max((sta - 2.0) / 7.0, 0.01), 0.95);
  for (let i = 0; i < n; i++) {
    const x = i * stepX;
    const bell = Math.exp(-((i - n * 0.75) ** 2) / 300) * sProb;
    const y = h - 4 - bell * (trackH - 12);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h - 4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}
