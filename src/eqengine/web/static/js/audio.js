/**
 * Web Audio Engine: Seismic Sonification & Warning Sounds
 */

import { state } from './state.js';

let audioCtx = null;
let sonificationGain = null;
let sonificationSource = null;
let sonificationScriptNode = null;
let isSonPlaying = false;

export function initAudio() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

export function playAlertSound(type = 'warning') {
  if (!state.audioEnabled) return;
  initAudio();
  if (!audioCtx) return;

  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  if (type === 'critical') {
    // High-low emergency siren
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.2);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.4);
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.6);
    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.8);
    osc.start(now);
    osc.stop(now + 0.8);
  } else if (type === 'warning') {
    // Alert chime
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.setValueAtTime(880, now + 0.1); // A5
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
    osc.start(now);
    osc.stop(now + 0.5);
  } else {
    // Subtle info chime
    osc.type = 'sine';
    osc.frequency.setValueAtTime(523.25, now); // C5
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    osc.start(now);
    osc.stop(now + 0.3);
  }
}

export function toggleSonification() {
  initAudio();
  if (!audioCtx) return;

  const btn = document.getElementById('sonPlayBtn');
  if (isSonPlaying) {
    if (sonificationScriptNode) sonificationScriptNode.disconnect();
    if (sonificationGain) sonificationGain.disconnect();
    isSonPlaying = false;
    if (btn) {
      btn.textContent = '▶ Listen to Live Earth Audio';
      btn.className = 'btn btn-primary';
    }
  } else {
    const bufferSize = 2048;
    sonificationScriptNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    sonificationGain = audioCtx.createGain();

    const speedSelect = document.getElementById('sonSpeedSelect');
    const volSlider = document.getElementById('sonVolSlider');

    let readIndex = 0;

    sonificationScriptNode.onaudioprocess = (e) => {
      const output = e.outputBuffer.getChannelData(0);
      const speed = speedSelect ? parseFloat(speedSelect.value) : 25;
      const vol = volSlider ? parseFloat(volSlider.value) / 100 : 0.7;

      if (sonificationGain) sonificationGain.gain.value = vol * 0.4;

      const rawBuf = state.buffers.EHZ;
      if (!rawBuf || rawBuf.length < 50) {
        output.fill(0);
        return;
      }

      for (let i = 0; i < output.length; i++) {
        readIndex += (speed * 100.0) / audioCtx.sampleRate;
        const idx = Math.floor(readIndex) % rawBuf.length;
        const val = rawBuf[idx] || 0;
        output[i] = Math.max(-1.0, Math.min(1.0, val / 800.0));
      }
    };

    sonificationScriptNode.connect(sonificationGain);
    sonificationGain.connect(audioCtx.destination);
    isSonPlaying = true;
    if (btn) {
      btn.textContent = '⏹ Stop Earth Audio';
      btn.className = 'btn btn-danger';
    }
  }
}

export function renderSonificationVisualizer() {
  const canvas = document.getElementById('sonVisualizer');
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (w <= 0 || h <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  const ctx = canvas.getContext('2d');
  ctx.resetTransform();
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#050814';
  ctx.fillRect(0, 0, w, h);

  const ehzBuf = state.buffers.EHZ;
  if (ehzBuf && ehzBuf.length > 10) {
    const slice = ehzBuf.slice(-200);
    let mean = 0;
    slice.forEach((v) => (mean += v));
    mean /= slice.length;

    ctx.strokeStyle = isSonPlaying ? '#00ff88' : '#334155';
    ctx.lineWidth = isSonPlaying ? 2.5 : 1.5;
    ctx.shadowColor = isSonPlaying ? '#00ff88' : 'transparent';
    ctx.shadowBlur = isSonPlaying ? 10 : 0;

    ctx.beginPath();
    const step = w / slice.length;
    slice.forEach((val, idx) => {
      const x = idx * step;
      const y = h / 2 - ((val - mean) / 600.0) * (h / 2 - 10);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}
