/**
 * EarthquakePredictionEngine - Main Application Orchestrator
 */

import { state } from './state.js';
import { elements, updateClock, initDomListeners } from './dom.js';
import { initAudio, toggleSonification, renderSonificationVisualizer } from './audio.js';
import { connectWebSocket } from './websocket.js';
import { renderOscilloscope } from './views/oscilloscope.js';
import { renderSpectrogram } from './views/spectrogram.js';
import { renderHelicorder } from './views/helicorder.js';
import { renderStaLta } from './views/stalta.js';
import { renderHodogram } from './views/hodogram.js';
import { renderUrbanProfiler } from './views/urban.js';
import { renderPhaseNet } from './views/phasenet.js';
import { renderPetersonCurve } from './views/peterson.js';
import { initRadarMap, updateRadarMap, fetchRadarEvents } from './views/radar.js';
import { loadHistoricalSeismograph, initReviewStudioListeners } from './views/review_studio.js';
import { renderEventsTable, fetchMlDataset, initTableListeners } from './views/tables.js';

// ---------------------------------------------------------------------------
// Telemetry Header Counters
// ---------------------------------------------------------------------------
function renderTelemetry() {
  const ehz = state.buffers.EHZ;
  if (ehz && ehz.length > 0 && elements.pkEHZ) {
    const lastPk = state.fourMinStats.EHZ ? state.fourMinStats.EHZ.baselineAmp : 35;
    elements.pkEHZ.textContent = Math.round(lastPk).toLocaleString();
  }
}

// ---------------------------------------------------------------------------
// Main Animation Loop (Optimized: Only active tab renders per frame)
// ---------------------------------------------------------------------------
let lastHelicorderRender = 0;

function mainLoop() {
  renderTelemetry();

  const tab = state.activeTab || 'oscilloscope';

  if (tab === 'traces' || tab === 'oscilloscope') {
    renderOscilloscope();
  } else if (tab === 'spectrogram') {
    renderSpectrogram();
  } else if (tab === 'helicorder') {
    const now = Date.now();
    if (now - lastHelicorderRender > 1000) {
      renderHelicorder();
      lastHelicorderRender = now;
    }
  } else if (tab === 'stalta') {
    renderStaLta();
  } else if (tab === 'hodogram') {
    renderHodogram();
  } else if (tab === 'environment') {
    renderUrbanProfiler();
  } else if (tab === 'phasenet') {
    renderPhaseNet();
  } else if (tab === 'psd') {
    renderPetersonCurve();
  } else if (tab === 'sonification') {
    renderSonificationVisualizer();
  }

  requestAnimationFrame(mainLoop);
}

// ---------------------------------------------------------------------------
// Tab Switching Coordinator
// ---------------------------------------------------------------------------
function initTabNavigation() {
  if (!elements.viewTabs) return;

  elements.viewTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;

    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));

    btn.classList.add('active');
    const tabName = btn.getAttribute('data-tab');
    state.activeTab = tabName;
    const targetPanel = document.getElementById(`tab-${tabName}`);
    if (targetPanel) targetPanel.classList.add('active');

    // Reset sort states to default (newest first)
    state.sortColumn = 'timestamp';
    state.sortDirection = 'desc';
    state.mlSortColumn = 'timestamp';
    state.mlSortDirection = 'desc';

    if (tabName === 'events') {
      renderEventsTable();
    } else if (tabName === 'ml') {
      fetchMlDataset();
      loadHistoricalSeismograph();
    } else if (tabName === 'radar') {
      initRadarMap();
      fetchRadarEvents();
      setTimeout(updateRadarMap, 100);
    }
  });
}

// ---------------------------------------------------------------------------
// Global Toolbar Controls
// ---------------------------------------------------------------------------
function initToolbarControls() {
  if (elements.windowSelect) {
    elements.windowSelect.addEventListener('change', (e) => {
      state.windowSec = parseInt(e.target.value, 10);
    });
  }

  if (elements.filterSelect) {
    elements.filterSelect.addEventListener('change', (e) => {
      state.filterMode = e.target.value;
    });
  }

  if (elements.gainSelect) {
    elements.gainSelect.addEventListener('change', (e) => {
      state.gainMode = e.target.value;
    });
  }

  if (elements.pauseBtn) {
    elements.pauseBtn.addEventListener('click', () => {
      state.paused = !state.paused;
      if (state.paused) {
        state.lastPausedTimestamp = Date.now() / 1000;
      }
      elements.pauseBtn.textContent = state.paused ? '▶ Resume' : '⏸ Pause';
    });
  }

  if (elements.audioToggle) {
    elements.audioToggle.addEventListener('click', () => {
      state.audioEnabled = !state.audioEnabled;
      elements.audioIcon.textContent = state.audioEnabled ? '🔊' : '🔇';
      elements.audioText.textContent = state.audioEnabled ? 'Audio On' : 'Audio Muted';
      initAudio();
    });
  }

  // Channel visibility toggles
  ['EHZ', 'ENZ', 'ENN', 'ENE'].forEach((ch) => {
    const cb = document.getElementById(`toggle${ch}`);
    const card = document.getElementById(`card-${ch}`);
    if (cb && card) {
      cb.addEventListener('change', () => {
        state.visibleChannels[ch] = cb.checked;
        card.style.display = cb.checked ? 'flex' : 'none';
      });
    }
  });

  // Simulation buttons
  if (elements.simTriggerBtn) {
    elements.simTriggerBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/simulate-trigger', { method: 'POST' });
      } catch (err) {
        console.error('Failed to trigger simulation:', err);
      }
    });
  }

  if (elements.simUsgsBtn) {
    elements.simUsgsBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/simulate-usgs', { method: 'POST' });
      } catch (err) {
        console.error('Failed to simulate USGS quake:', err);
      }
    });
  }

  const sonBtn = document.getElementById('sonPlayBtn');
  if (sonBtn) {
    sonBtn.addEventListener('click', toggleSonification);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  setInterval(updateClock, 50);
  initDomListeners();
  initTabNavigation();
  initToolbarControls();
  initTableListeners();
  initReviewStudioListeners();
  connectWebSocket();
  fetchRadarEvents();
  requestAnimationFrame(mainLoop);
});
