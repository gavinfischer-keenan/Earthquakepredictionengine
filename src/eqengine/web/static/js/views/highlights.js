/**
 * Shake Highlights ("Notable Moments") Strip & Quake Archive Replay Modal
 */

let highlightsTimer = null;
let lastReplayPayload = null;

function formatUtcShort(tsSec) {
  if (!tsSec) return '--:-- UTC';
  return new Date(tsSec * 1000).toISOString().substring(11, 19) + ' UTC';
}

function getModalEls() {
  return {
    modal: document.getElementById('quakeReplayModal'),
    title: document.getElementById('replayModalTitle'),
    subtitle: document.getElementById('replayModalSubtitle'),
    verdictBadge: document.getElementById('replayVerdictBadge'),
    snrStat: document.getElementById('replaySnrStat'),
    peakStat: document.getElementById('replayPeakStat'),
    noiseStat: document.getElementById('replayNoiseStat'),
    canvas: document.getElementById('replayWaveformCanvas'),
    closeBtn: document.getElementById('closeReplayModalBtn'),
  };
}

function drawReplayWaveform(payload) {
  const { canvas } = getModalEls();
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const w = Math.max(320, Math.floor(rect.width || 680));
  const h = Math.max(180, Math.floor(rect.height || 240));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);

  const ctx = canvas.getContext('2d');
  ctx.resetTransform();
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#070b14';
  ctx.fillRect(0, 0, w, h);

  const padL = 46;
  const padR = 16;
  const padT = 22;
  const padB = 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const midY = padT + plotH / 2;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, midY);
  ctx.lineTo(padL + plotW, midY);
  ctx.stroke();

  const samples = Array.isArray(payload?.samples) ? payload.samples : [];
  const times = Array.isArray(payload?.times) ? payload.times : [];

  if (samples.length < 2 || times.length !== samples.length) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      payload?.verdict === 'NO ARCHIVE DATA'
        ? 'No archived MiniSEED waveform available for this timestamp window.'
        : 'Loading waveform clip...',
      w / 2,
      h / 2,
    );
    return;
  }

  const tMin = times[0];
  const tMax = times[times.length - 1];
  const tSpan = Math.max(0.1, tMax - tMin);

  let maxAbs = 1.0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const yScale = (plotH * 0.44) / maxAbs;

  // Draw waveform
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const x = padL + ((times[i] - tMin) / tSpan) * plotW;
    const y = midY - samples[i] * yScale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Draw theoretical arrival cursors if present
  const cursors = [
    { key: 'p_arrival', label: 'P-Wave', color: '#38bdf8' },
    { key: 's_arrival', label: 'S-Wave', color: '#f59e0b' },
    { key: 'surf_arrival', label: 'Surface', color: '#ef4444' },
  ];
  ctx.font = 'bold 10px JetBrains Mono, monospace';
  cursors.forEach(({ key, label, color }) => {
    const ts = Number(payload[key]);
    if (!Number.isFinite(ts) || ts < tMin || ts > tMax) return;
    const x = padL + ((ts - tMin) / tSpan) * plotW;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(label, Math.min(x + 4, padL + plotW - 50), padT + 12);
  });

  // Axes
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.strokeRect(padL, padT, plotW, plotH);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '9.5px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`±${Math.round(maxAbs)}`, padL - 5, padT + 10);
  ctx.textAlign = 'left';
  ctx.fillText(formatUtcShort(tMin), padL, padT + plotH + 16);
  ctx.textAlign = 'right';
  ctx.fillText(formatUtcShort(tMax), padL + plotW, padT + plotH + 16);
}

function setReplayModalOpen(open) {
  const { modal } = getModalEls();
  if (!modal) return;
  modal.style.display = open ? 'flex' : 'none';
  if (open && lastReplayPayload) {
    requestAnimationFrame(() => drawReplayWaveform(lastReplayPayload));
  }
}

export async function openQuakeReplayModal(usgsEvent) {
  const els = getModalEls();
  if (!els.modal || !usgsEvent) return;

  const mag = usgsEvent.magnitude != null ? `M${Number(usgsEvent.magnitude).toFixed(1)}` : 'Event';
  const place = usgsEvent.place || 'Regional Earthquake';
  if (els.title) els.title.textContent = `🔍 Did My Sensor See That Quake? — ${mag}`;
  if (els.subtitle) els.subtitle.textContent = `${place} · Querying RS4D MiniSEED archive...`;
  if (els.verdictBadge) {
    els.verdictBadge.textContent = 'ANALYZING...';
    els.verdictBadge.className = 'meta-badge';
  }
  if (els.snrStat) els.snrStat.textContent = '--';
  if (els.peakStat) els.peakStat.textContent = '--';
  if (els.noiseStat) els.noiseStat.textContent = '--';
  lastReplayPayload = null;
  setReplayModalOpen(true);

  const params = new URLSearchParams();
  if (usgsEvent.time != null) params.set('origin_time', String(usgsEvent.time));
  if (usgsEvent.distance_km != null && Number.isFinite(Number(usgsEvent.distance_km))) {
    params.set('distance_km', String(usgsEvent.distance_km));
  }
  if (usgsEvent.magnitude != null && Number.isFinite(Number(usgsEvent.magnitude))) {
    params.set('magnitude', String(usgsEvent.magnitude));
  }
  params.set('place', place);

  try {
    const res = await fetch(`/api/archive/quake-replay?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lastReplayPayload = data;

    if (els.subtitle) {
      els.subtitle.textContent = `${place} · Origin ${formatUtcShort(data.origin_time)} · ${data.channel || 'EHZ'}`;
    }
    if (els.verdictBadge) {
      els.verdictBadge.textContent = data.verdict || 'UNKNOWN';
      els.verdictBadge.className = data.detected
        ? 'meta-badge witness-confirmed'
        : 'meta-badge witness-idle';
    }
    if (els.snrStat) {
      els.snrStat.textContent = data.snr_peak != null ? `${Number(data.snr_peak).toFixed(1)}x peak SNR` : '--';
    }
    if (els.peakStat) {
      els.peakStat.textContent = data.peak_counts != null ? `${Math.round(data.peak_counts)} cts` : '--';
    }
    if (els.noiseStat) {
      els.noiseStat.textContent = data.baseline_rms != null ? `${Number(data.baseline_rms).toFixed(1)} rms` : '--';
    }
    drawReplayWaveform(data);
  } catch (err) {
    if (els.verdictBadge) els.verdictBadge.textContent = 'UNAVAILABLE';
    if (els.subtitle) els.subtitle.textContent = `Archive lookup failed: ${err.message}`;
  }
}

export async function openHighlightModal(highlightId) {
  const els = getModalEls();
  if (!els.modal || !highlightId) return;

  if (els.title) els.title.textContent = '✨ Notable Moment Clip';
  if (els.subtitle) els.subtitle.textContent = 'Loading archived 60s waveform highlight...';
  if (els.verdictBadge) {
    els.verdictBadge.textContent = 'HIGHLIGHT';
    els.verdictBadge.className = 'meta-badge witness-confirmed';
  }
  lastReplayPayload = null;
  setReplayModalOpen(true);

  try {
    const res = await fetch(`/api/highlights/${encodeURIComponent(highlightId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lastReplayPayload = data;

    if (els.title) els.title.textContent = data.title || 'Shake Highlight';
    if (els.subtitle) {
      els.subtitle.textContent = `${data.subtitle || ''} · ${formatUtcShort(data.timestamp)}`;
    }
    if (els.verdictBadge) {
      els.verdictBadge.textContent = (data.category || 'highlight').toUpperCase();
    }
    if (els.snrStat) {
      els.snrStat.textContent = data.peak_metric != null ? `${data.peak_metric} ${data.metric_unit || ''}` : '--';
    }
    if (els.peakStat) {
      els.peakStat.textContent = `${data.duration_sec || 60}s clip`;
    }
    if (els.noiseStat) {
      els.noiseStat.textContent = data.metadata?.witness_verdict || data.metadata?.status_detail || 'Archived';
    }
    drawReplayWaveform(data);
  } catch (err) {
    if (els.subtitle) els.subtitle.textContent = `Failed to load clip: ${err.message}`;
  }
}

export async function refreshHighlightsStrip() {
  const stripEl = document.getElementById('highlightsList');
  const archiveBadge = document.getElementById('archiveStatusBadge');
  if (!stripEl) return;

  try {
    const [hlRes, archRes] = await Promise.all([
      fetch('/api/highlights?limit=12'),
      fetch('/api/archive/status'),
    ]);

    if (archRes.ok && archiveBadge) {
      const arch = await archRes.json();
      const mb = arch.size_mb ?? arch.total_mb ?? 0;
      archiveBadge.textContent = arch.file_count != null
        ? `Archive: ${arch.file_count}h (${mb} MB)`
        : 'Archive: Ready';
    }

    if (!hlRes.ok) return;
    const { highlights = [] } = await hlRes.json();
    if (!highlights.length) {
      stripEl.innerHTML = '<span class="highlight-empty">Listening for notable earthquakes, Cal touchdowns & Greek encores...</span>';
      return;
    }

    stripEl.innerHTML = highlights
      .map((hl) => {
        const cls = hl.category === 'earthquake'
          ? 'hl-quake'
          : hl.category === 'touchdown'
            ? 'hl-stadium'
            : 'hl-concert';
        return `
          <button type="button" class="highlight-pill ${cls}" data-hl-id="${hl.id}" title="${hl.subtitle || ''}">
            <span class="hl-title">${hl.title || 'Highlight'}</span>
            <span class="hl-time">${formatUtcShort(hl.timestamp)}</span>
          </button>
        `;
      })
      .join('');

    stripEl.querySelectorAll('.highlight-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-hl-id');
        if (id) openHighlightModal(id);
      });
    });
  } catch (err) {
    console.debug('Highlights refresh skipped:', err);
  }
}

export function initHighlightsStrip() {
  const { modal, closeBtn } = getModalEls();
  if (closeBtn) {
    closeBtn.addEventListener('click', () => setReplayModalOpen(false));
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) setReplayModalOpen(false);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setReplayModalOpen(false);
  });

  refreshHighlightsStrip();
  if (!highlightsTimer) {
    highlightsTimer = setInterval(refreshHighlightsStrip, 60000);
  }
}
