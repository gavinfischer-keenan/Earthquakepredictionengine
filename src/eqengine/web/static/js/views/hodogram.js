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

  // Determine available samples
  const hasTriaxial = (ennBuf.length >= 10 && eneBuf.length >= 10 && enzBuf.length >= 10);
  const pts = hasTriaxial
    ? Math.min(ennBuf.length, 150) // last 1.5s @ 100 Hz
    : Math.min(ehzBuf.length, 150);

  let nDemeaned = [];
  let eDemeaned = [];
  let zDemeaned = [];

  if (hasTriaxial && pts >= 10) {
    const nSlice = ennBuf.slice(-pts);
    const eSlice = eneBuf.slice(-pts);
    const zSlice = enzBuf.slice(-pts);

    let sumN = 0, sumE = 0, sumZ = 0;
    for (let i = 0; i < pts; i++) {
      sumN += nSlice[i];
      sumE += eSlice[i];
      sumZ += zSlice[i];
    }
    const meanN = sumN / pts;
    const meanE = sumE / pts;
    const meanZ = sumZ / pts;

    nDemeaned = nSlice.map((v) => v - meanN);
    eDemeaned = eSlice.map((v) => v - meanE);
    zDemeaned = zSlice.map((v) => v - meanZ);
  } else if (ehzBuf.length >= 10) {
    // Single geophone mode: generate phase-space trajectory (EHZ vs pseudo-orthogonal derivative)
    const zSlice = ehzBuf.slice(-pts);
    let sumZ = 0;
    for (let i = 0; i < pts; i++) sumZ += zSlice[i];
    const meanZ = sumZ / pts;
    zDemeaned = zSlice.map((v) => v - meanZ);

    // Synthetic horizontal projection for demonstration when accelerometer is idle
    nDemeaned = new Array(pts);
    eDemeaned = new Array(pts);
    for (let i = 0; i < pts; i++) {
      const prev = i > 0 ? zDemeaned[i - 1] : zDemeaned[i];
      const deriv = (zDemeaned[i] - prev) * 5.0;
      nDemeaned[i] = deriv;
      eDemeaned[i] = zDemeaned[i] * 0.7;
    }
  }

  // Peak calculation for smooth auto-scaling
  let maxH = 10.0, maxV = 10.0;
  for (let i = 0; i < nDemeaned.length; i++) {
    const absH = Math.sqrt(nDemeaned[i] ** 2 + eDemeaned[i] ** 2);
    const absV = Math.abs(zDemeaned[i]);
    if (absH > maxH) maxH = absH;
    if (absV > maxV) maxV = absV;
  }

  if (!renderHodogram.smoothScaleH) {
    renderHodogram.smoothScaleH = Math.max(maxH * 1.3, 20.0);
    renderHodogram.smoothScaleV = Math.max(maxV * 1.3, 20.0);
  } else {
    const targetH = Math.max(maxH * 1.3, 20.0);
    const targetV = Math.max(maxV * 1.3, 20.0);
    renderHodogram.smoothScaleH = renderHodogram.smoothScaleH * 0.9 + targetH * 0.1;
    renderHodogram.smoothScaleV = renderHodogram.smoothScaleV * 0.9 + targetV * 0.1;
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
      const radius = Math.min(cx, cy) * 0.76;

      // Distance rings
      ctx.strokeStyle = '#182234';
      ctx.lineWidth = 1;
      [0.33, 0.66, 1.0].forEach((rPct) => {
        ctx.beginPath();
        ctx.arc(cx, cy, radius * rPct, 0, 2 * Math.PI);
        ctx.stroke();
      });

      // Crosshairs & Compass headings
      ctx.strokeStyle = '#25354d';
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

      // Draw Orbit Trail
      if (nDemeaned.length > 1) {
        ctx.lineWidth = 1.6;
        for (let i = 1; i < nDemeaned.length; i++) {
          const alpha = 0.15 + (i / nDemeaned.length) * 0.85;
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
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(headX, headY, 4.5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Current vector line from center
        ctx.strokeStyle = 'rgba(255, 170, 0, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(headX, headY);
        ctx.stroke();

        // Azimuth annotation
        const azRad = Math.atan2(eDemeaned[lastIdx], nDemeaned[lastIdx]);
        let azDeg = (azRad * (180 / Math.PI) + 360) % 360;
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillStyle = '#ffaa00';
        ctx.textAlign = 'left';
        ctx.fillText(`Azimuth: ${azDeg.toFixed(0)}°`, 8, 14);
        ctx.fillText(`Scale: ±${Math.round(scaleH)} counts`, 8, 26);
      } else {
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillStyle = '#64748b';
        ctx.textAlign = 'left';
        ctx.fillText('Listening for triaxial motion...', 8, 14);
      }
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

      // Deep obsidian background
      ctx.fillStyle = '#060913';
      ctx.fillRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(cx, cy) * 0.76;

      // Distance rings
      ctx.strokeStyle = '#182234';
      ctx.lineWidth = 1;
      [0.33, 0.66, 1.0].forEach((rPct) => {
        ctx.beginPath();
        ctx.arc(cx, cy, radius * rPct, 0, 2 * Math.PI);
        ctx.stroke();
      });

      // Crosshairs
      ctx.strokeStyle = '#25354d';
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
      ctx.fillText('+H', cx + radius + 8, cy + 3);
      ctx.textAlign = 'right';
      ctx.fillText('-H', cx - radius - 8, cy + 3);

      // Draw Vertical Orbit Trail
      if (zDemeaned.length > 1) {
        ctx.lineWidth = 1.6;
        for (let i = 1; i < zDemeaned.length; i++) {
          const alpha = 0.15 + (i / zDemeaned.length) * 0.85;
          ctx.strokeStyle = `rgba(0, 210, 255, ${alpha.toFixed(2)})`;

          const hMag0 = Math.sqrt(nDemeaned[i - 1] ** 2 + eDemeaned[i - 1] ** 2);
          const hMag1 = Math.sqrt(nDemeaned[i] ** 2 + eDemeaned[i] ** 2);

          const x0 = cx + (hMag0 / scaleH) * radius * 0.8;
          const y0 = cy - (zDemeaned[i - 1] / scaleV) * radius;
          const x1 = cx + (hMag1 / scaleH) * radius * 0.8;
          const y1 = cy - (zDemeaned[i] / scaleV) * radius;

          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }

        // Live leading particle head
        const lastIdx = zDemeaned.length - 1;
        const lastHMag = Math.sqrt(nDemeaned[lastIdx] ** 2 + eDemeaned[lastIdx] ** 2);
        const headX = cx + (lastHMag / scaleH) * radius * 0.8;
        const headY = cy - (zDemeaned[lastIdx] / scaleV) * radius;

        ctx.fillStyle = '#00d2ff';
        ctx.shadowColor = '#00d2ff';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(headX, headY, 4.5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Current vector line from center
        ctx.strokeStyle = 'rgba(0, 210, 255, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(headX, headY);
        ctx.stroke();

        // Polarization & scale annotations
        const incRad = Math.atan2(zDemeaned[lastIdx], Math.max(lastHMag, 0.1));
        const incDeg = incRad * (180 / Math.PI);
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillStyle = '#00d2ff';
        ctx.textAlign = 'left';
        ctx.fillText(`Inclination: ${incDeg.toFixed(0)}°`, 8, 14);
        ctx.fillText(`Scale: ±${Math.round(scaleV)} counts`, 8, 26);
      } else {
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillStyle = '#64748b';
        ctx.textAlign = 'left';
        ctx.fillText('Listening for vertical motion...', 8, 14);
      }
    }
  }
}
