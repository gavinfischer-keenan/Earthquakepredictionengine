/**
 * Epicenter Radar View: Geospatial Leaflet Map, California Faults & 48-Hour Regional Activity
 */

import { state } from '../state.js';

let leafletMap = null;
let stationMarker = null;
let quakeMarkers = [];
let elapsedTimer = null;

export function formatElapsedTime(timeSec) {
  const now = Date.now() / 1000;
  const elapsedSec = Math.max(0, now - timeSec);

  if (elapsedSec < 60) {
    return `${Math.round(elapsedSec)}s ago`;
  }
  const mins = Math.floor(elapsedSec / 60);
  if (mins < 60) {
    return `${mins} min${mins === 1 ? '' : 's'} ago`;
  }
  const hours = (elapsedSec / 3600).toFixed(1);
  if (elapsedSec < 86400) {
    return `${hours} hrs ago`;
  }
  const days = (elapsedSec / 86400).toFixed(1);
  return `${days} days ago (${hours} hrs ago)`;
}

export async function fetchRadarEvents() {
  try {
    const resp = await fetch('/api/usgs-events');
    if (!resp.ok) return;
    const data = await resp.json();
    const incomingEvents = data.events || [];

    // Merge without duplicates by ID
    const existingIds = new Set(state.usgsEvents.map((e) => e.id));
    incomingEvents.forEach((evt) => {
      if (evt && evt.id && !existingIds.has(evt.id)) {
        state.usgsEvents.push(evt);
        existingIds.add(evt.id);
      }
    });

    updateRadarMap();
  } catch (err) {
    console.error('Failed to fetch USGS radar events:', err);
  }
}

export function initRadarMap() {
  if (leafletMap || typeof L === 'undefined') return;
  const mapEl = document.getElementById('radarMap');
  if (!mapEl) return;

  leafletMap = L.map('radarMap', {
    center: [37.8696, -122.2491],
    zoom: 9,
    zoomControl: true,
  });

  // Dark Matter tiles
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CartoDB & USGS',
    maxZoom: 19,
    subdomains: 'abcd',
  }).addTo(leafletMap);

  // Berkeley Home Station Marker
  const stationIcon = L.divIcon({
    className: 'station-radar-marker',
    html: '<div style="width:18px;height:18px;background:#00ff88;border:2.5px solid #fff;border-radius:50%;box-shadow:0 0 14px #00ff88;"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
  stationMarker = L.marker([37.8696, -122.2491], { icon: stationIcon }).addTo(leafletMap);
  stationMarker.bindPopup(`
    <div style="font-family: 'JetBrains Mono', monospace; font-size: 11px;">
      <b style="color: #00ff88; font-size: 13px;">AM.R1A3D Berkeley Hills</b><br>
      <b>Lat/Lon:</b> 37.8696° N, 122.2491° W<br>
      <b>Elevation:</b> ~240m above sea level<br>
      <b>Fault:</b> Hayward Fault Zone (~400m West)<br>
      <span style="color: #38bdf8;">Listening to 48h regional seismic activity</span>
    </div>
  `);

  // 1. Hayward Fault Trace (~400m West)
  const haywardCoords = [
    [37.45, -121.88], [37.54, -121.96], [37.64, -122.05], [37.73, -122.14],
    [37.81, -122.21], [37.87, -122.25], [37.93, -122.31], [38.01, -122.38]
  ];
  L.polyline(haywardCoords, { color: '#ef4444', weight: 3.5, opacity: 0.85, dashArray: '6, 6' })
    .addTo(leafletMap)
    .bindPopup('<b>Hayward Fault Zone</b><br>Major active strike-slip fault ~400m West of station.');

  // 2. San Andreas Fault Trace
  const sanAndreasCoords = [
    [36.80, -121.55], [37.15, -121.90], [37.50, -122.25], [37.75, -122.50],
    [38.00, -122.80], [38.30, -123.05], [38.60, -123.35]
  ];
  L.polyline(sanAndreasCoords, { color: '#f59e0b', weight: 2.5, opacity: 0.75 })
    .addTo(leafletMap)
    .bindPopup('<b>San Andreas Fault</b><br>Major Pacific-North American tectonic plate boundary.');

  // 3. Calaveras Fault Trace
  const calaverasCoords = [
    [36.90, -121.35], [37.20, -121.65], [37.45, -121.85], [37.75, -121.97], [38.00, -122.10]
  ];
  L.polyline(calaverasCoords, { color: '#ea580c', weight: 2.0, opacity: 0.75 })
    .addTo(leafletMap)
    .bindPopup('<b>Calaveras Fault Zone</b>');

  // Radar distance range rings
  [16.09, 40.23, 80.47, 160.93, 402.33, 804.67].forEach((km, idx) => {
    const labels = ['10 mi', '25 mi', '50 mi', '100 mi', '250 mi', '500 mi'];
    L.circle([37.8696, -122.2491], {
      radius: km * 1000,
      color: '#1e293b',
      fill: false,
      weight: 1,
      dashArray: '4, 8',
    }).addTo(leafletMap).bindTooltip(`Radar Range: ${labels[idx]}`, { sticky: true });
  });

  // Start live elapsed count-up timer for any open popups
  if (!elapsedTimer) {
    elapsedTimer = setInterval(() => {
      document.querySelectorAll('.live-elapsed').forEach((el) => {
        const tSec = parseFloat(el.getAttribute('data-time'));
        if (tSec) el.textContent = formatElapsedTime(tSec);
      });
    }, 1000);
  }

  fetchRadarEvents();
}

export function updateRadarMap() {
  if (!leafletMap || typeof L === 'undefined') return;
  leafletMap.invalidateSize();

  quakeMarkers.forEach((m) => leafletMap.removeLayer(m));
  quakeMarkers = [];

  const now = Date.now() / 1000;
  const cutoff48h = now - 48 * 3600; // Strictly retain past 48 hours

  // Filter for valid coordinates, <= 500 miles, and within last 48 hours
  const active48hEvents = state.usgsEvents.filter((evt) => {
    if (!evt.latitude || !evt.longitude || !evt.time) return false;
    if (evt.time < cutoff48h) return false;
    const distMi = evt.distance_miles !== undefined ? evt.distance_miles : (evt.distance_km ? evt.distance_km * 0.621371 : 9999);
    return distMi <= 500.0;
  });

  let maxMag = 0;
  let closestDist = 9999;

  active48hEvents.forEach((evt) => {
    const mag = evt.magnitude !== undefined && evt.magnitude !== null ? evt.magnitude : 1.5;
    if (mag > maxMag) maxMag = mag;

    const distMi = evt.distance_miles !== undefined ? evt.distance_miles : (evt.distance_km ? evt.distance_km * 0.621371 : 0);
    if (distMi < closestDist) closestDist = distMi;

    const radius = Math.max(mag * 3.5, 5);
    const color = mag >= 5.0 ? '#ef4444' : mag >= 3.5 ? '#f97316' : mag >= 2.5 ? '#f59e0b' : '#38bdf8';

    const circle = L.circleMarker([evt.latitude, evt.longitude], {
      radius: radius,
      color: color,
      fillColor: color,
      fillOpacity: 0.65,
      weight: 2,
    }).addTo(leafletMap);

    const timeUtc = new Date(evt.time * 1000).toISOString().substring(11, 19);
    const elapsedStr = formatElapsedTime(evt.time);
    const depthStr = evt.depth_km !== undefined ? `${evt.depth_km.toFixed(1)} km` : '--';
    const distStr = `${distMi.toFixed(1)} mi (${(distMi * 1.60934).toFixed(1)} km)`;

    circle.bindPopup(`
      <div style="font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.5; min-width: 220px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; border-bottom: 1px solid #334155; padding-bottom: 4px;">
          <span style="font-weight: 700; color: ${color}; font-size: 13px;">M ${mag.toFixed(1)} Earthquake</span>
          <span style="color: #64748b; font-size: 9px;">USGS FEED</span>
        </div>
        <div style="font-weight: 600; color: #f8fafc; margin-bottom: 6px;">${evt.place || 'Regional Earthquake'}</div>
        <div style="color: #cbd5e1;"><b>Distance:</b> ${distStr}</div>
        <div style="color: #cbd5e1;"><b>Depth:</b> ${depthStr}</div>
        <div style="color: #cbd5e1;"><b>Origin Time:</b> ${timeUtc} UTC</div>
        <div style="color: #00ff88; margin-top: 3px; font-weight: 600; background: rgba(0,255,136,0.1); padding: 2px 4px; border-radius: 3px;">
          <b>Elapsed:</b> <span class="live-elapsed" data-time="${evt.time}">${elapsedStr}</span>
        </div>
        ${evt.url ? `<div style="margin-top: 6px;"><a href="${evt.url}" target="_blank" style="color: #38bdf8; text-decoration: underline; font-size: 10px;">USGS Event Page ↗</a></div>` : ''}
      </div>
    `);
    quakeMarkers.push(circle);

    // If event is very recent (< 90s), draw animated expanding P and S wavefront circles
    const elapsed = now - evt.time;
    if (elapsed > 0 && elapsed < 90) {
      // P-wave ring (6.0 km/s)
      const pRadiusM = elapsed * 6000;
      const pRing = L.circle([evt.latitude, evt.longitude], {
        radius: pRadiusM,
        color: '#00d2ff',
        fill: false,
        weight: 1.5,
        opacity: Math.max(0, 1.0 - elapsed / 90.0),
      }).addTo(leafletMap);
      quakeMarkers.push(pRing);

      // S-wave ring (3.5 km/s)
      const sRadiusM = elapsed * 3500;
      const sRing = L.circle([evt.latitude, evt.longitude], {
        radius: sRadiusM,
        color: '#ef4444',
        fill: false,
        weight: 2.0,
        opacity: Math.max(0, 1.0 - elapsed / 90.0),
      }).addTo(leafletMap);
      quakeMarkers.push(sRing);
    }
  });

  // -------------------------------------------------------------------------
  // Update Overlay HUD Stats & Normal Baseline Reference
  // -------------------------------------------------------------------------
  const count48h = active48hEvents.length;
  const countEl = document.getElementById('radarQuakeCount');
  if (countEl) countEl.textContent = `${count48h} Events`;

  const badgeEl = document.getElementById('radarActivityBadge');
  const weirdEl = document.getElementById('radarWeirdAlert');
  const maxMagEl = document.getElementById('radarMaxMag');
  const closestEl = document.getElementById('radarClosestQuake');

  if (maxMagEl) maxMagEl.textContent = maxMag > 0 ? `M ${maxMag.toFixed(1)}` : '--';
  if (closestEl) closestEl.textContent = closestDist < 9990 ? `${closestDist.toFixed(1)} mi` : '--';

  // Benchmark against California 500-mile normal baseline:
  // Normal 48h Count: 80 - 250 micro-quakes
  // Normal Max Magnitude: M 1.0 - M 3.2
  // Elevated: > 260 quakes or M 3.8+ or quake < 25 miles
  // Weird / Anomalous: > 400 quakes (swarm) or M 5.0+ or major Hayward fault trigger
  if (count48h > 400 || maxMag >= 5.0 || (closestDist < 15 && maxMag >= 3.5)) {
    if (badgeEl) {
      badgeEl.textContent = '⚡ WEIRD / SWARM';
      badgeEl.className = 'radar-status-badge badge-weird';
    }
    if (weirdEl) {
      weirdEl.textContent = 'High-rate swarm or moderate-to-strong shaking detected!';
      weirdEl.style.color = '#ef4444';
    }
  } else if (count48h > 260 || maxMag >= 3.5 || closestDist < 25) {
    if (badgeEl) {
      badgeEl.textContent = '🟡 ELEVATED';
      badgeEl.className = 'radar-status-badge badge-elevated';
    }
    if (weirdEl) {
      weirdEl.textContent = 'Moderately elevated regional activity or local cluster';
      weirdEl.style.color = '#f59e0b';
    }
  } else {
    if (badgeEl) {
      badgeEl.textContent = '🟢 NORMAL';
      badgeEl.className = 'radar-status-badge badge-normal';
    }
    if (weirdEl) {
      weirdEl.textContent = 'Seismicity within normal California background range';
      weirdEl.style.color = '#22c55e';
    }
  }
}
