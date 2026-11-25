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
import { initRadarMap, updateRadarMap, fetchRadarEvents, syncRadarStationCenter } from './views/radar.js';
import { loadHistoricalSeismograph, initReviewStudioListeners } from './views/review_studio.js';
import { renderEventsTable, fetchMlDataset, initTableListeners } from './views/tables.js';
import { loadStationIdentity } from './station.js';
import { initTrendsView, renderTrendsView, prefetchBandThresholds } from './views/trends.js';
import { initHighlightsStrip } from './views/highlights.js';

// ---------------------------------------------------------------------------
// Main Animation Loop (Optimized: Only active tab renders per frame)
// ---------------------------------------------------------------------------
let lastHelicorderRender = 0;

function mainLoop() {
  try {
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

    // Keep mobile horizontal tab bar centered on selection and prevent horizontal page drift
    btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    if (window.scrollX !== 0) {
      window.scrollTo({ top: window.scrollY, left: 0, behavior: 'auto' });
    }

    // Reset sort states to default (newest first)
    state.sortColumn = 'timestamp';
    state.sortDirection = 'desc';
    state.mlSortColumn = 'timestamp';
    state.mlSortDirection = 'desc';

    if (tabName === 'events') {
      renderEventsTable();
    } else if (tabName === 'trends') {
      renderTrendsView();
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

  // 'Tell Me What This Shows' Quick Explainer Button
  const explainBtn = document.getElementById('explainViewBtn');
  if (explainBtn) {
    explainBtn.addEventListener('click', () => {
      const sourceTab = state.activeTab || 'oscilloscope';
      const chapterAnchorMap = {
        oscilloscope: 'ch-oscilloscope',
        traces: 'ch-oscilloscope',
        spectrogram: 'ch-spectrogram',
        helicorder: 'ch-helicorder',
        stalta: 'ch-stalta',
        hodogram: 'ch-hodogram',
        radar: 'ch-radar',
        environment: 'ch-environment',
        trends: 'ch-environment',
        sonification: 'ch-sonification',
        events: 'ch-events',
        ml: 'ch-ml',
        psd: 'ch-psd',
        phasenet: 'ch-phasenet',
        manual: 'ch-oscilloscope',
      };
      const anchor = chapterAnchorMap[sourceTab] || 'ch-oscilloscope';

      const tabManualBtn = document.querySelector('.tab-btn[data-tab="manual"]');
      if (tabManualBtn) tabManualBtn.click();

      const iframe = document.getElementById('manualIframe');
      if (iframe && iframe.contentWindow) {
        setTimeout(() => {
          try {
            const doc = iframe.contentDocument || iframe.contentWindow.document;
            const targetEl = doc ? doc.getElementById(anchor) : null;
            if (targetEl) {
              targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else {
              iframe.contentWindow.location.hash = anchor;
            }
          } catch (e) {}
        }, 150);
      }
    });
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
  loadStationIdentity().then((status) => {
    if (status?.public_mode) initPublicMode();
    syncRadarStationCenter();
  });
  setInterval(updateClock, 50);
  initDomListeners();
  initTabNavigation();
  initToolbarControls();
  initTableListeners();
  initReviewStudioListeners();
  initTrendsView();
  initHighlightsStrip();
  prefetchBandThresholds();
  connectWebSocket();
  initRadarMap();
  fetchRadarEvents();
  requestAnimationFrame(mainLoop);
});
