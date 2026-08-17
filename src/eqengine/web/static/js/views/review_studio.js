/**
 * Historical Seismograph Review Studio & Precision Event Crop Labeller
 */

import { CH_COLORS } from '../state.js';
import { playAlertSound } from '../audio.js';
import { fetchMlDataset } from './tables.js';

export const reviewState = {
  offsetSec: 0,
  spanSec: 30,
  cachedData: null,
  isDragging: false,
  cropStartX: 0,
  cropStartRatio: 0,
  cropEndRatio: 0,
  activeSnippetData: null,
};

export async function loadHistoricalSeismograph() {
  try {
    const now = Date.now() / 1000;
    const reqStart = now - reviewState.offsetSec - reviewState.spanSec;
    const resp = await fetch(`/api/seismograph/historical?start_time=${reqStart}&duration_sec=${reviewState.spanSec}`);
    if (!resp.ok) return;

    const data = await resp.json();
    reviewState.cachedData = data;

    const startIso = new Date(data.requested_start * 1000).toISOString().substring(11, 19);
    const endIso = new Date(data.requested_end * 1000).toISOString().substring(11, 19);
    const labelEl = document.getElementById('reviewTimeWindowLabel');
    if (labelEl) {
      if (reviewState.offsetSec === 0) {
        labelEl.innerHTML = `Viewing Window: <b>Live Current Buffer (${data.duration_sec}s)</b> [${startIso} - ${endIso} UTC]`;
      } else {
        labelEl.innerHTML = `Viewing Window: <b>T - ${(reviewState.offsetSec / 60).toFixed(1)} min ago</b> [${startIso} - ${endIso} UTC]`;
      }
    }

    renderReviewCanvas(data);
  } catch (err) {
    console.error('Failed to load historical seismograph:', err);
  }
}

export function renderReviewCanvas(data) {
  const canvas = document.getElementById('reviewCanvas');
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

  ctx.fillStyle = '#030712';
  ctx.fillRect(0, 0, w, h);

  const channels = ['EHZ', 'ENZ', 'ENN', 'ENE'];
  const trackH = h / channels.length;

  channels.forEach((ch, idx) => {
    const topY = idx * trackH;
    const centerY = topY + trackH / 2;
    const samples = data.channels[ch] || [];

    // Baseline & Divider
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, topY); ctx.lineTo(w, topY);
    ctx.moveTo(0, centerY); ctx.lineTo(w, centerY);
    ctx.stroke();

    // Channel label
    ctx.font = '10px JetBrains Mono';
    ctx.fillStyle = CH_COLORS[ch] || '#00ff88';
    ctx.fillText(ch, 8, topY + 14);

    if (samples.length < 2) return;

    // Demean
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i];
    const mean = sum / samples.length;

    let pk = 1.0;
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i] - mean);
      if (abs > pk) pk = abs;
    }
    const maxVal = Math.max(pk * 1.2, 5.0);

    // Draw Trace
    ctx.strokeStyle = CH_COLORS[ch] || '#00ff88';
    ctx.lineWidth = 1.2;
    ctx.beginPath();

    for (let i = 0; i < samples.length; i++) {
      const x = (i / (samples.length - 1)) * w;
      const val = samples[i] - mean;
      const normalizedY = val / maxVal;
      const clampedY = Math.max(-0.95, Math.min(0.95, normalizedY));
      const y = centerY - clampedY * (trackH / 2) * 0.85;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
}

export async function saveCropSnippet(label, category, notes) {
  if (!reviewState.cachedData) {
    alert('Please load the seismograph first.');
    return;
  }

  let startT = reviewState.cachedData.requested_start;
  let endT = reviewState.cachedData.requested_end;

  if (reviewState.cropEndRatio > reviewState.cropStartRatio + 0.01) {
    const dur = reviewState.cachedData.requested_end - reviewState.cachedData.requested_start;
    startT = reviewState.cachedData.requested_start + reviewState.cropStartRatio * dur;
    endT = reviewState.cachedData.requested_start + reviewState.cropEndRatio * dur;
  }

  try {
    const resp = await fetch('/api/ml/annotate_range', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start_time: startT,
        end_time: endT,
        label: label,
        category: category,
        notes: notes,
        confidence: 1.0,
      }),
    });

    const res = await resp.json();
    if (res.status === 'ok') {
      playAlertSound('advisory');
      fetchMlDataset();
      alert(`✅ Successfully saved '${label}' (${(endT - startT).toFixed(1)}s) to ML Dataset!`);
    } else {
      alert(`Error: ${res.detail || 'Could not save crop'}`);
    }
  } catch (err) {
    console.error('Failed to save crop:', err);
  }
}

export async function inspectEventSnippet(eventId) {
  try {
    const resp = await fetch(`/api/ml/snippet/${eventId}`);
    if (!resp.ok) {
      alert(`Snippet file for '${eventId}' not found on disk.`);
      return;
    }
    const data = await resp.json();
    reviewState.activeSnippetData = data;

    const titleEl = document.getElementById('modalEventTitle');
    const subEl = document.getElementById('modalEventSub');
    if (titleEl) titleEl.textContent = `🔬 Event: ${data.label} (${data.category})`;
    if (subEl) subEl.textContent = `ID: ${data.event_id} | UTC: ${data.timestamp_utc} | Duration: ${data.duration_sec}s | Notes: ${data.notes || 'None'}`;

    const feats = data.features || {};
    const setVal = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    setVal('featPGA', feats.pga_resultant_m_s2 !== undefined ? `${feats.pga_resultant_m_s2.toFixed(6)} m/s²` : '--');
    setVal('featDomFreq', feats.dominant_freq_hz !== undefined ? `${feats.dominant_freq_hz} Hz` : '--');
    setVal('featCentroid', feats.spectral_centroid_hz !== undefined ? `${feats.spectral_centroid_hz} Hz` : '--');
    setVal('featRSAM', feats.rsam !== undefined ? `${feats.rsam.toFixed(1)} counts` : '--');
    setVal('featAzimuth', feats.apparent_azimuth_deg !== undefined ? `${feats.apparent_azimuth_deg}°` : '--');
    setVal('featRect', feats.rectilinearity !== undefined ? `${(feats.rectilinearity * 100).toFixed(1)}%` : '--');
    setVal('featDuration', `${data.duration_sec}s`);
    setVal('featSamples', `${data.channels.EHZ ? data.channels.EHZ.length : 0} pts`);

    ['EHZ', 'ENZ', 'ENN', 'ENE'].forEach((ch) => {
      const c = document.getElementById(`modalCanvas${ch}`);
      if (!c) return;
      const arr = data.channels[ch] || [];
      renderModalCanvas(c, arr, ch);

      if (ch === 'EHZ') {
        const pk = arr.length > 0 ? Math.max(...arr.map(Math.abs)) : 0;
        setVal('modalPkEHZ', Math.round(pk).toLocaleString());
      } else {
        const pk = arr.length > 0 ? Math.max(...arr.map(Math.abs)) * 1.9e-6 : 0;
        setVal(`modalPga${ch}`, pk.toFixed(6));
      }
    });

    const modal = document.getElementById('snippetModalBackdrop');
    if (modal) modal.style.display = 'flex';
  } catch (err) {
    console.error('Failed to load snippet:', err);
  }
}

function renderModalCanvas(canvas, samples, ch) {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 800, h = rect.height || 90;
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);

  const ctx = canvas.getContext('2d');
  ctx.resetTransform();
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#030712';
  ctx.fillRect(0, 0, w, h);

  if (!samples || samples.length < 2) return;

  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i];
  const mean = sum / samples.length;

  let pk = 1.0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i] - mean);
    if (abs > pk) pk = abs;
  }
  const maxVal = Math.max(pk * 1.15, 5.0);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
  ctx.stroke();

  ctx.strokeStyle = CH_COLORS[ch] || '#00ff88';
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  for (let i = 0; i < samples.length; i++) {
    const x = (i / (samples.length - 1)) * w;
    const val = samples[i] - mean;
    const normalizedY = val / maxVal;
    const clampedY = Math.max(-0.95, Math.min(0.95, normalizedY));
    const y = h / 2 - clampedY * (h / 2) * 0.85;

    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

export function initReviewStudioListeners() {
  const reviewContainer = document.getElementById('reviewCanvasContainer');
  const cropOverlay = document.getElementById('reviewCropOverlay');
  const selectionBox = document.getElementById('selectionBox');
  const cropBadge = document.getElementById('reviewCropBadge');
  const cropText = document.getElementById('reviewCropText');

  if (reviewContainer) {
    reviewContainer.addEventListener('mousedown', (e) => {
      const rect = reviewContainer.getBoundingClientRect();
      const x = e.clientX - rect.left;
      reviewState.isDragging = true;
      reviewState.cropStartX = x;
      reviewState.cropStartRatio = Math.max(0, Math.min(1, x / rect.width));
      reviewState.cropEndRatio = reviewState.cropStartRatio;

      if (cropOverlay) cropOverlay.style.display = 'block';
      if (selectionBox) {
        selectionBox.style.left = `${x}px`;
        selectionBox.style.width = '0px';
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!reviewState.isDragging || !reviewContainer) return;
      const rect = reviewContainer.getBoundingClientRect();
      const curX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const startX = reviewState.cropStartX;

      const leftX = Math.min(startX, curX);
      const widthX = Math.abs(curX - startX);

      reviewState.cropStartRatio = Math.max(0, Math.min(1, leftX / rect.width));
      reviewState.cropEndRatio = Math.max(0, Math.min(1, (leftX + widthX) / rect.width));

      if (selectionBox) {
        selectionBox.style.left = `${leftX}px`;
        selectionBox.style.width = `${widthX}px`;
      }

      if (cropBadge && cropText && reviewState.cachedData) {
        const cropDur = (reviewState.cropEndRatio - reviewState.cropStartRatio) * reviewState.spanSec;
        cropBadge.style.display = 'inline';
        cropText.textContent = `${cropDur.toFixed(2)}s window (${Math.round(cropDur * 100)} samples)`;
      }
    });

    window.addEventListener('mouseup', () => {
      if (reviewState.isDragging) reviewState.isDragging = false;
    });
  }

  // Scrubber jump buttons
  const setupScrubBtn = (id, offsetSec) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener('click', () => {
        reviewState.offsetSec = offsetSec;
        loadHistoricalSeismograph();
      });
    }
  };
  setupScrubBtn('scrubBack60m', 3600);
  setupScrubBtn('scrubBack30m', 1800);
  setupScrubBtn('scrubBack15m', 900);
  setupScrubBtn('scrubBack5m', 300);
  setupScrubBtn('scrubBack1m', 60);
  setupScrubBtn('scrubLiveHead', 0);

  const spanSelect = document.getElementById('reviewSpanSelect');
  if (spanSelect) {
    spanSelect.addEventListener('change', (e) => {
      reviewState.spanSec = parseFloat(e.target.value);
      loadHistoricalSeismograph();
    });
  }

  const reviewRefreshBtn = document.getElementById('reviewRefreshBtn');
  if (reviewRefreshBtn) {
    reviewRefreshBtn.addEventListener('click', loadHistoricalSeismograph);
  }

  document.querySelectorAll('.btn-tag-mini').forEach((btn) => {
    btn.addEventListener('click', () => {
      const label = btn.getAttribute('data-crop-label');
      const cat = btn.getAttribute('data-crop-cat') || 'human_indoor';
      const notes = btn.getAttribute('data-crop-notes') || '';
      saveCropSnippet(label, cat, notes);
    });
  });

  const saveCropBtn = document.getElementById('saveCropBtn');
  if (saveCropBtn) {
    saveCropBtn.addEventListener('click', () => {
      const labelInput = document.getElementById('cropCustomLabel');
      const catSelect = document.getElementById('cropCustomCategory');
      const notesInput = document.getElementById('cropCustomNotes');

      const label = labelInput ? labelInput.value.trim() : '';
      if (!label) {
        alert('Please enter a custom label for the selected crop.');
        return;
      }
      const category = catSelect ? catSelect.value : 'custom';
      const notes = notesInput ? notesInput.value.trim() : '';

      saveCropSnippet(label, category, notes);
      if (labelInput) labelInput.value = '';
      if (notesInput) notesInput.value = '';
    });
  }

  // Modal Close & Audio
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  const modalBackdrop = document.getElementById('snippetModalBackdrop');
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', () => {
      if (modalBackdrop) modalBackdrop.style.display = 'none';
    });
  }
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) modalBackdrop.style.display = 'none';
    });
  }

  const modalPlayAudioBtn = document.getElementById('modalPlayAudioBtn');
  if (modalPlayAudioBtn) {
    modalPlayAudioBtn.addEventListener('click', () => {
      if (!reviewState.activeSnippetData || !reviewState.activeSnippetData.channels.EHZ) return;
      playSnippetAudioBuffer(reviewState.activeSnippetData.channels.EHZ);
    });
  }
}

function playSnippetAudioBuffer(samples, sr = 100.0) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !samples || samples.length === 0) return;
  const ctx = new AudioContextClass();

  const speed = 25.0;
  const playSr = sr * speed;
  const buf = ctx.createBuffer(1, samples.length, playSr);
  const chanData = buf.getChannelData(0);

  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i];
  const mean = sum / samples.length;

  let pk = 1.0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i] - mean);
    if (abs > pk) pk = abs;
  }

  for (let i = 0; i < samples.length; i++) {
    chanData[i] = (samples[i] - mean) / pk;
  }

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}
