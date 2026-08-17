/**
 * High-Definition 256-Point FFT Waterfall Spectrogram
 */

import { state } from '../state.js';
import { elements } from '../dom.js';
import { computeFFT256, getSpectrogramColor } from '../dsp.js';

let offscreenCanvas = null;
let lastSpectrogramUpdate = 0;

export function renderSpectrogram() {
  const canvas = elements.canvases.spectrogram;
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (w <= 0 || h <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    // Recreate offscreen buffer on resize
    offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = canvas.width;
    offscreenCanvas.height = canvas.height;
    const octx = offscreenCanvas.getContext('2d');
    octx.fillStyle = '#050814';
    octx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
  }

  if (!offscreenCanvas) {
    offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = canvas.width;
    offscreenCanvas.height = canvas.height;
    const octx = offscreenCanvas.getContext('2d');
    octx.fillStyle = '#050814';
    octx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
  }

  const now = Date.now();
  // Update at ~20 Hz (every 50ms) for high-density waterfall
  if (now - lastSpectrogramUpdate < 50) {
    const ctx = canvas.getContext('2d');
    ctx.drawImage(offscreenCanvas, 0, 0);
    return;
  }
  lastSpectrogramUpdate = now;

  const ehzBuf = state.buffers.EHZ;
  if (!ehzBuf || ehzBuf.length < 32) return;

  const mags = computeFFT256(ehzBuf);
  const nBins = mags.length; // 128 bins (0 - 50 Hz)

  const octx = offscreenCanvas.getContext('2d');
  const shiftPx = 2 * dpr;

  // Shift previous spectrogram image left by shiftPx
  octx.drawImage(offscreenCanvas, shiftPx, 0, offscreenCanvas.width - shiftPx, offscreenCanvas.height, 0, 0, offscreenCanvas.width - shiftPx, offscreenCanvas.height);

  // Draw new vertical column on the right edge
  const colX = offscreenCanvas.width - shiftPx;
  const binH = offscreenCanvas.height / nBins;

  for (let b = 0; b < nBins; b++) {
    const mag = mags[b];
    octx.fillStyle = getSpectrogramColor(mag, 1.8);
    // Draw from low frequency (bottom) to high frequency (top)
    const y = offscreenCanvas.height - (b + 1) * binH;
    octx.fillRect(colX, y, shiftPx, binH + 0.5);
  }

  // Blit offscreen buffer to visible canvas
  const ctx = canvas.getContext('2d');
  ctx.drawImage(offscreenCanvas, 0, 0);

  // Overlay frequency axis markings (10 Hz, 20 Hz, 30 Hz, 40 Hz, 50 Hz)
  ctx.save();
  ctx.resetTransform();
  ctx.scale(dpr, dpr);
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.textAlign = 'left';

  [10, 20, 30, 40, 50].forEach((freq) => {
    const yRatio = freq / 50.0;
    const y = h - yRatio * h;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillText(`${freq} Hz`, 6, y - 2);
  });
  ctx.setLineDash([]);
  ctx.restore();
}
