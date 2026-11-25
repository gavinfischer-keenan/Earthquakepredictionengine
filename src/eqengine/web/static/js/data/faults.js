/**
 * Western North America Active Fault System Polylines (700-Mile Radar)
 */
export const FAULT_LINES = [
  {
    coords: [
      [37.45, -121.88], [37.54, -121.96], [37.64, -122.05], [37.73, -122.14],
      [37.81, -122.21], [37.87, -122.25], [37.93, -122.31], [38.01, -122.38],
    ],
    style: { color: '#ef4444', weight: 3.5, opacity: 0.9, dashArray: '6, 6' },
    popup: '<b>Hayward Fault Zone</b><br>Major active strike-slip fault ~400m West of station.',
  },
  {
    coords: [
      [38.01, -122.38], [38.15, -122.48], [38.30, -122.58], [38.45, -122.72], [38.60, -122.85],
    ],
    style: { color: '#f97316', weight: 2.5, opacity: 0.85, dashArray: '5, 5' },
    popup: '<b>Rodgers Creek Fault</b><br>North Bay active fault segment through Santa Rosa.',
  },
  {
    coords: [
      [40.35, -124.45], [40.00, -124.10], [39.50, -123.80], [38.90, -123.70],
      [38.60, -123.35], [38.30, -123.05], [38.00, -122.80], [37.75, -122.50],
      [37.50, -122.25], [37.15, -121.90], [36.80, -121.55],
    ],
    style: { color: '#f59e0b', weight: 3.0, opacity: 0.9 },
    popup: '<b>San Andreas Fault (Northern / SF Peninsula)</b><br>Primary Pacific-North American tectonic boundary.',
  },
  {
    coords: [
      [36.80, -121.55], [36.50, -121.15], [36.20, -120.75], [35.90, -120.45], [35.60, -120.15],
    ],
    style: { color: '#f59e0b', weight: 2.8, opacity: 0.85 },
    popup: '<b>San Andreas Fault (Central Creeping / Parkfield)</b>',
  },
  {
    coords: [
      [35.60, -120.15], [35.20, -119.70], [34.80, -118.90], [34.50, -118.10],
      [34.20, -117.45], [33.90, -116.80], [33.50, -116.00], [33.20, -115.60],
    ],
    style: { color: '#f59e0b', weight: 2.8, opacity: 0.85 },
    popup: '<b>San Andreas Fault (Southern / Mojave & Coachella)</b>',
  },
  {
    coords: [
      [36.90, -121.35], [37.20, -121.65], [37.45, -121.85], [37.75, -121.97], [38.00, -122.10],
    ],
    style: { color: '#d97706', weight: 2.5, opacity: 0.85, dashArray: '4, 4' },
    popup: '<b>Calaveras Fault Zone</b><br>East Bay active strike-slip branch.',
  },
  {
    coords: [
      [37.95, -122.02], [38.05, -122.08], [38.18, -122.15], [38.30, -122.20],
    ],
    style: { color: '#fbbf24', weight: 2.0, opacity: 0.8, dashArray: '4, 4' },
    popup: '<b>Concord - Green Valley Fault</b>',
  },
  {
    coords: [
      [35.20, -120.90], [35.70, -121.35], [36.20, -121.80], [36.70, -122.05],
      [37.10, -122.35], [37.50, -122.55], [37.85, -122.65],
    ],
    style: { color: '#38bdf8', weight: 2.0, opacity: 0.75, dashArray: '5, 5' },
    popup: '<b>San Gregorio - Hosgri Fault Zone</b><br>Coastal / offshore strike-slip system.',
  },
  {
    coords: [[37.55, -121.68], [37.75, -121.78], [37.90, -121.85]],
    style: { color: '#fb923c', weight: 2.0, opacity: 0.75, dashArray: '4, 4' },
    popup: '<b>Greenville Fault</b>',
  },
  {
    coords: [[38.18, -122.28], [38.30, -122.33], [38.42, -122.42]],
    style: { color: '#ef4444', weight: 2.0, opacity: 0.8, dashArray: '3, 3' },
    popup: '<b>West Napa Fault</b>',
  },
  {
    coords: [[38.60, -122.85], [38.90, -123.10], [39.30, -123.35], [39.70, -123.50]],
    style: { color: '#f59e0b', weight: 2.0, opacity: 0.75, dashArray: '4, 4' },
    popup: '<b>Maacama Fault Zone</b>',
  },
  {
    coords: [[38.95, -122.65], [39.25, -122.85], [39.60, -123.05], [40.00, -123.30]],
    style: { color: '#fbbf24', weight: 2.0, opacity: 0.75, dashArray: '4, 4' },
    popup: '<b>Bartlett Springs Fault Zone</b>',
  },
  {
    coords: [[34.85, -118.90], [35.15, -118.10], [35.40, -117.40], [35.65, -116.70], [35.75, -116.20]],
    style: { color: '#a855f7', weight: 2.2, opacity: 0.8, dashArray: '5, 5' },
    popup: '<b>Garlock Fault Zone</b><br>Major sinistral (left-lateral) transform fault.',
  },
  {
    coords: [[35.50, -117.40], [36.00, -117.80], [36.55, -118.15], [37.20, -118.35], [37.80, -118.60], [38.50, -119.10]],
    style: { color: '#3b82f6', weight: 2.0, opacity: 0.8, dashArray: '4, 4' },
    popup: '<b>Eastern California Shear Zone / Owens Valley</b>',
  },
  {
    coords: [[34.25, -117.45], [33.90, -117.05], [33.55, -116.65], [33.20, -116.20], [32.80, -115.75]],
    style: { color: '#ef4444', weight: 2.0, opacity: 0.8, dashArray: '4, 4' },
    popup: '<b>San Jacinto Fault Zone</b>',
  },
  {
    coords: [[33.90, -117.65], [33.60, -117.35], [33.30, -117.00], [33.00, -116.65], [32.65, -116.10]],
    style: { color: '#f97316', weight: 2.0, opacity: 0.8, dashArray: '4, 4' },
    popup: '<b>Elsinore Fault Zone</b>',
  },
  {
    coords: [[40.35, -124.50], [40.35, -126.50], [40.35, -128.50], [40.35, -130.00]],
    style: { color: '#06b6d4', weight: 2.5, opacity: 0.85, dashArray: '6, 4' },
    popup: '<b>Mendocino Fracture Zone / Gorda Plate Boundary</b>',
  },
  {
    coords: [
      [40.35, -124.60], [41.20, -124.70], [42.40, -124.90], [44.00, -124.95],
      [45.50, -124.85], [47.00, -125.10], [48.50, -125.80],
    ],
    style: { color: '#ec4899', weight: 3.2, opacity: 0.9, dashArray: '8, 4' },
    popup: '<b>Cascadia Megathrust Subduction Zone</b><br>1,000 km convergent boundary capable of M 9.0+ megathrust ruptures.',
  },
  {
    coords: [[42.75, -125.50], [43.50, -127.20], [44.20, -129.00], [44.60, -130.50]],
    style: { color: '#38bdf8', weight: 2.2, opacity: 0.8, dashArray: '5, 5' },
    popup: '<b>Blanco Fracture Zone</b><br>Active oceanic transform fault between Gorda and Juan de Fuca plates.',
  },
  {
    coords: [
      [39.40, -111.75], [39.90, -111.65], [40.40, -111.75], [40.75, -111.85],
      [41.25, -111.95], [41.80, -112.05], [42.30, -112.10],
    ],
    style: { color: '#a855f7', weight: 2.8, opacity: 0.85, dashArray: '5, 5' },
    popup: '<b>Wasatch Fault Zone (Utah)</b><br>370-km active normal fault system capable of M 7.0+ ruptures.',
  },
  {
    coords: [
      [36.80, -116.80], [37.60, -117.40], [38.40, -118.20], [39.20, -119.10],
      [39.90, -119.70], [40.80, -120.30],
    ],
    style: { color: '#f59e0b', weight: 2.4, opacity: 0.8, dashArray: '4, 4' },
    popup: '<b>Walker Lane Tectonic Belt (Nevada)</b><br>Accommodates ~20% of Pacific-North American dextral shear.',
  },
  {
    coords: [[38.70, -118.20], [39.15, -118.15], [39.60, -118.10], [40.10, -118.00]],
    style: { color: '#e11d48', weight: 2.2, opacity: 0.8, dashArray: '4, 4' },
    popup: '<b>Central Nevada Seismic Zone</b><br>Site of the 1954 Fairview Peak (M7.1) & Dixie Valley (M6.8) ruptures.',
  },
  {
    coords: [[43.60, -113.50], [44.00, -113.85], [44.45, -114.15]],
    style: { color: '#8b5cf6', weight: 2.2, opacity: 0.8, dashArray: '4, 4' },
    popup: '<b>Lost River Fault Zone (Idaho)</b><br>Source of the 1983 Borah Peak M6.9 earthquake.',
  },
  {
    coords: [[43.85, -114.85], [44.25, -115.00], [44.65, -115.15]],
    style: { color: '#6366f1', weight: 2.0, opacity: 0.8, dashArray: '4, 4' },
    popup: '<b>Sawtooth Fault Zone (Idaho)</b><br>Source of the 2020 Stanley M6.5 earthquake.',
  },
  {
    coords: [[33.10, -115.60], [32.80, -115.45], [32.55, -115.30], [32.25, -115.10], [31.95, -114.90]],
    style: { color: '#14b8a6', weight: 2.8, opacity: 0.85, dashArray: '6, 4' },
    popup: '<b>Imperial & Cerro Prieto Fault System (Baja California)</b><br>Connecting the San Andreas Fault to the Gulf of California spreading centers.',
  },
  {
    coords: [[47.60, -122.65], [47.58, -122.35], [47.54, -122.05], [47.52, -121.80]],
    style: { color: '#ef4444', weight: 2.2, opacity: 0.8, dashArray: '3, 3' },
    popup: '<b>Seattle Fault Zone (Washington)</b><br>Active shallow crustal thrust fault beneath Puget Sound.',
  },
  {
    coords: [[45.35, -122.55], [45.55, -122.75], [45.75, -122.90]],
    style: { color: '#f97316', weight: 2.0, opacity: 0.8, dashArray: '3, 3' },
    popup: '<b>Portland Hills Fault Zone (Oregon)</b>',
  },
];
