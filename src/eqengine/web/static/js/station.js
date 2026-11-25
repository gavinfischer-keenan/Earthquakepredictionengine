import { state } from './state.js';

const PICKER_LABELS = {
  heuristic: 'Z/H Polarization Heuristic',
  onnx: 'PhaseNet ONNX AI',
  seisbench: 'SeisBench PhaseNet AI',
};

export function formatCoords(lat, lon) {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${latDir}, ${Math.abs(lon).toFixed(4)}° ${lonDir}`;
}

export function applyPickerModeBadge(modeOrLabel) {
  const badge = document.getElementById('phasePickerModeBadge');
  if (!badge) return;
  const raw = String(modeOrLabel || 'heuristic');
  const label = PICKER_LABELS[raw.toLowerCase()] || raw;
  badge.textContent = label;
  badge.classList.toggle('picker-ai-active', raw.toLowerCase() !== 'heuristic' && !raw.toLowerCase().includes('heuristic'));
}

export function applyWitnessStatus(verdictPayload) {
  const badge = document.getElementById('witnessStatusBadge');
  if (!badge) return;
  if (!verdictPayload) {
    badge.textContent = `Witness: ${state.station.witness_station || 'BK.BKS'}`;
    badge.className = 'meta-badge witness-idle';
    return;
  }
  const v = verdictPayload.verdict || 'UNAVAILABLE';
  const ref = verdictPayload.witness_station || verdictPayload.reference_station || state.station.witness_station || 'BK.BKS';
  if (v === 'CONFIRMED_TECTONIC') {
    badge.textContent = `✓ ${ref} Confirmed`;
    badge.className = 'meta-badge witness-confirmed';
  } else if (v === 'LOCAL_ONLY') {
    badge.textContent = `⊘ ${ref} Local Only`;
    badge.className = 'meta-badge witness-local';
  } else {
    badge.textContent = `Witness: ${ref} (${v})`;
    badge.className = 'meta-badge witness-idle';
  }
}

export function applyStationIdentity(status) {
  if (!status || typeof status !== 'object') return;
  const srRaw = status.sampling_rate ?? status.sample_rate;
  state.station = {
    ...state.station,
    network: status.network || state.station.network,
    station: status.station || state.station.station,
    station_code: status.station_code || `${status.network || 'AM'}.${status.station || 'R1A3D'}`,
    station_name: status.station_name || state.station.station_name,
    station_lat: Number.isFinite(Number(status.station_lat)) ? Number(status.station_lat) : state.station.station_lat,
    station_lon: Number.isFinite(Number(status.station_lon)) ? Number(status.station_lon) : state.station.station_lon,
    sample_rate: Number.isFinite(Number(srRaw)) ? Number(srRaw) : state.station.sample_rate,
    ingest_mode: status.ingest_mode || state.station.ingest_mode,
    mqtt_connected: Boolean(status.mqtt_enabled ?? status.mqtt_connected),
    ml_enabled: Boolean(status.ml_enabled),
    ml_backend: status.picker_mode || status.ml_backend || 'heuristic',
    ml_label: status.picker_label || status.ml_label || 'Z/H Polarization Heuristic',
    witness_enabled: status.witness_enabled !== false,
    witness_station: status.witness_station || 'BK.BKS',
    public_mode: Boolean(status.public_mode),
    version: status.version || state.station.version,
  };

  const st = state.station;
  const codeEl = document.getElementById('stationCode');
  if (codeEl) codeEl.textContent = st.station_code;

  const ingestEl = document.getElementById('ingestMeta');
  if (ingestEl) {
    const modeTitle = st.ingest_mode === 'udp' ? 'UDP' : st.ingest_mode === 'mock' ? 'Simulated' : 'SeedLink';
    ingestEl.textContent = `${modeTitle} (${Math.round(st.sample_rate)} Hz)`;
  }

  const mqttEl = document.getElementById('mqttStatus');
  if (mqttEl) {
    if (st.mqtt_connected) {
      mqttEl.textContent = 'BROADCASTING';
      mqttEl.className = 'status-badge ok';
    } else {
      mqttEl.textContent = 'LOCAL ONLY';
      mqttEl.className = 'status-badge';
    }
  }

  const footerSrEl = document.getElementById('footerSampleRate');
  if (footerSrEl) footerSrEl.textContent = `${Math.round(st.sample_rate)} Hz`;

  const footerCoordsEl = document.getElementById('footerCoords');
  if (footerCoordsEl) {
    footerCoordsEl.textContent = `${formatCoords(st.station_lat, st.station_lon)} (${st.station_name})`;
  }

  const footerVerEl = document.getElementById('footerVersion');
  if (footerVerEl) footerVerEl.textContent = `v${st.version}`;

  if (st.station_code) {
    document.title = `${st.station_code} Seismic Observatory — ${st.station_name}`;
  }

  applyPickerModeBadge(st.ml_label || st.ml_backend);
  applyWitnessStatus(state.latestWitness);

  if (st.public_mode) {
    document.body.classList.add('public-mode');
  }
}

export async function loadStationIdentity() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return null;
    const data = await res.json();
    applyStationIdentity(data);
    return data;
  } catch (err) {
    console.warn('Failed to fetch /api/status:', err);
    return null;
  }
}
