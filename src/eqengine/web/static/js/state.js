/**
 * Central Reactive State Store & Geophysical Constants
 * EarthquakePredictionEngine - Seismic Early Warning System
 */

export const SAMPLING_RATE = 100;
export const MAX_BUFFER_SECONDS = 120;
export const MAX_SAMPLES = SAMPLING_RATE * MAX_BUFFER_SECONDS; // 12,000 samples per channel

export const CHANNELS = ['EHZ', 'ENZ', 'ENN', 'ENE'];

export const CH_COLORS = {
  EHZ: '#00ff88',
  ENZ: '#00d2ff',
  ENN: '#ffaa00',
  ENE: '#d080ff',
};

export const state = {
  connected: false,
  paused: false,
  lastPausedTimestamp: null,
  activeTab: 'traces',
  audioEnabled: false,
  latestStreamTimestamp: 0.0,
  lastPacketArrivalLocalMs: 0,

  // User controls
  windowSec: 30,
  filterMode: 'bandpass',
  gainMode: 'auto',

  // Channel visibility toggles
  visibleChannels: {
    EHZ: true,
    ENZ: true,
    ENN: true,
    ENE: true,
  },

  // Ring buffers for live streaming waveforms
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

  // Rolling 4-minute ambient baseline statistics for anomaly detection
  fourMinStats: {
    EHZ: { baselineAmp: 35, history: [] },
    ENZ: { baselineAmp: 20, history: [] },
    ENN: { baselineAmp: 20, history: [] },
    ENE: { baselineAmp: 20, history: [] },
  },

  // Live STA/LTA ratios and history
  staLtaRatios: { EHZ: 1.0, ENZ: 1.0, ENN: 1.0, ENE: 1.0 },
  staLtaHistory: [],

  // Events, triggers, and external USGS quakes
  triggers: [],
  alerts: [],
  usgsEvents: [],
  allEvents: [],

  // Table sorting states
  sortColumn: 'timestamp',
  sortDirection: 'desc',
  mlSortColumn: 'timestamp',
  mlSortDirection: 'desc',

  // Session & Helicorder data
  sessionStartTime: Date.now() / 1000,
  helicorderMinutePeaks: {},

  // ML Ground-truth dataset records
  mlEvents: [],

  // Active HUD alerts
  activeAlert: null,
  sWaveTimerInterval: null,
  incomingTimerInterval: null,
};
