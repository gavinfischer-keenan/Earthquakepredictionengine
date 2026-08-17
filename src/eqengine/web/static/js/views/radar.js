/**
 * Epicenter Radar View: Geospatial Leaflet Map, 500-Mile California Fault System,
 * Special Seismic Swarm/Geothermal Cluster Zones (with PR Photos & Hover Popups),
 * and Magnitude-Sized Earthquake Event Markers.
 */

import { state } from '../state.js';

let leafletMap = null;
let stationMarker = null;
let quakeMarkers = [];
let elapsedTimer = null;
let clusterPolygons = [];

// ===========================================================================
// California Special Seismic Cluster / Geothermal / Volcanic Zones
// ===========================================================================
export const CLUSTER_ZONES = [
  {
    id: 'geysers',
    name: '⚡ The Geysers Geothermal Field',
    location: 'Cobb / Mayacamas Highlands (~65 mi North of Berkeley)',
    image: '/static/assets/images/geysers_site.jpg',
    color: '#f59e0b',
    coords: [
      [38.86, -122.84],
      [38.89, -122.76],
      [38.84, -122.66],
      [38.75, -122.64],
      [38.69, -122.73],
      [38.72, -122.83],
      [38.79, -122.88],
    ],
    center: [38.78, -122.75],
    radiusKm: 13.0,
    whatIsThere: "World's largest complex of geothermal power plants (~725 MW baseload clean electricity) spanning 45 square miles across Sonoma & Lake Counties, with over 350 active steam turbine wells.",
    whyItSwarms: "Treated municipal wastewater is injected 2–3 km deep into boiling Franciscan graywacke rock (~240°C), generating 30–50 induced micro-earthquakes per day (M 0.5–2.5) from thermal contraction and micro-fracturing.",
    statusBadge: "🟢 NORMAL AMBIENT HYDROTHERMAL BACKGROUND",
    statusColor: '#10b981',
  },
  {
    id: 'long_valley',
    name: '🌋 Long Valley Caldera & Mammoth Mountain',
    location: 'Mono County / Eastern Sierra (~190 mi East of Berkeley)',
    image: '/static/assets/images/long_valley_caldera.jpg',
    color: '#ec4899',
    coords: [
      [37.78, -118.98],
      [37.78, -118.72],
      [37.64, -118.68],
      [37.58, -118.82],
      [37.62, -119.02],
      [37.72, -119.04],
    ],
    center: [37.70, -118.87],
    radiusKm: 22.0,
    whatIsThere: "A 20-mile-wide active volcanic caldera formed by a super-eruption 760,000 years ago, surrounded by Mammoth Mountain and Hot Creek hydrothermal fumaroles.",
    whyItSwarms: "Recurring magmatic fluid migration, resurgent dome inflation, and supercritical hydrothermal gas releases trigger episodic volcanic earthquake swarms.",
    statusBadge: "🟡 ACTIVE VOLCANIC HYDROTHERMAL SWARM ZONE",
    statusColor: '#f59e0b',
  },
  {
    id: 'salton_sea',
    name: '🌊 Salton Sea & Brawley Seismic Zone',
    location: 'Imperial Valley (~460 mi Southeast of Berkeley)',
    image: '/static/assets/images/salton_sea_field.jpg',
    color: '#06b6d4',
    coords: [
      [33.35, -115.75],
      [33.35, -115.45],
      [33.00, -115.45],
      [33.00, -115.75],
    ],
    center: [33.15, -115.60],
    radiusKm: 30.0,
    whatIsThere: "11 geothermal power plants, bubbling volcanic mud pots (Salton Buttes), and lithium extraction facilities along the tectonic rift zone.",
    whyItSwarms: "An active continental rift pull-apart basin between the San Andreas and Imperial Faults, creating intense strike-slip transform swarm sequences (hundreds of quakes in hours).",
    statusBadge: "⚡ TECTONIC-VOLCANIC SPREADING RIFT",
    statusColor: '#06b6d4',
  },
  {
    id: 'coso',
    name: '♨️ Coso Volcanic & Geothermal Field',
    location: 'China Lake / Inyo County (~280 mi Southeast)',
    color: '#8b5cf6',
    coords: [
      [36.12, -117.90],
      [36.12, -117.70],
      [35.92, -117.70],
      [35.92, -117.90],
    ],
    center: [36.02, -117.80],
    radiusKm: 16.0,
    whatIsThere: "270 MW geothermal power complex situated on China Lake Naval Weapons Station with 38 Pleistocene rhyolite lava domes.",
    whyItSwarms: "High regional crustal heat flow and active hydrothermal fluid circulation trigger continuous induced micro-seismicity (M 1.0–2.8).",
    statusBadge: "🟢 NORMAL INDUCED GEOTHERMAL BACKGROUND",
    statusColor: '#10b981',
  },
  {
    id: 'parkfield',
    name: '🔬 Parkfield Creeping Segment ("Earthquake Capital")',
    location: 'Monterey / Fresno Counties (~160 mi South)',
    color: '#10b981',
    coords: [
      [36.05, -120.55],
      [36.05, -120.30],
      [35.75, -120.30],
      [35.75, -120.55],
    ],
    center: [35.90, -120.43],
    radiusKm: 18.0,
    whatIsThere: "The world's most instrumented earthquake observatory (USGS SAFOD deep borehole, laser creepmeters, borehole strainmeters).",
    whyItSwarms: "Tectonic transition zone between the locked San Andreas Fault and the creeping central section, with repeating M6.0 characteristic ruptures.",
    statusBadge: "🔬 TECTONIC TRANSITION & CREEP BENCHMARK",
    statusColor: '#10b981',
  },
  {
    id: 'san_ramon',
    name: '🏙️ San Ramon Valley Fault Swarm Zone',
    location: 'East Bay Hills (~18 mi Southeast of Berkeley)',
    color: '#f43f5e',
    coords: [
      [37.82, -122.04],
      [37.82, -121.92],
      [37.72, -121.92],
      [37.72, -122.04],
    ],
    center: [37.77, -121.98],
    radiusKm: 8.0,
    whatIsThere: "Suburban East Bay hills overlying the Calaveras, Concord, and Las Trampas fault stepover structures.",
    whyItSwarms: "Episodic shallow strike-slip earthquake swarms (often generating 100+ micro-quakes within a few days) on unmapped cross-faults.",
    statusBadge: "⚠️ PERIODIC SHALLOW EAST BAY SWARM ZONE",
    statusColor: '#f43f5e',
  },
];

export function getClusterZoneForEvent(lat, lon) {
  for (const zone of CLUSTER_ZONES) {
    const dLat = (lat - zone.center[0]) * 111.0;
    const dLon = (lon - zone.center[1]) * 111.0 * Math.cos((zone.center[0] * Math.PI) / 180);
    if (Math.sqrt(dLat * dLat + dLon * dLon) <= zone.radiusKm) {
      return zone;
    }
  }
  return null;
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

export async function fetchRadarEvents() {
  try {
    // 1. Fetch from local engine API
    const resp = await fetch('/api/usgs-events');
    if (resp.ok) {
      const data = await resp.json();
      const incomingEvents = data.events || [];
      const existingIds = new Set(state.usgsEvents.map((e) => e.id));
      incomingEvents.forEach((evt) => {
        if (evt && evt.id && !existingIds.has(evt.id)) {
          state.usgsEvents.push(evt);
          existingIds.add(evt.id);
        }
      });
    }

    // 2. Fetch directly from USGS 48-hour feed
    if (state.usgsEvents.length < 20) {
      const usgsResp = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson');
      if (usgsResp.ok) {
        const usgsData = await usgsResp.json();
        const features = usgsData.features || [];
        const existingIds = new Set(state.usgsEvents.map((e) => e.id));

        features.forEach((f) => {
          const id = f.id;
          if (!existingIds.has(id) && f.geometry && f.geometry.coordinates) {
            const lon = f.geometry.coordinates[0];
            const lat = f.geometry.coordinates[1];
            const depth = f.geometry.coordinates[2] || 5.0;
            const props = f.properties || {};

            // Calculate distance to Berkeley station (37.8696, -122.2491)
            const dLat = (lat - 37.8696) * 111.0;
            const dLon = (lon - (-122.2491)) * (111.0 * Math.cos((37.8696 * Math.PI) / 180));
            const distKm = Math.sqrt(dLat * dLat + dLon * dLon);
            const distMi = distKm * 0.621371;

            if (distMi <= 500.0) {
              state.usgsEvents.push({
                id: id,
                magnitude: props.mag,
                place: props.place,
                time: props.time ? props.time / 1000 : Date.now() / 1000,
                latitude: lat,
                longitude: lon,
                depth_km: depth,
                distance_km: distKm,
                distance_miles: distMi,
                url: props.url,
              });
              existingIds.add(id);
            }
          }
        });
      }
    }

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
    zoom: 8,
    zoomControl: true,
  });

  // Dark Matter CartoDB Basemap
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CartoDB & USGS',
    maxZoom: 19,
    subdomains: 'abcd',
  }).addTo(leafletMap);

  // Home Station Marker (Berkeley Hills AM.R1A3D)
  const stationIcon = L.divIcon({
    className: 'station-radar-marker',
    html: '<div style="width:18px;height:18px;background:#00ff88;border:2.5px solid #fff;border-radius:50%;box-shadow:0 0 16px #00ff88;cursor:pointer;"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
  stationMarker = L.marker([37.8696, -122.2491], { icon: stationIcon }).addTo(leafletMap);
  stationMarker.bindPopup(`
    <div style="font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.5; min-width: 220px;">
      <b style="color: #00ff88; font-size: 13px;">🏠 AM.R1A3D Berkeley Hills</b><br>
      <b>Coordinates:</b> 37.8696° N, 122.2491° W<br>
      <b>Elevation:</b> ~240m above sea level<br>
      <b>Fault:</b> Hayward Fault Zone (~400m West)<br>
      <span style="color: #38bdf8;">Listening to 500-mile regional seismicity</span>
    </div>
  `);

  // =========================================================================
  // 500-Mile California Fault System Mapping
  // =========================================================================

  // 1. Hayward Fault Trace (~400m West of Station)
  const haywardCoords = [
    [37.45, -121.88], [37.54, -121.96], [37.64, -122.05], [37.73, -122.14],
    [37.81, -122.21], [37.87, -122.25], [37.93, -122.31], [38.01, -122.38]
  ];
  L.polyline(haywardCoords, { color: '#ef4444', weight: 3.5, opacity: 0.9, dashArray: '6, 6' })
    .addTo(leafletMap)
    .bindPopup('<b>Hayward Fault Zone</b><br>Major active strike-slip fault ~400m West of station.');

  // 2. Rodgers Creek Fault (Northern continuation of Hayward across San Pablo Bay)
  const rodgersCoords = [
    [38.01, -122.38], [38.15, -122.48], [38.30, -122.58], [38.45, -122.72], [38.60, -122.85]
  ];
  L.polyline(rodgersCoords, { color: '#f97316', weight: 2.5, opacity: 0.85, dashArray: '5, 5' })
    .addTo(leafletMap)
    .bindPopup('<b>Rodgers Creek Fault</b><br>North Bay active fault segment through Santa Rosa.');

  // 3. San Andreas Fault System (Northern, Central & Southern Segments)
  const sanAndreasNorthern = [
    [40.35, -124.45], [40.00, -124.10], [39.50, -123.80], [38.90, -123.70],
    [38.60, -123.35], [38.30, -123.05], [38.00, -122.80], [37.75, -122.50],
    [37.50, -122.25], [37.15, -121.90], [36.80, -121.55]
  ];
  L.polyline(sanAndreasNorthern, { color: '#f59e0b', weight: 3.0, opacity: 0.9 })
    .addTo(leafletMap)
    .bindPopup('<b>San Andreas Fault (Northern / SF Peninsula)</b><br>Primary Pacific-North American tectonic boundary.');

  const sanAndreasCentral = [
    [36.80, -121.55], [36.50, -121.15], [36.20, -120.75], [35.90, -120.45], [35.60, -120.15]
  ];
  L.polyline(sanAndreasCentral, { color: '#f59e0b', weight: 2.8, opacity: 0.85 })
    .addTo(leafletMap)
    .bindPopup('<b>San Andreas Fault (Central Creeping / Parkfield)</b>');

  const sanAndreasSouthern = [
    [35.60, -120.15], [35.20, -119.70], [34.80, -118.90], [34.50, -118.10],
    [34.20, -117.45], [33.90, -116.80], [33.50, -116.00], [33.20, -115.60]
  ];
  L.polyline(sanAndreasSouthern, { color: '#f59e0b', weight: 2.8, opacity: 0.85 })
    .addTo(leafletMap)
    .bindPopup('<b>San Andreas Fault (Southern / Mojave & Coachella)</b>');

  // 4. Calaveras Fault Zone
  const calaverasCoords = [
    [36.90, -121.35], [37.20, -121.65], [37.45, -121.85], [37.75, -121.97], [38.00, -122.10]
  ];
  L.polyline(calaverasCoords, { color: '#d97706', weight: 2.5, opacity: 0.85, dashArray: '4, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>Calaveras Fault Zone</b><br>East Bay active strike-slip branch.');

  // 5. Concord - Green Valley Fault
  const concordCoords = [
    [37.95, -122.02], [38.05, -122.08], [38.18, -122.15], [38.30, -122.20]
  ];
  L.polyline(concordCoords, { color: '#fbbf24', weight: 2.0, opacity: 0.8, dashArray: '4, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>Concord - Green Valley Fault</b>');

  // 6. San Gregorio - Hosgri Fault Zone (Coastal / Offshore)
  const sanGregorioCoords = [
    [35.20, -120.90], [35.70, -121.35], [36.20, -121.80], [36.70, -122.05],
    [37.10, -122.35], [37.50, -122.55], [37.85, -122.65]
  ];
  L.polyline(sanGregorioCoords, { color: '#38bdf8', weight: 2.0, opacity: 0.75, dashArray: '5, 5' })
    .addTo(leafletMap)
    .bindPopup('<b>San Gregorio - Hosgri Fault Zone</b><br>Coastal / offshore strike-slip system.');

  // 7. Greenville Fault (East Bay)
  const greenvilleCoords = [
    [37.55, -121.68], [37.75, -121.78], [37.90, -121.85]
  ];
  L.polyline(greenvilleCoords, { color: '#fb923c', weight: 2.0, opacity: 0.75, dashArray: '4, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>Greenville Fault</b>');

  // 8. West Napa Fault (2014 South Napa Quake Source)
  const westNapaCoords = [
    [38.18, -122.28], [38.30, -122.33], [38.42, -122.42]
  ];
  L.polyline(westNapaCoords, { color: '#ef4444', weight: 2.0, opacity: 0.8, dashArray: '3, 3' })
    .addTo(leafletMap)
    .bindPopup('<b>West Napa Fault</b>');

  // 9. Maacama & Bartlett Springs Faults (North Coast / Mendocino)
  const maacamaCoords = [
    [38.60, -122.85], [38.90, -123.10], [39.30, -123.35], [39.70, -123.50]
  ];
  L.polyline(maacamaCoords, { color: '#f59e0b', weight: 2.0, opacity: 0.75, dashArray: '4, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>Maacama Fault Zone</b>');

  const bartlettCoords = [
    [38.95, -122.65], [39.25, -122.85], [39.60, -123.05], [40.00, -123.30]
  ];
  L.polyline(bartlettCoords, { color: '#fbbf24', weight: 2.0, opacity: 0.75, dashArray: '4, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>Bartlett Springs Fault Zone</b>');

  // 10. Garlock Fault (Southern Sierra / Mojave)
  const garlockCoords = [
    [34.85, -118.90], [35.15, -118.10], [35.40, -117.40], [35.65, -116.70], [35.75, -116.20]
  ];
  L.polyline(garlockCoords, { color: '#a855f7', weight: 2.2, opacity: 0.8, dashArray: '5, 5' })
    .addTo(leafletMap)
    .bindPopup('<b>Garlock Fault Zone</b><br>Major sinistral (left-lateral) transform fault.');

  // 11. Eastern California Shear Zone / Owens Valley Fault
  const ecszCoords = [
    [35.50, -117.40], [36.00, -117.80], [36.55, -118.15], [37.20, -118.35], [37.80, -118.60], [38.50, -119.10]
  ];
  L.polyline(ecszCoords, { color: '#3b82f6', weight: 2.0, opacity: 0.8, dashArray: '4, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>Eastern California Shear Zone / Owens Valley</b>');

  // 12. San Jacinto & Elsinore Faults (SoCal)
  const sanJacintoCoords = [
    [34.25, -117.45], [33.90, -117.05], [33.55, -116.65], [33.20, -116.20], [32.80, -115.75]
  ];
  L.polyline(sanJacintoCoords, { color: '#ef4444', weight: 2.0, opacity: 0.8, dashArray: '4, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>San Jacinto Fault Zone</b>');

  const elsinoreCoords = [
    [33.90, -117.65], [33.60, -117.35], [33.30, -117.00], [33.00, -116.65], [32.65, -116.10]
  ];
  L.polyline(elsinoreCoords, { color: '#f97316', weight: 2.0, opacity: 0.8, dashArray: '4, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>Elsinore Fault Zone</b>');

  // 13. Cascadia Subduction Front & Mendocino Fracture Zone
  const mendocinoFracture = [
    [40.35, -124.50], [40.35, -126.50], [40.35, -128.00]
  ];
  L.polyline(mendocinoFracture, { color: '#06b6d4', weight: 2.5, opacity: 0.8, dashArray: '6, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>Mendocino Fracture Zone / Gorda Plate Boundary</b>');

  // =========================================================================
  // California Swarm / Geothermal / Volcanic Cluster Overlays
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

  // Radar range rings (10, 25, 50, 100, 250, 500 miles)
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

  // Start live elapsed timer
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
  const cutoff48h = now - 48 * 3600; // Past 48 hours

  const active48hEvents = state.usgsEvents.filter((evt) => {
    if (!evt.latitude || !evt.longitude || !evt.time) return false;
    if (evt.time < cutoff48h) return false;
    const distMi = evt.distance_miles !== undefined ? evt.distance_miles : (evt.distance_km ? evt.distance_km * 0.621371 : 9999);
    return distMi <= 500.0;
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

    circle.bindPopup(`
      <div style="font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.5; min-width: 240px; color: #f8fafc;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; border-bottom: 1px solid #334155; padding-bottom: 4px;">
          <span style="font-weight: 700; color: ${color}; font-size: 13px;">M ${mag.toFixed(1)} Earthquake</span>
          <span style="color: #64748b; font-size: 9px;">USGS FEED</span>
        </div>
        <div style="font-weight: 600; color: #f8fafc; margin-bottom: 6px;">${evt.place || 'Regional Seismic Event'}</div>
        <div style="color: #cbd5e1;"><b>Classification:</b> <span style="color: ${color}; font-weight: 600;">${magCategory}</span></div>
        <div style="color: #cbd5e1;"><b>Distance:</b> ${distStr} from Berkeley</div>
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
        ${evt.url ? `<div style="margin-top: 6px;"><a href="${evt.url}" target="_blank" style="color: #38bdf8; text-decoration: underline; font-size: 10px;">USGS Event Details ↗</a></div>` : ''}
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
}
