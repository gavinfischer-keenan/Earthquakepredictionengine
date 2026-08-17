/**
 * Epicenter Radar View: Geospatial Leaflet Map, California Faults & Wavefront Rings
 */

import { state } from '../state.js';

let leafletMap = null;
let stationMarker = null;
let quakeMarkers = [];

export function initRadarMap() {
  if (leafletMap || typeof L === 'undefined') return;
  const mapEl = document.getElementById('radarMap');
  if (!mapEl) return;

  leafletMap = L.map('radarMap', {
    center: [37.8696, -122.2491],
    zoom: 10,
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
    html: '<div style="width:16px;height:16px;background:#00ff88;border:2px solid #fff;border-radius:50%;box-shadow:0 0 10px #00ff88;"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
  stationMarker = L.marker([37.8696, -122.2491], { icon: stationIcon }).addTo(leafletMap);
  stationMarker.bindPopup('<b>AM.R1A3D Berkeley Hills</b><br>Lat: 37.8696° N, Lon: -122.2491° W<br>Elev: ~240m | Hayward Fault Zone');

  // 1. Hayward Fault Trace (~400m West)
  const haywardCoords = [
    [37.45, -121.88], [37.54, -121.96], [37.64, -122.05], [37.73, -122.14],
    [37.81, -122.21], [37.87, -122.25], [37.93, -122.31], [38.01, -122.38]
  ];
  L.polyline(haywardCoords, { color: '#ef4444', weight: 3.5, opacity: 0.85, dashArray: '6, 6' })
    .addTo(leafletMap)
    .bindPopup('<b>Hayward Fault Zone</b><br>Active strike-slip fault ~400m West of station.');

  // 2. San Andreas Fault Trace
  const sanAndreasCoords = [
    [36.80, -121.55], [37.15, -121.90], [37.50, -122.25], [37.75, -122.50],
    [38.00, -122.80], [38.30, -123.05], [38.60, -123.35]
  ];
  L.polyline(sanAndreasCoords, { color: '#f59e0b', weight: 2.5, opacity: 0.75 })
    .addTo(leafletMap)
    .bindPopup('<b>San Andreas Fault</b><br>Major Pacific-North American plate boundary.');

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
}

export function updateRadarMap() {
  if (!leafletMap || typeof L === 'undefined') return;
  leafletMap.invalidateSize();

  quakeMarkers.forEach((m) => leafletMap.removeLayer(m));
  quakeMarkers = [];

  const now = Date.now() / 1000;

  state.usgsEvents.forEach((evt) => {
    if (!evt.latitude || !evt.longitude) return;

    const mag = evt.magnitude || 2.0;
    const radius = Math.max(mag * 3.5, 6);
    const color = mag >= 5.0 ? '#ef4444' : mag >= 3.0 ? '#f59e0b' : '#38bdf8';

    const circle = L.circleMarker([evt.latitude, evt.longitude], {
      radius: radius,
      color: color,
      fillColor: color,
      fillOpacity: 0.6,
      weight: 2,
    }).addTo(leafletMap);

    circle.bindPopup(`
      <b>M ${mag.toFixed(1)} Earthquake</b><br>
      ${evt.place || 'Regional'}<br>
      Distance: ${evt.distance_miles ? evt.distance_miles + ' mi' : (evt.distance_km ? evt.distance_km + ' km' : '--')}<br>
      Time: ${new Date((evt.time || now) * 1000).toISOString().substring(11, 19)} UTC
    `);
    quakeMarkers.push(circle);

    // If event is recent (< 90s), draw animated expanding P and S wavefront circles
    const elapsed = now - (evt.time || now);
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
}
