/**
 * Hodogram View: 3D Particle Motion Orbit (Horizontal & Vertical Planes)
 * Visualizes:
 * 1. Horizontal Plane (N-S vs E-W): Polarization, particle back-azimuth, and shear wave orbit.
 * 2. Vertical Plane (Z vs Horizontal): Rayleigh wave retrograde elliptical loops and P-wave inclination.
 */

import { state } from '../state.js';
import { elements } from '../dom.js';

export function renderHodogram() {
  const hCanvas = elements.canvases.hodoH || document.getElementById('hodoHorizontal') || document.getElementById('hodoHCanvas');
  const vCanvas = elements.canvases.hodoV || document.getElementById('hodoVertical') || document.getElementById('hodoVCanvas');

  if (!hCanvas && !vCanvas) return;

  const ennBuf = state.buffers.ENN || [];
  const eneBuf = state.buffers.ENE || [];
  const enzBuf = state.buffers.ENZ || [];
  const ehzBuf = state.buffers.EHZ || [];

  // 150 points = 1.5s window @ 100 Hz
  const pts = Math.min(Math.max(ehzBuf.length, ennBuf.length, 20), 150);

  let nDemeaned = [];
  let eDemeaned = [];
  let zDemeaned = [];

  // Triaxial mode (accelerometer or hybrid)
  if (ennBuf.length >= 10 && eneBuf.length >= 10) {
    const nSlice = ennBuf.slice(-pts);
    const eSlice = eneBuf.slice(-pts);
    const zSlice = enzBuf.length >= pts ? enzBuf.slice(-pts) : (ehzBuf.length >= pts ? ehzBuf.slice(-pts) : []);

    let sumN = 0, sumE = 0, sumZ = 0;
    for (let i = 0; i < nSlice.length; i++) {
      sumN += nSlice[i];
      sumE += eSlice[i];
      if (zSlice.length > i) sumZ += zSlice[i];
    }
    const meanN = sumN / nSlice.length;
    const meanE = sumE / eSlice.length;
    const meanZ = zSlice.length > 0 ? sumZ / zSlice.length : 0;

    nDemeaned = nSlice.map((v) => v - meanN);
    eDemeaned = eSlice.map((v) => v - meanE);
    zDemeaned = zSlice.length > 0 ? zSlice.map((v) => v - meanZ) : nSlice.map(() => 0);
  } else if (ehzBuf.length >= 10) {
    // Geophone derivative mode
    const zSlice = ehzBuf.slice(-pts);
    let sumZ = 0;
    for (let i = 0; i < zSlice.length; i++) sumZ += zSlice[i];
    const meanZ = sumZ / zSlice.length;
    zDemeaned = zSlice.map((v) => v - meanZ);

    nDemeaned = new Array(zSlice.length);
    eDemeaned = new Array(zSlice.length);
    for (let i = 0; i < zSlice.length; i++) {
      const prev = i > 0 ? zDemeaned[i - 1] : zDemeaned[i];
      const deriv = (zDemeaned[i] - prev) * 3.0;
      nDemeaned[i] = deriv;
      eDemeaned[i] = zDemeaned[i] * 0.6;
    }
  }

  if (nDemeaned.length < 2) return;

  // Peak calculation for stable auto-scaling
  let maxH = 0.5, maxV = 0.5;
  for (let i = 0; i < nDemeaned.length; i++) {
    const absH = Math.sqrt(nDemeaned[i] ** 2 + eDemeaned[i] ** 2);
    const absV = Math.abs(zDemeaned[i]);
    if (absH > maxH) maxH = absH;
    if (absV > maxV) maxV = absV;
  }

  // Stable scale target with sensible floor so it never over-magnifies off-screen
  const targetH = Math.max(maxH * 1.4, 4.0);
  const targetV = Math.max(maxV * 1.4, 4.0);

  if (!renderHodogram.smoothScaleH) {
    renderHodogram.smoothScaleH = targetH;
    renderHodogram.smoothScaleV = targetV;
  } else {
    // Smooth, dampened scale transitions (alpha = 0.05) to eliminate sudden zoom jumps
    renderHodogram.smoothScaleH = renderHodogram.smoothScaleH * 0.95 + targetH * 0.05;
    renderHodogram.smoothScaleV = renderHodogram.smoothScaleV * 0.95 + targetV * 0.05;
  }

  const scaleH = renderHodogram.smoothScaleH;
  const scaleV = renderHodogram.smoothScaleV;

  // =========================================================================
  // 1. Horizontal Plane (N-S vs E-W)
  // =========================================================================
  if (hCanvas) {
    const rect = hCanvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);

    if (w > 0 && h > 0) {
      const dpr = window.devicePixelRatio || 1;
      if (hCanvas.width !== Math.round(w * dpr) || hCanvas.height !== Math.round(h * dpr)) {
        hCanvas.width = Math.round(w * dpr);
        hCanvas.height = Math.round(h * dpr);
      }

      const ctx = hCanvas.getContext('2d');
      ctx.resetTransform();
      ctx.scale(dpr, dpr);

      // Deep obsidian background
      ctx.fillStyle = '#060913';
      ctx.fillRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(cx, cy) * 0.70;

      // Distance rings
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      [0.33, 0.66, 1.0].forEach((rPct) => {
        ctx.beginPath();
        ctx.arc(cx, cy, radius * rPct, 0, 2 * Math.PI);
        ctx.stroke();
      });

      // Crosshairs & Compass headings
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.beginPath();
      ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
      ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
      ctx.stroke();

      ctx.font = '700 9.5px JetBrains Mono, monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'center';
      ctx.fillText('N (ENN)', cx, cy - radius - 6);
      ctx.fillText('S', cx, cy + radius + 14);
      ctx.textAlign = 'left';
      ctx.fillText('E (ENE)', cx + radius + 8, cy + 3);
      ctx.textAlign = 'right';
      ctx.fillText('W', cx - radius - 8, cy + 3);

      // Draw Orbit Trail clamped strictly inside bounding radius
      ctx.lineWidth = 1.8;
      for (let i = 1; i < nDemeaned.length; i++) {
        const alpha = 0.10 + (i / nDemeaned.length) * 0.90;
        ctx.strokeStyle = `rgba(255, 170, 0, ${alpha.toFixed(2)})`;

        const normE0 = Math.max(-1.0, Math.min(1.0, eDemeaned[i - 1] / scaleH));
        const normN0 = Math.max(-1.0, Math.min(1.0, nDemeaned[i - 1] / scaleH));
        const normE1 = Math.max(-1.0, Math.min(1.0, eDemeaned[i] / scaleH));
        const normN1 = Math.max(-1.0, Math.min(1.0, nDemeaned[i] / scaleH));

        const x0 = cx + normE0 * radius;
        const y0 = cy - normN0 * radius;
        const x1 = cx + normE1 * radius;
        const y1 = cy - normN1 * radius;

        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      // Live leading particle head
      const lastIdx = nDemeaned.length - 1;
      const lastNormE = Math.max(-1.0, Math.min(1.0, eDemeaned[lastIdx] / scaleH));
      const lastNormN = Math.max(-1.0, Math.min(1.0, nDemeaned[lastIdx] / scaleH));
      const headX = cx + lastNormE * radius;
      const headY = cy - lastNormN * radius;

      ctx.fillStyle = '#ffaa00';
      ctx.shadowColor = '#ffaa00';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(headX, headY, 4.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Current vector line from center
      ctx.strokeStyle = 'rgba(255, 170, 0, 0.45)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(headX, headY);
      ctx.stroke();

      // Azimuth annotation
      const azRad = Math.atan2(eDemeaned[lastIdx], nDemeaned[lastIdx]);
      let azDeg = (azRad * (180 / Math.PI) + 360) % 360;
      ctx.font = '9.5px JetBrains Mono, monospace';
      ctx.fillStyle = '#ffaa00';
      ctx.textAlign = 'left';
      ctx.fillText(`Back-Azimuth: ${azDeg.toFixed(0)}°`, 10, 16);
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`Scale: ±${scaleH.toFixed(1)} counts`, 10, 28);
    }
  }

  // =========================================================================
  // 2. Vertical Plane (Z vs Horizontal)
  // =========================================================================
  if (vCanvas) {
    const rect = vCanvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);

    if (w > 0 && h > 0) {
      const dpr = window.devicePixelRatio || 1;
      if (vCanvas.width !== Math.round(w * dpr) || vCanvas.height !== Math.round(h * dpr)) {
        vCanvas.width = Math.round(w * dpr);
        vCanvas.height = Math.round(h * dpr);
      }

      const ctx = vCanvas.getContext('2d');
      ctx.resetTransform();
      ctx.scale(dpr, dpr);

      ctx.fillStyle = '#060913';
      ctx.fillRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(cx, cy) * 0.70;

      // Distance rings
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      [0.33, 0.66, 1.0].forEach((rPct) => {
        ctx.beginPath();
        ctx.arc(cx, cy, radius * rPct, 0, 2 * Math.PI);
        ctx.stroke();
      });

      // Crosshairs
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.beginPath();
      ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
      ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
      ctx.stroke();

      ctx.font = '700 9.5px JetBrains Mono, monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'center';
      ctx.fillText('+Z (Up / ENZ)', cx, cy - radius - 6);
      ctx.fillText('-Z (Down)', cx, cy + radius + 14);
      ctx.textAlign = 'left';
      ctx.fillText('+H (Horiz)', cx + radius + 8, cy + 3);
      ctx.textAlign = 'right';
      ctx.fillText('-H', cx - radius - 8, cy + 3);

      // Draw Vertical Orbit Trail clamped strictly inside bounding radius
      ctx.lineWidth = 1.8;
      for (let i = 1; i < zDemeaned.length; i++) {
        const alpha = 0.10 + (i / zDemeaned.length) * 0.90;
        ctx.strokeStyle = `rgba(0, 210, 255, ${alpha.toFixed(2)})`;

        const hMag0 = Math.sqrt(nDemeaned[i - 1] ** 2 + eDemeaned[i - 1] ** 2);
        const hMag1 = Math.sqrt(nDemeaned[i] ** 2 + eDemeaned[i] ** 2);

        const normH0 = Math.max(-1.0, Math.min(1.0, hMag0 / scaleH));
        const normZ0 = Math.max(-1.0, Math.min(1.0, zDemeaned[i - 1] / scaleV));
        const normH1 = Math.max(-1.0, Math.min(1.0, hMag1 / scaleH));
        const normZ1 = Math.max(-1.0, Math.min(1.0, zDemeaned[i] / scaleV));

        const x0 = cx + normH0 * radius * 0.85;
        const y0 = cy - normZ0 * radius;
        const x1 = cx + normH1 * radius * 0.85;
        const y1 = cy - normZ1 * radius;

        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      // Live leading particle head
      const lastIdx = zDemeaned.length - 1;
      const lastHMag = Math.sqrt(nDemeaned[lastIdx] ** 2 + eDemeaned[lastIdx] ** 2);
      const lastNormH = Math.max(-1.0, Math.min(1.0, lastHMag / scaleH));
      const lastNormZ = Math.max(-1.0, Math.min(1.0, zDemeaned[lastIdx] / scaleV));
      const headX = cx + lastNormH * radius * 0.85;
      const headY = cy - lastNormZ * radius;

      ctx.fillStyle = '#00d2ff';
      ctx.shadowColor = '#00d2ff';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(headX, headY, 4.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Current vector line from center
      ctx.strokeStyle = 'rgba(0, 210, 255, 0.45)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(headX, headY);
      ctx.stroke();

      // Inclination & scale annotations
      const incRad = Math.atan2(zDemeaned[lastIdx], Math.max(lastHMag, 0.05));
      const incDeg = incRad * (180 / Math.PI);
      ctx.font = '9.5px JetBrains Mono, monospace';
      ctx.fillStyle = '#00d2ff';
      ctx.textAlign = 'left';
      ctx.fillText(`Inclination Angle: ${incDeg.toFixed(0)}°`, 10, 16);
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`Scale: ±${scaleV.toFixed(1)} counts`, 10, 28);
    }
  }
}
