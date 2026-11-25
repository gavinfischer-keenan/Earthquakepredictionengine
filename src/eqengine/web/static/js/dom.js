/**
 * DOM Element Cache & UI Notification Helpers
 */

import { state } from './state.js';
import { playAlertSound } from './audio.js';
import { computeMMI } from './intensity.js';

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
    hodoH: document.getElementById('hodoHorizontal') || document.getElementById('hodoHCanvas'),
    hodoV: document.getElementById('hodoVertical') || document.getElementById('hodoVCanvas'),
  },
  overlays: {
    EHZ: document.getElementById('overlay-EHZ'),
    ENZ: document.getElementById('overlay-ENZ'),
    ENN: document.getElementById('overlay-ENN'),
    ENE: document.getElementById('overlay-ENE'),
  },

  // HUD Warning & Incoming Alerts
  warningHud: document.getElementById('warningHud'),
  warningSeverity: document.getElementById('warningSeverity'),
  warningTitle: document.getElementById('warningTitle'),
  warningSub: document.getElementById('warningSub'),
  alertPgaVal: document.getElementById('alertPgaVal'),
  alertPgvVal: document.getElementById('alertPgvVal'),
  alertMagVal: document.getElementById('alertMagVal'),
  alertDistVal: document.getElementById('alertDistVal'),
  alertMmiVal: document.getElementById('alertMmiVal'),
  sWaveCountdown: document.getElementById('sWaveCountdown'),
  dismissWarningBtn: document.getElementById('dismissWarningBtn'),

  incomingHud: document.getElementById('incomingHud'),
  incomingTitle: document.getElementById('incomingTitle'),
  incomingSub: document.getElementById('incomingSub'),
  incomingPCount: document.getElementById('incomingPCount'),
  incomingSCount: document.getElementById('incomingSCount'),
  dismissIncomingBtn: document.getElementById('dismissIncomingBtn'),

  // Floating Context Tooltip
  tooltip: document.getElementById('observatoryTooltip'),
  tooltipTitle: document.getElementById('tooltipTitle'),
  tooltipBody: document.getElementById('tooltipBody'),

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

function formatCountdownSec(remaining) {
  if (!Number.isFinite(remaining) || remaining <= 0) return 'ARRIVED';
  if (remaining >= 60) {
    const mins = Math.floor(remaining / 60);
    const secs = Math.floor(remaining % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}s`;
  }
  return `${remaining.toFixed(1)}s`;
}

export function showWarningHud(alert) {
  if (!elements.warningHud || !alert) return;

  state.activeAlert = alert;
  const pgaRaw = alert.peak_ground_acceleration ?? alert.pga_m_s2 ?? alert.pga;
  const pgvRaw = alert.peak_ground_velocity ?? alert.pgv_m_s;
  const magRaw = alert.estimated_magnitude ?? alert.magnitude;
  const distKmRaw = alert.estimated_distance_km ?? alert.distance_km ?? (alert.distance_miles != null ? alert.distance_miles * 1.60934 : null);

  const pga = Number.isFinite(Number(pgaRaw)) ? Number(pgaRaw).toFixed(4) : '--';
  const pgv = Number.isFinite(Number(pgvRaw)) ? (Number(pgvRaw) * 100).toFixed(2) : '--';
  const mag = Number.isFinite(Number(magRaw)) ? Number(magRaw).toFixed(1) : '--';
  const dist = Number.isFinite(Number(distKmRaw)) ? `${Math.round(Number(distKmRaw))} km` : '--';
  const sev = (alert.severity || 'WARNING').toString().toUpperCase();

  if (elements.warningSeverity) elements.warningSeverity.textContent = sev;
  if (elements.warningTitle) {
    elements.warningTitle.textContent = `⚡ SEISMIC TRIGGER: ${sev === 'CRITICAL' ? 'STRONG GROUND MOTION' : 'P-WAVE DETECTED'}`;
  }
  if (elements.warningSub) {
    const distClass = alert.distance_class ? alert.distance_class.toUpperCase() : 'SEISMIC TRIGGER';
    elements.warningSub.textContent = alert.tts_message || `Estimated M ${mag} — ${distClass} (${dist}) — P-wave triggered`;
  }
  if (elements.alertPgaVal) elements.alertPgaVal.textContent = pga;
  if (elements.alertPgvVal) elements.alertPgvVal.textContent = pgv;
  if (elements.alertMagVal) elements.alertMagVal.textContent = mag;
  if (elements.alertDistVal) elements.alertDistVal.textContent = dist;
  if (elements.alertMmiVal) {
    const computed = computeMMI(pgaRaw, pgvRaw);
    const roman = alert.mmi_roman || computed.roman;
    const label = alert.mmi_label || computed.label;
    const color = alert.mmi_color || computed.color;
    elements.alertMmiVal.textContent = `MMI ${roman} (${label})`;
    elements.alertMmiVal.style.color = color;
  }

  elements.warningHud.style.display = 'block';

  // S-Wave countdown calculation (assumes P-wave ~6 km/s, S-wave ~3.5 km/s)
  if (state.sWaveTimerInterval) clearInterval(state.sWaveTimerInterval);
  const nowSec = Date.now() / 1000;
  let sTargetTime;
  if (Number.isFinite(Number(alert.estimated_s_arrival))) {
    sTargetTime = Number(alert.estimated_s_arrival);
  } else if (Number.isFinite(Number(alert.seconds_until_s_wave))) {
    sTargetTime = nowSec + Math.max(Number(alert.seconds_until_s_wave), 0);
  } else {
    const distKm = Number.isFinite(Number(distKmRaw)) ? Number(distKmRaw) : 25;
    const sDelaySec = distKm * (1.0 / 3.5 - 1.0 / 6.0);
    const pTime = Number(alert.p_wave_time) || nowSec;
    sTargetTime = pTime + Math.max(sDelaySec, 3.0);
  }

  const updateSWave = () => {
    const remaining = sTargetTime - Date.now() / 1000;
    if (elements.sWaveCountdown) {
      elements.sWaveCountdown.textContent = formatCountdownSec(remaining);
    }
    if (remaining <= 0 && state.sWaveTimerInterval) {
      clearInterval(state.sWaveTimerInterval);
      state.sWaveTimerInterval = null;
    }
  };

  updateSWave();
  state.sWaveTimerInterval = setInterval(updateSWave, 100);
}

export function showIncomingHud(evt) {
  if (!elements.incomingHud || !evt) return;

  const mag = evt.magnitude != null ? `M ${Number(evt.magnitude).toFixed(1)}` : 'Earthquake';
  const place = evt.place || 'Regional Seismic Event';
  const distMi = evt.distance_miles != null
    ? `${Number(evt.distance_miles).toFixed(1)} miles`
    : (evt.distance_km != null ? `${(Number(evt.distance_km) * 0.621371).toFixed(1)} miles` : 'Regional');
  const originTime = evt.time ? new Date(evt.time * 1000).toISOString().substring(11, 19) : new Date().toISOString().substring(11, 19);

  if (elements.incomingTitle) elements.incomingTitle.textContent = `🌊 USGS: ${mag} — ${place}`;
  if (elements.incomingSub) elements.incomingSub.textContent = `Distance: ${distMi} — Origin: ${originTime} UTC — Theoretical wavefronts in transit`;
  elements.incomingHud.style.display = 'block';

  if (state.incomingTimerInterval) clearInterval(state.incomingTimerInterval);
  const nowSec = Date.now() / 1000;
  const distKm = Number(evt.distance_km) || (Number(evt.distance_miles) ? Number(evt.distance_miles) * 1.60934 : 50);
  const pArrivalRaw = evt.p_arrival ?? evt.theor_p_arrival;
  const sArrivalRaw = evt.s_arrival ?? evt.theor_s_arrival;
  const pArrival = Number.isFinite(Number(pArrivalRaw)) ? Number(pArrivalRaw) : (nowSec + 10);
  const sArrival = Number.isFinite(Number(sArrivalRaw))
    ? Number(sArrivalRaw)
    : (pArrival + Math.max(distKm * (1.0 / 3.5 - 1.0 / 6.0), 6.0));

  const updateIncoming = () => {
    const curSec = Date.now() / 1000;
    const remP = pArrival - curSec;
    const remS = sArrival - curSec;
    if (elements.incomingPCount) elements.incomingPCount.textContent = formatCountdownSec(remP);
    if (elements.incomingSCount) elements.incomingSCount.textContent = formatCountdownSec(remS);
    if (remP <= 0 && remS <= 0 && state.incomingTimerInterval) {
      clearInterval(state.incomingTimerInterval);
      state.incomingTimerInterval = null;
    }
  };

  updateIncoming();
  state.incomingTimerInterval = setInterval(updateIncoming, 100);
}

function initTooltips() {
  const tip = elements.tooltip;
  if (!tip) return;

  let activeAnchor = null;

  const positionTooltip = (clientX, clientY, anchorRect) => {
    const margin = 8;
    const tipRect = tip.getBoundingClientRect();
    const w = tipRect.width || 240;
    const h = tipRect.height || 80;

    let x = Number.isFinite(clientX) ? clientX + 14 : (anchorRect ? anchorRect.left + anchorRect.width / 2 - w / 2 : 16);
    let y = Number.isFinite(clientY) ? clientY + 16 : (anchorRect ? anchorRect.bottom + 8 : 16);

    if (x + w + margin > window.innerWidth) x = window.innerWidth - w - margin;
    if (x < margin) x = margin;

    if (y + h + margin > window.innerHeight) {
      y = Number.isFinite(clientY) ? clientY - h - 12 : (anchorRect ? anchorRect.top - h - 8 : window.innerHeight - h - margin);
    }
    if (y < margin) y = margin;

    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
  };

  const showForAnchor = (anchor, clientX, clientY) => {
    const text = anchor?.getAttribute('data-tooltip');
    if (!text) return;
    activeAnchor = anchor;
    const title = anchor.getAttribute('data-tooltip-title') || '';
    if (elements.tooltipTitle) {
      elements.tooltipTitle.textContent = title;
      elements.tooltipTitle.style.display = title ? 'block' : 'none';
    }
    if (elements.tooltipBody) elements.tooltipBody.textContent = text;
    tip.classList.add('visible');
    tip.setAttribute('aria-hidden', 'false');
    positionTooltip(clientX, clientY, anchor.getBoundingClientRect());
  };

  const hideTooltip = () => {
    if (!activeAnchor) return;
    activeAnchor = null;
    tip.classList.remove('visible');
    tip.setAttribute('aria-hidden', 'true');
  };

  document.addEventListener('mouseover', (e) => {
    const anchor = e.target.closest?.('[data-tooltip]');
    if (!anchor) return;
    if (anchor === activeAnchor) return;
    showForAnchor(anchor, e.clientX, e.clientY);
  });

  document.addEventListener('mousemove', (e) => {
    if (!activeAnchor) return;
    positionTooltip(e.clientX, e.clientY, null);
  });

  document.addEventListener('mouseout', (e) => {
    if (!activeAnchor) return;
    const nextTarget = e.relatedTarget;
    if (!nextTarget || !activeAnchor.contains(nextTarget)) {
      const nextAnchor = nextTarget?.closest?.('[data-tooltip]');
      if (nextAnchor && nextAnchor !== activeAnchor) {
        showForAnchor(nextAnchor, e.clientX, e.clientY);
      } else {
        hideTooltip();
      }
    }
  });

  document.addEventListener('focusin', (e) => {
    const anchor = e.target.closest?.('[data-tooltip]');
    if (anchor) showForAnchor(anchor, NaN, NaN);
  });

  document.addEventListener('focusout', () => hideTooltip());
  window.addEventListener('scroll', hideTooltip, { passive: true });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest?.('[data-tooltip]')) hideTooltip();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideTooltip();
  });
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

  // Science Interpretation Guide Collapsible Listeners (mouse + keyboard)
  const toggleGuide = (toggle) => {
    const guide = toggle.closest('.science-guide');
    if (!guide) return;
    const isCollapsed = guide.classList.toggle('collapsed');
    toggle.setAttribute('aria-expanded', String(!isCollapsed));
  };

  document.querySelectorAll('.guide-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => toggleGuide(toggle));
    toggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleGuide(toggle);
      }
    });
  });

  initTooltips();
}
