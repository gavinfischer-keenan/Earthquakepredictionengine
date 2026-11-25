/**
 * Epicenter Radar View: Geospatial Leaflet Map, 500-Mile California Fault System,
 * Special Seismic Swarm/Geothermal Cluster Zones (with PR Photos & Hover Popups),
 * and Magnitude-Sized Earthquake Event Markers.
 */

import { state } from '../state.js';
import { CLUSTER_ZONES, getClusterZoneForEvent } from '../data/clusters.js';
import { HISTORIC_EARTHQUAKES } from '../data/historic_quakes.js';
import { FAULT_LINES } from '../data/faults.js';
import { formatCoords } from '../station.js';
import { openQuakeReplayModal } from './highlights.js';

export { CLUSTER_ZONES, HISTORIC_EARTHQUAKES, getClusterZoneForEvent };

let leafletMap = null;
let stationMarker = null;
let quakeMarkers = [];
let historicMarkers = [];
let elapsedTimer = null;
let clusterPolygons = [];
let userExpandedOnNarrow = false;

// ===========================================================================
// California Special Seismic Cluster / Geothermal / Volcanic Zones
// ===========================================================================
function generateStarburstPath(cx, cy, outerR, innerR, points) {
  let path = '';
  const step = Math.PI / points;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = i * step - Math.PI / 2;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    path += (i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  path += ' Z';
  return path;
}

export function createStarburstIcon(mag) {
  if (typeof L === 'undefined') return null;
  // Size by magnitude: M5.6 -> 28px, M6.0 -> 32px, M6.9 -> 40px, M7.9 -> 50px
  const size = Math.round(28 + Math.max(0, mag - 5.5) * 9);
  const half = size / 2;
  const magId = mag.toFixed(1).replace('.', '_');

  const svg = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" class="historic-starburst-svg">
      <defs>
        <radialGradient id="starGrad-${magId}-${Math.round(half)}" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#ffffff" />
          <stop offset="25%" stop-color="#fbbf24" />
          <stop offset="65%" stop-color="#ef4444" />
          <stop offset="100%" stop-color="#7f1d1d" stop-opacity="0.95" />
        </radialGradient>
      </defs>
      <!-- Radiant glow backdrop -->
      <circle cx="${half}" cy="${half}" r="${half * 0.95}" fill="rgba(245, 158, 11, 0.35)" />
      <!-- 12-point radiant starburst -->
      <path d="${generateStarburstPath(half, half, half * 0.95, half * 0.44, 12)}"
            fill="url(#starGrad-${magId}-${Math.round(half)})"
            stroke="#ffffff"
            stroke-width="1.4" />
      <circle cx="${half}" cy="${half}" r="${half * 0.36}" fill="#ffffff" stroke="#991b1b" stroke-width="1" />
      <text x="${half}" y="${half + 3.2}" font-family="'JetBrains Mono', monospace" font-size="${Math.max(7.5, size * 0.23)}px" font-weight="900" fill="#991b1b" text-anchor="middle">M${mag.toFixed(1)}</text>
    </svg>
  `;

  return L.divIcon({
    html: svg,
    className: 'historic-starburst-marker',
    iconSize: [size, size],
    iconAnchor: [half, half],
    popupAnchor: [0, -half],
  });
}

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
  return `${days} days ago`;
}

const RADAR_CACHE_KEY = 'eqengine_radar_usgs_events_v2';

export async function fetchRadarEvents() {
  try {
    // Fetch directly from local engine API cache (no external third-party requests)
    const resp = await fetch('/api/usgs-events');
    if (resp.ok) {
      const data = await resp.json();
      const incomingEvents = data.events || [];
      if (incomingEvents.length > 0) {
        const existingIds = new Set(state.usgsEvents.map((e) => e.id));
        incomingEvents.forEach((evt) => {
          if (evt && evt.id && !existingIds.has(evt.id)) {
            state.usgsEvents.push(evt);
            existingIds.add(evt.id);
          }
        });
        // Cache to browser localStorage
        try {
          localStorage.setItem(RADAR_CACHE_KEY, JSON.stringify(state.usgsEvents.slice(-500)));
        } catch (e) {}
      }
    }
  } catch (err) {
    console.warn('Local USGS API sync:', err);
  } finally {
    updateRadarMap();
  }
}

export function initRadarMap() {
  if (leafletMap || typeof L === 'undefined') return;
  const mapEl = document.getElementById('radarMap');
  if (!mapEl) return;

  // 0. Load cached events from localStorage immediately for 0ms startup
  try {
    const cached = localStorage.getItem(RADAR_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const existingIds = new Set(state.usgsEvents.map((e) => e.id));
        parsed.forEach((evt) => {
          if (evt && evt.id && !existingIds.has(evt.id)) {
            state.usgsEvents.push(evt);
            existingIds.add(evt.id);
          }
        });
      }
    }
  } catch (e) {}

  // 1. Dark Gray Observatory Basemap (Esri World Dark Gray Canvas — no API key watermark)
  const darkMatterLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    maxZoom: 16,
  });

  // 2. High-Resolution Satellite Imagery (ESRI World Imagery)
  const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    maxZoom: 19,
  });

  // 3. Topographical Relief Map (OpenTopoMap / SRTM)
  const topoLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)',
    maxZoom: 17,
  });

  // 4. OpenStreetMap Standard (OSM Streets)
  const osmStreetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  });

  const st = state.station || {};
  const stLat = Number.isFinite(Number(st.station_lat)) ? Number(st.station_lat) : 37.8696;
  const stLon = Number.isFinite(Number(st.station_lon)) ? Number(st.station_lon) : -122.2491;
  const stCode = st.station_code || 'AM.R1A3D';
  const stName = st.station_name || 'Berkeley Hills';

  leafletMap = L.map('radarMap', {
    center: [stLat, stLon],
    zoom: 7,
    minZoom: 3,
    maxZoom: 18,
    layers: [darkMatterLayer],
    zoomControl: true,
  });

  // Base map layers
  const allBaseLayers = {
    dark: darkMatterLayer,
    satellite: satelliteLayer,
    topo: topoLayer,
    osm: osmStreetLayer,
  };

  function switchBaseLayer(layerKey) {
    Object.values(allBaseLayers).forEach((layer) => {
      if (leafletMap.hasLayer(layer)) leafletMap.removeLayer(layer);
    });
    if (allBaseLayers[layerKey]) {
      leafletMap.addLayer(allBaseLayers[layerKey]);
      allBaseLayers[layerKey].bringToBack();
    }
    document.querySelectorAll('.basemap-pill').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-layer') === layerKey);
    });
  }

  // Bind floating basemap switcher buttons
  ['btnBasemapDark', 'btnBasemapSatellite', 'btnBasemapTopo', 'btnBasemapOsm'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-layer');
        if (key) switchBaseLayer(key);
      });
    }
  });

  // Home Station Marker
  const stationIcon = L.divIcon({
    className: 'station-radar-marker',
    html: '<div style="width:18px;height:18px;background:#00ff88;border:2.5px solid #fff;border-radius:50%;box-shadow:0 0 16px #00ff88;cursor:pointer;"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
  stationMarker = L.marker([stLat, stLon], { icon: stationIcon }).addTo(leafletMap);
  stationMarker.bindPopup(`
    <div style="font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.5; min-width: 220px;">
      <b style="color: #00ff88; font-size: 13px;">🏠 ${stCode} ${stName}</b><br>
      <b>Coordinates:</b> ${formatCoords(stLat, stLon)}<br>
      <b>Witness Ref:</b> ${st.witness_station || 'BK.BKS'}<br>
      <span style="color: #38bdf8;">Listening to 700-mile regional seismicity</span>
    </div>
  `);

  leafletMap.on('popupopen', (e) => {
    const popupEl = e.popup && e.popup.getElement();
    if (!popupEl) return;
    const btn = popupEl.querySelector('.btn-quake-replay');
    if (btn) {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const originTime = parseFloat(btn.getAttribute('data-origin-time'));
        const distanceKm = parseFloat(btn.getAttribute('data-dist-km'));
        const magVal = parseFloat(btn.getAttribute('data-mag'));
        const placeVal = btn.getAttribute('data-place') || '';
        openQuakeReplayModal({
          time: originTime,
          distance_km: distanceKm,
          magnitude: magVal,
          place: placeVal,
        });
      });
    }
  });

  // =========================================================================
  // 700-Mile Western North America Fault System Mapping
  // =========================================================================

  FAULT_LINES.forEach((fault) => {
    L.polyline(fault.coords, fault.style).addTo(leafletMap).bindPopup(fault.popup);
  });

  // =========================================================================
  // California & Regional Swarm / Geothermal / Volcanic Cluster Overlays
  // =========================================================================
  clusterPolygons.forEach((p) => leafletMap.removeLayer(p));
  clusterPolygons = [];

  CLUSTER_ZONES.forEach((zone) => {
    const poly = L.polygon(zone.coords, {
      color: zone.color,
      weight: 2.0,
      dashArray: '5, 5',
      fillColor: zone.color,
      fillOpacity: 0.16,
    }).addTo(leafletMap);

    const popupHtml = `
      <div style="font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.5; max-width: 290px; color: #f8fafc;">
        ${zone.image ? `
          <div style="margin: -8px -8px 8px -8px; overflow: hidden; border-radius: 6px 6px 0 0;">
            <img src="${zone.image}" alt="${zone.name}" style="width: 100%; height: 130px; object-fit: cover; display: block;" />
          </div>
        ` : ''}
        <div style="font-size: 12px; font-weight: 700; color: ${zone.color}; margin-bottom: 2px;">${zone.name}</div>
        <div style="color: #94a3b8; font-size: 10px; margin-bottom: 6px;">📍 ${zone.location}</div>
        <div style="margin-bottom: 4px;"><b style="color: #38bdf8;">WHAT IS THERE:</b> ${zone.whatIsThere}</div>
        <div style="margin-bottom: 6px;"><b style="color: #f59e0b;">WHY IT SWARMS:</b> ${zone.whyItSwarms}</div>
        <div style="color: ${zone.statusColor || '#10b981'}; font-size: 9.5px; font-weight: 600; background: rgba(255,255,255,0.06); padding: 3px 6px; border-radius: 3px; border: 1px solid ${zone.color}40;">
          ${zone.statusBadge}
        </div>
      </div>
    `;

    poly.bindPopup(popupHtml, { maxWidth: 310, className: 'cluster-zone-popup' });

    // Interactive Hover & Click Behaviors
    poly.on('mouseover', function (e) {
      this.setStyle({ fillOpacity: 0.35, weight: 3 });
      this.openPopup(e.latlng);
    });

    poly.on('mouseout', function () {
      this.setStyle({ fillOpacity: 0.16, weight: 2 });
    });

    clusterPolygons.push(poly);
  });

  const ringLat = Number.isFinite(Number(state.station?.station_lat)) ? Number(state.station.station_lat) : 37.8696;
  const ringLon = Number.isFinite(Number(state.station?.station_lon)) ? Number(state.station.station_lon) : -122.2491;

  // Radar range rings (10, 25, 50, 100, 250, 500, 700 miles)
  [16.09, 40.23, 80.47, 160.93, 402.33, 804.67, 1126.54].forEach((km, idx) => {
    const labels = ['10 mi', '25 mi', '50 mi', '100 mi', '250 mi', '500 mi', '700 mi'];
    L.circle([ringLat, ringLon], {
      radius: km * 1000,
      color: '#1e293b',
      fill: false,
      weight: 1,
      dashArray: '4, 8',
    }).addTo(leafletMap).bindTooltip(`Radar Range: ${labels[idx]}`, { sticky: true });
  });

  // Start live elapsed timer
  if (!elapsedTimer) {
    elapsedTimer = setInterval(() => {
      document.querySelectorAll('.live-elapsed').forEach((el) => {
        const tSec = parseFloat(el.getAttribute('data-time'));
        if (tSec) el.textContent = formatElapsedTime(tSec);
      });
    }, 1000);
  }

  // Ensure drawer starts collapsed on narrower viewports (<= 1100px) unless expanded manually
  const drawerEl = document.getElementById('radarEventsDrawer');
  if (drawerEl && window.innerWidth <= 1100 && !userExpandedOnNarrow) {
    drawerEl.classList.add('collapsed');
  }

  updateRadarMap();
  fetchRadarEvents();
}

export function updateRadarMap() {
  if (!leafletMap || typeof L === 'undefined') return;
  const drawerEl = document.getElementById('radarEventsDrawer');
  if (drawerEl && window.innerWidth <= 1100 && !userExpandedOnNarrow) {
    drawerEl.classList.add('collapsed');
  }
  leafletMap.invalidateSize();

  quakeMarkers.forEach((m) => leafletMap.removeLayer(m));
  quakeMarkers = [];

  const now = Date.now() / 1000;
  const cutoff48h = now - 48 * 3600; // Past 48 hours

  const active48hEvents = state.usgsEvents.filter((evt) => {
    if (!evt.latitude || !evt.longitude || !evt.time) return false;
    if (evt.time < cutoff48h) return false;
    const distMi = evt.distance_miles !== undefined ? evt.distance_miles : (evt.distance_km ? evt.distance_km * 0.621371 : 9999);
    return distMi <= 700.0;
  });

  let maxMag = 0;
  let closestDist = 9999;
  let geysersCount = 0;

  active48hEvents.forEach((evt) => {
    const mag = evt.magnitude !== undefined && evt.magnitude !== null ? evt.magnitude : 1.2;
    if (mag > maxMag) maxMag = mag;

    const distMi = evt.distance_miles !== undefined ? evt.distance_miles : (evt.distance_km ? evt.distance_km * 0.621371 : 0);
    if (distMi < closestDist) closestDist = distMi;

    const matchedZone = getClusterZoneForEvent(evt.latitude, evt.longitude);
    if (matchedZone && matchedZone.id === 'geysers') geysersCount++;

    // Sized by magnitude (Raspberry Shake StationView style)
    let radius = 3.5;
    if (mag >= 4.5) radius = 16.0;
    else if (mag >= 3.5) radius = 12.0;
    else if (mag >= 2.5) radius = 8.5;
    else if (mag >= 1.5) radius = 5.5;
    else radius = 3.5;

    // Standardized Geophysical Magnitude Coloring:
    // 🔵 Sky Blue: Microseism (M < 1.5 - Unfelt / Ambient)
    // 🟡 Gold/Amber: Minor (M 1.5 - 2.4 - Light motion)
    // 🟠 Orange: Moderate (M 2.5 - 3.9 - Noticeable shaking)
    // 🔴 Red: Strong (M >= 4.0 - Significant shaking / Warning)
    let color = '#38bdf8'; // Blue (<1.5)
    let magCategory = 'Microseism (Unfelt)';
    if (mag >= 4.0) {
      color = '#ef4444'; // Red
      magCategory = 'Strong Quake (Widely Felt)';
    } else if (mag >= 2.5) {
      color = '#f97316'; // Orange
      magCategory = 'Light Quake (Noticeable)';
    } else if (mag >= 1.5) {
      color = '#eab308'; // Gold
      magCategory = 'Minor Quake (Sensors)';
    }

    const circle = L.circleMarker([evt.latitude, evt.longitude], {
      radius: radius,
      color: matchedZone ? matchedZone.color : color,
      fillColor: color,
      fillOpacity: matchedZone ? 0.6 : 0.8,
      weight: matchedZone ? 2.0 : 1.8,
    }).addTo(leafletMap);

    const timeUtc = new Date(evt.time * 1000).toISOString().substring(11, 19);
    const elapsedStr = formatElapsedTime(evt.time);
    const depthStr = evt.depth_km !== undefined ? `${evt.depth_km.toFixed(1)} km` : '--';
    const distStr = `${distMi.toFixed(1)} mi (${(distMi * 1.60934).toFixed(1)} km)`;

    const stLabel = state.station?.station_name || 'Station';
    const distKmVal = evt.distance_km != null ? evt.distance_km : distMi * 1.60934;
    const safePlace = String(evt.place || 'Regional Seismic Event').replace(/"/g, '&quot;');

    circle.bindPopup(`
      <div style="font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.5; min-width: 240px; color: #f8fafc;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; border-bottom: 1px solid #334155; padding-bottom: 4px;">
          <span style="font-weight: 700; color: ${color}; font-size: 13px;">M ${mag.toFixed(1)} Earthquake</span>
          <span style="color: #64748b; font-size: 9px;">USGS FEED</span>
        </div>
        <div style="font-weight: 600; color: #f8fafc; margin-bottom: 6px;">${evt.place || 'Regional Seismic Event'}</div>
        <div style="color: #cbd5e1;"><b>Classification:</b> <span style="color: ${color}; font-weight: 600;">${magCategory}</span></div>
        <div style="color: #cbd5e1;"><b>Distance:</b> ${distStr} from ${stLabel}</div>
        <div style="color: #cbd5e1;"><b>Depth:</b> ${depthStr}</div>
        <div style="color: #cbd5e1;"><b>Origin Time:</b> ${timeUtc} UTC</div>
        <div style="color: #00ff88; margin-top: 4px; font-weight: 600; background: rgba(0,255,136,0.1); padding: 2px 4px; border-radius: 3px;">
          <b>Elapsed:</b> <span class="live-elapsed" data-time="${evt.time}">${elapsedStr}</span>
        </div>
        ${matchedZone ? `
          <div style="color: ${matchedZone.color}; margin-top: 5px; font-size: 9.5px; background: rgba(255,255,255,0.06); padding: 4px 6px; border-radius: 3px; border: 1px solid ${matchedZone.color}40;">
            <b>${matchedZone.name}:</b> Localized swarm activity (normal background).
          </div>
        ` : ''}
        <div style="margin-top: 7px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
          <button type="button" class="btn-quake-replay" data-origin-time="${evt.time}" data-dist-km="${distKmVal.toFixed(2)}" data-mag="${mag.toFixed(2)}" data-place="${safePlace}">🔍 Did My Sensor See This?</button>
          ${evt.url ? `<a href="${evt.url}" target="_blank" style="color: #38bdf8; text-decoration: underline; font-size: 10px;">USGS ↗</a>` : ''}
        </div>
      </div>
    `);
    quakeMarkers.push(circle);

    // If event is very recent (< 90s), draw animated expanding P and S wavefront circles
    const elapsed = now - evt.time;
    if (elapsed > 0 && elapsed < 90) {
      const pRadiusM = elapsed * 6000;
      const pRing = L.circle([evt.latitude, evt.longitude], {
        radius: pRadiusM,
        color: '#00d2ff',
        fill: false,
        weight: 1.5,
        opacity: Math.max(0, 1.0 - elapsed / 90.0),
      }).addTo(leafletMap);
      quakeMarkers.push(pRing);

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
  // Render Major Historic California Epicenters (M >= 6.0) Starbursts
  // -------------------------------------------------------------------------
  historicMarkers.forEach((m) => leafletMap.removeLayer(m));
  historicMarkers = [];

  const historicCheckbox = document.getElementById('radarHistoricCheckbox');
  const showHistoric = historicCheckbox ? historicCheckbox.checked : true;

  if (showHistoric) {
    HISTORIC_EARTHQUAKES.forEach((quake) => {
      const starIcon = createStarburstIcon(quake.magnitude);
      const marker = L.marker(quake.coords, {
        icon: starIcon,
        zIndexOffset: 500,
      }).addTo(leafletMap);

      const popupHtml = `
        <div style="font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.5; min-width: 270px; max-width: 320px; color: #f8fafc;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; border-bottom: 1px solid rgba(245, 158, 11, 0.4); padding-bottom: 4px;">
            <span style="font-weight: 800; color: #fbbf24; font-size: 13px;">⭐ HISTORIC M ${quake.magnitude.toFixed(1)}</span>
            <span style="color: #ef4444; font-weight: 700; font-size: 10px;">${quake.year}</span>
          </div>
          <div style="font-weight: 700; color: #ffffff; font-size: 12px; margin-bottom: 4px;">${quake.name}</div>
          <div style="color: #cbd5e1; margin-bottom: 2px;">📅 <b>Date & Time:</b> ${quake.date}</div>
          <div style="color: #38bdf8; margin-bottom: 2px;">⚡ <b>Fault Rupture:</b> ${quake.fault}</div>
          <div style="color: #cbd5e1; margin-bottom: 2px;">📍 <b>Distance to ${state.station?.station_name || 'Station'}:</b> ${quake.distanceMiles.toFixed(1)} miles</div>
          <div style="color: #ef4444; margin-bottom: 4px;">💥 <b>Intensity:</b> ${quake.shakingIntensity} (Depth ${quake.depthKm.toFixed(1)} km)</div>
          <div style="font-size: 10px; color: #94a3b8; background: rgba(255,255,255,0.06); padding: 5px 7px; border-radius: 4px; border-left: 2px solid #fbbf24; margin-top: 4px;">
            ${quake.summary}
          </div>
        </div>
      `;

      marker.bindPopup(popupHtml, { maxWidth: 330, className: 'historic-quake-popup' });
      historicMarkers.push(marker);
    });
  }

  // -------------------------------------------------------------------------
  // Update Overlay HUD Stats & Regional Benchmarks
  // -------------------------------------------------------------------------
  const countEl = document.getElementById('radarQuakeCount');
  if (countEl) {
    countEl.textContent = `${active48hEvents.length} Events (48h)`;
  }

  const maxMagEl = document.getElementById('radarMaxMag');
  if (maxMagEl) {
    maxMagEl.textContent = maxMag > 0 ? `M ${maxMag.toFixed(1)}` : '--';
    maxMagEl.style.color = maxMag >= 4.0 ? '#ef4444' : maxMag >= 2.5 ? '#f97316' : '#38bdf8';
  }

  const closestEl = document.getElementById('radarClosestQuake');
  if (closestEl) {
    closestEl.textContent = closestDist < 9999 ? `${closestDist.toFixed(1)} mi` : '--';
  }

  const badgeEl = document.getElementById('radarActivityBadge');
  const alertEl = document.getElementById('radarWeirdAlert');
  const totalCount = active48hEvents.length;

  if (badgeEl && alertEl) {
    if (totalCount > 350 || maxMag >= 4.5 || closestDist <= 15.0) {
      badgeEl.textContent = '⚡ ANOMALOUS (WEIRD)';
      badgeEl.className = 'radar-status-badge badge-anomalous';
      alertEl.style.color = '#ef4444';
      alertEl.textContent = `High seismic energy detected! (${totalCount} events, Max M${maxMag.toFixed(1)})`;
    } else if (totalCount > 250 || maxMag >= 3.5 || closestDist <= 30.0) {
      badgeEl.textContent = '🟡 ELEVATED';
      badgeEl.className = 'radar-status-badge badge-elevated';
      alertEl.style.color = '#f59e0b';
      alertEl.textContent = `Elevated regional activity (${totalCount} events in 48h)`;
    } else {
      badgeEl.textContent = '🟢 NORMAL';
      badgeEl.className = 'radar-status-badge badge-normal';
      alertEl.style.color = '#22c55e';
      alertEl.textContent = `Seismicity within normal California background range (${geysersCount} in The Geysers)`;
    }
  }

  // -------------------------------------------------------------------------
  // Render Left-Side Dynamic Events Drawer List
  // -------------------------------------------------------------------------
  lastActive48hEvents = active48hEvents;
  renderRadarEventsList(active48hEvents);
}

let lastActive48hEvents = [];
let isDrawerListenersInit = false;
let currentDrawerFilter = 'all';

export function initRadarDrawerListeners() {
  if (isDrawerListenersInit) return;
  const sortSelect = document.getElementById('radarSortSelect');
  const searchInput = document.getElementById('radarSearchInput');
  const collapseBtn = document.getElementById('radarDrawerCollapseBtn');
  const expandBtn = document.getElementById('radarDrawerExpandBtn');
  const drawerEl = document.getElementById('radarEventsDrawer');
  const historicCheckbox = document.getElementById('radarHistoricCheckbox');

  // Auto-collapse drawer on <= 1100px viewports so map & right HUD never collide
  if (drawerEl && window.innerWidth <= 1100 && !userExpandedOnNarrow) {
    drawerEl.classList.add('collapsed');
  }

  // Filter Tabs: All Events, Recent 48h, Historic Giants
  ['radarTabAll', 'radarTabRecent', 'radarTabHistoric'].forEach((tabId) => {
    const tabBtn = document.getElementById(tabId);
    if (tabBtn) {
      tabBtn.addEventListener('click', () => {
        document.querySelectorAll('.drawer-tab').forEach((el) => el.classList.remove('active'));
        tabBtn.classList.add('active');
        currentDrawerFilter = tabBtn.getAttribute('data-filter') || 'all';
        renderRadarEventsList(lastActive48hEvents);
      });
    }
  });

  if (collapseBtn && drawerEl) {
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      userExpandedOnNarrow = false;
      drawerEl.classList.add('collapsed');
    });
  }

  if (expandBtn && drawerEl) {
    expandBtn.addEventListener('click', () => {
      if (window.innerWidth <= 1100) userExpandedOnNarrow = true;
      drawerEl.classList.remove('collapsed');
    });
  }

  const collapsedBarEl = drawerEl?.querySelector('.drawer-collapsed-bar');
  if (collapsedBarEl && collapsedBarEl !== expandBtn && drawerEl) {
    collapsedBarEl.addEventListener('click', () => {
      if (window.innerWidth <= 1100) userExpandedOnNarrow = true;
      drawerEl.classList.remove('collapsed');
    });
  }

  window.addEventListener('resize', () => {
    if (!drawerEl) return;
    if (window.innerWidth > 1100) {
      userExpandedOnNarrow = false;
    } else if (!userExpandedOnNarrow) {
      drawerEl.classList.add('collapsed');
    }
  });

  if (historicCheckbox) {
    historicCheckbox.addEventListener('change', () => {
      updateRadarMap();
    });
  }

  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      renderRadarEventsList(lastActive48hEvents);
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderRadarEventsList(lastActive48hEvents);
    });
  }

  isDrawerListenersInit = true;
}

export function renderRadarEventsList(events) {
  initRadarDrawerListeners();

  const listEl = document.getElementById('radarEventsList');
  const countBadge = document.getElementById('radarDrawerCount');
  if (!listEl) return;

  const historicCheckbox = document.getElementById('radarHistoricCheckbox');
  const showHistoric = historicCheckbox ? historicCheckbox.checked : true;

  let combined = events ? events.slice() : [];

  if (showHistoric) {
    const histEvents = HISTORIC_EARTHQUAKES.map((hq) => ({
      id: hq.id,
      place: hq.name,
      magnitude: hq.magnitude,
      latitude: hq.coords[0],
      longitude: hq.coords[1],
      distance_miles: hq.distanceMiles,
      depth_km: hq.depthKm,
      time: new Date(hq.date).getTime() / 1000 || 0,
      isHistoric: true,
      year: hq.year,
      fault: hq.fault,
      rawDate: hq.date,
      summary: hq.summary,
      shakingIntensity: hq.shakingIntensity,
    }));
    combined = combined.concat(histEvents);
  }

  // Filter by drawer tab (all / recent / historic)
  if (currentDrawerFilter === 'recent') {
    combined = combined.filter((e) => !e.isHistoric);
  } else if (currentDrawerFilter === 'historic') {
    combined = combined.filter((e) => e.isHistoric);
  }

  if (combined.length === 0) {
    listEl.innerHTML = '<div class="drawer-empty">No regional seismic events found for this filter.</div>';
    if (countBadge) countBadge.textContent = '0 events';
    return;
  }

  const sortSelect = document.getElementById('radarSortSelect');
  const sortMode = sortSelect ? sortSelect.value : 'time';

  const searchInput = document.getElementById('radarSearchInput');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

  // Filter events by query if specified
  let filtered = combined.slice();
  if (query) {
    filtered = filtered.filter((evt) => {
      const place = (evt.place || '').toLowerCase();
      const fault = (evt.fault || '').toLowerCase();
      const zone = !evt.isHistoric ? getClusterZoneForEvent(evt.latitude, evt.longitude) : null;
      const zoneName = zone ? zone.name.toLowerCase() : '';
      return place.includes(query) || fault.includes(query) || zoneName.includes(query);
    });
  }

  // Sort events
  filtered.sort((a, b) => {
    const magA = a.magnitude !== undefined && a.magnitude !== null ? a.magnitude : 1.2;
    const magB = b.magnitude !== undefined && b.magnitude !== null ? b.magnitude : 1.2;

    const distA = a.distance_miles !== undefined ? a.distance_miles : (a.distance_km ? a.distance_km * 0.621371 : 9999);
    const distB = b.distance_miles !== undefined ? b.distance_miles : (b.distance_km ? b.distance_km * 0.621371 : 9999);

    if (sortMode === 'historic') {
      // Historic giants first (sorted by magnitude), then live events
      if (a.isHistoric && !b.isHistoric) return -1;
      if (!a.isHistoric && b.isHistoric) return 1;
      if (a.isHistoric && b.isHistoric) return magB - magA;
      return (b.time || 0) - (a.time || 0);
    } else if (sortMode === 'mag') {
      return magB - magA; // Largest first across both live & historic!
    } else if (sortMode === 'dist') {
      return distA - distB; // Closest to Berkeley station first
    }
    // Default: 'time' (Most recent live events first, then historic ordered by year)
    if (!a.isHistoric && b.isHistoric) return -1;
    if (a.isHistoric && !b.isHistoric) return 1;
    if (a.isHistoric && b.isHistoric) return (b.year || 0) - (a.year || 0);
    return (b.time || 0) - (a.time || 0);
  });

  if (countBadge) {
    countBadge.textContent = `${filtered.length} events`;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="drawer-empty">No events match "${query}".</div>`;
    return;
  }

  // Build event cards
  const html = filtered.map((evt) => {
    const mag = evt.magnitude !== undefined && evt.magnitude !== null ? evt.magnitude : 1.2;
    const distMi = evt.distance_miles !== undefined ? evt.distance_miles : (evt.distance_km ? evt.distance_km * 0.621371 : 0);
    const depthStr = evt.depth_km !== undefined ? `${evt.depth_km.toFixed(1)} km` : '--';
    const placeStr = evt.place || 'California Regional Event';

    if (evt.isHistoric) {
      return `
        <div class="radar-event-item" data-lat="${evt.latitude}" data-lng="${evt.longitude}" data-historic="true">
          <div class="event-mag-badge mag-historic">
            <span class="event-mag-num">M${mag.toFixed(1)}</span>
            <span class="event-mag-tag">⭐ ${evt.year}</span>
          </div>
          <div class="event-info-col">
            <div class="event-place" title="${placeStr}" style="color: #fbbf24; font-weight: 700;">⭐ ${placeStr}</div>
            <div class="event-meta-row">
              <span class="event-dist">📍 ${distMi.toFixed(1)} mi · ${depthStr}</span>
              <span class="event-time" style="color: #f59e0b;"><b>${evt.year} Epicenter</b></span>
            </div>
            <div class="event-zone-tag" style="background: rgba(245, 158, 11, 0.15); color: #fbbf24; border-color: rgba(245, 158, 11, 0.4);">
              ⚡ ${evt.fault ? evt.fault.split('(')[0] : 'Major Fault Rupture'}
            </div>
          </div>
        </div>
      `;
    }

    const timeUtc = new Date(evt.time * 1000).toISOString().substring(11, 19);
    const elapsedStr = formatElapsedTime(evt.time);

    let badgeClass = 'mag-micro';
    let tagLabel = 'MICRO';
    if (mag >= 4.0) {
      badgeClass = 'mag-strong';
      tagLabel = 'STRONG';
    } else if (mag >= 2.5) {
      badgeClass = 'mag-moderate';
      tagLabel = 'LIGHT';
    } else if (mag >= 1.5) {
      badgeClass = 'mag-minor';
      tagLabel = 'MINOR';
    }

    const matchedZone = getClusterZoneForEvent(evt.latitude, evt.longitude);
    const distKmItem = evt.distance_km != null ? evt.distance_km : distMi * 1.60934;
    const safePlaceItem = String(placeStr).replace(/"/g, '&quot;');

    return `
      <div class="radar-event-item" data-lat="${evt.latitude}" data-lng="${evt.longitude}" data-time="${evt.time}">
        <div class="event-mag-badge ${badgeClass}">
          <span class="event-mag-num">M${mag.toFixed(1)}</span>
          <span class="event-mag-tag">${tagLabel}</span>
        </div>
        <div class="event-info-col">
          <div class="event-place" title="${placeStr}">${placeStr}</div>
          <div class="event-meta-row">
            <span class="event-dist">📍 ${distMi.toFixed(1)} mi · ${depthStr}</span>
            <span class="event-time"><span class="live-elapsed" data-time="${evt.time}">${elapsedStr}</span></span>
          </div>
          ${matchedZone ? `
            <div class="event-zone-tag" style="background: ${matchedZone.color}20; color: ${matchedZone.color}; border-color: ${matchedZone.color}40;">
              ${matchedZone.name.split(' ')[0]} ${matchedZone.name.split(' ').slice(1, 3).join(' ')}
            </div>
          ` : ''}
          <button type="button" class="btn-quake-replay btn-quake-replay-sm" data-origin-time="${evt.time}" data-dist-km="${distKmItem.toFixed(2)}" data-mag="${mag.toFixed(2)}" data-place="${safePlaceItem}">🔍 Did My Sensor See This?</button>
        </div>
      </div>
    `;
  }).join('');

  listEl.innerHTML = html;

  // Attach click listeners to jump map center WITHOUT changing zoom!
  listEl.querySelectorAll('.btn-quake-replay').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const originTime = parseFloat(btn.getAttribute('data-origin-time'));
      const distanceKm = parseFloat(btn.getAttribute('data-dist-km'));
      const magVal = parseFloat(btn.getAttribute('data-mag'));
      const placeVal = btn.getAttribute('data-place') || '';
      openQuakeReplayModal({
        time: originTime,
        distance_km: distanceKm,
        magnitude: magVal,
        place: placeVal,
      });
    });
  });

  listEl.querySelectorAll('.radar-event-item').forEach((item) => {
    item.addEventListener('click', () => {
      const lat = parseFloat(item.getAttribute('data-lat'));
      const lng = parseFloat(item.getAttribute('data-lng'));

      if (!isNaN(lat) && !isNaN(lng) && leafletMap) {
        // Pan to coordinates as center — keep current zoom level!
        leafletMap.panTo([lat, lng], { animate: true, duration: 0.5 });

        // Highlight selected card
        listEl.querySelectorAll('.radar-event-item').forEach((el) => el.classList.remove('active-item'));
        item.classList.add('active-item');

        // Find corresponding marker and trigger popup
        const allMarkers = quakeMarkers.concat(historicMarkers);
        const marker = allMarkers.find((m) => {
          if (!m.getLatLng) return false;
          const ll = m.getLatLng();
          return Math.abs(ll.lat - lat) < 0.005 && Math.abs(ll.lng - lng) < 0.005;
        });
        if (marker && marker.openPopup) {
          marker.openPopup();
        }
      }
    });
  });
}

export function syncRadarStationCenter() {
  const st = state.station;
  if (!leafletMap || !st) return;
  const stLat = Number(st.station_lat);
  const stLon = Number(st.station_lon);
  if (!Number.isFinite(stLat) || !Number.isFinite(stLon)) return;
  if (stationMarker) {
    stationMarker.setLatLng([stLat, stLon]);
    stationMarker.setPopupContent(`
      <div style="font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.5; min-width: 220px;">
        <b style="color: #00ff88; font-size: 13px;">🏠 ${st.station_code} ${st.station_name}</b><br>
        <b>Coordinates:</b> ${formatCoords(stLat, stLon)}<br>
        <b>Witness Ref:</b> ${st.witness_station || 'BK.BKS'}<br>
        <span style="color: #38bdf8;">Listening to 700-mile regional seismicity</span>
      </div>
    `);
  }
  leafletMap.setView([stLat, stLon], leafletMap.getZoom());
}
