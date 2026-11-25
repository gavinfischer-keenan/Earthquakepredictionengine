import { setExternalEvents } from './dsp.js';

let _lastFetchMs = 0;
let _inFlight = null;
let _cachedPayload = null;
const CACHE_TTL_MS = 15000;

/**
 * Fetch external event snapshot (Cal Athletics, Greek Theatre, NWS Weather,
 * BART transit, and OpenSky/airplanes.live overhead aircraft) with a 15s TTL.
 */
export async function fetchExternalEvents(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedPayload && (now - _lastFetchMs) < CACHE_TTL_MS) {
    return _cachedPayload;
  }
  if (_inFlight && !forceRefresh) {
    return _inFlight;
  }

  const endpoint = forceRefresh ? '/api/external-events/refresh' : '/api/external-events';
  const options = forceRefresh ? { method: 'POST' } : { method: 'GET' };

  _inFlight = fetch(endpoint, options)
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      _cachedPayload = data;
      _lastFetchMs = Date.now();
      setExternalEvents(data);
      return data;
    })
    .catch((err) => {
      console.warn('External events fetch failed:', err);
      return _cachedPayload;
    })
    .finally(() => {
      _inFlight = null;
    });

  return _inFlight;
}

export function getCachedExternalEvents() {
  return _cachedPayload;
}
