/**
 * Earthquake Prediction Engine — Observatory Frontend
 * Real-time 4-channel oscilloscope, warning symbology drop engine,
 * spectrogram, helicorder, STA/LTA monitor, and 3D hodogram.
 */

(() => {
  'use strict';

  // -------------------------------------------------------------------------
  // State & Configuration
  // -------------------------------------------------------------------------
  const SAMPLING_RATE = 100; // Hz
  const MAX_BUFFER_SEC = 300; // 5 minutes max memory buffer
  const MAX_SAMPLES = SAMPLING_RATE * MAX_BUFFER_SEC;

  const state = {
    connected: false,
    paused: false,
    audioEnabled: true,
    activeTab: 'oscilloscope',
    windowSec: 30,
    filterMode: 'bandpass',
    gainMode: 'auto',
    visibleChannels: {
      EHZ: true,
      ENZ: true,
      ENN: true,
      ENE: true,
    },
    buffers: {
      EHZ: [],
      ENZ: [],
      ENN: [],
      ENE: [],
    },
    timestamps: {
      EHZ: [],
      ENZ: [],
      ENN: [],
      ENE: [],
    },
    staLtaRatios: {
      EHZ: 1.0,
      ENZ: 1.0,
      ENN: 1.0,
      ENE: 1.0,
    },
    staLtaHistory: [],
    rsamHistory: [],
    triggers: [],
    alerts: [],
    usgsEvents: [],
    allEvents: [],
    mlEvents: [],
    sortColumn: 'timestamp',
    sortDirection: 'desc',
    mlSortColumn: 'timestamp',
    mlSortDirection: 'desc',
    sessionStartTime: (Date.now() / 1000),
    helicorderMinutePeaks: {},
    activeAlert: null,
    sWaveTimerInterval: null,
    incomingTimerInterval: null,
  };

  const CH_COLORS = {
    EHZ: '#00ff88',
    ENZ: '#00d2ff',
    ENN: '#ffaa00',
    ENE: '#d080ff',
  };

  // -------------------------------------------------------------------------
  // DOM Elements
  // -------------------------------------------------------------------------
  const elements = {
    statusPulse: document.getElementById('statusPulse'),
    stationCode: document.getElementById('stationCode'),
    ingestMeta: document.getElementById('ingestMeta'),
    mqttStatus: document.getElementById('mqttStatus'),
    utcClock: document.getElementById('utcClock'),
    audioToggle: document.getElementById('audioToggle'),
    audioIcon: document.getElementById('audioIcon'),
    audioText: document.getElementById('audioText'),
    simTriggerBtn: document.getElementById('simTriggerBtn'),
    simUsgsBtn: document.getElementById('simUsgsBtn'),
    warningHud: document.getElementById('warningHud'),
    warningSeverity: document.getElementById('warningSeverity'),
    warningTitle: document.getElementById('warningTitle'),
    warningSub: document.getElementById('warningSub'),
    sWaveCountdown: document.getElementById('sWaveCountdown'),
    dismissWarningBtn: document.getElementById('dismissWarningBtn'),
    incomingHud: document.getElementById('incomingHud'),
    incomingTitle: document.getElementById('incomingTitle'),
    incomingSub: document.getElementById('incomingSub'),
    incomingPCount: document.getElementById('incomingPCount'),
    incomingSCount: document.getElementById('incomingSCount'),
    dismissIncomingBtn: document.getElementById('dismissIncomingBtn'),
    viewTabs: document.getElementById('viewTabs'),
    windowSelect: document.getElementById('windowSelect'),
    filterSelect: document.getElementById('filterSelect'),
    gainSelect: document.getElementById('gainSelect'),
    pauseBtn: document.getElementById('pauseBtn'),
    footerConnection: document.getElementById('footerConnection'),
    footerBuffer: document.getElementById('footerBuffer'),
    eventsTableBody: document.getElementById('eventsTableBody'),
    rsamValue: document.getElementById('rsamValue'),
    canvases: {
      EHZ: document.getElementById('canvas-EHZ'),
      ENZ: document.getElementById('canvas-ENZ'),
      ENN: document.getElementById('canvas-ENN'),
      ENE: document.getElementById('canvas-ENE'),
      spectrogram: document.getElementById('spectrogramCanvas'),
      helicorder: document.getElementById('helicorderCanvas'),
      stalta: document.getElementById('staltaCanvas'),
      rsam: document.getElementById('rsamCanvas'),
      hodoH: document.getElementById('hodoHorizontal'),
      hodoV: document.getElementById('hodoVertical'),
    },
    overlays: {
      EHZ: document.getElementById('overlay-EHZ'),
      ENZ: document.getElementById('overlay-ENZ'),
      ENN: document.getElementById('overlay-ENN'),
      ENE: document.getElementById('overlay-ENE'),
    },
    values: {
      EHZ: document.getElementById('val-EHZ'),
      ENZ: document.getElementById('val-ENZ'),
      ENN: document.getElementById('val-ENN'),
      ENE: document.getElementById('val-ENE'),
    },
    pkEHZ: document.getElementById('pk-EHZ'),
    staEHZ: document.getElementById('sta-EHZ'),
    pgaENZ: document.getElementById('pga-ENZ'),
    pgaENN: document.getElementById('pga-ENN'),
    pgaENE: document.getElementById('pga-ENE'),
  };

  // -------------------------------------------------------------------------
  // Web Audio Alarm Synthesizer
  // -------------------------------------------------------------------------
  let audioCtx = null;

  function initAudio() {
    if (!audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        audioCtx = new AudioContext();
      }
    }
  }

  function playAlertSound(severity = 'warning') {
    if (!state.audioEnabled) return;
    initAudio();
    if (!audioCtx) return;

    try {
      const now = audioCtx.currentTime;
      const osc1 = audioCtx.createOscillator();
      const osc2 = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      const freq1 = severity === 'critical' ? 880 : 660;
      const freq2 = severity === 'critical' ? 440 : 550;

      osc1.type = 'sawtooth';
      osc2.type = 'sine';
      osc1.frequency.setValueAtTime(freq1, now);
      osc2.frequency.setValueAtTime(freq2, now);

      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.6);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(audioCtx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.6);
      osc2.stop(now + 0.6);
    } catch (e) {
      console.warn('Audio playback error', e);
    }
  }

  // -------------------------------------------------------------------------
  // UTC Clock
  // -------------------------------------------------------------------------
  function updateClock() {
    const now = new Date();
    const iso = now.toISOString().replace('T', ' ').substring(11, 22);
    elements.utcClock.textContent = iso + ' UTC';
  }
  setInterval(updateClock, 50);

  // -------------------------------------------------------------------------
  // WebSocket Connection
  // -------------------------------------------------------------------------
  let ws = null;
  let reconnectTimer = null;

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/live`;

    elements.footerConnection.textContent = `Connecting to ${wsUrl}...`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      state.connected = true;
      elements.statusPulse.classList.add('online');
      elements.footerConnection.textContent = `Connected to ${wsUrl}`;
      if (reconnectTimer) clearTimeout(reconnectTimer);
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
      state.connected = false;
      elements.statusPulse.classList.remove('online');
      elements.footerConnection.textContent = 'Disconnected. Reconnecting...';
      reconnectTimer = setTimeout(connectWebSocket, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  function handleMessage(msg) {
    if (msg.type === 'waveform') {
      if (!state.paused) {
        const ts = msg.timestamp || (Date.now() / 1000);
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

            // Prune buffer to max length
            if (state.buffers[ch].length > MAX_SAMPLES) {
              const overflow = state.buffers[ch].length - MAX_SAMPLES;
              state.buffers[ch].splice(0, overflow);
              state.timestamps[ch].splice(0, overflow);
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
      if (msg.recent_events) {
        msg.recent_events.forEach(handleTriggerEvent);
      }
      if (msg.recent_alerts) {
        msg.recent_alerts.forEach(handleAlertEvent);
      }
      if (msg.recent_usgs) {
        msg.recent_usgs.forEach(handleUsgsEvent);
      }
    }
  }

  // -------------------------------------------------------------------------
  // USGS External Earthquake Handler
  // -------------------------------------------------------------------------
  function handleUsgsEvent(evt) {
    state.usgsEvents.push(evt);
    if (state.usgsEvents.length > 100) state.usgsEvents.shift();

    const now = Date.now() / 1000;
    if (evt.p_arrival && evt.p_arrival > now - 30) {
      showIncomingHud(evt);
      playAlertSound('advisory');
    }

    addEventToTable({
      timestamp: evt.time || evt.p_arrival,
      severity: 'info',
      mag: evt.magnitude ? `M ${evt.magnitude.toFixed(1)}` : '--',
      distance: evt.distance_miles ? `${evt.distance_miles} mi` : (evt.distance_km ? `${evt.distance_km} km` : 'REGIONAL'),
      staLta: `P+${Math.round(evt.p_travel_sec || 0)}s`,
      channel: 'USGS',
      type: evt.place || 'External Regional Quake',
      status: evt.is_observable ? 'Observable' : 'Teleseismic',
    });
  }

  function showIncomingHud(evt) {
    const mag = evt.magnitude ? `M ${evt.magnitude.toFixed(1)}` : 'Earthquake';
    const place = evt.place || 'Regional Seismic Event';
    const dist = evt.distance_miles ? `${evt.distance_miles} miles away` : (evt.distance_km ? `${evt.distance_km} km away` : 'Regional');

    elements.incomingTitle.textContent = `🌊 USGS: ${mag} — ${place}`;
    elements.incomingSub.textContent = `Distance: ${dist} — Origin: ${new Date((evt.time || Date.now()/1000) * 1000).toISOString().substring(11, 19)} UTC — Theoretical wavefronts in transit`;
    elements.incomingHud.style.display = 'block';

    if (state.incomingTimerInterval) clearInterval(state.incomingTimerInterval);

    state.incomingTimerInterval = setInterval(() => {
      const now = Date.now() / 1000;
      const pRem = (evt.p_arrival || now) - now;
      const sRem = (evt.s_arrival || now) - now;

      if (pRem <= 0) {
        elements.incomingPCount.textContent = 'ARRIVED';
      } else {
        elements.incomingPCount.textContent = `-${pRem.toFixed(1)}s`;
      }

      if (sRem <= 0) {
        elements.incomingSCount.textContent = 'ARRIVED';
        if (pRem <= -60) {
          clearInterval(state.incomingTimerInterval);
        }
      } else {
        elements.incomingSCount.textContent = `-${sRem.toFixed(1)}s`;
      }
    }, 100);
  }

  elements.dismissIncomingBtn.addEventListener('click', () => {
    elements.incomingHud.style.display = 'none';
    if (state.incomingTimerInterval) clearInterval(state.incomingTimerInterval);
  });

  // -------------------------------------------------------------------------
  // Trigger & Early Warning Symbology Handler
  // -------------------------------------------------------------------------
  function handleTriggerEvent(trigger) {
    state.triggers.push(trigger);
    if (state.triggers.length > 50) state.triggers.shift();

    // Drop symbology & trigger sound
    playAlertSound('advisory');
    addEventToTable({
      timestamp: trigger.start_time,
      severity: 'advisory',
      mag: '--',
      distance: '--',
      staLta: (trigger.peak_sta_lta || trigger.sta_lta_ratio || 4.0).toFixed(1) + 'x',
      channel: trigger.channel || 'EHZ',
      type: trigger.is_simulation ? 'Simulation Trigger' : 'STA/LTA Detection',
      status: 'Triggered',
    });
  }

  function handleAlertEvent(alert) {
    state.alerts.push(alert);
    state.activeAlert = alert;

    // Show warning HUD banner with S-wave countdown
    showWarningHud(alert);
    playAlertSound(alert.severity || 'warning');

    addEventToTable({
      timestamp: alert.timestamp || alert.p_wave_time,
      severity: alert.severity || 'warning',
      mag: alert.estimated_magnitude ? `M ${alert.estimated_magnitude.toFixed(1)}` : '--',
      distance: alert.distance_miles ? `${alert.distance_miles} mi` : (alert.estimated_distance_km ? `${alert.estimated_distance_km} km` : 'LOCAL'),
      staLta: (alert.sta_lta_ratio || 4.0).toFixed(1) + 'x',
      channel: alert.channel || 'EHZ',
      type: alert.is_simulation ? 'Simulation Alert' : 'Earthquake Warning',
      status: alert.status || 'Confirmed',
    });
  }

  function handleStatusEvent(status) {
    if (status.rsam_1min !== undefined) {
      elements.rsamValue.textContent = `RSAM: ${Math.round(status.rsam_1min)}`;
      state.rsamHistory.push({
        time: Date.now() / 1000,
        rsam: status.rsam_1min,
        noiseFloor: status.noise_floor_counts,
      });
      if (state.rsamHistory.length > 60) state.rsamHistory.shift();
    }
  }

  function showWarningHud(alert) {
    const severity = (alert.severity || 'warning').toUpperCase();
    elements.warningSeverity.textContent = severity;
    elements.warningSeverity.className = `warning-badge severity-${severity.toLowerCase()}`;

    const mag = alert.estimated_magnitude ? `M ${alert.estimated_magnitude.toFixed(1)}` : 'Seismic Event';
    const dist = alert.distance_miles ? `${alert.distance_miles} miles away` : (alert.distance_class || 'LOCAL');
    elements.warningTitle.textContent = `🚨 EARTHQUAKE WARNING: ${mag}`;
    elements.warningSub.textContent = `${dist} — Onset: ${new Date(alert.p_wave_time * 1000).toISOString().substring(11, 19)} UTC — Ratio: ${(alert.sta_lta_ratio || 4.0).toFixed(1)}x`;

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
        elements.sWaveCountdown.textContent = 'ARRIVED';
        clearInterval(state.sWaveTimerInterval);
      } else {
        elements.sWaveCountdown.textContent = `${remaining.toFixed(1)}s`;
      }
    }, 100);
  }

  elements.dismissWarningBtn.addEventListener('click', () => {
    elements.warningHud.style.display = 'none';
    if (state.sWaveTimerInterval) clearInterval(state.sWaveTimerInterval);
  });

  // -------------------------------------------------------------------------
  // Event History Table & Column Sorting (Default: Newest First)
  // -------------------------------------------------------------------------
  const SEVERITY_RANKS = { info: 1, advisory: 2, warning: 3, critical: 4 };

  function addEventToTable(evt) {
    state.allEvents.push(evt);
    if (state.allEvents.length > 200) state.allEvents.shift();
    renderEventsTable();
  }

  function renderEventsTable() {
    const tbody = elements.eventsTableBody;
    if (!tbody) return;

    if (!state.allEvents || state.allEvents.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-muted text-center">No triggers recorded yet. Listening to live SeedLink stream...</td></tr>';
      return;
    }

    const col = state.sortColumn || 'timestamp';
    const dir = state.sortDirection || 'desc';

    const sorted = [...state.allEvents].sort((a, b) => {
      let valA, valB;
      if (col === 'timestamp') {
        valA = a.timestamp || 0;
        valB = b.timestamp || 0;
      } else if (col === 'severity') {
        valA = SEVERITY_RANKS[(a.severity || 'info').toLowerCase()] || 0;
        valB = SEVERITY_RANKS[(b.severity || 'info').toLowerCase()] || 0;
      } else if (col === 'mag') {
        valA = parseFloat(String(a.mag || '').replace(/[^\d.-]/g, '')) || 0;
        valB = parseFloat(String(b.mag || '').replace(/[^\d.-]/g, '')) || 0;
      } else if (col === 'distance') {
        valA = parseFloat(String(a.distance || '').replace(/[^\d.-]/g, '')) || 0;
        valB = parseFloat(String(b.distance || '').replace(/[^\d.-]/g, '')) || 0;
      } else if (col === 'staLta') {
        valA = parseFloat(String(a.staLta || '').replace(/[^\d.-]/g, '')) || 0;
        valB = parseFloat(String(b.staLta || '').replace(/[^\d.-]/g, '')) || 0;
      } else if (col === 'channel') {
        valA = String(a.channel || '').toLowerCase();
        valB = String(b.channel || '').toLowerCase();
      } else if (col === 'type') {
        valA = String(a.type || '').toLowerCase();
        valB = String(b.type || '').toLowerCase();
      } else if (col === 'status') {
        valA = String(a.status || '').toLowerCase();
        valB = String(b.status || '').toLowerCase();
      } else {
        valA = a.timestamp || 0;
        valB = b.timestamp || 0;
      }

      if (valA < valB) return dir === 'asc' ? -1 : 1;
      if (valA > valB) return dir === 'asc' ? 1 : -1;
      return 0;
    });

    // Update header indicator icons
    document.querySelectorAll('#eventsTable th.sortable').forEach((th) => {
      const thCol = th.getAttribute('data-col');
      const arrow = th.querySelector('.sort-arrow');
      if (thCol === col) {
        th.classList.add('sorted');
        if (arrow) arrow.textContent = dir === 'asc' ? '▲' : '▼';
      } else {
        th.classList.remove('sorted');
        if (arrow) arrow.textContent = '⇅';
      }
    });

    tbody.innerHTML = '';
    sorted.forEach((evt) => {
      const row = document.createElement('tr');
      const timeStr = new Date((evt.timestamp || 0) * 1000).toISOString().substring(11, 23);
      const sevClass = `sev-${(evt.severity || 'info').toLowerCase()}`;
      row.innerHTML = `
        <td>${timeStr}</td>
        <td><span class="sev-tag ${sevClass}">${(evt.severity || 'info').toUpperCase()}</span></td>
        <td><b>${evt.mag || '--'}</b></td>
        <td>${evt.distance || '--'}</td>
        <td>${evt.staLta || '--'}</td>
        <td>${evt.channel || '--'}</td>
        <td>${evt.type || '--'}</td>
        <td>${evt.status || '--'}</td>
      `;
      tbody.appendChild(row);
    });
  }

  // -------------------------------------------------------------------------
  // Digital Signal Processing Filters
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Digital Signal Processing Filters
  // -------------------------------------------------------------------------
  function filterData(data, mode) {
    if (!data || data.length === 0) return new Float64Array(0);

    const n = data.length;
    const out = new Float64Array(n);

    // Calculate baseline DC offset (mean)
    let sum = 0;
    for (let i = 0; i < n; i++) sum += data[i];
    const mean = sum / n;

    // Always demean for visualization so signal is centered around zero
    for (let i = 0; i < n; i++) out[i] = data[i] - mean;

    if (mode === 'raw' || mode === 'demean' || n < 8) return out;

    // 1–10 Hz Bandpass Filter (2nd-order Butterworth IIR approximation)
    if (mode === 'bandpass') {
      const filtered = new Float64Array(n);
      let y1 = 0, y2 = 0, x1 = 0, x2 = 0;
      const b0 = 0.067455, b1 = 0.0, b2 = -0.067455;
      const a1 = -1.14298, a2 = 0.41280;

      for (let i = 0; i < n; i++) {
        const x = out[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        filtered[i] = isNaN(y) ? 0 : y;
        x2 = x1; x1 = x;
        y2 = y1; y1 = filtered[i];
      }
      return filtered;
    }

    return out;
  }

  // -------------------------------------------------------------------------
  // Oscilloscope Renderer (Sample-Fitted Strip Chart)
  // -------------------------------------------------------------------------
  function renderOscilloscope() {
    const channels = ['EHZ', 'ENZ', 'ENN', 'ENE'];
    const windowSec = state.windowSec || 30;
    const numSamples = Math.round(windowSec * SAMPLING_RATE);

    // Determine current display time from latest channel sample
    let latestT = 0;
    for (const ch of channels) {
      const tsArr = state.timestamps[ch];
      if (tsArr && tsArr.length > 0) {
        const lastTs = tsArr[tsArr.length - 1];
        if (lastTs > latestT) latestT = lastTs;
      }
    }
    const endT = state.paused
      ? (state.lastPausedTimestamp || latestT || (Date.now() / 1000))
      : (latestT || (Date.now() / 1000));
    const startT = endT - windowSec;

    // Update UTC clock display
    if (elements.utcClock) {
      elements.utcClock.textContent = new Date(endT * 1000).toISOString().substring(11, 23);
    }

    channels.forEach((ch) => {
      const canvas = elements.canvases[ch];
      const overlay = elements.overlays[ch];
      if (!canvas || !state.visibleChannels[ch]) return;

      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      if (w <= 0 || h <= 0) return;

      // Handle Retina pixel ratio
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }

      const ctx = canvas.getContext('2d');
      ctx.resetTransform();
      ctx.scale(dpr, dpr);

      // 1. Clear background
      ctx.fillStyle = '#0a0e17';
      ctx.fillRect(0, 0, w, h);

      // 2. Draw Time Grid (scaled to exact canvas width)
      ctx.strokeStyle = '#182234';
      ctx.lineWidth = 1;
      ctx.beginPath();
      // Center horizontal zero line
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);

      const secStep = windowSec <= 15 ? 2 : (windowSec <= 30 ? 5 : (windowSec <= 120 ? 15 : 60));
      const firstSec = Math.ceil(startT / secStep) * secStep;
      for (let t = firstSec; t <= endT; t += secStep) {
        const x = ((t - startT) / windowSec) * w;
        if (x >= 0 && x <= w) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
        }
      }
      ctx.stroke();

      // Zero-crossing accent line
      ctx.strokeStyle = '#25354d';
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      const rawBuf = state.buffers[ch];
      if (!rawBuf || rawBuf.length === 0) return;

      // Slice exact visible window (e.g. 3,000 samples for 30s)
      const visibleRaw = rawBuf.slice(-numSamples);
      const filtered = filterData(visibleRaw, state.filterMode);
      const nVisible = filtered.length;
      if (nVisible < 2) return;

      // Calculate peak amplitude for scaling
      let pk = 15;
      for (let i = 0; i < nVisible; i++) {
        const abs = Math.abs(filtered[i]);
        if (abs > pk) pk = abs;
      }

      let maxVal = 100;
      if (state.gainMode === 'auto') {
        maxVal = Math.max(pk * 1.3, 20.0);
      } else {
        maxVal = Math.max(parseFloat(state.gainMode), 10.0);
      }

      // Update telemetry badges
      const lastVal = filtered[nVisible - 1] || 0;
      if (elements.values[ch]) {
        elements.values[ch].textContent = Math.round(lastVal).toLocaleString();
      }

      if (ch === 'EHZ' && elements.pkEHZ) {
        elements.pkEHZ.textContent = Math.round(maxVal).toLocaleString();
        if (elements.staEHZ) {
          elements.staEHZ.textContent = (state.staLtaRatios.EHZ || 1.0).toFixed(2);
        }
      } else if (ch === 'ENZ' && elements.pgaENZ) {
        elements.pgaENZ.textContent = (maxVal * 1.9e-6).toFixed(4);
      } else if (ch === 'ENN' && elements.pgaENN) {
        elements.pgaENN.textContent = (maxVal * 1.9e-6).toFixed(4);
      } else if (ch === 'ENE' && elements.pgaENE) {
        elements.pgaENE.textContent = (maxVal * 1.9e-6).toFixed(4);
      }

      // 3. Draw Seismic Trace (guaranteed 100% fitted to canvas width)
      ctx.save();
      ctx.strokeStyle = CH_COLORS[ch] || '#00ff88';
      ctx.lineWidth = 1.8;
      ctx.shadowColor = CH_COLORS[ch] || '#00ff88';
      ctx.shadowBlur = 3;
      ctx.beginPath();

      // If buffer is still filling on startup, align to right side
      const xOffset = nVisible < numSamples ? ((numSamples - nVisible) / (numSamples - 1)) * w : 0;
      const xSpan = w - xOffset;

      for (let i = 0; i < nVisible; i++) {
        const x = xOffset + (i / Math.max(nVisible - 1, 1)) * xSpan;
        const val = filtered[i];
        const normalizedY = (val / maxVal);
        const clampedY = Math.max(-1.0, Math.min(1.0, normalizedY));
        const y = h / 2 - clampedY * (h / 2) * 0.88;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      ctx.restore();

      // -------------------------------------------------------------------
      // Drop Symbology & Annotations on Live Traces
      // -------------------------------------------------------------------
      if (overlay) {
        overlay.innerHTML = '';

        // Trigger pins
        state.triggers.forEach((trig) => {
          const trigTime = trig.start_time;
          if (trigTime >= startT && trigTime <= endT) {
            const xPercent = ((trigTime - startT) / windowSec) * 100;
            if (xPercent >= 0 && xPercent <= 100) {
              const flag = document.createElement('div');
              flag.className = 'trigger-flag';
              flag.style.left = `${xPercent}%`;

              const badge = document.createElement('div');
              badge.className = 'trigger-badge';
              badge.textContent = `📍 P-Wave [STA/LTA: ${(trig.peak_sta_lta || trig.sta_lta_ratio || 4.0).toFixed(1)}x]`;
              flag.appendChild(badge);

              overlay.appendChild(flag);
            }
          }
        });

        // USGS External Earthquakes & Theoretical Wavefronts
        state.usgsEvents.forEach((uEvt) => {
          const pArr = uEvt.p_arrival;
          if (pArr && pArr >= startT && pArr <= endT) {
            const xPercent = ((pArr - startT) / windowSec) * 100;
            if (xPercent >= 0 && xPercent <= 100) {
              const flag = document.createElement('div');
              flag.className = 'usgs-flag';
              flag.style.left = `${xPercent}%`;

              const badge = document.createElement('div');
              badge.className = 'usgs-badge';
              badge.textContent = `🌐 USGS M${uEvt.magnitude} [Theor. P | ${uEvt.distance_miles}mi]`;
              flag.appendChild(badge);

              overlay.appendChild(flag);
            }
          }
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // High-Definition (HD) Waterfall Spectrogram Renderer (0–50 Hz Real-Time FFT)
  // -------------------------------------------------------------------------
  const specCanvas = elements.canvases.spectrogram;
  const specCtx = specCanvas ? specCanvas.getContext('2d') : null;
  let specNoiseFloor = 2.0;
  let specMaxPower = 6.0;

  // Precompute Twiddle factors & Blackman-Harris window for N=256 (128 discrete frequency bins)
  const FFT_SIZE = 256;
  const NUM_FREQ_BINS = FFT_SIZE / 2; // 128 bins (0 to 50 Hz, 0.39 Hz/bin)
  const fftSin = new Float32Array(FFT_SIZE);
  const fftCos = new Float32Array(FFT_SIZE);
  const fftWindow = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    fftSin[i] = Math.sin((-2 * Math.PI * i) / FFT_SIZE);
    fftCos[i] = Math.cos((-2 * Math.PI * i) / FFT_SIZE);
    const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
    fftWindow[i] = a0 - a1 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)) +
                        a2 * Math.cos((4 * Math.PI * i) / (FFT_SIZE - 1)) -
                        a3 * Math.cos((6 * Math.PI * i) / (FFT_SIZE - 1));
  }

  function computeHighResPowerSpectrum(rawSlice) {
    if (!rawSlice || rawSlice.length < FFT_SIZE) return null;

    // 1. Demean & apply Blackman-Harris window
    let sum = 0;
    for (let i = 0; i < FFT_SIZE; i++) sum += rawSlice[i];
    const mean = sum / FFT_SIZE;

    const real = new Float32Array(FFT_SIZE);
    const imag = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      real[i] = (rawSlice[i] - mean) * fftWindow[i];
    }

    // 2. Cooley-Tukey Radix-2 FFT
    let j = 0;
    for (let i = 0; i < FFT_SIZE - 1; i++) {
      if (i < j) {
        const tr = real[i]; real[i] = real[j]; real[j] = tr;
        const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
      }
      let k = FFT_SIZE >> 1;
      while (k <= j) {
        j -= k;
        k >>= 1;
      }
      j += k;
    }

    for (let len = 2; len <= FFT_SIZE; len <<= 1) {
      const halfLen = len >> 1;
      const step = FFT_SIZE / len;
      for (let i = 0; i < FFT_SIZE; i += len) {
        let k = 0;
        for (let m = 0; m < halfLen; m++) {
          const c = fftCos[k];
          const s = fftSin[k];
          const tr = real[i + m + halfLen] * c - imag[i + m + halfLen] * s;
          const ti = real[i + m + halfLen] * s + imag[i + m + halfLen] * c;
          real[i + m + halfLen] = real[i + m] - tr;
          imag[i + m + halfLen] = imag[i + m] - ti;
          real[i + m] += tr;
          imag[i + m] += ti;
          k += step;
        }
      }
    }

    // 3. Compute Power in dB for the 128 positive frequency bins
    const psd = new Float32Array(NUM_FREQ_BINS);
    for (let i = 0; i < NUM_FREQ_BINS; i++) {
      const p = real[i] * real[i] + imag[i] * imag[i];
      psd[i] = Math.log10(1.0 + p);
    }
    return psd;
  }

  function getSeismicHeatmapRGB(val) {
    const v = Math.max(0, Math.min(1, val));
    let r = 0, g = 0, b = 0;

    if (v < 0.2) {
      const t = v / 0.2;
      r = Math.floor(5 + 10 * t);
      g = Math.floor(10 + 35 * t);
      b = Math.floor(25 + 120 * t);
    } else if (v < 0.4) {
      const t = (v - 0.2) / 0.2;
      r = Math.floor(15 + 10 * t);
      g = Math.floor(45 + 150 * t);
      b = Math.floor(145 + 90 * t);
    } else if (v < 0.6) {
      const t = (v - 0.4) / 0.2;
      r = Math.floor(25 + 210 * t);
      g = Math.floor(195 + 40 * t);
      b = Math.floor(235 * (1 - t));
    } else if (v < 0.8) {
      const t = (v - 0.6) / 0.2;
      r = Math.floor(235 + 20 * t);
      g = Math.floor(235 * (1 - t * 0.7));
      b = 0;
    } else {
      const t = (v - 0.8) / 0.2;
      r = 255;
      g = Math.floor(70 + 185 * t);
      b = Math.floor(255 * t);
    }
    return [r, g, b];
  }

  function renderSpectrogram() {
    if (!specCanvas || state.activeTab !== 'spectrogram') return;

    const rect = specCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w <= 0 || h <= 0) return;

    if (specCanvas.width !== Math.round(w) || specCanvas.height !== Math.round(h)) {
      specCanvas.width = Math.round(w);
      specCanvas.height = Math.round(h);
      specCtx.fillStyle = '#050814';
      specCtx.fillRect(0, 0, specCanvas.width, specCanvas.height);
    }

    const buf = state.buffers.EHZ;
    if (!buf || buf.length < FFT_SIZE) return;

    // Shift previous spectrogram image 1px to the left (ultra smooth scroll)
    specCtx.drawImage(specCanvas, 1, 0, w - 1, h, 0, 0, w - 1, h);

    // Compute HD FFT power spectrum on latest 256 samples (128 bins)
    const slice = buf.slice(-FFT_SIZE);
    const psd = computeHighResPowerSpectrum(slice);
    if (!psd) return;

    let currentPeak = 0;
    let currentMin = 999;
    for (let k = 0; k < psd.length; k++) {
      if (psd[k] > currentPeak) currentPeak = psd[k];
      if (psd[k] < currentMin) currentMin = psd[k];
    }
    if (currentMin < 999) {
      specNoiseFloor = specNoiseFloor * 0.98 + currentMin * 0.02;
    }
    if (currentPeak > 0) {
      specMaxPower = Math.max(specMaxPower * 0.99 + currentPeak * 0.01, specNoiseFloor + 2.0);
    }

    const dynamicRange = Math.max(specMaxPower - specNoiseFloor, 1.5);

    // High-resolution vertical scanline interpolation (1 pixel wide column at right edge)
    const imgData = specCtx.createImageData(1, h);
    const data = imgData.data;

    for (let y = 0; y < h; y++) {
      // Invert Y: y = 0 is 50 Hz, y = h - 1 is 0 Hz
      const binFloat = ((h - 1 - y) / (h - 1)) * (NUM_FREQ_BINS - 1);
      const bin0 = Math.floor(binFloat);
      const bin1 = Math.min(bin0 + 1, NUM_FREQ_BINS - 1);
      const frac = binFloat - bin0;

      // Linear interpolation between frequency bins
      const power = psd[bin0] * (1.0 - frac) + psd[bin1] * frac;
      const normalized = (power - specNoiseFloor) / dynamicRange;
      const [r, g, b] = getSeismicHeatmapRGB(normalized);

      const offset = y * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }

    specCtx.putImageData(imgData, w - 1, 0);

    // Overlay subtle frequency reference lines
    specCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    specCtx.lineWidth = 1;
    [10, 20, 30, 40].forEach((freqHz) => {
      const y = h - (freqHz / 50.0) * h;
      specCtx.beginPath();
      specCtx.moveTo(w - 6, y);
      specCtx.lineTo(w, y);
      specCtx.stroke();
    });
  }

  // -------------------------------------------------------------------------
  // 24-Hour Real Helicorder Drum Renderer
  // -------------------------------------------------------------------------
  const heliCanvas = elements.canvases.helicorder;
  const heliCtx = heliCanvas ? heliCanvas.getContext('2d') : null;

  function renderHelicorder() {
    if (!heliCanvas || state.activeTab !== 'helicorder') return;

    const rect = heliCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w <= 0 || h <= 0) return;

    if (heliCanvas.width !== Math.round(w) || heliCanvas.height !== Math.round(h)) {
      heliCanvas.width = Math.round(w);
      heliCanvas.height = Math.round(h);
    }

    const rows = 24;
    const rowHeight = h / rows;

    heliCtx.fillStyle = '#0a0e17';
    heliCtx.fillRect(0, 0, w, h);

    const now = new Date();
    const curUtcSec = now.getTime() / 1000;
    const curMinuteUtc = Math.floor(curUtcSec / 60) * 60;
    const curHourUtc = Math.floor(curUtcSec / 3600) * 3600;
    const curSec = now.getUTCSeconds();
    const curMin = now.getUTCMinutes();
    const curFraction = (curMin * 60 + curSec) / 3600;

    const sessionStartMinute = Math.floor(state.sessionStartTime / 60) * 60;

    for (let r = 0; r < rows; r++) {
      const y = r * rowHeight;
      const rowStartUtc = curHourUtc - (rows - 1 - r) * 3600;
      const rowEndUtc = rowStartUtc + 3600;
      const rowDate = new Date(rowStartUtc * 1000);
      const hourStr = String(rowDate.getUTCHours()).padStart(2, '0');

      // Row separator
      heliCtx.strokeStyle = '#182234';
      heliCtx.lineWidth = 1;
      heliCtx.beginPath();
      heliCtx.moveTo(0, y + rowHeight);
      heliCtx.lineTo(w, y + rowHeight);
      heliCtx.stroke();

      // Timestamp margin
      heliCtx.fillStyle = '#64748b';
      heliCtx.font = '10px monospace';
      heliCtx.fillText(`${hourStr}:00`, 8, y + rowHeight / 2 + 4);

      // Baseline guide
      const traceStartX = 56;
      const traceEndX = w - 10;
      const traceWidth = traceEndX - traceStartX;
      const centerY = y + rowHeight / 2;

      heliCtx.strokeStyle = '#1e293b';
      heliCtx.beginPath();
      heliCtx.moveTo(traceStartX, centerY);
      heliCtx.lineTo(traceEndX, centerY);
      heliCtx.stroke();

      const isCurrentRow = r === rows - 1;
      const activeEndX = isCurrentRow ? traceStartX + curFraction * traceWidth : traceEndX;

      // Draw real recorded minute envelopes
      heliCtx.strokeStyle = r % 2 === 0 ? '#38bdf8' : '#818cf8';
      heliCtx.lineWidth = 1.2;
      heliCtx.beginPath();

      let started = false;
      for (let m = 0; m < 60; m++) {
        const minKey = rowStartUtc + m * 60;
        if (minKey < sessionStartMinute) continue; // Unrecorded past: Leave blank paper!
        if (minKey > curMinuteUtc) break;          // Future minutes: Leave blank paper!

        const x0 = traceStartX + (m / 60) * traceWidth;
        const x1 = traceStartX + ((m + 1) / 60) * traceWidth;
        const xMid = (x0 + x1) / 2;

        const peak = state.helicorderMinutePeaks[minKey];
        if (peak && peak.count > 0) {
          const mean = peak.sum / peak.count;
          const maxDefl = Math.min((peak.max - mean) * 0.0015, rowHeight * 0.42);
          const minDefl = Math.max((peak.min - mean) * 0.0015, -rowHeight * 0.42);

          if (!started) {
            heliCtx.moveTo(x0, centerY);
            started = true;
          }
          heliCtx.lineTo(xMid - 1, centerY - maxDefl);
          heliCtx.lineTo(xMid + 1, centerY - minDefl);
          heliCtx.lineTo(x1, centerY);
        } else {
          if (!started) {
            heliCtx.moveTo(x0, centerY);
            started = true;
          }
          heliCtx.lineTo(x1, centerY);
        }
      }
      if (started) heliCtx.stroke();

      // Current moving record needle (Red Stylus)
      if (isCurrentRow) {
        heliCtx.fillStyle = '#ef4444';
        heliCtx.shadowColor = '#ef4444';
        heliCtx.shadowBlur = 6;
        heliCtx.fillRect(activeEndX - 1.5, y + 2, 3, rowHeight - 4);
        heliCtx.shadowBlur = 0;
      }
    }

    // Paint USGS Earthquake Markers on Helicorder
    state.usgsEvents.forEach((uEvt) => {
      const eTime = new Date((uEvt.time || 0) * 1000);
      const eUtcSec = eTime.getTime() / 1000;
      const ageHours = (curUtcSec - eUtcSec) / 3600;

      if (ageHours >= 0 && ageHours < 24) {
        const row = (rows - 1) - Math.floor(ageHours);
        if (row >= 0 && row < rows) {
          const y = row * rowHeight;
          const eMin = eTime.getUTCMinutes();
          const eSec = eTime.getUTCSeconds();
          const fraction = (eMin * 60 + eSec) / 3600;
          const traceStartX = 56;
          const traceWidth = (w - 10) - traceStartX;
          const x = traceStartX + fraction * traceWidth;

          heliCtx.fillStyle = '#f59e0b';
          heliCtx.beginPath();
          heliCtx.arc(x, y + rowHeight / 2, 3.5, 0, 2 * Math.PI);
          heliCtx.fill();

          heliCtx.fillStyle = '#fff';
          heliCtx.font = '8px monospace';
          heliCtx.fillText(`M${uEvt.magnitude}`, x + 5, y + rowHeight / 2 + 3);
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // STA/LTA & RSAM Renderer
  // -------------------------------------------------------------------------
  function renderTelemetry() {
    if (state.activeTab !== 'stalta') return;

    // 1. STA/LTA Canvas
    const staltaC = elements.canvases.stalta;
    if (staltaC) {
      const rect = staltaC.getBoundingClientRect();
      if (staltaC.width !== rect.width || staltaC.height !== rect.height) {
        staltaC.width = rect.width;
        staltaC.height = rect.height;
      }
      const ctx = staltaC.getContext('2d');
      const w = staltaC.width;
      const h = staltaC.height;

      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(0, 0, w, h);

      // Trigger ON line (4.0) and OFF line (1.5)
      const maxRatio = 10.0;
      const yOn = h - (4.0 / maxRatio) * h;
      const yOff = h - (1.5 / maxRatio) * h;

      ctx.strokeStyle = '#ef4444';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, yOn);
      ctx.lineTo(w, yOn);
      ctx.stroke();

      ctx.strokeStyle = '#eab308';
      ctx.beginPath();
      ctx.moveTo(0, yOff);
      ctx.lineTo(w, yOff);
      ctx.stroke();
      ctx.setLineDash([]);

      // Ratio trace
      if (state.staLtaHistory.length > 1) {
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        const step = w / state.staLtaHistory.length;
        state.staLtaHistory.forEach((pt, i) => {
          const x = i * step;
          const y = h - (Math.min(pt.ratio, maxRatio) / maxRatio) * h;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
    }

    // 2. RSAM Canvas
    const rsamC = elements.canvases.rsam;
    if (rsamC) {
      const rect = rsamC.getBoundingClientRect();
      if (rsamC.width !== rect.width || rsamC.height !== rect.height) {
        rsamC.width = rect.width;
        rsamC.height = rect.height;
      }
      const ctx = rsamC.getContext('2d');
      const w = rsamC.width;
      const h = rsamC.height;

      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(0, 0, w, h);

      if (state.rsamHistory.length > 0) {
        const barWidth = Math.max(w / 60, 4);
        let maxRsam = 25000;
        state.rsamHistory.forEach(pt => { if (pt.rsam > maxRsam) maxRsam = pt.rsam * 1.2; });

        state.rsamHistory.forEach((pt, i) => {
          const x = w - (state.rsamHistory.length - i) * barWidth;
          const barH = (pt.rsam / maxRsam) * (h - 20);
          ctx.fillStyle = '#00d2ff';
          ctx.fillRect(x, h - barH, barWidth - 1, barH);
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3D / 2D Hodogram & Particle Motion Orbit Renderer
  // -------------------------------------------------------------------------
  function renderHodogram() {
    if (state.activeTab !== 'hodogram') return;

    const nBuf = state.buffers.ENN;
    const eBuf = state.buffers.ENE;
    const zBuf = state.buffers.ENZ;
    if (!nBuf || !eBuf || !zBuf || nBuf.length < 30) return;

    const pts = Math.min(nBuf.length, 300); // 3 seconds @ 100 Hz
    const nSlice = nBuf.slice(-pts);
    const eSlice = eBuf.slice(-pts);
    const zSlice = zBuf.slice(-pts);

    // 1. Demean each axis to center motion precisely at (0,0)
    let meanN = 0, meanE = 0, meanZ = 0;
    for (let i = 0; i < pts; i++) {
      meanN += nSlice[i];
      meanE += eSlice[i];
      meanZ += zSlice[i];
    }
    meanN /= pts; meanE /= pts; meanZ /= pts;

    const nDemeaned = new Float64Array(pts);
    const eDemeaned = new Float64Array(pts);
    const zDemeaned = new Float64Array(pts);
    let maxH = 5, maxV = 5;

    for (let i = 0; i < pts; i++) {
      const n = nSlice[i] - meanN;
      const e = eSlice[i] - meanE;
      const z = zSlice[i] - meanZ;
      nDemeaned[i] = n;
      eDemeaned[i] = e;
      zDemeaned[i] = z;

      const radH = Math.sqrt(n * n + e * e);
      const radV = Math.sqrt(z * z + radH * radH);
      if (radH > maxH) maxH = radH;
      if (radV > maxV) maxV = radV;
    }

    const scaleH = Math.max(maxH * 1.3, 10.0);
    const scaleV = Math.max(maxV * 1.3, 10.0);

    // -----------------------------------------------------------------------
    // Canvas 1: Horizontal Plane (N-S vs E-W)
    // -----------------------------------------------------------------------
    const hCanvas = elements.canvases.hodoH;
    if (hCanvas) {
      const rect = hCanvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      if (w > 0 && h > 0) {
        const dpr = window.devicePixelRatio || 1;
        if (hCanvas.width !== Math.round(w * dpr) || hCanvas.height !== Math.round(h * dpr)) {
          hCanvas.width = Math.round(w * dpr);
          hCanvas.height = Math.round(h * dpr);
        }

        const ctx = hCanvas.getContext('2d');
        ctx.resetTransform();
        ctx.scale(dpr, dpr);

        // Background & Polar Grid Rings
        ctx.fillStyle = '#0a0e17';
        ctx.fillRect(0, 0, w, h);

        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(cx, cy) * 0.82;

        // Concentric distance rings
        ctx.strokeStyle = '#182234';
        ctx.lineWidth = 1;
        [0.33, 0.66, 1.0].forEach((rPct) => {
          ctx.beginPath();
          ctx.arc(cx, cy, radius * rPct, 0, 2 * Math.PI);
          ctx.stroke();
        });

        // Crosshairs
        ctx.strokeStyle = '#25354d';
        ctx.beginPath();
        ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
        ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
        ctx.stroke();

        // Compass labels
        ctx.fillStyle = '#64748b';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('N (ENN)', cx, cy - radius - 6);
        ctx.fillText('S', cx, cy + radius + 14);
        ctx.fillText('E (ENE)', cx + radius + 22, cy + 3);
        ctx.fillText('W', cx - radius - 14, cy + 3);

        // Draw particle orbit with fading amber trail
        for (let i = 1; i < pts; i++) {
          const alpha = 0.12 + 0.88 * (i / pts);
          const x0 = cx + (eDemeaned[i - 1] / scaleH) * radius;
          const y0 = cy - (nDemeaned[i - 1] / scaleH) * radius;
          const x1 = cx + (eDemeaned[i] / scaleH) * radius;
          const y1 = cy - (nDemeaned[i] / scaleH) * radius;

          ctx.strokeStyle = `rgba(255, 170, 0, ${alpha})`;
          ctx.lineWidth = 1.0 + 1.5 * (i / pts);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }

        // Instantaneous particle dot (Head)
        const headX = cx + (eDemeaned[pts - 1] / scaleH) * radius;
        const headY = cy - (nDemeaned[pts - 1] / scaleH) * radius;

        ctx.fillStyle = '#ffaa00';
        ctx.shadowColor = '#ffaa00';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(headX, headY, 4.5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    // -----------------------------------------------------------------------
    // Canvas 2: Vertical Motion Plane (Z vs Horizontal)
    // -----------------------------------------------------------------------
    const vCanvas = elements.canvases.hodoV;
    if (vCanvas) {
      const rect = vCanvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      if (w > 0 && h > 0) {
        const dpr = window.devicePixelRatio || 1;
        if (vCanvas.width !== Math.round(w * dpr) || vCanvas.height !== Math.round(h * dpr)) {
          vCanvas.width = Math.round(w * dpr);
          vCanvas.height = Math.round(h * dpr);
        }

        const ctx = vCanvas.getContext('2d');
        ctx.resetTransform();
        ctx.scale(dpr, dpr);

        ctx.fillStyle = '#0a0e17';
        ctx.fillRect(0, 0, w, h);

        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(cx, cy) * 0.82;

        // Concentric distance rings
        ctx.strokeStyle = '#182234';
        ctx.lineWidth = 1;
        [0.33, 0.66, 1.0].forEach((rPct) => {
          ctx.beginPath();
          ctx.arc(cx, cy, radius * rPct, 0, 2 * Math.PI);
          ctx.stroke();
        });

        // Crosshairs
        ctx.strokeStyle = '#25354d';
        ctx.beginPath();
        ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
        ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
        ctx.stroke();

        // Axis labels
        ctx.fillStyle = '#64748b';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('+Z (Up / ENZ)', cx, cy - radius - 6);
        ctx.fillText('-Z (Down)', cx, cy + radius + 14);
        ctx.fillText('+H (Horiz)', cx + radius + 24, cy + 3);
        ctx.fillText('-H', cx - radius - 14, cy + 3);

        // Draw vertical trajectory with fading cyan trail
        for (let i = 1; i < pts; i++) {
          const alpha = 0.12 + 0.88 * (i / pts);
          const radH0 = Math.sqrt(nDemeaned[i - 1] ** 2 + eDemeaned[i - 1] ** 2) * (nDemeaned[i - 1] >= 0 ? 1 : -1);
          const radH1 = Math.sqrt(nDemeaned[i] ** 2 + eDemeaned[i] ** 2) * (nDemeaned[i] >= 0 ? 1 : -1);

          const x0 = cx + (radH0 / scaleV) * radius;
          const y0 = cy - (zDemeaned[i - 1] / scaleV) * radius;
          const x1 = cx + (radH1 / scaleV) * radius;
          const y1 = cy - (zDemeaned[i] / scaleV) * radius;

          ctx.strokeStyle = `rgba(0, 210, 255, ${alpha})`;
          ctx.lineWidth = 1.0 + 1.5 * (i / pts);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }

        // Instantaneous particle dot (Head)
        const lastH = Math.sqrt(nDemeaned[pts - 1] ** 2 + eDemeaned[pts - 1] ** 2) * (nDemeaned[pts - 1] >= 0 ? 1 : -1);
        const headX = cx + (lastH / scaleV) * radius;
        const headY = cy - (zDemeaned[pts - 1] / scaleV) * radius;

        ctx.fillStyle = '#00d2ff';
        ctx.shadowColor = '#00d2ff';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(headX, headY, 4.5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Main Animation Loop
  // -------------------------------------------------------------------------
  function mainLoop() {
    renderOscilloscope();
    renderSpectrogram();
    renderHelicorder();
    renderTelemetry();
    renderHodogram();
    requestAnimationFrame(mainLoop);
  }

  // -------------------------------------------------------------------------
  // UI Event Handlers
  // -------------------------------------------------------------------------
  elements.viewTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;

    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

    btn.classList.add('active');
    const tabName = btn.getAttribute('data-tab');
    state.activeTab = tabName;
    const targetPanel = document.getElementById(`tab-${tabName}`);
    if (targetPanel) targetPanel.classList.add('active');

    // Reset sort states to default (newest first) on every tab switch
    state.sortColumn = 'timestamp';
    state.sortDirection = 'desc';
    state.mlSortColumn = 'timestamp';
    state.mlSortDirection = 'desc';

    if (tabName === 'events') {
      renderEventsTable();
    } else if (tabName === 'ml') {
      fetchMlDataset();
    }
  });

  // -------------------------------------------------------------------------
  // Column Header Sorting Click Listeners
  // -------------------------------------------------------------------------
  document.querySelectorAll('#eventsTable th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.getAttribute('data-col');
      if (!col) return;

      if (state.sortColumn === col) {
        state.sortDirection = state.sortDirection === 'desc' ? 'asc' : 'desc';
      } else {
        state.sortColumn = col;
        state.sortDirection = (col === 'timestamp' || col === 'mag' || col === 'staLta') ? 'desc' : 'asc';
      }
      renderEventsTable();
    });
  });

  document.querySelectorAll('#mlEventsTable th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.getAttribute('data-ml-col');
      if (!col) return;

      if (state.mlSortColumn === col) {
        state.mlSortDirection = state.mlSortDirection === 'desc' ? 'asc' : 'desc';
      } else {
        state.mlSortColumn = col;
        state.mlSortDirection = (col === 'timestamp' || col === 'pga' || col === 'duration') ? 'desc' : 'asc';
      }
      renderMlTable();
    });
  });

  // -------------------------------------------------------------------------
  // Machine Learning Dataset & Annotation Handler
  // -------------------------------------------------------------------------
  async function fetchMlDataset() {
    try {
      const [sumRes, evRes] = await Promise.all([
        fetch('/api/ml/summary'),
        fetch('/api/ml/events?limit=100'),
      ]);
      const summary = await sumRes.json();
      const eventsData = await evRes.json();

      const countEl = document.getElementById('mlStatCount');
      const diskEl = document.getElementById('mlStatDisk');
      if (countEl) countEl.textContent = summary.total_annotated_events || 0;
      if (diskEl) diskEl.textContent = `${summary.disk_size_mb || 0} MB`;

      state.mlEvents = eventsData.events || [];
      renderMlTable();
    } catch (err) {
      console.error('Failed to fetch ML dataset summary:', err);
    }
  }

  function renderMlTable() {
    const tbody = document.getElementById('mlEventsTableBody');
    if (!tbody) return;

    if (!state.mlEvents || state.mlEvents.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-muted text-center">No ground-truth events tagged yet. Click a quick tag above to record your first ML training snippet!</td></tr>';
      return;
    }

    const col = state.mlSortColumn || 'timestamp';
    const dir = state.mlSortDirection || 'desc';

    const sorted = [...state.mlEvents].sort((a, b) => {
      let valA, valB;
      const featsA = a.features || {};
      const featsB = b.features || {};

      if (col === 'timestamp') {
        valA = a.start_time || 0;
        valB = b.start_time || 0;
      } else if (col === 'event_id') {
        valA = String(a.event_id || '');
        valB = String(b.event_id || '');
      } else if (col === 'label') {
        valA = String(a.label || '').toLowerCase();
        valB = String(b.label || '').toLowerCase();
      } else if (col === 'category') {
        valA = String(a.category || '').toLowerCase();
        valB = String(b.category || '').toLowerCase();
      } else if (col === 'duration') {
        valA = a.duration_sec || 0;
        valB = b.duration_sec || 0;
      } else if (col === 'pga') {
        valA = featsA.pga_resultant_m_s2 || 0;
        valB = featsB.pga_resultant_m_s2 || 0;
      } else if (col === 'dom_freq') {
        valA = featsA.dominant_freq_hz || 0;
        valB = featsB.dominant_freq_hz || 0;
      } else if (col === 'centroid') {
        valA = featsA.spectral_centroid_hz || 0;
        valB = featsB.spectral_centroid_hz || 0;
      } else if (col === 'file') {
        valA = String(a.snippet_file || '');
        valB = String(b.snippet_file || '');
      } else {
        valA = a.start_time || 0;
        valB = b.start_time || 0;
      }

      if (valA < valB) return dir === 'asc' ? -1 : 1;
      if (valA > valB) return dir === 'asc' ? 1 : -1;
      return 0;
    });

    // Update ML table header indicators
    document.querySelectorAll('#mlEventsTable th.sortable').forEach((th) => {
      const thCol = th.getAttribute('data-ml-col');
      const arrow = th.querySelector('.sort-arrow');
      if (thCol === col) {
        th.classList.add('sorted');
        if (arrow) arrow.textContent = dir === 'asc' ? '▲' : '▼';
      } else {
        th.classList.remove('sorted');
        if (arrow) arrow.textContent = '⇅';
      }
    });

    tbody.innerHTML = '';
    sorted.forEach((evt) => {
      const row = document.createElement('tr');
      const timeStr = new Date((evt.start_time || 0) * 1000).toISOString().substring(11, 23);
      const feats = evt.features || {};
      row.innerHTML = `
        <td><code>${evt.event_id || '--'}</code></td>
        <td>${timeStr}</td>
        <td><b style="color: #38bdf8;">${evt.label || '--'}</b></td>
        <td><span class="ch-tag" style="background: rgba(255,255,255,0.1);">${evt.category || '--'}</span></td>
        <td>${evt.duration_sec ? evt.duration_sec + 's' : '--'}</td>
        <td>${feats.pga_resultant_m_s2 !== undefined ? feats.pga_resultant_m_s2.toFixed(5) : '--'}</td>
        <td>${feats.dominant_freq_hz !== undefined ? feats.dominant_freq_hz + ' Hz' : '--'}</td>
        <td>${feats.spectral_centroid_hz !== undefined ? feats.spectral_centroid_hz + ' Hz' : '--'}</td>
        <td><code>${evt.snippet_file || '--'}</code></td>
      `;
      tbody.appendChild(row);
    });
  }

  async function annotateCurrentWindow(label, category, notes, durationSec = 30.0) {
    try {
      const resp = await fetch('/api/ml/annotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label,
          category: category,
          notes: notes,
          duration_sec: durationSec,
          confidence: 1.0,
        }),
      });
      const data = await resp.json();
      if (data.status === 'ok') {
        playAlertSound('advisory');
        fetchMlDataset();
      }
    } catch (err) {
      console.error('Failed to annotate event:', err);
    }
  }

  // Quick-tag button listeners
  document.querySelectorAll('.btn-tag').forEach((btn) => {
    btn.addEventListener('click', () => {
      const label = btn.getAttribute('data-label');
      const category = btn.getAttribute('data-category') || 'human_indoor';
      const notes = btn.getAttribute('data-notes') || '';
      annotateCurrentWindow(label, category, notes, 30.0);
    });
  });

  // Custom annotation form listener
  const mlSaveBtn = document.getElementById('mlSaveCustomBtn');
  if (mlSaveBtn) {
    mlSaveBtn.addEventListener('click', () => {
      const labelInput = document.getElementById('mlCustomLabel');
      const catSelect = document.getElementById('mlCustomCategory');
      const durSelect = document.getElementById('mlCustomDuration');
      const notesInput = document.getElementById('mlCustomNotes');

      const label = labelInput ? labelInput.value.trim() : '';
      if (!label) {
        alert('Please enter an Event Label before saving.');
        return;
      }
      const category = catSelect ? catSelect.value : 'custom';
      const duration = durSelect ? parseFloat(durSelect.value) : 30.0;
      const notes = notesInput ? notesInput.value.trim() : '';

      annotateCurrentWindow(label, category, notes, duration);
      if (labelInput) labelInput.value = '';
      if (notesInput) notesInput.value = '';
    });
  }

  elements.windowSelect.addEventListener('change', (e) => {
    state.windowSec = parseInt(e.target.value, 10);
  });

  elements.filterSelect.addEventListener('change', (e) => {
    state.filterMode = e.target.value;
  });

  elements.gainSelect.addEventListener('change', (e) => {
    state.gainMode = e.target.value;
  });

  elements.pauseBtn.addEventListener('click', () => {
    state.paused = !state.paused;
    elements.pauseBtn.textContent = state.paused ? '▶ Resume' : '⏸ Pause';
  });

  elements.audioToggle.addEventListener('click', () => {
    state.audioEnabled = !state.audioEnabled;
    elements.audioIcon.textContent = state.audioEnabled ? '🔊' : '🔇';
    elements.audioText.textContent = state.audioEnabled ? 'Audio On' : 'Audio Muted';
    initAudio();
  });

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

  elements.simTriggerBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/simulate-trigger', { method: 'POST' });
    } catch (err) {
      console.error('Failed to trigger simulation:', err);
    }
  });

  if (elements.simUsgsBtn) {
    elements.simUsgsBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/simulate-usgs', { method: 'POST' });
      } catch (err) {
        console.error('Failed to simulate USGS quake:', err);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Science Interpretation Guide Collapsible Listeners
  // -------------------------------------------------------------------------
  document.querySelectorAll('.guide-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const guide = toggle.closest('.science-guide');
      if (guide) {
        guide.classList.toggle('collapsed');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------
  connectWebSocket();
  requestAnimationFrame(mainLoop);
})();
