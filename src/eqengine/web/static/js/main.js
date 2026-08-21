/**
 * EarthquakePredictionEngine - Main Application Orchestrator
 */

import { state } from './state.js?v=1787296000';
import { elements, updateClock, initDomListeners } from './dom.js?v=1787296000';
import { initAudio, toggleSonification, renderSonificationVisualizer } from './audio.js?v=1787296000';
import { connectWebSocket } from './websocket.js?v=1787296000';
import { renderOscilloscope } from './views/oscilloscope.js?v=1787296000';
import { renderSpectrogram } from './views/spectrogram.js?v=1787296000';
import { renderHelicorder } from './views/helicorder.js?v=1787296000';
import { renderStaLta } from './views/stalta.js?v=1787296000';
import { renderHodogram } from './views/hodogram.js?v=1787296000';
import { renderUrbanProfiler } from './views/urban.js?v=1787296000';
import { renderPhaseNet } from './views/phasenet.js?v=1787296000';
import { renderPetersonCurve } from './views/peterson.js?v=1787296000';
import { initRadarMap, updateRadarMap, fetchRadarEvents } from './views/radar.js?v=1787296000';
import { loadHistoricalSeismograph, initReviewStudioListeners } from './views/review_studio.js?v=1787296000';
import { renderEventsTable, fetchMlDataset, initTableListeners } from './views/tables.js?v=1787296000';

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
  try {
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
  } catch (err) {
    console.error('Render error in mainLoop:', err);
  } finally {
    requestAnimationFrame(mainLoop);
  }
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
// Public Mode Initialization
// ---------------------------------------------------------------------------
function initPublicMode() {
  const host = window.location.hostname.toLowerCase();
  const search = new URLSearchParams(window.location.search);
  const isPublic =
    host === '11mosswood.us' ||
    (host.endsWith('11mosswood.us') && !host.startsWith('tto')) ||
    search.get('mode') === 'public' ||
    document.body.classList.contains('public-mode');

  if (isPublic) {
    document.body.classList.add('public-mode');

    // 1. Hide simulation buttons
    if (elements.simUsgsBtn) elements.simUsgsBtn.style.display = 'none';
    if (elements.simTriggerBtn) elements.simTriggerBtn.style.display = 'none';

    // 2. Hide audio and ML nav tabs
    const sonificationTab = document.querySelector('.tab-btn[data-tab="sonification"]');
    const mlTab = document.querySelector('.tab-btn[data-tab="ml"]');
    if (sonificationTab) sonificationTab.style.display = 'none';
    if (mlTab) mlTab.style.display = 'none';

    // 3. Hide audio header toggle button
    if (elements.audioToggle) elements.audioToggle.style.display = 'none';

    // 4. If current active tab is forbidden, fall back to oscilloscope
    if (state.activeTab === 'sonification' || state.activeTab === 'ml') {
      const oscTab = document.querySelector('.tab-btn[data-tab="oscilloscope"]');
      if (oscTab) oscTab.click();
    }
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initPublicMode();
  setInterval(updateClock, 50);
  initDomListeners();
  initTabNavigation();
  initToolbarControls();
  initTableListeners();
  initReviewStudioListeners();
  connectWebSocket();
  initRadarMap();
  fetchRadarEvents();
  requestAnimationFrame(mainLoop);
});
