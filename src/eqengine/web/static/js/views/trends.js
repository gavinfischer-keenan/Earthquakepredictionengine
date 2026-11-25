/**
 * "Berkeley Pulse" 24H / 7D / 30D Forensics Trends, Predictive Models & Site Normals
 */

import { state } from '../state.js';
import { setBandThresholds } from '../dsp.js';

let currentDays = 7;
let cachedTrends = null;
let lastFetchMs = 0;
let listenersAttached = false;
const hoverStates = {
  ocean: { active: false, x: 0, y: 0 },
  cultural: { active: false, x: 0, y: 0 },
  event: { active: false, x: 0, y: 0 },
};

function setupHiDPICanvas(canvas) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(300, Math.floor(rect.width || 620));
  const h = Math.max(180, Math.floor(rect.height || 230));
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.resetTransform();
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#070b14';
  ctx.fillRect(0, 0, w, h);
  return { ctx, w, h };
}

function attachHover(canvasId, key) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || canvas.dataset.hoverBound) return;
  canvas.dataset.hoverBound = '1';
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    hoverStates[key] = { active: true, x: e.clientX - r.left, y: e.clientY - r.top };
    if (cachedTrends) drawAllTrendCanvases(cachedTrends);
  });
  canvas.addEventListener('mouseleave', () => {
    hoverStates[key].active = false;
    if (cachedTrends) drawAllTrendCanvases(cachedTrends);
  });
}

export async function prefetchBandThresholds() {
  try {
    const res = await fetch('/api/forensics/trends?days=7');
    if (!res.ok) return null;
    const data = await res.json();
    cachedTrends = data;
    lastFetchMs = Date.now();
    if (data?.band_thresholds) {
      state.bandThresholds = data.band_thresholds;
      setBandThresholds(data.band_thresholds);
    }
    return data;
  } catch (err) {
    console.debug('Prefetch trends failed:', err);
    return null;
  }
}

async function loadTrends(days = currentDays, force = false) {
  const now = Date.now();
  if (!force && cachedTrends && days === currentDays && (now - lastFetchMs) < 30000) {
    renderTrendsPayload(cachedTrends);
    return cachedTrends;
  }
  currentDays = days;
  try {
    const res = await fetch(`/api/forensics/trends?days=${days}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cachedTrends = data;
    lastFetchMs = Date.now();
    if (data?.band_thresholds) {
      state.bandThresholds = data.band_thresholds;
      setBandThresholds(data.band_thresholds);
    }
    renderTrendsPayload(data);
    return data;
  } catch (err) {
    const metaEl = document.getElementById('trendsDataSpanMeta');
    if (metaEl) metaEl.textContent = `Unable to load trends (${err.message})`;
    return null;
  }
}

function renderTrendsPayload(data) {
  if (!data) return;
  const sum = data.summary || {};
  const ocean = data.ocean_model || {};
  const cult = data.cultural_model || {};
  const ev = data.event_profiles || {};

  // Header span summary
  const spanEl = document.getElementById('trendsDataSpanMeta');
  if (spanEl) {
    const anchorNote = sum.anchored_to_latest_data ? ' · Latest Logged Window' : '';
    spanEl.textContent = `${sum.total_minutes || 0} min analyzed (${sum.span_hours || 0}h span, ${sum.bucket_minutes || 60}m buckets)${anchorNote}`;
  }

  // KPI 1: Ocean Transfer Model
  const oceanKpiVal = document.getElementById('kpiOceanR2');
  const oceanKpiSub = document.getElementById('kpiOceanDetail');
  if (oceanKpiVal) {
    oceanKpiVal.textContent = ocean.model_ready ? `R² ${Number(ocean.r2 || 0).toFixed(2)}` : 'Learning...';
  }
  if (oceanKpiSub) {
    if (ocean.model_ready) {
      const pred = ocean.live_predicted_nm_s != null ? `Pred: ${ocean.live_predicted_nm_s} nm/s` : `Slope: ${ocean.slope}`;
      const zStr = ocean.live_anomaly_z != null ? ` · z=${ocean.live_anomaly_z >= 0 ? '+' : ''}${ocean.live_anomaly_z}σ` : '';
      oceanKpiSub.textContent = `${pred}${zStr} (${ocean.sample_pairs} pairs)`;
    } else {
      oceanKpiSub.textContent = `Collecting buoy 46026 + microseism pairs (${ocean.sample_pairs || 0}/6)`;
    }
  }

  // KPI 2: Cultural Noise Forecast & Z-Score
  const cultVal = document.getElementById('kpiCulturalStatus');
  const cultSub = document.getElementById('kpiCulturalDetail');
  const anom = cult.live_anomaly || {};
  if (cultVal) {
    const lvl = anom.level || 'NORMAL';
    const zVal = Number(anom.z_score || 0);
    cultVal.textContent = `${lvl} (${zVal >= 0 ? '+' : ''}${zVal.toFixed(1)}σ)`;
  }
  if (cultSub) {
    const expStr = anom.expected_cultural_um_s != null ? `${Number(anom.expected_cultural_um_s).toFixed(2)} µm/s expected` : '--';
    cultSub.textContent = `${expStr} · Quietest ${String(sum.quietest_hour_local ?? 3).padStart(2, '0')}:00 · Busiest ${String(sum.busiest_hour_local ?? 17).padStart(2, '0')}:00`;
  }

  // KPI 3: Blind + Tagged Event Days
  const evVal = document.getElementById('kpiEventDays');
  const evSub = document.getElementById('kpiEventDetail');
  if (evVal) {
    evVal.textContent = `${ev.stadium_event_days_count || 0} Cal · ${ev.concert_event_days_count || 0} Greek`;
  }
  if (evSub) {
    const nextUp = Array.isArray(ev.predicted_event_windows) && ev.predicted_event_windows[0]
      ? `Next: ${ev.predicted_event_windows[0].title}`
      : `Thresholds: ${ev.learned_stadium_threshold_um_s || '--'} / ${ev.learned_concert_threshold_um_s || '--'} µm/s`;
    evSub.textContent = nextUp;
  }

  // KPI 4: Peak Swell & Buoy Summary
  const swellVal = document.getElementById('kpiPeakSwell');
  const swellSub = document.getElementById('kpiPeakSwellDetail');
  if (swellVal) {
    swellVal.textContent = `${sum.peak_ocean_nm_s || 0} nm/s`;
  }
  if (swellSub) {
    swellSub.textContent = `Peak NOAA 46026: ${sum.peak_buoy_wvht_m || 0} m · History: ${sum.total_history_minutes || 0} min`;
  }

  // Learned Site Thresholds Table
  const tbody = document.getElementById('trendsThresholdsBody');
  const thMap = data.band_thresholds || {};
  if (tbody) {
    const entries = Object.entries(thMap);
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#94a3b8;">Awaiting logged forensics history...</td></tr>';
    } else {
      tbody.innerHTML = entries
        .map(([, item]) => {
          const u = item.unit || '';
          return `
            <tr>
              <td><b>${item.label || item.key}</b></td>
              <td><span class="level-pill level-pill-light">≤ ${Number(item.p25 || 0).toFixed(2)} ${u}</span></td>
              <td><span class="level-pill level-pill-normal">${Number(item.p50 || 0).toFixed(2)} ${u}</span></td>
              <td><span class="level-pill level-pill-heavy">${Number(item.p75 || 0).toFixed(2)} ${u}</span></td>
              <td><span class="level-pill level-pill-extreme">&gt; ${Number(item.p95 || 0).toFixed(2)} ${u}</span></td>
              <td style="color:#94a3b8;">${item.sample_count || 0}</td>
            </tr>
          `;
        })
        .join('');
    }
  }

  drawAllTrendCanvases(data);
}

function drawAllTrendCanvases(data) {
  drawOceanCanvas(data.ocean_model || {});
  drawCulturalCanvas(data.cultural_model || {});
  drawEventsCanvas(data.event_profiles || {});
}

function drawOceanCanvas(ocean) {
  const canvas = document.getElementById('pulseOceanCanvas');
  const setup = setupHiDPICanvas(canvas);
  if (!setup) return;
  const { ctx, w, h } = setup;
  const series = Array.isArray(ocean.series) ? ocean.series : [];

  const padL = 48;
  const padR = 46;
  const padT = 24;
  const padB = 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  if (series.length < 2) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Insufficient forensics history points for Buoy vs. Microseism plot.', w / 2, h / 2);
    return;
  }

  let maxNm = 50;
  let maxWv = 2.0;
  series.forEach((pt) => {
    if (pt.ocean_microseism_nm_s > maxNm) maxNm = pt.ocean_microseism_nm_s;
    if (pt.predicted_ocean_nm_s > maxNm) maxNm = pt.predicted_ocean_nm_s;
    if (pt.buoy_wvht_m > maxWv) maxWv = pt.buoy_wvht_m;
  });
  maxNm *= 1.12;
  maxWv *= 1.15;

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach((f) => {
    const y = padT + plotH * f;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
  });

  const drawLine = (getter, color, dashed = false, fillRgba = null) => {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = dashed ? 1.5 : 2.0;
    if (dashed) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    let started = false;
    let firstX = padL;
    let lastX = padL;
    series.forEach((pt, idx) => {
      const val = getter(pt);
      if (val == null || !Number.isFinite(val)) return;
      const maxVal = color === '#fbbf24' ? maxWv : maxNm;
      const x = padL + (idx / (series.length - 1)) * plotW;
      const y = padT + plotH - (val / maxVal) * plotH;
      if (!started) {
        ctx.moveTo(x, y);
        firstX = x;
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
      lastX = x;
    });
    ctx.stroke();
    if (fillRgba && started) {
      ctx.lineTo(lastX, padT + plotH);
      ctx.lineTo(firstX, padT + plotH);
      ctx.closePath();
      ctx.fillStyle = fillRgba;
      ctx.fill();
    }
    ctx.restore();
  };

  drawLine((p) => p.ocean_microseism_nm_s, '#38bdf8', false, 'rgba(56,189,248,0.12)');
  drawLine((p) => p.predicted_ocean_nm_s, '#00ff88', true, null);
  drawLine((p) => p.buoy_wvht_m, '#fbbf24', false, null);

  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.strokeRect(padL, padT, plotW, plotH);

  // Legend
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#38bdf8';
  ctx.fillText('● RS4D Microseism (nm/s)', padL + 4, 15);
  ctx.fillStyle = '#00ff88';
  ctx.fillText('-- Model Predicted', padL + 175, 15);
  ctx.fillStyle = '#fbbf24';
  ctx.fillText('● Buoy 46026 (m)', padL + 305, 15);

  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(maxNm)}`, padL - 5, padT + 9);
  ctx.fillText('0 nm/s', padL - 5, padT + plotH);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fbbf24';
  ctx.fillText(`${maxWv.toFixed(1)}m`, padL + plotW + 5, padT + 9);
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(series[0]?.label || '', padL, padT + plotH + 16);
  ctx.textAlign = 'right';
  ctx.fillText(series[series.length - 1]?.label || '', padL + plotW, padT + plotH + 16);

  const hv = hoverStates.ocean;
  if (hv.active && hv.x >= padL && hv.x <= padL + plotW) {
    const idx = Math.min(series.length - 1, Math.max(0, Math.round(((hv.x - padL) / plotW) * (series.length - 1))));
    const pt = series[idx];
    const cx = padL + (idx / (series.length - 1)) * plotW;
    ctx.strokeStyle = 'rgba(56,189,248,0.6)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, padT);
    ctx.lineTo(cx, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    const text = `${pt.label} · Swell ${pt.ocean_microseism_nm_s ?? '--'} nm/s · Pred ${pt.predicted_ocean_nm_s ?? '--'} · Buoy ${pt.buoy_wvht_m ?? '--'}m`;
    ctx.font = '10px JetBrains Mono, monospace';
    const tw = ctx.measureText(text).width + 14;
    const bx = Math.min(padL + plotW - tw, Math.max(padL, cx - tw / 2));
    ctx.fillStyle = 'rgba(10,15,28,0.92)';
    ctx.fillRect(bx, padT + 4, tw, 18);
    ctx.fillStyle = '#f8fafc';
    ctx.textAlign = 'left';
    ctx.fillText(text, bx + 7, padT + 16);
  }
}

function drawCulturalCanvas(cult) {
  const canvas = document.getElementById('pulseCulturalCanvas');
  const setup = setupHiDPICanvas(canvas);
  if (!setup) return;
  const { ctx, w, h } = setup;
  const wkday = Array.isArray(cult.weekday_profile) ? cult.weekday_profile : [];
  const wknd = Array.isArray(cult.weekend_profile) ? cult.weekend_profile : [];
  const fc = Array.isArray(cult.next_24h_forecast) ? cult.next_24h_forecast : [];

  const padL = 46;
  const padR = 16;
  const padT = 24;
  const padB = 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  if (wkday.length !== 24) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Building 24h Weekday vs Weekend Cultural Diurnal Curves...', w / 2, h / 2);
    return;
  }

  let maxY = 0.5;
  wkday.forEach((p) => {
    const v = (p.cultural_mean || 0) + (p.cultural_std || 0);
    if (v > maxY) maxY = v;
  });
  wknd.forEach((p) => {
    const v = (p.cultural_mean || 0) + (p.cultural_std || 0);
    if (v > maxY) maxY = v;
  });
  fc.forEach((p) => {
    if ((p.upper_1sigma || 0) > maxY) maxY = p.upper_1sigma;
  });
  maxY *= 1.15;

  // Plot ±1σ forecast envelope if present
  if (fc.length === 24) {
    ctx.fillStyle = 'rgba(16, 185, 129, 0.14)';
    ctx.beginPath();
    fc.forEach((p, idx) => {
      const x = padL + (idx / 23) * plotW;
      const y = padT + plotH - ((p.upper_1sigma || 0) / maxY) * plotH;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    for (let idx = 23; idx >= 0; idx--) {
      const x = padL + (idx / 23) * plotW;
      const y = padT + plotH - ((fc[idx].lower_1sigma || 0) / maxY) * plotH;
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }

  const drawCurve = (arr, key, color, dashed = false) => {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = dashed ? 1.6 : 2.2;
    if (dashed) ctx.setLineDash([4, 4]);
    ctx.beginPath();
    arr.forEach((p, idx) => {
      const x = padL + (idx / 23) * plotW;
      const y = padT + plotH - ((p[key] || 0) / maxY) * plotH;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  };

  drawCurve(wkday, 'cultural_mean', '#f59e0b', false);
  if (wknd.length === 24) drawCurve(wknd, 'cultural_mean', '#a78bfa', false);
  if (fc.length === 24) drawCurve(fc, 'predicted_cultural_um_s', '#10b981', true);

  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.strokeRect(padL, padT, plotW, plotH);

  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f59e0b';
  ctx.fillText('● Weekday Curve', padL + 4, 15);
  ctx.fillStyle = '#a78bfa';
  ctx.fillText('● Weekend Curve', padL + 122, 15);
  ctx.fillStyle = '#10b981';
  ctx.fillText('-- Next 24h (±1σ)', padL + 242, 15);

  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'right';
  ctx.fillText(`${maxY.toFixed(2)} µm/s`, padL - 4, padT + 9);
  ctx.textAlign = 'center';
  [0, 6, 12, 18, 23].forEach((hr) => {
    const x = padL + (hr / 23) * plotW;
    ctx.fillText(`${String(hr).padStart(2, '0')}h`, x, padT + plotH + 16);
  });

  const hv = hoverStates.cultural;
  if (hv.active && hv.x >= padL && hv.x <= padL + plotW) {
    const idx = Math.min(23, Math.max(0, Math.round(((hv.x - padL) / plotW) * 23)));
    const wd = wkday[idx] || {};
    const we = wknd[idx] || {};
    const fp = fc[idx] || {};
    const cx = padL + (idx / 23) * plotW;
    ctx.strokeStyle = 'rgba(245,158,11,0.6)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, padT);
    ctx.lineTo(cx, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    const text = `${String(idx).padStart(2, '0')}:00 · Wkday ${Number(wd.cultural_mean || 0).toFixed(2)} · Wknd ${Number(we.cultural_mean || 0).toFixed(2)} · Next +${idx}h ${fp.predicted_level || ''}`;
    ctx.font = '10px JetBrains Mono, monospace';
    const tw = ctx.measureText(text).width + 14;
    const bx = Math.min(padL + plotW - tw, Math.max(padL, cx - tw / 2));
    ctx.fillStyle = 'rgba(10,15,28,0.92)';
    ctx.fillRect(bx, padT + 4, tw, 18);
    ctx.fillStyle = '#f8fafc';
    ctx.textAlign = 'left';
    ctx.fillText(text, bx + 7, padT + 16);
  }
}

function drawEventsCanvas(ev) {
  const canvas = document.getElementById('pulseEventCanvas');
  const setup = setupHiDPICanvas(canvas);
  if (!setup) return;
  const { ctx, w, h } = setup;

  const stadEv = Array.isArray(ev.stadium_event_day) ? ev.stadium_event_day : [];
  const stadBase = Array.isArray(ev.stadium_baseline_day) ? ev.stadium_baseline_day : [];
  const concEv = Array.isArray(ev.concert_event_day) ? ev.concert_event_day : [];
  const concBase = Array.isArray(ev.concert_baseline_day) ? ev.concert_baseline_day : [];

  const padL = 46;
  const padR = 16;
  const padT = 24;
  const padB = 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  if (stadBase.length !== 24 && concBase.length !== 24) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Awaiting Stadium & Concert 24h comparison profiles.', w / 2, h / 2);
    return;
  }

  let maxY = 0.5;
  [...stadEv, ...stadBase, ...concEv, ...concBase].forEach((v) => {
    if (v > maxY) maxY = v;
  });
  maxY *= 1.15;

  const plotArr = (arr, color, dashed = false) => {
    if (arr.length !== 24) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = dashed ? 1.4 : 2.1;
    if (dashed) ctx.setLineDash([4, 4]);
    ctx.beginPath();
    arr.forEach((v, idx) => {
      const x = padL + (idx / 23) * plotW;
      const y = padT + plotH - ((v || 0) / maxY) * plotH;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  };

  plotArr(stadEv, '#fb7185', false);
  plotArr(stadBase, '#64748b', true);
  plotArr(concEv, '#c084fc', false);
  plotArr(concBase, '#475569', true);

  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.strokeRect(padL, padT, plotW, plotH);

  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fb7185';
  ctx.fillText('● Game Day 2–5 Hz', padL + 4, 15);
  ctx.fillStyle = '#c084fc';
  ctx.fillText('● Concert Day 25–45 Hz', padL + 132, 15);
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('-- Non-Event Baseline', padL + 292, 15);

  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'right';
  ctx.fillText(`${maxY.toFixed(2)} µm/s`, padL - 4, padT + 9);
  ctx.textAlign = 'center';
  [0, 6, 12, 18, 23].forEach((hr) => {
    const x = padL + (hr / 23) * plotW;
    ctx.fillText(`${String(hr).padStart(2, '0')}h`, x, padT + plotH + 16);
  });

  const hv = hoverStates.event;
  if (hv.active && hv.x >= padL && hv.x <= padL + plotW) {
    const idx = Math.min(23, Math.max(0, Math.round(((hv.x - padL) / plotW) * 23)));
    const cx = padL + (idx / 23) * plotW;
    ctx.strokeStyle = 'rgba(251,113,133,0.6)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, padT);
    ctx.lineTo(cx, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    const text = `${String(idx).padStart(2, '0')}:00 · Game ${Number(stadEv[idx] || 0).toFixed(2)} vs ${Number(stadBase[idx] || 0).toFixed(2)} · Concert ${Number(concEv[idx] || 0).toFixed(2)}`;
    ctx.font = '10px JetBrains Mono, monospace';
    const tw = ctx.measureText(text).width + 14;
    const bx = Math.min(padL + plotW - tw, Math.max(padL, cx - tw / 2));
    ctx.fillStyle = 'rgba(10,15,28,0.92)';
    ctx.fillRect(bx, padT + 4, tw, 18);
    ctx.fillStyle = '#f8fafc';
    ctx.textAlign = 'left';
    ctx.fillText(text, bx + 7, padT + 16);
  }
}

export function initTrendsView() {
  if (!listenersAttached) {
    document.querySelectorAll('.trends-window-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const d = parseInt(btn.getAttribute('data-days') || '7', 10);
        document.querySelectorAll('.trends-window-btn').forEach((b) => b.classList.toggle('active', b === btn));
        loadTrends(d, true);
      });
    });
    const refreshBtn = document.getElementById('refreshTrendsBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => loadTrends(currentDays, true));
    }
    attachHover('pulseOceanCanvas', 'ocean');
    attachHover('pulseCulturalCanvas', 'cultural');
    attachHover('pulseEventCanvas', 'event');
    listenersAttached = true;
  }
}

export function renderTrendsView() {
  initTrendsView();
  loadTrends(currentDays, false);
}
