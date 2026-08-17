/**
 * Hodogram View: 3D Particle Motion Orbit (Horizontal & Vertical Planes)
 */

import { state } from '../state.js';
import { elements } from '../dom.js';

export function renderHodogram() {
  const enzBuf = state.buffers.ENZ;
  const ennBuf = state.buffers.ENN;
  const eneBuf = state.buffers.ENE;

  if (!enzBuf || !ennBuf || !eneBuf || enzBuf.length < 10) return;

  const pts = Math.min(enzBuf.length, 150); // last 1.5s
  const zSlice = enzBuf.slice(-pts);
  const nSlice = ennBuf.slice(-pts);
  const eSlice = eneBuf.slice(-pts);

  // Demean
  let sumZ = 0, sumN = 0, sumE = 0;
  for (let i = 0; i < pts; i++) {
    sumZ += zSlice[i];
    sumN += nSlice[i];
    sumE += eSlice[i];
  }
  const meanZ = sumZ / pts, meanN = sumN / pts, meanE = sumE / pts;

  const zDemeaned = zSlice.map((v) => v - meanZ);
  const nDemeaned = nSlice.map((v) => v - meanN);
  const eDemeaned = eSlice.map((v) => v - meanE);

  // Peak calculation
  let maxH = 5.0, maxV = 5.0;
  for (let i = 0; i < pts; i++) {
    const absH = Math.sqrt(nDemeaned[i] ** 2 + eDemeaned[i] ** 2);
    const absV = Math.abs(zDemeaned[i]);
    if (absH > maxH) maxH = absH;
    if (absV > maxV) maxV = absV;
  }

  // Smooth dynamic scale (prevent instantaneous scaling jitter)
  if (!renderHodogram.smoothScaleH) {
    renderHodogram.smoothScaleH = Math.max(maxH * 1.3, 10.0);
    renderHodogram.smoothScaleV = Math.max(maxV * 1.3, 10.0);
  } else {
    const targetH = Math.max(maxH * 1.3, 10.0);
    const targetV = Math.max(maxV * 1.3, 10.0);
    renderHodogram.smoothScaleH = renderHodogram.smoothScaleH * 0.9 + targetH * 0.1;
    renderHodogram.smoothScaleV = renderHodogram.smoothScaleV * 0.9 + targetV * 0.1;
  }

  const scaleH = renderHodogram.smoothScaleH;
  const scaleV = renderHodogram.smoothScaleV;

  // 1. Horizontal Plane (N vs E)
  const hCanvas = elements.canvases.hodoH;
  if (hCanvas) {
    const rect = hCanvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (w > 0 && h > 0) {
      const dpr = window.devicePixelRatio || 1;
      if (hCanvas.width !== Math.round(w * dpr) || hCanvas.height !== Math.round(h * dpr)) {
        hCanvas.width = Math.round(w * dpr);
        hCanvas.height = Math.round(h * dpr);
      }

      const ctx = hCanvas.getContext('2d');
      ctx.resetTransform();
      ctx.scale(dpr, dpr);

      ctx.fillStyle = '#0a0e17';
      ctx.fillRect(0, 0, w, h);

      const cx = w / 2, cy = h / 2;
      const radius = Math.min(cx, cy) * 0.82;

      // Distance rings
      ctx.strokeStyle = '#182234';
      ctx.lineWidth = 1;
      [0.33, 0.66, 1.0].forEach((rPct) => {
        ctx.beginPath();
        ctx.arc(cx, cy, radius * rPct, 0, 2 * Math.PI);
        ctx.stroke();
      });

      // Crosshairs & Compass labels
      ctx.strokeStyle = '#25354d';
      ctx.beginPath();
      ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
      ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
      ctx.stroke();

      ctx.font = '10px JetBrains Mono';
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'center';
      ctx.fillText('N (ENN)', cx, cy - radius - 6);
      ctx.fillText('S', cx, cy + radius + 14);
      ctx.fillText('E (ENE)', cx + radius + 22, cy + 3);
      ctx.fillText('W', cx - radius - 14, cy + 3);

      // Trajectory
      for (let i = 1; i < pts; i++) {
        const alpha = 0.12 + 0.88 * (i / pts);
        const x0 = cx + (eDemeaned[i - 1] / scaleH) * radius;
        const y0 = cy - (nDemeaned[i - 1] / scaleH) * radius;
        const x1 = cx + (eDemeaned[i] / scaleH) * radius;
        const y1 = cy - (nDemeaned[i] / scaleH) * radius;

        ctx.strokeStyle = `rgba(255, 170, 0, ${alpha})`;
        ctx.lineWidth = 1.0 + 1.5 * (i / pts);
        ctx.beginPath();
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      // Particle Head
      const headX = cx + (eDemeaned[pts - 1] / scaleH) * radius;
      const headY = cy - (nDemeaned[pts - 1] / scaleH) * radius;
      ctx.fillStyle = '#ffaa00';
      ctx.shadowColor = '#ffaa00';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(headX, headY, 4.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // 2. Vertical Plane (Z vs H)
  const vCanvas = elements.canvases.hodoV;
  if (vCanvas) {
    const rect = vCanvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (w > 0 && h > 0) {
      const dpr = window.devicePixelRatio || 1;
      if (vCanvas.width !== Math.round(w * dpr) || vCanvas.height !== Math.round(h * dpr)) {
        vCanvas.width = Math.round(w * dpr);
        vCanvas.height = Math.round(h * dpr);
      }

      const ctx = vCanvas.getContext('2d');
      ctx.resetTransform();
      ctx.scale(dpr, dpr);

      ctx.fillStyle = '#0a0e17';
      ctx.fillRect(0, 0, w, h);

      const cx = w / 2, cy = h / 2;
      const radius = Math.min(cx, cy) * 0.82;

      ctx.strokeStyle = '#182234';
      ctx.lineWidth = 1;
      [0.33, 0.66, 1.0].forEach((rPct) => {
        ctx.beginPath();
        ctx.arc(cx, cy, radius * rPct, 0, 2 * Math.PI);
        ctx.stroke();
      });

      ctx.strokeStyle = '#25354d';
      ctx.beginPath();
      ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
      ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
      ctx.stroke();

      ctx.font = '10px JetBrains Mono';
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'center';
      ctx.fillText('+Z (Up / ENZ)', cx, cy - radius - 6);
      ctx.fillText('-Z (Down)', cx, cy + radius + 14);
      ctx.fillText('+H (Horiz)', cx + radius + 24, cy + 3);
      ctx.fillText('-H', cx - radius - 14, cy + 3);

      for (let i = 1; i < pts; i++) {
        const alpha = 0.12 + 0.88 * (i / pts);
        const radH0 = Math.sqrt(nDemeaned[i - 1] ** 2 + eDemeaned[i - 1] ** 2) * (nDemeaned[i - 1] >= 0 ? 1 : -1);
        const radH1 = Math.sqrt(nDemeaned[i] ** 2 + eDemeaned[i] ** 2) * (nDemeaned[i] >= 0 ? 1 : -1);

        const x0 = cx + (radH0 / scaleV) * radius;
        const y0 = cy - (zDemeaned[i - 1] / scaleV) * radius;
        const x1 = cx + (radH1 / scaleV) * radius;
        const y1 = cy - (zDemeaned[i] / scaleV) * radius;

        ctx.strokeStyle = `rgba(0, 210, 255, ${alpha})`;
        ctx.lineWidth = 1.0 + 1.5 * (i / pts);
        ctx.beginPath();
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      const lastH = Math.sqrt(nDemeaned[pts - 1] ** 2 + eDemeaned[pts - 1] ** 2) * (nDemeaned[pts - 1] >= 0 ? 1 : -1);
      const headX = cx + (lastH / scaleV) * radius;
      const headY = cy - (zDemeaned[pts - 1] / scaleV) * radius;

      ctx.fillStyle = '#00d2ff';
      ctx.shadowColor = '#00d2ff';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(headX, headY, 4.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}
