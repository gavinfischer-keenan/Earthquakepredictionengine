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
              state.buffers[ch].push(samples[i]);
              state.timestamps[ch].push(startT + i * dt);
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

  function addEventToTable(evt) {
    const tbody = elements.eventsTableBody;
    if (tbody.children.length === 1 && tbody.children[0].children.length === 1) {
      tbody.innerHTML = '';
    }

    const row = document.createElement('tr');
    const timeStr = new Date((evt.timestamp || Date.now() / 1000) * 1000).toISOString().substring(11, 23);
    const sevClass = `badge-${evt.severity || 'info'}`;

    row.innerHTML = `
      <td>${timeStr}</td>
      <td><span class="sev-tag ${sevClass}">${(evt.severity || 'info').toUpperCase()}</span></td>
      <td><b>${evt.mag}</b></td>
      <td>${evt.distance}</td>
      <td>${evt.staLta}</td>
      <td>${evt.channel}</td>
      <td>${evt.type}</td>
      <td>${evt.status}</td>
    `;
    tbody.prepend(row);
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
  // Waterfall Spectrogram Renderer (0–50 Hz Real-Time FFT)
  // -------------------------------------------------------------------------
  const specCanvas = elements.canvases.spectrogram;
  const specCtx = specCanvas ? specCanvas.getContext('2d') : null;
  let specNoiseFloor = 2.0;
  let specMaxPower = 6.0;

  function computePowerSpectrum(rawSlice) {
    const N = 64;
    if (!rawSlice || rawSlice.length < N) return new Float32Array(32);

    // 1. Demean
    let sum = 0;
    for (let i = 0; i < N; i++) sum += rawSlice[i];
    const mean = sum / N;

    // 2. Apply Hanning window
    const windowed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
      windowed[i] = (rawSlice[i] - mean) * w;
    }

    // 3. 32-bin Real DFT (0 Hz to 50 Hz Nyquist)
    const numBins = 32;
    const psd = new Float32Array(numBins);

    for (let k = 0; k < numBins; k++) {
      let real = 0;
      let imag = 0;
      const angleStep = (2 * Math.PI * k) / N;
      for (let n = 0; n < N; n++) {
        const angle = angleStep * n;
        real += windowed[n] * Math.cos(angle);
        imag -= windowed[n] * Math.sin(angle);
      }
      const power = real * real + imag * imag;
      // Convert to dB scale: log10(1 + power)
      psd[k] = Math.log10(1.0 + power);
    }
    return psd;
  }

  function getSeismicHeatmapColor(val) {
    // Clamped 0.0 to 1.0
    const v = Math.max(0, Math.min(1, val));
    let r = 0, g = 0, b = 0;

    if (v < 0.2) {
      // Midnight Navy to Deep Blue
      const t = v / 0.2;
      r = Math.floor(5 + 10 * t);
      g = Math.floor(10 + 35 * t);
      b = Math.floor(25 + 120 * t);
    } else if (v < 0.4) {
      // Deep Blue to Cyan / Teal
      const t = (v - 0.2) / 0.2;
      r = Math.floor(15 + 10 * t);
      g = Math.floor(45 + 150 * t);
      b = Math.floor(145 + 90 * t);
    } else if (v < 0.6) {
      // Cyan to Emerald / Yellow
      const t = (v - 0.4) / 0.2;
      r = Math.floor(25 + 210 * t);
      g = Math.floor(195 + 40 * t);
      b = Math.floor(235 * (1 - t));
    } else if (v < 0.8) {
      // Yellow to Vivid Orange / Red
      const t = (v - 0.6) / 0.2;
      r = Math.floor(235 + 20 * t);
      g = Math.floor(235 * (1 - t * 0.7));
      b = 0;
    } else {
      // Red to Hot White
      const t = (v - 0.8) / 0.2;
      r = 255;
      g = Math.floor(70 + 185 * t);
      b = Math.floor(255 * t);
    }
    return `rgb(${r},${g},${b})`;
  }

  function renderSpectrogram() {
    if (!specCanvas || state.activeTab !== 'spectrogram') return;

    const rect = specCanvas.getBoundingClientRect();
    if (specCanvas.width !== rect.width || specCanvas.height !== rect.height) {
      specCanvas.width = rect.width;
      specCanvas.height = rect.height;
      // Clear with dark background on resize
      specCtx.fillStyle = '#050814';
      specCtx.fillRect(0, 0, specCanvas.width, specCanvas.height);
    }

    const w = specCanvas.width;
    const h = specCanvas.height;
    const buf = state.buffers.EHZ;
    if (!buf || buf.length < 64) return;

    // Shift previous spectrogram image 2px to the left
    specCtx.drawImage(specCanvas, 2, 0, w - 2, h, 0, 0, w - 2, h);

    // Compute FFT power spectrum on latest 64 samples
    const slice = buf.slice(-64);
    const psd = computePowerSpectrum(slice);

    // Adaptively update noise floor and peak power
    let currentPeak = 0;
    let currentMin = 999;
    for (let k = 0; k < psd.length; k++) {
      if (psd[k] > currentPeak) currentPeak = psd[k];
      if (psd[k] < currentMin) currentMin = psd[k];
    }
    if (currentMin < 999) {
      specNoiseFloor = specNoiseFloor * 0.95 + currentMin * 0.05;
    }
    if (currentPeak > 0) {
      specMaxPower = Math.max(specMaxPower * 0.98 + currentPeak * 0.02, specNoiseFloor + 2.0);
    }

    const dynamicRange = Math.max(specMaxPower - specNoiseFloor, 1.5);

    // Render frequency column from 0 Hz (bottom) to 50 Hz (top)
    const numBins = psd.length;
    const binHeight = h / numBins;

    for (let b = 0; b < numBins; b++) {
      const power = psd[b];
      const normalized = (power - specNoiseFloor) / dynamicRange;
      const color = getSeismicHeatmapColor(normalized);

      // Invert Y so 0 Hz is at the bottom and 50 Hz is at the top
      const y = h - (b + 1) * binHeight;
      specCtx.fillStyle = color;
      specCtx.fillRect(w - 2, Math.floor(y), 2, Math.ceil(binHeight) + 1);
    }
  }

  // -------------------------------------------------------------------------
  // 24-Hour Helicorder Renderer
  // -------------------------------------------------------------------------
  const heliCanvas = elements.canvases.helicorder;
  const heliCtx = heliCanvas ? heliCanvas.getContext('2d') : null;

  function renderHelicorder() {
    if (!heliCanvas || state.activeTab !== 'helicorder') return;

    const rect = heliCanvas.getBoundingClientRect();
    if (heliCanvas.width !== rect.width || heliCanvas.height !== rect.height) {
      heliCanvas.width = rect.width;
      heliCanvas.height = rect.height;
    }

    const w = heliCanvas.width;
    const h = heliCanvas.height;
    const rows = 24;
    const rowHeight = h / rows;

    heliCtx.fillStyle = '#0a0e14';
    heliCtx.fillRect(0, 0, w, h);

    const now = new Date();
    const curHour = now.getUTCHours();
    const curMin = now.getUTCMinutes();
    const curSec = now.getUTCSeconds();
    const curFraction = (curMin * 60 + curSec) / 3600;

    for (let r = 0; r < rows; r++) {
      const y = r * rowHeight;
      const hour = (curHour - (rows - 1 - r) + 24) % 24;

      // Row background & separator
      heliCtx.strokeStyle = '#1e293b';
      heliCtx.lineWidth = 1;
      heliCtx.beginPath();
      heliCtx.moveTo(0, y + rowHeight);
      heliCtx.lineTo(w, y + rowHeight);
      heliCtx.stroke();

      // Timestamp margin
      heliCtx.fillStyle = '#64748b';
      heliCtx.font = '10px JetBrains Mono';
      heliCtx.fillText(`${String(hour).padStart(2, '0')}:00 UTC`, 8, y + rowHeight - 4);

      // Trace line
      heliCtx.strokeStyle = r % 2 === 0 ? '#38bdf8' : '#818cf8';
      heliCtx.lineWidth = 1.2;
      heliCtx.beginPath();
      heliCtx.moveTo(60, y + rowHeight / 2);

      const isCurrentRow = r === rows - 1;
      const endX = isCurrentRow ? 60 + curFraction * (w - 70) : w - 10;

      for (let x = 60; x < endX; x += 3) {
        // Draw baseline with slight ambient noise
        const noise = (Math.sin(x * 0.1 + r) * 2);
        heliCtx.lineTo(x, y + rowHeight / 2 + noise);
      }
      heliCtx.stroke();

      // Current moving record needle
      if (isCurrentRow) {
        heliCtx.fillStyle = '#ef4444';
        heliCtx.fillRect(endX - 2, y + 2, 4, rowHeight - 4);
      }
    }

    // Paint USGS Earthquake Markers on Helicorder
    state.usgsEvents.forEach((uEvt) => {
      const eTime = new Date((uEvt.time || 0) * 1000);
      const eMin = eTime.getUTCMinutes();
      const eSec = eTime.getUTCSeconds();
      const ageHours = (now.getTime() - eTime.getTime()) / (1000 * 3600);

      if (ageHours >= 0 && ageHours < 24) {
        const row = (rows - 1) - Math.floor(ageHours);
        if (row >= 0 && row < rows) {
          const y = row * rowHeight;
          const fraction = (eMin * 60 + eSec) / 3600;
          const x = 60 + fraction * (w - 70);

          heliCtx.fillStyle = '#f59e0b';
          heliCtx.beginPath();
          heliCtx.arc(x, y + rowHeight / 2, 3.5, 0, 2 * Math.PI);
          heliCtx.fill();

          heliCtx.fillStyle = '#fff';
          heliCtx.font = '8px JetBrains Mono';
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
  // 3D / 2D Hodogram Renderer
  // -------------------------------------------------------------------------
  function renderHodogram() {
    if (state.activeTab !== 'hodogram') return;

    const nBuf = state.buffers.ENN;
    const eBuf = state.buffers.ENE;
    const zBuf = state.buffers.ENZ;
    if (nBuf.length < 50) return;

    // Horizontal Plane: N vs E
    const hCanvas = elements.canvases.hodoH;
    if (hCanvas) {
      const rect = hCanvas.getBoundingClientRect();
      if (hCanvas.width !== rect.width || hCanvas.height !== rect.height) {
        hCanvas.width = rect.width;
        hCanvas.height = rect.height;
      }
      const ctx = hCanvas.getContext('2d');
      const w = hCanvas.width;
      const h = hCanvas.height;

      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(0, 0, w, h);

      // Axes
      ctx.strokeStyle = '#1e293b';
      ctx.beginPath();
      ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
      ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
      ctx.stroke();

      // Particle Trail
      const pts = Math.min(nBuf.length, 300);
      ctx.strokeStyle = '#ffaa00';
      ctx.lineWidth = 1.5;
      ctx.beginPath();

      const scale = 2000;
      for (let i = 0; i < pts; i++) {
        const idx = nBuf.length - pts + i;
        const x = w / 2 + (eBuf[idx] / scale) * (w / 2);
        const y = h / 2 - (nBuf[idx] / scale) * (h / 2);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
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

    if (tabName === 'ml') {
      fetchMlDataset();
    }
  });

  // -------------------------------------------------------------------------
  // Machine Learning Dataset & Annotation Handler
  // -------------------------------------------------------------------------
  async function fetchMlDataset() {
    try {
      const [sumRes, evRes] = await Promise.all([
        fetch('/api/ml/summary'),
        fetch('/api/ml/events?limit=50'),
      ]);
      const summary = await sumRes.json();
      const eventsData = await evRes.json();

      const countEl = document.getElementById('mlStatCount');
      const diskEl = document.getElementById('mlStatDisk');
      if (countEl) countEl.textContent = summary.total_annotated_events || 0;
      if (diskEl) diskEl.textContent = `${summary.disk_size_mb || 0} MB`;

      const tbody = document.getElementById('mlEventsTableBody');
      if (tbody && eventsData.events) {
        if (eventsData.events.length === 0) {
          tbody.innerHTML = '<tr><td colspan="9" class="text-muted text-center">No ground-truth events tagged yet. Click a quick tag above to record your first ML training snippet!</td></tr>';
          return;
        }

        tbody.innerHTML = '';
        eventsData.events.forEach((evt) => {
          const row = document.createElement('tr');
          const timeStr = new Date(evt.start_time * 1000).toISOString().substring(11, 23);
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
    } catch (err) {
      console.error('Failed to fetch ML dataset summary:', err);
    }
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
  // Startup
  // -------------------------------------------------------------------------
  connectWebSocket();
  requestAnimationFrame(mainLoop);
})();
