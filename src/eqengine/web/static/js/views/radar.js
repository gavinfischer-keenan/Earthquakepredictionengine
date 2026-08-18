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
  {
    id: 'yellowstone',
    name: '🌋 Yellowstone Supervolcano Caldera',
    location: 'NW Wyoming / Montana / Idaho border (~685 mi NE)',
    color: '#ef4444',
    coords: [
      [44.85, -111.15],
      [44.85, -110.15],
      [44.15, -110.15],
      [44.15, -111.15],
    ],
    center: [44.45, -110.65],
    radiusKm: 55.0,
    whatIsThere: "Active continental supervolcano caldera (45×30 miles), Norris Geyser Basin, and massive hydrothermal reservoir underlain by a 10,000 km³ magma reservoir.",
    whyItSwarms: "Tectonic stretching along the Intermountain Seismic Belt coupled with hydrothermal fluid/gas migration causes 1,500–3,000 earthquakes annually in intense episodic swarm clusters.",
    statusBadge: "🟡 ACTIVE SUPERVOLCANO HYDROTHERMAL SWARM SYSTEM",
    statusColor: '#ef4444',
  },
  {
    id: 'mount_st_helens',
    name: '🌋 Mount St. Helens & Cascade Volcanic Arc',
    location: 'Skamania County, Washington (~565 mi North)',
    color: '#f97316',
    coords: [
      [46.32, -122.35],
      [46.32, -122.05],
      [46.08, -122.05],
      [46.08, -122.35],
    ],
    center: [46.20, -122.19],
    radiusKm: 22.0,
    whatIsThere: "Active Cascade arc stratovolcano with 1980 cataclysmic crater, growing dacite lava dome, and hydrothermal fumaroles.",
    whyItSwarms: "Subsurface magma recharge into the 2–8 km conduit system triggers continuous low-frequency volcanic earthquakes and volcano-tectonic (VT) swarms.",
    statusBadge: "🌋 ACTIVE CASCADE VOLCANIC SEISMIC ARC",
    statusColor: '#f97316',
  },
  {
    id: 'wasatch_front',
    name: '⚡ Wasatch Fault Zone / Salt Lake Rift Stepover',
    location: 'Wasatch Front, Utah (~585 mi East)',
    color: '#a855f7',
    coords: [
      [41.25, -112.15],
      [41.25, -111.70],
      [40.35, -111.70],
      [40.35, -112.15],
    ],
    center: [40.75, -111.90],
    radiusKm: 42.0,
    whatIsThere: "370-km Holocene normal fault system bounding the Wasatch Mountain range and the Great Salt Lake urban corridor.",
    whyItSwarms: "Extensional crustal rifting of the Basin and Range province with active intra-basin stepovers (e.g. 2020 M5.7 Magna earthquake sequence).",
    statusBadge: "⚡ INTERMOUNTAIN EXTENSIONAL FAULT ZONE",
    statusColor: '#a855f7',
  },
  {
    id: 'cerro_prieto',
    name: '♨️ Cerro Prieto Spreading Center & Geothermal Basin',
    location: 'Mexicali Valley, Baja California (~520 mi SE)',
    color: '#14b8a6',
    coords: [
      [32.60, -115.42],
      [32.60, -115.08],
      [32.22, -115.08],
      [32.22, -115.42],
    ],
    center: [32.42, -115.24],
    radiusKm: 26.0,
    whatIsThere: "Major continental pull-apart rift basin between Imperial and Cerro Prieto faults hosting the world's 2nd largest geothermal power complex (~720 MW).",
    whyItSwarms: "Active crustal spreading center linking the Gulf of California rift with the San Andreas transform system, generating high-density strike-slip earthquake swarms.",
    statusBadge: "🌊 ACTIVE GULF RIFT SPREADING CENTER",
    statusColor: '#14b8a6',
  },
  {
    id: 'newberry',
    name: '🌋 Newberry Volcano & Geothermal Caldera',
    location: 'Deschutes County, Oregon (~375 mi North)',
    color: '#eab308',
    coords: [
      [43.88, -121.42],
      [43.88, -121.05],
      [43.58, -121.05],
      [43.58, -121.42],
    ],
    center: [43.72, -121.23],
    radiusKm: 24.0,
    whatIsThere: "Massive 1,200 sq mile shield volcano with a 4×5 mile central caldera (Paulina & East Lakes), Big Obsidian Flow, and deep EGS geothermal research wells.",
    whyItSwarms: "Crustal extension along the Sisters and Brothers fault zones combined with geothermal fluid circulation in young rhyolitic magma chambers.",
    statusBadge: "🟡 ACTIVE CASCADE CALDERA & GEOTHERMAL ZONE",
    statusColor: '#eab308',
  },
];

export const HISTORIC_EARTHQUAKES = [
  {
    id: 'sf_1906',
    name: '1906 Great San Francisco Earthquake',
    year: 1906,
    date: 'April 18, 1906 (05:12 PST)',
    magnitude: 7.9,
    depthKm: 8.0,
    coords: [37.75, -122.55], // Off Daly City / Olema
    fault: 'San Andreas Fault (Northern Segment, 470 km rupture)',
    distanceMiles: 18.2,
    summary: 'The catastrophic Great 1906 earthquake ruptured 296 miles of the San Andreas Fault from San Juan Bautista to Cape Mendocino with up to 28 feet (8.5m) of horizontal offset; triggered the Great Fire destroying 80% of San Francisco.',
    shakingIntensity: 'MMI XI (Extreme / Violent)',
  },
  {
    id: 'fort_tejon_1857',
    name: '1857 Great Fort Tejon Earthquake',
    year: 1857,
    date: 'January 9, 1857 (08:20 PST)',
    magnitude: 7.9,
    depthKm: 12.0,
    coords: [35.720, -120.300], // Cholame / Carrizo Plain
    fault: 'San Andreas Fault (Southern & Central segments, 350 km rupture)',
    distanceMiles: 186.0,
    summary: 'One of the largest recorded earthquakes in US history. Ruptured 225 miles of the San Andreas Fault from Parkfield to Wrightwood with up to 30 feet of lateral offset in the Carrizo Plain.',
    shakingIntensity: 'MMI X (Extreme)',
  },
  {
    id: 'lone_pine_1872',
    name: '1872 Great Lone Pine / Owens Valley Earthquake',
    year: 1872,
    date: 'March 26, 1872 (02:30 PST)',
    magnitude: 7.8,
    depthKm: 10.0,
    coords: [36.58, -118.06], // Lone Pine / Owens Valley
    fault: 'Owens Valley Fault (Eastern California Shear Zone)',
    distanceMiles: 248.0,
    summary: 'One of the top 3 largest earthquakes in California history; produced a 100-km surface scarp with up to 23 feet of strike-slip and 17 feet of vertical displacement; felt in Mexico and Nevada.',
    shakingIntensity: 'MMI X (Extreme)',
  },
  {
    id: 'landers_1992',
    name: '1992 Landers Earthquake',
    year: 1992,
    date: 'June 28, 1992 (04:57 PDT)',
    magnitude: 7.3,
    depthKm: 1.1,
    coords: [34.200, -116.437], // High Desert / Landers
    fault: 'Johnson Valley, Kickapoo, Homestead Valley, & Camp Rock Faults',
    distanceMiles: 412.0,
    summary: 'A complex multi-fault rupture jumping across 5 distinct faults over 70 km; triggered remote microseisms across Yellowstone and California, followed 3 hours later by the M6.5 Big Bear earthquake.',
    shakingIntensity: 'MMI IX (Violent)',
  },
  {
    id: 'hebgen_1959',
    name: '1959 Hebgen Lake / Yellowstone Earthquake',
    year: 1959,
    date: 'August 17, 1959 (23:37 MST)',
    magnitude: 7.3,
    depthKm: 10.0,
    coords: [44.83, -111.20], // Near Hebgen Lake / West Yellowstone, MT
    fault: 'Hebgen Lake & Red Canyon Normal Faults',
    distanceMiles: 692.0,
    summary: 'Triggered the massive Madison Canyon rockslide (80 million tons of rock) damming the Madison River to create Earthquake Lake; created 20-foot vertical fault scarps.',
    shakingIntensity: 'MMI X (Extreme)',
  },
  {
    id: 'cape_mendocino_1992',
    name: '1992 Cape Mendocino Earthquake',
    year: 1992,
    date: 'April 25, 1992 (11:06 PDT)',
    magnitude: 7.2,
    depthKm: 15.0,
    coords: [40.33, -124.23], // Petrolia / Mendocino Triple Junction
    fault: 'Cascadia Megathrust Subduction Zone',
    distanceMiles: 202.0,
    summary: 'The only recorded modern megathrust earthquake on the Cascadia Subduction Zone in California. Uplifted the shoreline by 1.4 meters near Petrolia and generated a localized tsunami along the Pacific coast.',
    shakingIntensity: 'MMI IX (Violent)',
  },
  {
    id: 'el_mayor_2010',
    name: '2010 El Mayor–Cucapah Earthquake',
    year: 2010,
    date: 'April 4, 2010 (15:40 PDT)',
    magnitude: 7.2,
    depthKm: 10.0,
    coords: [32.259, -115.287], // Baja California / Mexicali Valley
    fault: 'Laguna Salada / Indiviso Fault System',
    distanceMiles: 512.0,
    summary: 'A complex multi-fault rupture spanning 120 km of faults in northern Baja California that shook skyscrapers in San Diego and Los Angeles.',
    shakingIntensity: 'MMI IX (Violent)',
  },
  {
    id: 'eureka_1980',
    name: '1980 Eureka / Gorda Plate Earthquake',
    year: 1980,
    date: 'November 8, 1980 (02:27 PST)',
    magnitude: 7.2,
    depthKm: 19.0,
    coords: [41.12, -124.64], // Offshore Cape Mendocino
    fault: 'Gorda Plate Intraplate Strike-Slip Fault',
    distanceMiles: 254.0,
    summary: 'Major left-lateral rupture within the oceanic Gorda Plate offshore Humboldt County; collapsed an overpass on Highway 101 and shook coastal Northern California.',
    shakingIntensity: 'MMI VII (Very Strong)',
  },
  {
    id: 'ridgecrest_2019',
    name: '2019 Ridgecrest Earthquake Sequence (Mainshock)',
    year: 2019,
    date: 'July 5, 2019 (20:19 PDT)',
    magnitude: 7.1,
    depthKm: 8.0,
    coords: [35.770, -117.599], // Mojave Desert / China Lake
    fault: 'Little Lake Fault / Eastern California Shear Zone',
    distanceMiles: 298.5,
    summary: 'Ruptured conjugate strike-slip faults following an M6.4 foreshock. Caused visible surface ruptures and severe ground displacement across the Searles Valley and Naval Air Weapons Station China Lake.',
    shakingIntensity: 'MMI IX (Violent)',
  },
  {
    id: 'hector_mine_1999',
    name: '1999 Hector Mine Earthquake',
    year: 1999,
    date: 'October 16, 1999 (02:46 PDT)',
    magnitude: 7.1,
    depthKm: 6.0,
    coords: [34.594, -116.271], // Twentynine Palms / Marine Corps Base
    fault: 'Lavic Lake & Bullion Faults (ECSZ)',
    distanceMiles: 405.0,
    summary: 'A powerful strike-slip rupture in the remote Mojave Desert that derailed an Amtrak train and produced over 5 meters of lateral displacement.',
    shakingIntensity: 'MMI VIII (Severe)',
  },
  {
    id: 'fairview_1954',
    name: '1954 Fairview Peak & Dixie Valley Earthquakes',
    year: 1954,
    date: 'December 16, 1954 (03:07 PST)',
    magnitude: 7.1,
    depthKm: 12.0,
    coords: [39.30, -118.15], // Churchill County, Nevada
    fault: 'Fairview Peak & Dixie Valley Faults (Central Nevada Seismic Zone)',
    distanceMiles: 262.0,
    summary: 'Twin major earthquakes occurring 4 minutes apart that created 20-foot vertical and horizontal surface ruptures visible for miles across the Great Basin.',
    shakingIntensity: 'MMI X (Extreme)',
  },
  {
    id: 'olympia_1949',
    name: '1949 Olympia / Puget Sound Earthquake',
    year: 1949,
    date: 'April 13, 1949 (11:55 PST)',
    magnitude: 7.1,
    depthKm: 54.0,
    coords: [47.100, -122.600], // Puget Sound, WA
    fault: 'Cascadia Intraplate Deep Benioff Zone',
    distanceMiles: 680.0,
    summary: 'Major deep intraslab earthquake beneath South Puget Sound causing extensive damage to brick buildings from Portland to Seattle.',
    shakingIntensity: 'MMI VIII (Severe)',
  },
  {
    id: 'loma_prieta_1989',
    name: '1989 Loma Prieta ("World Series") Earthquake',
    year: 1989,
    date: 'October 17, 1989 (17:04 PDT)',
    magnitude: 6.9,
    depthKm: 19.0,
    coords: [37.036, -121.883], // Santa Cruz Mountains near Loma Prieta peak
    fault: 'San Andreas Fault (Santa Cruz Mountains segment)',
    distanceMiles: 59.4,
    summary: 'Struck during Game 3 warmups of the Bay Bridge World Series (Giants vs A\'s). Caused the collapse of the upper deck of the I-880 Cypress Street Viaduct in Oakland and a section of the San Francisco-Oakland Bay Bridge.',
    shakingIntensity: 'MMI IX (Violent)',
  },
  {
    id: 'borah_1983',
    name: '1983 Borah Peak Earthquake',
    year: 1983,
    date: 'October 28, 1983 (08:06 MST)',
    magnitude: 6.9,
    depthKm: 16.0,
    coords: [44.05, -113.89], // Lost River Range / Mackay, Idaho
    fault: 'Lost River Fault Zone (Thousand Springs segment)',
    distanceMiles: 622.0,
    summary: 'The largest recorded earthquake in Idaho history; produced a spectacular 21-mile-long, 9-foot-high surface rupture along the base of the Lost River Range.',
    shakingIntensity: 'MMI IX (Violent)',
  },
  {
    id: 'hayward_1868',
    name: '1868 Great Hayward Fault Earthquake',
    year: 1868,
    date: 'October 21, 1868 (07:53 PST)',
    magnitude: 6.8,
    depthKm: 10.0,
    coords: [37.70, -122.10], // Directly on Hayward Fault near San Leandro/Hayward
    fault: 'Hayward Fault (Southern & Central segments, 32 km rupture)',
    distanceMiles: 14.1,
    summary: 'Known as the "Original Great San Francisco Earthquake" before 1906. Ruptured directly through the East Bay from San Leandro to Warm Springs, destroying the Alameda County Courthouse and severely shaking the Berkeley Hills.',
    shakingIntensity: 'MMI IX (Violent)',
  },
  {
    id: 'nisqually_2001',
    name: '2001 Nisqually / Puget Sound Earthquake',
    year: 2001,
    date: 'February 28, 2001 (10:54 PST)',
    magnitude: 6.8,
    depthKm: 52.0,
    coords: [47.149, -122.727], // South Puget Sound / Olympia, WA
    fault: 'Cascadia Intraplate Deep Benioff Zone',
    distanceMiles: 684.0,
    summary: 'Deep slab earthquake beneath Puget Sound shaking Seattle, Olympia, and Tacoma; damaged the Alaskan Way Viaduct and Sea-Tac air traffic control tower.',
    shakingIntensity: 'MMI VIII (Severe)',
  },
  {
    id: 'northridge_1994',
    name: '1994 Northridge Earthquake',
    year: 1994,
    date: 'January 17, 1994 (04:30 PST)',
    magnitude: 6.7,
    depthKm: 18.2,
    coords: [34.213, -118.537], // San Fernando Valley / Reseda
    fault: 'Northridge Blind Thrust Fault',
    distanceMiles: 320.0,
    summary: 'One of the costliest natural disasters in US history. The hidden blind thrust fault produced extreme peak ground accelerations (up to 1.82 g) that collapsed freeway overpasses and parking structures across Los Angeles.',
    shakingIntensity: 'MMI IX (Violent)',
  },
  {
    id: 'san_fernando_1971',
    name: '1971 San Fernando / Sylmar Earthquake',
    year: 1971,
    date: 'February 9, 1971 (06:00 PST)',
    magnitude: 6.6,
    depthKm: 8.4,
    coords: [34.41, -118.40], // San Fernando Valley / Sylmar
    fault: 'San Fernando Fault Zone (Sierra Madre Fault system)',
    distanceMiles: 312.0,
    summary: 'Severely damaged the Olive View Hospital and Lower San Fernando Dam, prompting landmark California earthquake building code reforms (Alquist-Priolo Act).',
    shakingIntensity: 'MMI IX (Violent)',
  },
  {
    id: 'san_simeon_2003',
    name: '2003 San Simeon Earthquake',
    year: 2003,
    date: 'December 22, 2003 (11:15 PST)',
    magnitude: 6.6,
    depthKm: 7.6,
    coords: [35.700, -121.100], // Central Coast near Paso Robles
    fault: 'Oceanic Fault Zone',
    distanceMiles: 162.0,
    summary: 'Struck the Santa Lucia Range on the Central Coast, damaging historic unreinforced masonry buildings in Paso Robles and causing hot sulfur springs to erupt into parking lots.',
    shakingIntensity: 'MMI VIII (Severe)',
  },
  {
    id: 'stanley_2020',
    name: '2020 Stanley / Central Idaho Earthquake',
    year: 2020,
    date: 'March 31, 2020 (17:52 MDT)',
    magnitude: 6.5,
    depthKm: 10.0,
    coords: [44.465, -115.118], // Sawtooth Wilderness, Idaho
    fault: 'Sawtooth Fault System',
    distanceMiles: 564.0,
    summary: 'Strike-slip mainshock northwest of Stanley, Idaho felt across 6 Western states and Canada; triggered extensive rockfalls in the Sawtooth Mountains.',
    shakingIntensity: 'MMI VIII (Severe)',
  },
  {
    id: 'monte_cristo_2020',
    name: '2020 Monte Cristo Range Earthquake',
    year: 2020,
    date: 'May 15, 2020 (04:03 PDT)',
    magnitude: 6.5,
    depthKm: 2.7,
    coords: [38.169, -117.850], // Mina Deflection / Tonopah, Nevada
    fault: 'Walker Lane / Mina Deflection Fault Zone',
    distanceMiles: 218.0,
    summary: 'Left-lateral strike-slip rupture near Tonopah, NV; the largest earthquake in Nevada in 66 years, severely cracking Highway 95.',
    shakingIntensity: 'MMI VIII (Severe)',
  },
  {
    id: 'big_bear_1992',
    name: '1992 Big Bear Earthquake',
    year: 1992,
    date: 'June 28, 1992 (08:05 PDT)',
    magnitude: 6.5,
    depthKm: 5.0,
    coords: [34.20, -116.82], // San Bernardino Mountains
    fault: 'Northridge / Helendale Fault stepover',
    distanceMiles: 395.0,
    summary: 'Triggered just 3 hours after the M7.3 Landers earthquake along a conjugate northeast-trending left-lateral fault in the San Bernardino Mountains.',
    shakingIntensity: 'MMI VIII (Severe)',
  },
  {
    id: 'ridgecrest_foreshock_2019',
    name: '2019 Ridgecrest M6.4 Foreshock',
    year: 2019,
    date: 'July 4, 2019 (10:33 PDT)',
    magnitude: 6.4,
    depthKm: 10.5,
    coords: [35.705, -117.508], // Searles Valley / Ridgecrest
    fault: 'Little Lake Fault Zone',
    distanceMiles: 302.0,
    summary: 'Occurred on 4th of July on a northeast-trending fault, triggering thousands of aftershocks and culminating in the M7.1 mainshock 34 hours later.',
    shakingIntensity: 'MMI VIII (Severe)',
  },
  {
    id: 'ferndale_2022',
    name: '2022 Ferndale / Humboldt County Earthquake',
    year: 2022,
    date: 'December 20, 2022 (02:34 PST)',
    magnitude: 6.4,
    depthKm: 17.9,
    coords: [40.530, -124.430], // 12 km WSW of Ferndale
    fault: 'Mendocino Fracture Zone / Gorda Plate',
    distanceMiles: 215.0,
    summary: 'Strike-slip rupture within the subducting Gorda oceanic plate near the Mendocino Triple Junction. Caused liquefaction and shut down the historic Fernbridge on Highway 211.',
    shakingIntensity: 'MMI VIII (Severe)',
  },
  {
    id: 'morgan_hill_1984',
    name: '1984 Morgan Hill Earthquake',
    year: 1984,
    date: 'April 24, 1984 (13:15 PST)',
    magnitude: 6.2,
    depthKm: 8.0,
    coords: [37.310, -121.680], // Calaveras Fault near Mt. Hamilton
    fault: 'Calaveras Fault (Central segment)',
    distanceMiles: 48.3,
    summary: 'Unilateral rupture extending 30 km southward along the Calaveras Fault with severe directivity effects focusing seismic waves into Morgan Hill.',
    shakingIntensity: 'MMI VIII (Severe)',
  },
  {
    id: 'south_napa_2014',
    name: '2014 South Napa Earthquake',
    year: 2014,
    date: 'August 24, 2014 (03:20 PDT)',
    magnitude: 6.0,
    depthKm: 11.1,
    coords: [38.215, -122.312], // 6 km NW of American Canyon
    fault: 'West Napa Fault System',
    distanceMiles: 24.2,
    summary: 'The largest earthquake in the San Francisco Bay Area since Loma Prieta. Surface faulting ruptured through Napa valley vineyards and historic brick architecture in downtown Napa.',
    shakingIntensity: 'MMI VIII (Severe)',
  },
  {
    id: 'parkfield_2004',
    name: '2004 Parkfield Earthquake',
    year: 2004,
    date: 'September 28, 2004 (10:15 PDT)',
    magnitude: 6.0,
    depthKm: 7.9,
    coords: [35.815, -120.374], // San Andreas Fault at Parkfield
    fault: 'San Andreas Fault (Parkfield segment)',
    distanceMiles: 178.0,
    summary: 'The long-awaited characteristic Parkfield event recorded by the dense USGS SAFOD borehole instrumentation array, confirming repeating rupture physics.',
    shakingIntensity: 'MMI VII (Very Strong)',
  },
  {
    id: 'parkfield_1966',
    name: '1966 Parkfield Earthquake',
    year: 1966,
    date: 'June 28, 1966 (20:26 PST)',
    magnitude: 6.0,
    depthKm: 8.9,
    coords: [35.900, -120.500], // San Andreas Fault at Parkfield
    fault: 'San Andreas Fault (Parkfield creeping transition segment)',
    distanceMiles: 171.0,
    summary: 'Part of the famous repeating Parkfield earthquake sequence (1857, 1881, 1901, 1922, 1934, 1966, 2004) that led the USGS to build the SAFOD borehole observatory.',
    shakingIntensity: 'MMI VII (Very Strong)',
  },
  {
    id: 'klamath_1993',
    name: '1993 Klamath Falls Earthquake Sequence',
    year: 1993,
    date: 'September 20, 1993 (20:28 PDT)',
    magnitude: 6.0,
    depthKm: 9.0,
    coords: [42.316, -122.062], // Southern Oregon
    fault: 'West Klamath Lake Fault Zone',
    distanceMiles: 322.0,
    summary: 'Doublet earthquake in southern Oregon damaging historic brick buildings and the Klamath County Courthouse.',
    shakingIntensity: 'MMI VII (Very Strong)',
  },
  {
    id: 'scotts_mills_1993',
    name: '1993 Scotts Mills ("Spring Break") Earthquake',
    year: 1993,
    date: 'March 25, 1993 (05:34 PST)',
    magnitude: 6.0,
    depthKm: 15.0,
    coords: [45.034, -122.607], // Willamette Valley / Mt. Angel, OR
    fault: 'Mount Angel Fault Zone',
    distanceMiles: 472.0,
    summary: 'Struck Western Oregon, damaging the State Capitol building in Salem and historic unreinforced masonry across the Willamette Valley.',
    shakingIntensity: 'MMI VII (Very Strong)',
  },
  {
    id: 'whittier_1987',
    name: '1987 Whittier Narrows Earthquake',
    year: 1987,
    date: 'October 1, 1987 (07:42 PDT)',
    magnitude: 5.9,
    depthKm: 9.5,
    coords: [34.061, -118.080], // San Gabriel Valley / Los Angeles
    fault: 'Puente Hills Blind Thrust Fault System',
    distanceMiles: 338.0,
    summary: 'Revealed the presence of the hazardous Puente Hills blind thrust system beneath downtown Los Angeles, damaging historic Whittier Uptown.',
    shakingIntensity: 'MMI VIII (Severe)',
  },
  {
    id: 'sierra_madre_1991',
    name: '1991 Sierra Madre Earthquake',
    year: 1991,
    date: 'June 28, 1991 (07:43 PDT)',
    magnitude: 5.8,
    depthKm: 12.0,
    coords: [34.26, -118.00], // San Gabriel Mountains / Pasadena
    fault: 'Clamshell-Sawpit Fault Zone',
    distanceMiles: 336.0,
    summary: 'Deep thrust rupture in the San Gabriel Mountains shaking the Los Angeles basin and damaging buildings in Pasadena and Monrovia.',
    shakingIntensity: 'MMI VII (Very Strong)',
  },
  {
    id: 'magna_2020',
    name: '2020 Magna / Salt Lake City Earthquake',
    year: 2020,
    date: 'March 18, 2020 (07:09 MDT)',
    magnitude: 5.7,
    depthKm: 11.9,
    coords: [40.751, -112.078], // Magna / Salt Lake Valley, Utah
    fault: 'Wasatch Fault Zone (Salt Lake City Segment)',
    distanceMiles: 585.0,
    summary: 'The largest earthquake in Utah since 1992; shook Salt Lake City, displaced the trumpet of the Angel Moroni statue on the Salt Lake Temple, and caused $62M in damage.',
    shakingIntensity: 'MMI VIII (Severe)',
  },
  {
    id: 'alum_rock_2007',
    name: '2007 Alum Rock / San Jose Earthquake',
    year: 2007,
    date: 'October 30, 2007 (20:04 PDT)',
    magnitude: 5.6,
    depthKm: 9.2,
    coords: [37.432, -121.776], // Alum Rock / East San Jose
    fault: 'Calaveras Fault Zone',
    distanceMiles: 39.8,
    summary: 'Widely felt across the San Francisco Bay Area and Berkeley Hills; the largest East Bay earthquake since the 1984 Morgan Hill rupture.',
    shakingIntensity: 'MMI VI (Strong)',
  },
];

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

            if (distMi <= 700.0) {
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

  // 1. Dark Matter CartoDB Basemap (Default)
  const darkMatterLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CartoDB & OpenStreetMap',
    maxZoom: 19,
    subdomains: 'abcd',
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

  leafletMap = L.map('radarMap', {
    center: [37.8696, -122.2491],
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
      <span style="color: #38bdf8;">Listening to 700-mile regional seismicity</span>
    </div>
  `);

  // =========================================================================
  // 700-Mile Western North America Fault System Mapping
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

  // 13. Mendocino Fracture Zone & Gorda Plate Boundary
  const mendocinoFracture = [
    [40.35, -124.50], [40.35, -126.50], [40.35, -128.50], [40.35, -130.00]
  ];
  L.polyline(mendocinoFracture, { color: '#06b6d4', weight: 2.5, opacity: 0.85, dashArray: '6, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>Mendocino Fracture Zone / Gorda Plate Boundary</b>');

  // 14. Cascadia Megathrust Subduction Zone (Northern California to Washington)
  const cascadiaMegathrust = [
    [40.35, -124.60], [41.20, -124.70], [42.40, -124.90], [44.00, -124.95],
    [45.50, -124.85], [47.00, -125.10], [48.50, -125.80]
  ];
  L.polyline(cascadiaMegathrust, { color: '#ec4899', weight: 3.2, opacity: 0.9, dashArray: '8, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>Cascadia Megathrust Subduction Zone</b><br>1,000 km convergent boundary capable of M 9.0+ megathrust ruptures.');

  // 15. Blanco Fracture Zone (Oceanic Transform linking Gorda & Juan de Fuca Ridges)
  const blancoFracture = [
    [42.75, -125.50], [43.50, -127.20], [44.20, -129.00], [44.60, -130.50]
  ];
  L.polyline(blancoFracture, { color: '#38bdf8', weight: 2.2, opacity: 0.8, dashArray: '5, 5' })
    .addTo(leafletMap)
    .bindPopup('<b>Blanco Fracture Zone</b><br>Active oceanic transform fault between Gorda and Juan de Fuca plates.');

  // 16. Wasatch Fault Zone (Utah Normal Fault System)
  const wasatchCoords = [
    [39.40, -111.75], [39.90, -111.65], [40.40, -111.75], [40.75, -111.85],
    [41.25, -111.95], [41.80, -112.05], [42.30, -112.10]
  ];
  L.polyline(wasatchCoords, { color: '#a855f7', weight: 2.8, opacity: 0.85, dashArray: '5, 5' })
    .addTo(leafletMap)
    .bindPopup('<b>Wasatch Fault Zone (Utah)</b><br>370-km active normal fault system capable of M 7.0+ ruptures.');

  // 17. Walker Lane Tectonic Belt (Nevada)
  const walkerLaneCoords = [
    [36.80, -116.80], [37.60, -117.40], [38.40, -118.20], [39.20, -119.10],
    [39.90, -119.70], [40.80, -120.30]
  ];
  L.polyline(walkerLaneCoords, { color: '#f59e0b', weight: 2.4, opacity: 0.8, dashArray: '4, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>Walker Lane Tectonic Belt (Nevada)</b><br>Accommodates ~20% of Pacific-North American dextral shear.');

  // 18. Central Nevada Seismic Zone / Fairview Peak Fault
  const cnszCoords = [
    [38.70, -118.20], [39.15, -118.15], [39.60, -118.10], [40.10, -118.00]
  ];
  L.polyline(cnszCoords, { color: '#e11d48', weight: 2.2, opacity: 0.8, dashArray: '4, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>Central Nevada Seismic Zone</b><br>Site of the 1954 Fairview Peak (M7.1) & Dixie Valley (M6.8) ruptures.');

  // 19. Lost River & Sawtooth Faults (Idaho Basin & Range)
  const lostRiverCoords = [
    [43.60, -113.50], [44.00, -113.85], [44.45, -114.15]
  ];
  L.polyline(lostRiverCoords, { color: '#8b5cf6', weight: 2.2, opacity: 0.8, dashArray: '4, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>Lost River Fault Zone (Idaho)</b><br>Source of the 1983 Borah Peak M6.9 earthquake.');

  const sawtoothCoords = [
    [43.85, -114.85], [44.25, -115.00], [44.65, -115.15]
  ];
  L.polyline(sawtoothCoords, { color: '#6366f1', weight: 2.0, opacity: 0.8, dashArray: '4, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>Sawtooth Fault Zone (Idaho)</b><br>Source of the 2020 Stanley M6.5 earthquake.');

  // 20. Imperial & Cerro Prieto Faults (Baja California / Salton Trough)
  const imperialBajaCoords = [
    [33.10, -115.60], [32.80, -115.45], [32.55, -115.30], [32.25, -115.10], [31.95, -114.90]
  ];
  L.polyline(imperialBajaCoords, { color: '#14b8a6', weight: 2.8, opacity: 0.85, dashArray: '6, 4' })
    .addTo(leafletMap)
    .bindPopup('<b>Imperial & Cerro Prieto Fault System (Baja California)</b><br>Connecting the San Andreas Fault to the Gulf of California spreading centers.');

  // 21. Seattle & Portland Hills Faults (Pacific Northwest)
  const seattleFaultCoords = [
    [47.60, -122.65], [47.58, -122.35], [47.54, -122.05], [47.52, -121.80]
  ];
  L.polyline(seattleFaultCoords, { color: '#ef4444', weight: 2.2, opacity: 0.8, dashArray: '3, 3' })
    .addTo(leafletMap)
    .bindPopup('<b>Seattle Fault Zone (Washington)</b><br>Active shallow crustal thrust fault beneath Puget Sound.');

  const portlandFaultCoords = [
    [45.35, -122.55], [45.55, -122.75], [45.75, -122.90]
  ];
  L.polyline(portlandFaultCoords, { color: '#f97316', weight: 2.0, opacity: 0.8, dashArray: '3, 3' })
    .addTo(leafletMap)
    .bindPopup('<b>Portland Hills Fault Zone (Oregon)</b>');

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

  // Radar range rings (10, 25, 50, 100, 250, 500, 700 miles)
  [16.09, 40.23, 80.47, 160.93, 402.33, 804.67, 1126.54].forEach((km, idx) => {
    const labels = ['10 mi', '25 mi', '50 mi', '100 mi', '250 mi', '500 mi', '700 mi'];
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

  updateRadarMap();
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
          <div style="color: #cbd5e1; margin-bottom: 2px;">📍 <b>Distance to Berkeley:</b> ${quake.distanceMiles.toFixed(1)} miles</div>
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
      drawerEl.classList.add('collapsed');
    });
  }

  if (expandBtn && drawerEl) {
    expandBtn.addEventListener('click', () => {
      drawerEl.classList.remove('collapsed');
    });
  }

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
        </div>
      </div>
    `;
  }).join('');

  listEl.innerHTML = html;

  // Attach click listeners to jump map center WITHOUT changing zoom!
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
