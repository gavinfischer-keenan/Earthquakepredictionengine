/**
 * Urban Profiler View: 5-Band Environmental Profiler & Real-World Signal Forensics Engine
 * Monitors & Deduces:
 * 1. Primary Active Source Deduction (Ocean Swell, Vehicle Passby, Rail, Indoor Impact, Concert, Quake)
 * 2. Pacific Ocean Double-Frequency Microseism & Deduced Primary Swell Period (T_swell)
 * 3. Roadway Traffic Doppler (df/dt Hz/s) & 4–8 Hz Rail/BART Harmonic Detection
 * 4. Nakamura Site Resonance (H/V) & Excess Kurtosis Impulsiveness (κ)
 * 5. Interactive 5-Band Spectral Energy History Canvas with Hover Crosshair
 */

import { state } from '../state.js';
import {
  computeEnvironmentalForensics,
  getBandLevel,
  setEnvironmentalIntelligence,
} from '../dsp.js';
import { fetchExternalEvents } from '../external_events_client.js';

const urbanHistory = [];
let hoverState = { active: false, x: 0, y: 0 };
let urbanListenersAttached = false;
let intelControlsAttached = false;
let extControlsAttached = false;
let cachedEnvIntel = null;
let lastIntelFetchMs = 0;
let intelFetchPromise = null;

async function refreshExternalEventsPanel(force = false) {
  const data = await fetchExternalEvents(force);
  if (data) renderExternalEventsPanel(data);
  return data;
}

function formatEventScheduleLabel(ev) {
  if (!ev || !ev.start_ts) return 'No upcoming events cached';
  const dt = new Date(ev.start_ts * 1000);
  const localStr = dt.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const diffHr = (ev.start_ts * 1000 - Date.now()) / 3600000;
  if (ev.status === 'live') return `LIVE NOW · Started ${localStr}`;
  if (diffHr > 0 && diffHr < 48) return `In ${diffHr.toFixed(1)}h · ${localStr}`;
  return localStr;
}

function initExternalEventsControls() {
  if (extControlsAttached) return;
  const btn = document.getElementById('refreshExternalEventsBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Refreshing...';
    try {
      await refreshExternalEventsPanel(true);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
  extControlsAttached = true;
}

function renderExternalEventsPanel(ext) {
  if (!ext) return;

  const corrBadge = document.getElementById('extCorrelationBadge');
  if (corrBadge) {
    const corr = ext.correlation;
    if (corr && corr.matched) {
      corrBadge.textContent = `MATCHED · ${corr.confidence}%`;
      corrBadge.className = 'forensic-badge ext-badge-live';
      corrBadge.title = corr.reason || '';
    } else if (corr && corr.active_event_title) {
      corrBadge.textContent = `LIVE: ${corr.active_category?.toUpperCase() || 'EVENT'}`;
      corrBadge.className = 'forensic-badge ext-badge-upcoming';
      corrBadge.title = corr.reason || '';
    } else {
      corrBadge.textContent = 'MONITORING';
      corrBadge.className = 'forensic-badge';
    }
  }

  // 1. Cal Memorial Stadium
  const cal = ext.next_cal_game;
  const calCard = document.getElementById('extCardCal');
  const calBadge = document.getElementById('extCalBadge');
  const calTitle = document.getElementById('extCalTitle');
  const calMeta = document.getElementById('extCalMeta');
  if (calCard) calCard.classList.toggle('is-live', Boolean(cal && cal.status === 'live'));
  if (cal) {
    if (calBadge) {
      calBadge.textContent = cal.status.toUpperCase();
      calBadge.className = `forensic-badge ${cal.status === 'live' ? 'ext-badge-live' : 'ext-badge-upcoming'}`;
    }
    if (calTitle) calTitle.textContent = cal.title;
    if (calMeta) {
      const detail = cal.metadata?.status_detail ? ` · ${cal.metadata.status_detail}` : '';
      calMeta.textContent = `${formatEventScheduleLabel(cal)}${detail}`;
    }
  } else {
    if (calBadge) {
      calBadge.textContent = 'OFF-SEASON';
      calBadge.className = 'forensic-badge';
    }
    if (calTitle) calTitle.textContent = 'No upcoming home games';
    if (calMeta) calMeta.textContent = 'ESPN CFB schedule synced · 2–5 Hz band';
  }

  // 2. Greek Theatre
  const greek = ext.next_greek_concert;
  const greekCard = document.getElementById('extCardGreek');
  const greekBadge = document.getElementById('extGreekBadge');
  const greekTitle = document.getElementById('extGreekTitle');
  const greekMeta = document.getElementById('extGreekMeta');
  if (greekCard) greekCard.classList.toggle('is-live', Boolean(greek && greek.status === 'live'));
  if (greek) {
    if (greekBadge) {
      const isSoundcheck = greek.status === 'live' && greek.metadata?.phase === 'soundcheck';
      greekBadge.textContent = isSoundcheck ? 'SOUNDCHECK' : greek.status.toUpperCase();
      greekBadge.className = `forensic-badge ${greek.status === 'live' ? 'ext-badge-live' : 'ext-badge-upcoming'}`;
    }
    if (greekTitle) greekTitle.textContent = greek.title;
    if (greekMeta) greekMeta.textContent = `${formatEventScheduleLabel(greek)} · 25–45 Hz sub-bass`;
  } else {
    if (greekBadge) {
      greekBadge.textContent = 'QUIET';
      greekBadge.className = 'forensic-badge';
    }
    if (greekTitle) greekTitle.textContent = 'No scheduled concerts listed';
    if (greekMeta) greekMeta.textContent = 'thegreekberkeley.com · 25–45 Hz band';
  }

  // 3. Berkeley Hills Wind & Weather
  const wx = ext.weather;
  const wxCard = document.getElementById('extCardWeather');
  const wxBadge = document.getElementById('extWeatherBadge');
  const wxTitle = document.getElementById('extWeatherTitle');
  const wxMeta = document.getElementById('extWeatherMeta');
  const wxHot = wx && (wx.regime === 'GUSTY' || wx.regime === 'STORM');
  if (wxCard) wxCard.classList.toggle('is-live', Boolean(wxHot));
  if (wx) {
    if (wxBadge) {
      wxBadge.textContent = wx.regime;
      wxBadge.className = `forensic-badge ${wxHot ? 'ext-badge-live' : ''}`;
    }
    if (wxTitle) wxTitle.textContent = `${wx.wind_speed_mph} mph ${wx.wind_direction_cardinal} (gusts ${wx.wind_gusts_mph})`;
    if (wxMeta) {
      const tempStr = wx.temperature_c != null ? `${wx.temperature_c}°C` : '--°C';
      const presStr = wx.pressure_hpa != null ? `${wx.pressure_hpa} hPa` : '-- hPa';
      wxMeta.textContent = `${tempStr} · ${presStr} · Rain ${wx.precipitation_mm} mm`;
    }
  }

  // 4. BART Berkeley Hills Tunnel
  const bart = ext.bart;
  const bartCard = document.getElementById('extCardBart');
  const bartBadge = document.getElementById('extBartBadge');
  const bartTitle = document.getElementById('extBartTitle');
  const bartMeta = document.getElementById('extBartMeta');
  if (bartCard) bartCard.classList.toggle('is-live', Boolean(bart && bart.tunnel_active));
  if (bart) {
    if (bartBadge) {
      bartBadge.textContent = bart.tunnel_active ? `${bart.trains_imminent_count} IN TUNNEL` : 'CLEAR';
      bartBadge.className = `forensic-badge ${bart.tunnel_active ? 'ext-badge-live' : ''}`;
    }
    const nextTrain = Array.isArray(bart.next_trains) && bart.next_trains.length > 0 ? bart.next_trains[0] : null;
    if (bartTitle) {
      bartTitle.textContent = nextTrain
        ? `${nextTrain.station} → ${nextTrain.destination} (${nextTrain.minutes === 0 ? 'Leaving' : `${nextTrain.minutes}m`})`
        : 'No imminent trains';
    }
    if (bartMeta) {
      const upcoming = (bart.next_trains || [])
        .slice(1, 3)
        .map((t) => `${t.station} ${t.minutes === 0 ? 'Now' : `${t.minutes}m`}`)
        .join(' · ');
      bartMeta.textContent = upcoming ? `Next: ${upcoming} · 4–8 Hz rail band` : 'DBRK & ROCK live ETD · 4–8 Hz band';
    }
  }

  // 5. Overhead Aircraft / Helicopter (airplanes.live ADS-B)
  const air = ext.aircraft;
  const airCard = document.getElementById('extCardAircraft');
  const airBadge = document.getElementById('extAircraftBadge');
  const airTitle = document.getElementById('extAircraftTitle');
  const airMeta = document.getElementById('extAircraftMeta');
  const lowCount = Number(air?.low_overhead_count || 0);
  const hasAir = Boolean(air && lowCount > 0);
  if (airCard) airCard.classList.toggle('is-live', hasAir);
  if (air) {
    const closest = air.closest_aircraft || (Array.isArray(air.aircraft) && air.aircraft[0]) || null;
    if (airBadge) {
      if (air.helicopter_overhead) {
        airBadge.textContent = `HELI OVERHEAD (${lowCount})`;
        airBadge.className = 'forensic-badge ext-badge-live';
      } else if (hasAir) {
        airBadge.textContent = `LOW AIR (${lowCount})`;
        airBadge.className = 'forensic-badge ext-badge-upcoming';
      } else {
        airBadge.textContent = 'CLEAR';
        airBadge.className = 'forensic-badge';
      }
    }
    if (airTitle) {
      if (closest) {
        const icon = closest.is_helicopter ? '🚁' : '✈️';
        const altStr = closest.altitude_ft != null ? `${Math.round(closest.altitude_ft).toLocaleString()} ft` : '-- ft';
        airTitle.textContent = `${icon} ${closest.callsign || closest.hex_id || 'Aircraft'} (${closest.aircraft_type || 'UNK'}) · ${altStr}`;
      } else {
        airTitle.textContent = 'No low aircraft nearby';
      }
    }
    if (airMeta) {
      airMeta.textContent = closest
        ? `${Number(closest.distance_km || 0).toFixed(1)} km away · 10–35 Hz acoustic comb`
        : 'airplanes.live ADS-B · 10–35 Hz acoustic band';
    }
  }
}

async function fetchEnvironmentalIntelligence(force = false) {
  const nowMs = Date.now();
  if (!force && intelFetchPromise) return intelFetchPromise;
  if (!force && cachedEnvIntel && nowMs - lastIntelFetchMs < 30000) return cachedEnvIntel;

  intelFetchPromise = fetch('/api/environmental-intelligence')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data) {
        cachedEnvIntel = data;
        lastIntelFetchMs = Date.now();
        setEnvironmentalIntelligence(data);
        renderQuietHunterPanel(data);
      }
      return data;
    })
    .catch(() => null)
    .finally(() => {
      intelFetchPromise = null;
    });

  return intelFetchPromise;
}

function initQuietHunterControls() {
  if (intelControlsAttached) return;
  const calBtn = document.getElementById('calibrateBaselineBtn');
  if (!calBtn) return;

  calBtn.addEventListener('click', async () => {
    const origText = calBtn.textContent;
    calBtn.disabled = true;
    calBtn.textContent = '⏳ Hunting Quiet Window...';
    try {
      const res = await fetch('/api/environmental/calibrate', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data && data.intelligence) {
          cachedEnvIntel = data.intelligence;
          lastIntelFetchMs = Date.now();
          setEnvironmentalIntelligence(data.intelligence);
          renderQuietHunterPanel(data.intelligence);
        }
      } else {
        const metaEl = document.getElementById('quietBaselineMeta');
        if (metaEl) metaEl.textContent = 'Need at least 20s of EHZ telemetry before calibrating.';
      }
    } catch {
      const metaEl = document.getElementById('quietBaselineMeta');
      if (metaEl) metaEl.textContent = 'Calibration request failed — check engine connection.';
    } finally {
      calBtn.disabled = false;
      calBtn.textContent = origText;
    }
  });
  intelControlsAttached = true;
}

function renderQuietHunterPanel(intel) {
  const qh = intel ? intel.quiet_hunter : null;
  if (!qh) return;

  const badgeEl = document.getElementById('quietWindowBadge');
  if (badgeEl) {
    const winLabel = qh.discovered_window_local || '02:00–04:00 PST';
    badgeEl.textContent = qh.is_in_quiet_window ? `${winLabel} · ACTIVE` : winLabel;
    badgeEl.classList.toggle('in-window', Boolean(qh.is_in_quiet_window));
  }

  const metaEl = document.getElementById('quietBaselineMeta');
  if (metaEl) {
    const base = qh.baseline;
    if (base) {
      const floorStr = base.ehz_rms_counts != null ? `${Number(base.ehz_rms_counts).toFixed(1)} cts` : '--';
      const curStr = qh.current_ehz_rms_counts != null ? `${Number(qh.current_ehz_rms_counts).toFixed(1)} cts` : '--';
      const ratioStr = qh.noise_ratio != null ? ` (${Number(qh.noise_ratio).toFixed(2)}x)` : '';
      const calTime = base.calibrated_local_time || (base.calibrated_at_utc ? base.calibrated_at_utc.slice(11, 16) + ' UTC' : 'recent');
      metaEl.textContent = `Floor: ${floorStr} · Live: ${curStr}${ratioStr} · Calibrated ${calTime} (#${qh.calibration_count || 1})`;
    } else {
      metaEl.textContent = `Tracking 24h diurnal noise (${qh.current_local_time || 'Local'}) — awaiting first quiet calibration...`;
    }
  }

  renderQuietHuntChart(qh);
}

function renderQuietHuntChart(qh) {
  const canvas = document.getElementById('quietHuntCanvas');
  if (!canvas || !qh || !Array.isArray(qh.hourly_profile) || qh.hourly_profile.length === 0) return;

  const rect = canvas.getBoundingClientRect();
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  if (w <= 0 || h <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  const ctx = canvas.getContext('2d');
  ctx.resetTransform();
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#060913';
  ctx.fillRect(0, 0, w, h);

  const series = qh.hourly_profile;
  const maxVal = Math.max(0.05, ...series.map((s) => s.effective_cultural_um_s || 0)) * 1.15;
  const bestStart = qh.best_start_hour_local ?? 2;
  const quietPair = new Set([bestStart, (bestStart + 1) % 24]);
  const curHour = qh.current_local_hour;

  const padL = 8;
  const padR = 8;
  const padT = 14;
  const padB = 16;
  const pW = Math.max(w - padL - padR, 20);
  const pH = Math.max(h - padT - padB, 16);
  const stepX = pW / 24;
  const barW = Math.max(3, stepX - 3);

  ctx.font = '700 8px "JetBrains Mono", monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('24H CULTURAL NOISE PROFILE (PST)', padL, 3);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#00ff88';
  ctx.fillText('QUIET', w - padR, 3);

  series.forEach((item, idx) => {
    const val = item.effective_cultural_um_s || 0;
    const barH = Math.max(2, (val / maxVal) * pH);
    const x = padL + idx * stepX + 1.5;
    const y = padT + pH - barH;

    const isQuiet = quietPair.has(item.hour);
    const isObs = item.source === 'observed';
    const isNow = item.hour === curHour;

    if (isQuiet) {
      ctx.fillStyle = isObs ? 'rgba(0, 255, 136, 0.85)' : 'rgba(0, 255, 136, 0.42)';
    } else {
      ctx.fillStyle = isObs ? 'rgba(148, 163, 184, 0.72)' : 'rgba(71, 85, 105, 0.35)';
    }
    ctx.fillRect(x, y, barW, barH);

    if (isNow) {
      ctx.strokeStyle = '#00d2ff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 0.5, y - 0.5, barW + 1, barH + 1);
    }

    if (idx % 6 === 0 || idx === 23) {
      ctx.fillStyle = isNow ? '#00d2ff' : '#64748b';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.fillText(`${String(item.hour).padStart(2, '0')}`, x + barW / 2, padT + pH + 3);
    }
  });
}

function initUrbanHover(canvas) {
  if (urbanListenersAttached || !canvas) return;
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    hoverState.active = true;
    hoverState.x = e.clientX - rect.left;
    hoverState.y = e.clientY - rect.top;
  });
  canvas.addEventListener('mouseleave', () => {
    hoverState.active = false;
  });
  urbanListenersAttached = true;
}

export function renderUrbanProfiler() {
  initQuietHunterControls();
  initExternalEventsControls();
  fetchEnvironmentalIntelligence(false);
  refreshExternalEventsPanel(false);

  const ehzBuf = state.buffers.EHZ;
  if (!ehzBuf || ehzBuf.length < 64) return;

  const staLta = (state.staLtaRatios && state.staLtaRatios.EHZ) || 1.0;
  const forensics = computeEnvironmentalForensics(state.buffers, staLta);
  if (!forensics) return;

  const {
    wind: pWind,
    stadium: pStadium,
    traffic: pTraffic,
    human: pHuman,
    concert: pConcert,
  } = forensics.bands;

  function updateCard(key, power, maxPower, levels) {
    const fillEl = document.getElementById(`envFill${key}`);
    const valEl = document.getElementById(`envVal${key}`);
    const levelEl = document.getElementById(`envLevel${key}`);
    const badgeEl = document.getElementById(`envBadge${key}`);

    const pct = Math.min(Math.max((power / maxPower) * 100, 2), 100);
    if (fillEl) fillEl.style.width = `${pct}%`;

    const valMicro = (power * 0.05).toFixed(2);
    if (valEl) valEl.textContent = valMicro;

    let chosenLevel = levels[0];
    for (const lvl of levels) {
      if (pct >= lvl.minPct) chosenLevel = lvl;
    }

    const learned = getBandLevel(key.toLowerCase(), Number(valMicro));
    if (levelEl) {
      levelEl.textContent = learned ? `${chosenLevel.desc} · Site: ${learned.level}` : chosenLevel.desc;
    }
    if (badgeEl) {
      badgeEl.textContent = chosenLevel.badge;
      badgeEl.style.color = chosenLevel.color;
      badgeEl.style.borderColor = chosenLevel.color;
      if (learned) badgeEl.title = `Learned site tier: ${learned.level} (p25/p75/p95)`;
    }
  }

  updateCard('Stadium', pStadium, 50, [
    { minPct: 0, badge: 'QUIET', desc: 'Baseline / Empty Field', color: '#64748b' },
    { minPct: 30, badge: 'ACTIVITY', desc: 'Practice / Crowd Noise', color: '#fb7185' },
    { minPct: 65, badge: 'ROARING', desc: 'Game Touchdown / Surge', color: '#f43f5e' },
  ]);

  updateCard('Concert', pConcert, 35, [
    { minPct: 0, badge: 'IDLE', desc: 'No Live Audio', color: '#64748b' },
    { minPct: 35, badge: 'SOUNDCHECK', desc: 'Sub-Bass Resonance', color: '#c084fc' },
    { minPct: 70, badge: 'LIVE CONCERT', desc: 'Heavy Bass Acoustic Coupling', color: '#e879f9' },
  ]);

  updateCard('Traffic', pTraffic, 45, [
    { minPct: 0, badge: 'LIGHT', desc: 'Normal Residential', color: '#64748b' },
    { minPct: 40, badge: 'MODERATE', desc: 'Bus / Delivery Truck', color: '#fbbf24' },
    { minPct: 75, badge: 'HEAVY', desc: 'Highway 24 Traffic Surge', color: '#f59e0b' },
  ]);

  updateCard('Human', pHuman, 40, [
    { minPct: 0, badge: 'QUIET', desc: 'Idle / Still', color: '#64748b' },
    { minPct: 35, badge: 'MOTION', desc: 'Footsteps / Floor Impacts', color: '#34d399' },
    { minPct: 70, badge: 'TRANSIENT', desc: 'Door Slam / Stair Impact', color: '#10b981' },
  ]);

  updateCard('Wind', pWind, 30, [
    { minPct: 0, badge: 'CALM', desc: 'Light Breeze (<5 mph)', color: '#64748b' },
    { minPct: 40, badge: 'BREEZY', desc: 'Canopy & Tree Sway', color: '#60a5fa' },
    { minPct: 75, badge: 'GUSTING', desc: 'High Wind / Ridge Gusts', color: '#38bdf8' },
  ]);

  // -------------------------------------------------------------------------
  // Update Real-World Signal Forensics & Source Deductor Panel
  // -------------------------------------------------------------------------
  const srcBadge = document.getElementById('forensicPrimaryBadge');
  const srcTitle = document.getElementById('forensicPrimaryTitle');
  const srcDetail = document.getElementById('forensicPrimaryDetail');
  if (srcBadge) {
    srcBadge.textContent = `${forensics.primarySource.confidence}% CONF`;
    srcBadge.style.color = forensics.primarySource.color;
    srcBadge.style.borderColor = forensics.primarySource.color;
  }
  if (srcTitle) {
    srcTitle.textContent = `${forensics.primarySource.icon} ${forensics.primarySource.label}`;
    srcTitle.style.color = forensics.primarySource.color;
  }
  if (srcDetail) srcDetail.textContent = forensics.primarySource.detail;

  const oceanPeriodEl = document.getElementById('forensicOceanPeriod');
  const oceanMetaEl = document.getElementById('forensicOceanMeta');
  const buoyBadgeEl = document.getElementById('forensicBuoyBadge');
  const buoyDetailEl = document.getElementById('forensicBuoyDetail');
  if (oceanPeriodEl) {
    oceanPeriodEl.textContent = `${forensics.ocean.swellPeriodSec.toFixed(1)}s Swell`;
  }
  if (oceanMetaEl) {
    oceanMetaEl.textContent = `${forensics.ocean.peakFreqHz.toFixed(2)} Hz microseism · ${forensics.ocean.ampNmS.toFixed(0)} nm/s (${forensics.ocean.state})`;
  }

  if (buoyBadgeEl || buoyDetailEl) {
    const buoy = forensics.buoy;
    if (buoy && (buoy.dpd_s != null || buoy.apd_s != null || buoy.wvht_m != null)) {
      const refPeriod = buoy.dpd_s ?? buoy.apd_s;
      let matchPct = forensics.correlation ? forensics.correlation.match_pct : 0;
      if (refPeriod != null && refPeriod > 0) {
        const dt = Math.abs(forensics.ocean.swellPeriodSec - refPeriod);
        matchPct = Math.max(0, Math.min(100, Math.round(100.0 * Math.exp(-((dt / 3.5) ** 2)))));
      }
      const matchColor = matchPct >= 70 ? '#00ff88' : matchPct >= 40 ? '#00d2ff' : '#f59e0b';
      if (buoyBadgeEl) {
        buoyBadgeEl.textContent = `${buoy.buoy_id} · ${matchPct}% 2f`;
        buoyBadgeEl.style.color = matchColor;
        buoyBadgeEl.style.borderColor = matchColor;
      }
      if (buoyDetailEl) {
        const wvStr = buoy.wvht_m != null ? `${buoy.wvht_m}m (${buoy.wvht_ft ?? (buoy.wvht_m * 3.28084).toFixed(1)}ft)` : '--m';
        const perStr = refPeriod != null ? `@ ${refPeriod}s` : '';
        const dirStr = buoy.mwd_cardinal ? ` ${buoy.mwd_cardinal}` : '';
        const windStr = buoy.wspd_mps != null ? ` · Wind ${buoy.wspd_mps} m/s` : '';
        buoyDetailEl.textContent = `NOAA ${buoy.buoy_id} (${buoy.name || 'SF Bar'}): ${wvStr} ${perStr}${dirStr}${windStr}`;
      }
    } else if (buoyDetailEl) {
      buoyDetailEl.textContent = 'Awaiting live NOAA NDBC buoy 46026 telemetry...';
    }
  }

  if (cachedEnvIntel) {
    renderQuietHunterPanel(cachedEnvIntel);
  }

  const dopplerEl = document.getElementById('forensicDopplerState');
  const dopplerMetaEl = document.getElementById('forensicDopplerMeta');
  if (dopplerEl) {
    dopplerEl.textContent = forensics.traffic.dopplerState;
    dopplerEl.style.color =
      forensics.traffic.dopplerState.includes('Approaching')
        ? '#f59e0b'
        : forensics.traffic.dopplerState.includes('Receding')
          ? '#38bdf8'
          : '#94a3b8';
  }
  if (dopplerMetaEl) {
    const railNote = forensics.traffic.railLikely ? ' · 🚇 4–8 Hz Rail Harmonic' : '';
    dopplerMetaEl.textContent = `Centroid ${forensics.traffic.centroidHz.toFixed(1)} Hz · Azimuth ${Math.round(forensics.polarization.azimuthDeg)}°${railNote}`;
  }

  const hvEl = document.getElementById('forensicHvKurtosis');
  const hvMetaEl = document.getElementById('forensicHvMeta');
  if (hvEl) {
    hvEl.textContent = `κ = ${forensics.kurtosis.toFixed(2)} · ${forensics.impulseClass}`;
  }
  if (hvMetaEl) {
    const hvStr =
      forensics.hv.peakFreqHz > 0
        ? `H/V f₀=${forensics.hv.peakFreqHz.toFixed(1)} Hz (${forensics.hv.peakRatio.toFixed(1)}x)`
        : 'H/V calibrating';
    hvMetaEl.textContent = `${hvStr} · Linear ${Math.round(forensics.polarization.rectilinearityPct)}%`;
  }

  // -------------------------------------------------------------------------
  // Maintain Real 5-Minute Rolling History (sampled every 0.5s)
  // -------------------------------------------------------------------------
  const now = Date.now() / 1000;
  if (!renderUrbanProfiler._lastHistory || now - renderUrbanProfiler._lastHistory >= 0.5) {
    if (urbanHistory.length === 0) {
      urbanHistory.push({
        time: now - 0.5,
        wind: pWind,
        stadium: pStadium,
        traffic: pTraffic,
        steps: pHuman,
        concert: pConcert,
      });
    }
    urbanHistory.push({
      time: now,
      wind: pWind,
      stadium: pStadium,
      traffic: pTraffic,
      steps: pHuman,
      concert: pConcert,
    });
    if (urbanHistory.length > 600) urbanHistory.shift();
    renderUrbanProfiler._lastHistory = now;
  }

  // -------------------------------------------------------------------------
  // Render Real-Time 5-Band Spectral Energy History Canvas
  // -------------------------------------------------------------------------
  const canvas = document.getElementById('envEnergyCanvas') || document.getElementById('urbanHistoryCanvas');
  if (!canvas) return;
  initUrbanHover(canvas);

  const rect = canvas.getBoundingClientRect();
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  if (w <= 0 || h <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  const ctx = canvas.getContext('2d');
  ctx.resetTransform();
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#060913';
  ctx.fillRect(0, 0, w, h);

  const compact = w < 640;
  const bands = [
    { key: 'stadium', color: '#f43f5e', icon: '🏈', label: compact ? 'Stadium 2–5Hz' : 'Cal Stadium (2–5 Hz)' },
    { key: 'concert', color: '#c084fc', icon: '🎸', label: compact ? 'Sub-Bass 25–45Hz' : 'Greek Theatre (25–45 Hz)' },
    { key: 'traffic', color: '#f59e0b', icon: '🚛', label: compact ? 'Traffic 8–14Hz' : 'Roadway Traffic (8–14 Hz)' },
    { key: 'steps', color: '#10b981', icon: '🏃', label: compact ? 'Impacts 15–24Hz' : 'Indoor Impacts (15–24 Hz)' },
    { key: 'wind', color: '#38bdf8', icon: '💨', label: compact ? 'Wind 0.1–0.5Hz' : 'Wind / Sway (0.1–0.5 Hz)' },
  ];

  // Layout wrapping legend pills FIRST so padT adapts dynamically
  const padL = compact ? 42 : 48;
  const padR = 14;
  ctx.font = compact ? 'bold 8.5px "JetBrains Mono", monospace' : 'bold 9px "JetBrains Mono", monospace';
  const pillH = 18;
  const pillGap = 6;
  const maxLegendX = w - padR;
  let curX = padL;
  let curRow = 0;
  const pillLayout = [];

  bands.forEach((b) => {
    const text = `${b.icon} ${b.label}`;
    const pillW = Math.ceil(ctx.measureText(text).width) + 18;
    if (curX > padL && curX + pillW > maxLegendX) {
      curX = padL;
      curRow++;
    }
    pillLayout.push({ band: b, text, x: curX, row: curRow, w: pillW });
    curX += pillW + pillGap;
  });

  const legendRows = curRow + 1;
  const padT = 8 + legendRows * (pillH + 4) + 6;
  const padB = 24;
  const pW = Math.max(w - padL - padR, 40);
  const pH = Math.max(h - padT - padB, 40);

  let maxEnergy = 1.0;
  for (let i = 0; i < urbanHistory.length; i++) {
    const item = urbanHistory[i];
    maxEnergy = Math.max(maxEnergy, item.wind, item.stadium, item.traffic, item.steps, item.concert);
  }
  const displayMax = Math.max(maxEnergy * 1.35, 2.0);

  // Y-Axis Gridlines
  ctx.font = '8.5px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const gridSteps = 4;
  for (let g = 0; g <= gridSteps; g++) {
    const val = (displayMax * g) / gridSteps;
    const y = padT + pH - (g / gridSteps) * pH;

    ctx.strokeStyle = g === 0 ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + pW, y);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.fillText((val * 0.05).toFixed(1), padL - 6, y);
  }

  ctx.save();
  ctx.translate(12, padT + pH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Energy (µm/s)', 0, 0);
  ctx.restore();

  // X-Axis Time Ticks
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const oldestTime = urbanHistory[0].time;
  const spanMin = Math.max(0.5, (now - oldestTime) / 60.0);
  const timeLabels = [
    { ratio: 0.0, label: `-${spanMin.toFixed(1)}m` },
    { ratio: 0.5, label: `-${(spanMin * 0.5).toFixed(1)}m` },
    { ratio: 1.0, label: 'Now' },
  ];
  if (!compact) {
    timeLabels.splice(1, 0, { ratio: 0.25, label: `-${(spanMin * 0.75).toFixed(1)}m` });
    timeLabels.splice(3, 0, { ratio: 0.75, label: `-${(spanMin * 0.25).toFixed(1)}m` });
  }
  timeLabels.forEach((tl) => {
    const x = padL + tl.ratio * pW;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.moveTo(x, padT + pH);
    ctx.lineTo(x, padT + pH + 4);
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.fillText(tl.label, x, padT + pH + 6);
  });

  // Draw Curves
  const n = urbanHistory.length;
  if (n >= 2) {
    const stepX = pW / Math.max(n - 1, 1);

    bands.forEach((b) => {
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 2.0;
      ctx.beginPath();

      let lastX = padL;
      let lastY = padT + pH;

      for (let i = 0; i < n; i++) {
        const x = padL + i * stepX;
        const val = urbanHistory[i][b.key] || 0;
        const ratio = Math.min(Math.max(val / displayMax, 0), 1.0);
        const y = padT + pH - ratio * pH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        if (i === n - 1) {
          lastX = x;
          lastY = y;
        }
      }
      ctx.stroke();

      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(lastX, lastY, 3.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    });
  }

  // Draw Wrapped Legend Pills
  ctx.font = compact ? 'bold 8.5px "JetBrains Mono", monospace' : 'bold 9px "JetBrains Mono", monospace';
  ctx.textBaseline = 'middle';
  pillLayout.forEach(({ band: b, text, x, row, w: pillW }) => {
    const pillY = 6 + row * (pillH + 4);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.beginPath();
    ctx.roundRect(x, pillY, pillW, pillH, 4);
    ctx.fill();
    ctx.strokeStyle = `${b.color}80`;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(x + 8, pillY + pillH / 2, 3.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = b.color;
    ctx.textAlign = 'left';
    ctx.fillText(text, x + 14, pillY + pillH / 2 + 0.5);
  });

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(padL, padT, pW, pH);

  // Interactive Hover Crosshair
  if (
    hoverState.active &&
    n >= 2 &&
    hoverState.x >= padL &&
    hoverState.x <= padL + pW &&
    hoverState.y >= padT &&
    hoverState.y <= padT + pH
  ) {
    const idx = Math.min(n - 1, Math.max(0, Math.round(((hoverState.x - padL) / pW) * (n - 1))));
    const item = urbanHistory[idx];
    const x = padL + (idx / Math.max(n - 1, 1)) * pW;

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + pH);
    ctx.stroke();
    ctx.setLineDash([]);

    const tStr = new Date(item.time * 1000).toISOString().substring(11, 19);
    const lines = [
      `${tStr} UTC`,
      `🏈 ${(item.stadium * 0.05).toFixed(2)}  🚛 ${(item.traffic * 0.05).toFixed(2)}  💨 ${(item.wind * 0.05).toFixed(2)}`,
      `🏃 ${(item.steps * 0.05).toFixed(2)}  🎸 ${(item.concert * 0.05).toFixed(2)} µm/s`,
    ];
    ctx.font = '600 9.5px JetBrains Mono, monospace';
    const boxW = Math.min(pW - 8, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16);
    const boxH = 52;
    const boxX = x + 10 + boxW > padL + pW ? Math.max(padL + 4, x - boxW - 10) : x + 10;
    const boxY = padT + 8;

    ctx.fillStyle = 'rgba(10, 15, 28, 0.92)';
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 5);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#38bdf8';
    ctx.fillText(lines[0], boxX + 8, boxY + 6);
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(lines[1], boxX + 8, boxY + 21);
    ctx.fillText(lines[2], boxX + 8, boxY + 35);
  }
}
