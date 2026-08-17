/**
 * WebSocket Live Waveform & Telemetry Ingestion Hub
 */

import { state, SAMPLING_RATE, MAX_SAMPLES } from './state.js';
import { elements, showWarningHud, showIncomingHud } from './dom.js';
import { playAlertSound } from './audio.js';
import { addEventToTable } from './views/tables.js';

let ws = null;
let reconnectTimer = null;
let connectTimeoutTimer = null;
let watchdogStarted = false;

export function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  if (ws) {
    try {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    } catch (e) {}
    ws = null;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/live`;

  if (elements.footerConnection && !state.connected) {
    elements.footerConnection.textContent = `Connecting to ${wsUrl}...`;
  }

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error('WebSocket connection error:', err);
    scheduleReconnect();
    return;
  }

  if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
  connectTimeoutTimer = setTimeout(() => {
    if (ws && ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket connection attempt timed out. Retrying...');
      try { ws.close(); } catch (e) {}
      scheduleReconnect();
    }
  }, 3000);

  ws.onopen = () => {
    if (connectTimeoutTimer) {
      clearTimeout(connectTimeoutTimer);
      connectTimeoutTimer = null;
    }
    state.connected = true;
    if (elements.statusPulse) elements.statusPulse.classList.add('online');
    if (elements.footerConnection) elements.footerConnection.textContent = `Connected to ${wsUrl}`;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (err) {
      console.error('Error parsing WebSocket message:', err);
    }
  };

  ws.onclose = () => {
    if (connectTimeoutTimer) {
      clearTimeout(connectTimeoutTimer);
      connectTimeoutTimer = null;
    }
    state.connected = false;
    if (elements.statusPulse) elements.statusPulse.classList.remove('online');
    if (elements.footerConnection) elements.footerConnection.textContent = 'Disconnected. Reconnecting...';
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.warn('WebSocket encountered error:', err);
  };

  // Start background watchdog once to continuously monitor connection health
  if (!watchdogStarted) {
    watchdogStarted = true;
    setInterval(() => {
      if (!state.connected || !ws || ws.readyState === WebSocket.CLOSED) {
        connectWebSocket();
      }
    }, 2000);
  }
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, 1500);
  }
}

export function handleMessage(msg) {
  if (msg.type === 'init') {
    if (msg.initial_waveforms) {
      for (const [ch, info] of Object.entries(msg.initial_waveforms)) {
        if (state.buffers[ch] && info.samples && info.samples.length > 0) {
          state.buffers[ch] = info.samples.slice();
          const dt = 1.0 / (info.sampling_rate || SAMPLING_RATE);
          const startT = info.start_time;
          state.timestamps[ch] = new Array(info.samples.length);
          for (let i = 0; i < info.samples.length; i++) {
            state.timestamps[ch][i] = startT + i * dt;
          }
          if (ch === 'EHZ' && info.samples.length > 0) {
            state.latestStreamTimestamp = startT + (info.samples.length - 1) * dt;
            state.lastPacketArrivalLocalMs = Date.now();
          }
        }
      }
    }
  } else if (msg.type === 'waveform') {
    if (!state.paused) {
      const ts = msg.timestamp || Date.now() / 1000;
      state.latestStreamTimestamp = ts;
      state.lastPacketArrivalLocalMs = Date.now();

      const channels = msg.channels || {};

      for (const [ch, samples] of Object.entries(channels)) {
        if (state.buffers[ch]) {
          const dt = 1.0 / SAMPLING_RATE;
          const startT = ts - (samples.length - 1) * dt;

          for (let i = 0; i < samples.length; i++) {
            const sTime = startT + i * dt;
            state.buffers[ch].push(samples[i]);
            state.timestamps[ch].push(sTime);

            // Maintain 24-hour minute envelopes for EHZ
            if (ch === 'EHZ') {
              const minKey = Math.floor(sTime / 60) * 60;
              const v = samples[i];
              if (!state.helicorderMinutePeaks[minKey]) {
                state.helicorderMinutePeaks[minKey] = { min: v, max: v, sum: v, count: 1 };
              } else {
                const entry = state.helicorderMinutePeaks[minKey];
                if (v < entry.min) entry.min = v;
                if (v > entry.max) entry.max = v;
                entry.sum += v;
                entry.count++;
              }
            }
          }

          // Fast amortized pruning (avoiding continuous array shifting)
          if (state.buffers[ch].length > MAX_SAMPLES + 500) {
            state.buffers[ch] = state.buffers[ch].slice(-MAX_SAMPLES);
            state.timestamps[ch] = state.timestamps[ch].slice(-MAX_SAMPLES);
          }
        }
      }

      if (msg.sta_lta) {
        state.staLtaRatios = { ...state.staLtaRatios, ...msg.sta_lta };
        state.staLtaHistory.push({
          time: ts,
          ratio: state.staLtaRatios.EHZ || 1.0,
        });
        if (state.staLtaHistory.length > 300) state.staLtaHistory.shift();
      }
    }
  } else if (msg.type === 'trigger') {
    handleTriggerEvent(msg.trigger);
  } else if (msg.type === 'alert') {
    handleAlertEvent(msg.alert);
  } else if (msg.type === 'usgs_event') {
    handleUsgsEvent(msg.event);
  } else if (msg.type === 'status') {
    handleStatusEvent(msg.status);
  } else if (msg.type === 'init') {
    if (msg.recent_events) msg.recent_events.forEach(handleTriggerEvent);
    if (msg.recent_alerts) msg.recent_alerts.forEach(handleAlertEvent);
    if (msg.recent_usgs) msg.recent_usgs.forEach(handleUsgsEvent);
  }
}

function handleTriggerEvent(trig) {
  state.triggers.push(trig);
  if (state.triggers.length > 100) state.triggers.shift();

  const ratio = trig.sta_lta_ratio || trig.peak_sta_lta || 0;
  const severity = ratio >= 12.0 ? 'warning' : ratio >= 6.0 ? 'advisory' : 'info';
  const typeLabel = ratio >= 12.0 ? 'Elevated Seismic Onset' : 'STA/LTA Transient Motion';

  addEventToTable({
    id: `trig-${trig.channel || 'EHZ'}-${Math.round((trig.start_time || 0) * 10)}`,
    timestamp: trig.start_time,
    severity: severity,
    mag: '--',
    distance: 'LOCAL (Hayward)',
    staLta: `${ratio.toFixed(1)}x`,
    channel: trig.channel || 'EHZ',
    type: typeLabel,
    status: 'Local Sensor Trigger',
  });
}

function handleAlertEvent(alert) {
  state.alerts.push(alert);
  if (state.alerts.length > 50) state.alerts.shift();

  showWarningHud(alert);
  playAlertSound(alert.severity || 'warning');

  addEventToTable({
    timestamp: alert.timestamp || (Date.now() / 1000),
    severity: alert.severity || 'warning',
    mag: alert.estimated_magnitude ? `M ${alert.estimated_magnitude.toFixed(1)}` : '--',
    distance: alert.estimated_distance_km ? `${Math.round(alert.estimated_distance_km)} km` : '--',
    staLta: 'TRIGGERED',
    channel: 'ALL',
    type: 'EARTHQUAKE EARLY WARNING',
    status: 'Active Alert',
  });
}

function handleUsgsEvent(evt) {
  state.usgsEvents.push(evt);
  if (state.usgsEvents.length > 100) state.usgsEvents.shift();

  const now = Date.now() / 1000;
  // Strictly filter: ONLY alert for observable quakes within 500 miles on sliding scale or M6.0+
  const isLocalObservable = evt.is_observable === true || (evt.magnitude && evt.magnitude >= 6.0);
  const isNearby = evt.distance_miles ? evt.distance_miles <= 500 : (evt.distance_km ? evt.distance_km <= 804.7 : false);

  if (isLocalObservable && isNearby && evt.p_arrival && evt.p_arrival > now - 30) {
    showIncomingHud(evt);
    playAlertSound('advisory');
  }

  addEventToTable({
    timestamp: evt.time || evt.p_arrival,
    severity: isLocalObservable ? 'warning' : 'info',
    mag: evt.magnitude ? `M ${evt.magnitude.toFixed(1)}` : '--',
    distance: evt.distance_miles ? `${evt.distance_miles} mi` : (evt.distance_km ? `${evt.distance_km} km` : 'REGIONAL'),
    staLta: `P+${Math.round(evt.p_travel_sec || 0)}s`,
    channel: 'USGS',
    type: evt.place || 'External Regional Quake',
    status: evt.is_observable ? 'Observable (<500mi)' : 'Distant Filtered',
  });
}

function handleStatusEvent(status) {
  if (status && status.buffer_fill !== undefined) {
    if (elements.footerBuffer) {
      elements.footerBuffer.textContent = `${Math.round(status.buffer_fill * 100)}%`;
    }
  }
}
