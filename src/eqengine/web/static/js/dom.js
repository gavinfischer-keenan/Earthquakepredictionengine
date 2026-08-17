/**
 * DOM Element Cache & UI Notification Helpers
 */

import { state } from './state.js';
import { playAlertSound } from './audio.js';

export const elements = {
  utcClock: document.getElementById('utcClock'),
  statusPulse: document.getElementById('statusPulse'),
  viewTabs: document.getElementById('viewTabs'),
  audioToggle: document.getElementById('audioToggle'),
  audioIcon: document.getElementById('audioIcon'),
  audioText: document.getElementById('audioText'),
  windowSelect: document.getElementById('windowSelect'),
  filterSelect: document.getElementById('filterSelect'),
  gainSelect: document.getElementById('gainSelect'),
  pauseBtn: document.getElementById('pauseBtn'),
  simTriggerBtn: document.getElementById('simTriggerBtn'),
  simUsgsBtn: document.getElementById('simUsgsBtn'),

  // Header badges & metrics
  values: {
    EHZ: document.getElementById('val-EHZ'),
    ENZ: document.getElementById('val-ENZ'),
    ENN: document.getElementById('val-ENN'),
    ENE: document.getElementById('val-ENE'),
  },
  staEHZ: document.getElementById('sta-EHZ'),
  pkEHZ: document.getElementById('pk-EHZ'),
  pgaENZ: document.getElementById('pga-ENZ'),
  pgaENN: document.getElementById('pga-ENN'),
  pgaENE: document.getElementById('pga-ENE'),

  // Canvases & Overlays
  canvases: {
    EHZ: document.getElementById('canvas-EHZ'),
    ENZ: document.getElementById('canvas-ENZ'),
    ENN: document.getElementById('canvas-ENN'),
    ENE: document.getElementById('canvas-ENE'),
    spectrogram: document.getElementById('spectrogramCanvas'),
    specWaveform: document.getElementById('specWaveformCanvas'),
    helicorder: document.getElementById('helicorderCanvas'),
    hodoH: document.getElementById('hodoHCanvas'),
    hodoV: document.getElementById('hodoVCanvas'),
  },
  overlays: {
    EHZ: document.getElementById('overlay-EHZ'),
    ENZ: document.getElementById('overlay-ENZ'),
    ENN: document.getElementById('overlay-ENN'),
    ENE: document.getElementById('overlay-ENE'),
  },

  // HUD Warning & Incoming Alerts
  warningHud: document.getElementById('warningHud'),
  alertSeverity: document.getElementById('alertSeverity'),
  alertTitle: document.getElementById('alertTitle'),
  alertPgaVal: document.getElementById('alertPgaVal'),
  alertPgvVal: document.getElementById('alertPgvVal'),
  alertMagVal: document.getElementById('alertMagVal'),
  alertDistVal: document.getElementById('alertDistVal'),
  sWaveCountdown: document.getElementById('sWaveCountdown'),
  dismissWarningBtn: document.getElementById('dismissWarningBtn'),

  incomingHud: document.getElementById('incomingHud'),
  incomingTitle: document.getElementById('incomingTitle'),
  incomingSub: document.getElementById('incomingSub'),
  incomingCountdown: document.getElementById('incomingCountdown'),
  dismissIncomingBtn: document.getElementById('dismissIncomingBtn'),

  // Tables & Footer
  eventsTableBody: document.getElementById('eventsTableBody'),
  footerConnection: document.getElementById('footerConnection'),
  footerBuffer: document.getElementById('footerBuffer'),
};

export function updateClock() {
  const now = new Date();
  if (elements.utcClock) {
    elements.utcClock.textContent = now.toISOString().replace('T', ' ').substring(11, 22) + ' UTC';
  }
}

export function showWarningHud(alert) {
  if (!elements.warningHud) return;

  state.activeAlert = alert;
  const pga = alert.pga_m_s2 ? alert.pga_m_s2.toFixed(4) : (alert.pga ? alert.pga.toFixed(4) : '--');
  const pgv = alert.pgv_m_s ? (alert.pgv_m_s * 100).toFixed(2) : '--';
  const mag = alert.estimated_magnitude ? alert.estimated_magnitude.toFixed(1) : (alert.magnitude ? alert.magnitude.toFixed(1) : '--');
  const dist = alert.estimated_distance_km ? `${Math.round(alert.estimated_distance_km)} km` : '--';

  elements.alertSeverity.textContent = (alert.severity || 'WARNING').toUpperCase();
  elements.alertTitle.textContent = `⚡ SEISMIC TRIGGER: ${alert.severity === 'critical' ? 'STRONG GROUND MOTION' : 'P-WAVE DETECTED'}`;
  elements.alertPgaVal.textContent = pga;
  elements.alertPgvVal.textContent = pgv;
  elements.alertMagVal.textContent = mag;
  elements.alertDistVal.textContent = dist;

  elements.warningHud.style.display = 'block';

  // S-Wave countdown calculation (assumes P-wave ~6 km/s, S-wave ~3.5 km/s)
  if (state.sWaveTimerInterval) clearInterval(state.sWaveTimerInterval);
  const distKm = alert.estimated_distance_km || 25;
  const sDelaySec = distKm / 3.5 - distKm / 6.0;
  const pTime = alert.p_wave_time || (Date.now() / 1000);
  const sTargetTime = pTime + Math.max(sDelaySec, 3.0);

  state.sWaveTimerInterval = setInterval(() => {
    const remaining = sTargetTime - (Date.now() / 1000);
    if (remaining <= 0) {
      if (elements.sWaveCountdown) elements.sWaveCountdown.textContent = 'ARRIVED';
      clearInterval(state.sWaveTimerInterval);
    } else {
      if (elements.sWaveCountdown) elements.sWaveCountdown.textContent = `${remaining.toFixed(1)}s`;
    }
  }, 100);
}

export function showIncomingHud(evt) {
  if (!elements.incomingHud) return;

  const mag = evt.magnitude ? `M ${evt.magnitude.toFixed(1)}` : 'Earthquake';
  const place = evt.place || 'Regional Seismic Event';
  const dist = evt.distance_miles ? `${evt.distance_miles} miles away` : (evt.distance_km ? `${evt.distance_km} km away` : 'Regional');

  elements.incomingTitle.textContent = `🌊 USGS: ${mag} — ${place}`;
  elements.incomingSub.textContent = `Distance: ${dist} — Origin: ${new Date((evt.time || Date.now() / 1000) * 1000).toISOString().substring(11, 19)} UTC — Theoretical wavefronts in transit`;
  elements.incomingHud.style.display = 'block';

  if (state.incomingTimerInterval) clearInterval(state.incomingTimerInterval);
  const pArrival = evt.p_arrival || (Date.now() / 1000 + 10);

  state.incomingTimerInterval = setInterval(() => {
    const remaining = pArrival - (Date.now() / 1000);
    if (remaining <= 0) {
      if (elements.incomingCountdown) elements.incomingCountdown.textContent = 'ARRIVED';
      clearInterval(state.incomingTimerInterval);
    } else {
      if (elements.incomingCountdown) elements.incomingCountdown.textContent = `${remaining.toFixed(1)}s`;
    }
  }, 100);
}

export function initDomListeners() {
  if (elements.dismissWarningBtn) {
    elements.dismissWarningBtn.addEventListener('click', () => {
      if (elements.warningHud) elements.warningHud.style.display = 'none';
      if (state.sWaveTimerInterval) clearInterval(state.sWaveTimerInterval);
    });
  }

  if (elements.dismissIncomingBtn) {
    elements.dismissIncomingBtn.addEventListener('click', () => {
      if (elements.incomingHud) elements.incomingHud.style.display = 'none';
      if (state.incomingTimerInterval) clearInterval(state.incomingTimerInterval);
    });
  }

  // Science Interpretation Guide Collapsible Listeners
  document.querySelectorAll('.guide-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const guide = toggle.closest('.science-guide');
      if (guide) guide.classList.toggle('collapsed');
    });
  });
}
