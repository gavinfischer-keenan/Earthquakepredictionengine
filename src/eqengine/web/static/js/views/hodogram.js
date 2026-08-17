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

  // Determine available samples (last 2 seconds @ 100 Hz = 200 pts)
  const pts = Math.min(Math.max(ehzBuf.length, ennBuf.length, 20), 200);

  let nDemeaned = [];
  let eDemeaned = [];
  let zDemeaned = [];

  // Prefer triaxial accelerometers if available, otherwise combine vertical geophone with horizontal
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
    // Single geophone mode: phase-space derivative trajectory
    const zSlice = ehzBuf.slice(-pts);
    let sumZ = 0;
    for (let i = 0; i < zSlice.length; i++) sumZ += zSlice[i];
    const meanZ = sumZ / zSlice.length;
    zDemeaned = zSlice.map((v) => v - meanZ);

    nDemeaned = new Array(zSlice.length);
    eDemeaned = new Array(zSlice.length);
    for (let i = 0; i < zSlice.length; i++) {
      const prev = i > 0 ? zDemeaned[i - 1] : zDemeaned[i];
      const deriv = (zDemeaned[i] - prev) * 4.0;
      nDemeaned[i] = deriv;
      eDemeaned[i] = zDemeaned[i] * 0.75;
    }
  }

  if (nDemeaned.length < 2) return;

  // Peak calculation for responsive auto-scaling
  let maxH = 0.1, maxV = 0.1;
  for (let i = 0; i < nDemeaned.length; i++) {
    const absH = Math.sqrt(nDemeaned[i] ** 2 + eDemeaned[i] ** 2);
    const absV = Math.abs(zDemeaned[i]);
    if (absH > maxH) maxH = absH;
    if (absV > maxV) maxV = absV;
  }

  const targetH = Math.max(maxH * 1.35, 0.4);
  const targetV = Math.max(maxV * 1.35, 0.4);

  if (!renderHodogram.smoothScaleH) {
    renderHodogram.smoothScaleH = targetH;
    renderHodogram.smoothScaleV = targetV;
  } else {
    renderHodogram.smoothScaleH = renderHodogram.smoothScaleH * 0.90 + targetH * 0.10;
    renderHodogram.smoothScaleV = renderHodogram.smoothScaleV * 0.90 + targetV * 0.10;
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

      // Deep background
      ctx.fillStyle = '#060913';
      ctx.fillRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(cx, cy) * 0.78;

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

      // Draw Orbit Trail with gradient opacity
      ctx.lineWidth = 1.8;
      for (let i = 1; i < nDemeaned.length; i++) {
        const alpha = 0.10 + (i / nDemeaned.length) * 0.90;
        ctx.strokeStyle = `rgba(255, 170, 0, ${alpha.toFixed(2)})`;

        const x0 = cx + (eDemeaned[i - 1] / scaleH) * radius;
        const y0 = cy - (nDemeaned[i - 1] / scaleH) * radius;
        const x1 = cx + (eDemeaned[i] / scaleH) * radius;
        const y1 = cy - (nDemeaned[i] / scaleH) * radius;

        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      // Live leading particle head
      const lastIdx = nDemeaned.length - 1;
      const headX = cx + (eDemeaned[lastIdx] / scaleH) * radius;
      const headY = cy - (nDemeaned[lastIdx] / scaleH) * radius;

      ctx.fillStyle = '#ffaa00';
      ctx.shadowColor = '#ffaa00';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(headX, headY, 5.0, 0, 2 * Math.PI);
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
      const radius = Math.min(cx, cy) * 0.78;

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
      ctx.fillText('+Z (Up / ENZ/EHZ)', cx, cy - radius - 6);
      ctx.fillText('-Z (Down)', cx, cy + radius + 14);
      ctx.textAlign = 'left';
      ctx.fillText('+H (Horiz)', cx + radius + 8, cy + 3);
      ctx.textAlign = 'right';
      ctx.fillText('-H', cx - radius - 8, cy + 3);

      // Draw Vertical Orbit Trail
      ctx.lineWidth = 1.8;
      for (let i = 1; i < zDemeaned.length; i++) {
        const alpha = 0.10 + (i / zDemeaned.length) * 0.90;
        ctx.strokeStyle = `rgba(0, 210, 255, ${alpha.toFixed(2)})`;

        const hMag0 = Math.sqrt(nDemeaned[i - 1] ** 2 + eDemeaned[i - 1] ** 2);
        const hMag1 = Math.sqrt(nDemeaned[i] ** 2 + eDemeaned[i] ** 2);

        const x0 = cx + (hMag0 / scaleH) * radius * 0.85;
        const y0 = cy - (zDemeaned[i - 1] / scaleV) * radius;
        const x1 = cx + (hMag1 / scaleH) * radius * 0.85;
        const y1 = cy - (zDemeaned[i] / scaleV) * radius;

        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      // Live leading particle head
      const lastIdx = zDemeaned.length - 1;
      const lastHMag = Math.sqrt(nDemeaned[lastIdx] ** 2 + eDemeaned[lastIdx] ** 2);
      const headX = cx + (lastHMag / scaleH) * radius * 0.85;
      const headY = cy - (zDemeaned[lastIdx] / scaleV) * radius;

      ctx.fillStyle = '#00d2ff';
      ctx.shadowColor = '#00d2ff';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(headX, headY, 5.0, 0, 2 * Math.PI);
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
