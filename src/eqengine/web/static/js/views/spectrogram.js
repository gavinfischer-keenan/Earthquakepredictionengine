/**
 * High-Definition 256-Point FFT Waterfall Spectrogram
 * Pixel-perfect zero-copy ImageData rendering with smooth bilinear frequency interpolation
 */

import { state } from '../state.js';
import { elements } from '../dom.js';
import { computeFFT256, getMagColor32 } from '../dsp.js';

let imgData = null;
let data32 = null;
let lastWidth = 0;
let lastHeight = 0;
let lastSpectrogramUpdate = 0;

export function renderSpectrogram() {
  const canvas = elements.canvases.spectrogram;
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  if (w <= 0 || h <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  const canvasW = Math.round(w * dpr);
  const canvasH = Math.round(h * dpr);

  if (canvas.width !== canvasW || canvas.height !== canvasH || !imgData || lastWidth !== canvasW || lastHeight !== canvasH) {
    canvas.width = canvasW;
    canvas.height = canvasH;
    lastWidth = canvasW;
    lastHeight = canvasH;

    const ctx = canvas.getContext('2d');
    imgData = ctx.createImageData(canvasW, canvasH);
    data32 = new Uint32Array(imgData.data.buffer);

    // Initialize with deep obsidian background (0xFF140508)
    data32.fill(0xFF140508);
  }

  const now = Date.now();
  // Smooth 25 Hz waterfall update rate (every 40ms)
  const isNewFftStep = now - lastSpectrogramUpdate >= 40;

  if (isNewFftStep) {
    lastSpectrogramUpdate = now;
    const ehzBuf = state.buffers.EHZ;

    if (ehzBuf && ehzBuf.length >= 32) {
      const mags = computeFFT256(ehzBuf);
      const nBins = mags.length; // 128 bins (0 - 50 Hz, 0.39 Hz resolution)
      const gain = state.gainMode === 'auto' ? 1.4 : parseFloat(state.gainMode) || 1.0;

      // 1. Shift every horizontal row left by 1 pixel
      for (let y = 0; y < canvasH; y++) {
        const rowStart = y * canvasW;
        data32.copyWithin(rowStart, rowStart + 1, rowStart + canvasW);
      }

      // 2. Compute the new rightmost column using smooth bilinear frequency interpolation
      const rightCol = canvasW - 1;
      for (let y = 0; y < canvasH; y++) {
        // Frequency axis: 0 Hz at the bottom (y = canvasH - 1), 50 Hz at the top (y = 0)
        const normY = 1.0 - (y / Math.max(canvasH - 1, 1));
        const binFloat = normY * (nBins - 1);
        const b0 = Math.floor(binFloat);
        const b1 = Math.min(nBins - 1, b0 + 1);
        const frac = binFloat - b0;

        const magInterp = mags[b0] * (1.0 - frac) + mags[b1] * frac;
        data32[y * canvasW + rightCol] = getMagColor32(magInterp, gain);
      }
    }
  }

  // 3. Blit pixel-perfect ImageData to canvas
  const ctx = canvas.getContext('2d');
  ctx.putImageData(imgData, 0, 0);

  // 4. Overlay clean frequency axis gridlines & labels
  ctx.save();
  ctx.resetTransform();
  ctx.scale(dpr, dpr);
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.textAlign = 'left';

  [10, 20, 30, 40, 50].forEach((freq) => {
    const yRatio = freq / 50.0;
    const y = Math.round(h - yRatio * h);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillText(`${freq} Hz`, 8, y - 3);
  });

  ctx.setLineDash([]);
  ctx.restore();
}
