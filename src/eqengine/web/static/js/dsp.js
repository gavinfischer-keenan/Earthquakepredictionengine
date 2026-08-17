/**
 * High-Performance Digital Signal Processing & Geophysical Mathematics
 */

// Pre-computed Blackman-Harris 256 window to eliminate allocation overhead
const FFT_SIZE = 256;
const BLACKMAN_HARRIS_256 = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  const a0 = 0.35875;
  const a1 = 0.48829;
  const a2 = 0.14128;
  const a3 = 0.01168;
  const term = (2 * Math.PI * i) / (FFT_SIZE - 1);
  BLACKMAN_HARRIS_256[i] = a0 - a1 * Math.cos(term) + a2 * Math.cos(2 * term) - a3 * Math.cos(3 * term);
}

// Pre-allocated real/imag arrays for FFT
const fftReal = new Float32Array(FFT_SIZE);
const fftImag = new Float32Array(FFT_SIZE);

export function filterData(data, mode) {
  if (!data || data.length === 0 || mode === 'raw') return data;

  const n = data.length;
  const out = new Float64Array(n);

  // Mean removal
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i];
  const mean = sum / n;
  for (let i = 0; i < n; i++) out[i] = data[i] - mean;

  if (mode === 'bandpass') {
    // 2nd-order bandpass filter (1–10 Hz @ 100 Hz SR)
    const b0 = 0.067455, b1 = 0, b2 = -0.067455;
    const a1 = -1.14298, a2 = 0.41280;
    const temp = new Float64Array(n);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

    for (let i = 0; i < n; i++) {
      const x0 = out[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      temp[i] = y0;
      x2 = x1; x1 = x0;
      y2 = y1; y1 = y0;
    }
    return temp;
  }

  if (mode === 'highpass') {
    // 1-pole highpass (0.5 Hz @ 100 Hz SR)
    const alpha = 0.969;
    const temp = new Float64Array(n);
    let y = 0, xPrev = out[0];

    for (let i = 0; i < n; i++) {
      y = alpha * (y + out[i] - xPrev);
      xPrev = out[i];
      temp[i] = y;
    }
    return temp;
  }

  if (mode === 'lowpass') {
    // 1-pole lowpass (5 Hz @ 100 Hz SR)
    const alpha = 0.24;
    const temp = new Float64Array(n);
    let y = out[0];

    for (let i = 0; i < n; i++) {
      y += alpha * (out[i] - y);
      temp[i] = y;
    }
    return temp;
  }

  return out;
}

/**
 * Radix-2 In-Place Cooley-Tukey Fast Fourier Transform (256-point)
 * Returns magnitudes array of length 128 (0 to 50 Hz, 0.39 Hz resolution)
 */
export function computeFFT256(samples) {
  const n = FFT_SIZE;
  const nSamples = samples.length;

  // Mean removal & windowing into pre-allocated real array
  let sum = 0;
  const start = Math.max(0, nSamples - n);
  const count = nSamples - start;
  for (let i = 0; i < count; i++) sum += samples[start + i];
  const mean = count > 0 ? sum / count : 0;

  for (let i = 0; i < n; i++) {
    if (i < count) {
      fftReal[i] = (samples[start + i] - mean) * BLACKMAN_HARRIS_256[i];
    } else {
      fftReal[i] = 0;
    }
    fftImag[i] = 0;
  }

  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      const tempR = fftReal[i];
      fftReal[i] = fftReal[j];
      fftReal[j] = tempR;
      const tempI = fftImag[i];
      fftImag[i] = fftImag[j];
      fftImag[j] = tempI;
    }
    let k = n >> 1;
    while (k <= j) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }

  // Butterfly computation
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wStepR = Math.cos(angle);
    const wStepI = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let wr = 1.0;
      let wi = 0.0;
      for (let m = 0; m < half; m++) {
        const uR = fftReal[i + m];
        const uI = fftImag[i + m];
        const vR = fftReal[i + m + half] * wr - fftImag[i + m + half] * wi;
        const vI = fftReal[i + m + half] * wi + fftImag[i + m + half] * wr;

        fftReal[i + m] = uR + vR;
        fftImag[i + m] = uI + vI;
        fftReal[i + m + half] = uR - vR;
        fftImag[i + m + half] = uI - vI;

        const nextWr = wr * wStepR - wi * wStepI;
        wi = wr * wStepI + wi * wStepR;
        wr = nextWr;
      }
    }
  }

  // Power magnitudes for first 128 bins (0 - 50 Hz)
  const halfBins = n >> 1;
  const magnitudes = new Float32Array(halfBins);
  for (let i = 0; i < halfBins; i++) {
    magnitudes[i] = Math.sqrt(fftReal[i] * fftReal[i] + fftImag[i] * fftImag[i]);
  }

  return magnitudes;
}

// ---------------------------------------------------------------------------
// Precomputed 256-level Inferno/Magma Geophysical Colormap
// ---------------------------------------------------------------------------
export const COLOR_LUT_RGBA_32 = new Uint32Array(256);
export const COLOR_LUT_RGB_STR = new Array(256);

for (let i = 0; i < 256; i++) {
  const t = i / 255.0;
  let r = 0, g = 0, b = 0;

  if (t < 0.25) {
    const k = t / 0.25;
    r = Math.floor(8 + k * 55);
    g = Math.floor(5 + k * 15);
    b = Math.floor(20 + k * 95);
  } else if (t < 0.55) {
    const k = (t - 0.25) / 0.3;
    r = Math.floor(63 + k * 135);
    g = Math.floor(20 + k * 30);
    b = Math.floor(115 - k * 55);
  } else if (t < 0.85) {
    const k = (t - 0.55) / 0.3;
    r = Math.floor(198 + k * 54);
    g = Math.floor(50 + k * 135);
    b = Math.floor(60 - k * 35);
  } else {
    const k = (t - 0.85) / 0.15;
    r = Math.floor(252 + k * 3);
    g = Math.floor(185 + k * 70);
    b = Math.floor(25 + k * 215);
  }

  // Pack as Little-Endian 0xAABBGGRR for direct 32-bit Uint32Array blitting
  COLOR_LUT_RGBA_32[i] = (255 << 24) | (b << 16) | (g << 8) | r;
  COLOR_LUT_RGB_STR[i] = `rgb(${r},${g},${b})`;
}

/**
 * Fast lookup for 32-bit packed color from seismic power
 */
export function getMagColor32(mag, gain = 1.0) {
  const db = 20.0 * Math.log10(Math.max(mag * gain, 0.05));
  // Map 15 dB (ambient baseline ~6 counts) to 75 dB (intense ~6000 counts)
  const norm = Math.max(0.0, Math.min(1.0, (db - 15.0) / 60.0));
  const idx = Math.floor(norm * 255);
  return COLOR_LUT_RGBA_32[idx];
}

export function getSpectrogramColor(value, gain = 1.0) {
  const db = 20.0 * Math.log10(Math.max(value * gain, 0.05));
  const norm = Math.max(0.0, Math.min(1.0, (db - 15.0) / 60.0));
  const idx = Math.floor(norm * 255);
  return COLOR_LUT_RGB_STR[idx];
}
