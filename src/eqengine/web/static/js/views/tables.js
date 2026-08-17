/**
 * Tables View: Sortable Trigger Event History & ML Ground-Truth Catalog
 */

import { state } from '../state.js';
import { elements } from '../dom.js';
import { playAlertSound } from '../audio.js';
import { inspectEventSnippet } from './review_studio.js';

const SEVERITY_RANKS = { info: 1, advisory: 2, warning: 3, critical: 4 };

export function addEventToTable(evt) {
  state.allEvents.push(evt);
  if (state.allEvents.length > 200) state.allEvents.shift();
  if (state.activeTab === 'events') {
    renderEventsTable();
  }
}

export function renderEventsTable() {
  const tbody = elements.eventsTableBody;
  if (!tbody) return;

  if (!state.allEvents || state.allEvents.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-muted text-center">No triggers recorded yet. Listening to live SeedLink stream...</td></tr>';
    return;
  }

  const col = state.sortColumn || 'timestamp';
  const dir = state.sortDirection || 'desc';

  const sorted = [...state.allEvents].sort((a, b) => {
    let valA, valB;
    if (col === 'timestamp') {
      valA = a.timestamp || 0;
      valB = b.timestamp || 0;
    } else if (col === 'severity') {
      valA = SEVERITY_RANKS[(a.severity || 'info').toLowerCase()] || 0;
      valB = SEVERITY_RANKS[(b.severity || 'info').toLowerCase()] || 0;
    } else if (col === 'mag') {
      valA = parseFloat(String(a.mag || '').replace(/[^\d.-]/g, '')) || 0;
      valB = parseFloat(String(b.mag || '').replace(/[^\d.-]/g, '')) || 0;
    } else if (col === 'distance') {
      valA = parseFloat(String(a.distance || '').replace(/[^\d.-]/g, '')) || 0;
      valB = parseFloat(String(b.distance || '').replace(/[^\d.-]/g, '')) || 0;
    } else if (col === 'staLta') {
      valA = parseFloat(String(a.staLta || '').replace(/[^\d.-]/g, '')) || 0;
      valB = parseFloat(String(b.staLta || '').replace(/[^\d.-]/g, '')) || 0;
    } else if (col === 'channel') {
      valA = String(a.channel || '').toLowerCase();
      valB = String(b.channel || '').toLowerCase();
    } else if (col === 'type') {
      valA = String(a.type || '').toLowerCase();
      valB = String(b.type || '').toLowerCase();
    } else if (col === 'status') {
      valA = String(a.status || '').toLowerCase();
      valB = String(b.status || '').toLowerCase();
    } else {
      valA = a.timestamp || 0;
      valB = b.timestamp || 0;
    }

    if (valA < valB) return dir === 'asc' ? -1 : 1;
    if (valA > valB) return dir === 'asc' ? 1 : -1;
    return 0;
  });

  // Update header indicator icons
  document.querySelectorAll('#eventsTable th.sortable').forEach((th) => {
    const thCol = th.getAttribute('data-col');
    const arrow = th.querySelector('.sort-arrow');
    if (thCol === col) {
      th.classList.add('sorted');
      if (arrow) arrow.textContent = dir === 'asc' ? '▲' : '▼';
    } else {
      th.classList.remove('sorted');
      if (arrow) arrow.textContent = '⇅';
    }
  });

  tbody.innerHTML = '';
  sorted.forEach((evt) => {
    const row = document.createElement('tr');
    const timeStr = new Date((evt.timestamp || 0) * 1000).toISOString().substring(11, 23);
    const sevClass = `sev-${(evt.severity || 'info').toLowerCase()}`;
    row.innerHTML = `
      <td>${timeStr}</td>
      <td><span class="sev-tag ${sevClass}">${(evt.severity || 'info').toUpperCase()}</span></td>
      <td><b>${evt.mag || '--'}</b></td>
      <td>${evt.distance || '--'}</td>
      <td>${evt.staLta || '--'}</td>
      <td>${evt.channel || '--'}</td>
      <td>${evt.type || '--'}</td>
      <td>${evt.status || '--'}</td>
    `;
    tbody.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// ML Ground-Truth Dataset Catalog
// ---------------------------------------------------------------------------
export async function fetchMlDataset() {
  try {
    const [sumRes, evRes] = await Promise.all([
      fetch('/api/ml/summary'),
      fetch('/api/ml/events?limit=100'),
    ]);
    const summary = await sumRes.json();
    const eventsData = await evRes.json();

    const countEl = document.getElementById('mlStatCount');
    const diskEl = document.getElementById('mlStatDisk');
    if (countEl) countEl.textContent = summary.total_annotated_events || 0;
    if (diskEl) diskEl.textContent = `${summary.disk_size_mb || 0} MB`;

    state.mlEvents = eventsData.events || [];
    renderMlTable();
  } catch (err) {
    console.error('Failed to fetch ML dataset summary:', err);
  }
}

export function renderMlTable() {
  const tbody = document.getElementById('mlEventsTableBody');
  if (!tbody) return;

  if (!state.mlEvents || state.mlEvents.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="text-muted text-center">No ground-truth events tagged yet. Click a quick tag above to record your first ML training snippet!</td></tr>';
    return;
  }

  const col = state.mlSortColumn || 'timestamp';
  const dir = state.mlSortDirection || 'desc';

  const sorted = [...state.mlEvents].sort((a, b) => {
    let valA, valB;
    const featsA = a.features || {};
    const featsB = b.features || {};

    if (col === 'timestamp') {
      valA = a.start_time || 0;
      valB = b.start_time || 0;
    } else if (col === 'event_id') {
      valA = String(a.event_id || '');
      valB = String(b.event_id || '');
    } else if (col === 'label') {
      valA = String(a.label || '').toLowerCase();
      valB = String(b.label || '').toLowerCase();
    } else if (col === 'category') {
      valA = String(a.category || '').toLowerCase();
      valB = String(b.category || '').toLowerCase();
    } else if (col === 'duration') {
      valA = a.duration_sec || 0;
      valB = b.duration_sec || 0;
    } else if (col === 'pga') {
      valA = featsA.pga_resultant_m_s2 || 0;
      valB = featsB.pga_resultant_m_s2 || 0;
    } else if (col === 'dom_freq') {
      valA = featsA.dominant_freq_hz || 0;
      valB = featsB.dominant_freq_hz || 0;
    } else if (col === 'centroid') {
      valA = featsA.spectral_centroid_hz || 0;
      valB = featsB.spectral_centroid_hz || 0;
    } else if (col === 'file') {
      valA = String(a.snippet_file || '');
      valB = String(b.snippet_file || '');
    } else {
      valA = a.start_time || 0;
      valB = b.start_time || 0;
    }

    if (valA < valB) return dir === 'asc' ? -1 : 1;
    if (valA > valB) return dir === 'asc' ? 1 : -1;
    return 0;
  });

  document.querySelectorAll('#mlEventsTable th.sortable').forEach((th) => {
    const thCol = th.getAttribute('data-ml-col');
    const arrow = th.querySelector('.sort-arrow');
    if (thCol === col) {
      th.classList.add('sorted');
      if (arrow) arrow.textContent = dir === 'asc' ? '▲' : '▼';
    } else {
      th.classList.remove('sorted');
      if (arrow) arrow.textContent = '⇅';
    }
  });

  tbody.innerHTML = '';
  sorted.forEach((evt) => {
    const row = document.createElement('tr');
    const timeStr = new Date((evt.start_time || 0) * 1000).toISOString().substring(11, 23);
    const feats = evt.features || {};
    row.innerHTML = `
      <td><code>${evt.event_id || '--'}</code></td>
      <td>${timeStr}</td>
      <td><b style="color: #38bdf8;">${evt.label || '--'}</b></td>
      <td><span class="ch-tag" style="background: rgba(255,255,255,0.1);">${evt.category || '--'}</span></td>
      <td>${evt.duration_sec ? evt.duration_sec + 's' : '--'}</td>
      <td>${feats.pga_resultant_m_s2 !== undefined ? feats.pga_resultant_m_s2.toFixed(5) : '--'}</td>
      <td>${feats.dominant_freq_hz !== undefined ? feats.dominant_freq_hz + ' Hz' : '--'}</td>
      <td>${feats.spectral_centroid_hz !== undefined ? feats.spectral_centroid_hz + ' Hz' : '--'}</td>
      <td><code>${evt.snippet_file || '--'}</code></td>
      <td style="white-space: nowrap;">
        <button class="btn-action-inspect" data-inspect-id="${evt.event_id}">🔍 Inspect</button>
        <button class="btn-action-delete" data-delete-id="${evt.event_id}">🗑️</button>
      </td>
    `;
    tbody.appendChild(row);
  });

  tbody.querySelectorAll('.btn-action-inspect').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-inspect-id');
      inspectEventSnippet(id);
    });
  });

  tbody.querySelectorAll('.btn-action-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-delete-id');
      if (confirm(`Are you sure you want to delete ML event '${id}' and remove its snippet file?`)) {
        await deleteMlEvent(id);
      }
    });
  });
}

async function deleteMlEvent(eventId) {
  try {
    const resp = await fetch(`/api/ml/events/${eventId}`, { method: 'DELETE' });
    const res = await resp.json();
    if (res.status === 'ok') {
      fetchMlDataset();
    }
  } catch (err) {
    console.error('Failed to delete event:', err);
  }
}

export async function annotateCurrentWindow(label, category, notes, durationSec = 30.0) {
  try {
    const resp = await fetch('/api/ml/annotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: label,
        category: category,
        notes: notes,
        duration_sec: durationSec,
        confidence: 1.0,
      }),
    });
    const data = await resp.json();
    if (data.status === 'ok') {
      playAlertSound('advisory');
      fetchMlDataset();
    }
  } catch (err) {
    console.error('Failed to annotate event:', err);
  }
}

export function initTableListeners() {
  document.querySelectorAll('#eventsTable th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.getAttribute('data-col');
      if (!col) return;

      if (state.sortColumn === col) {
        state.sortDirection = state.sortDirection === 'desc' ? 'asc' : 'desc';
      } else {
        state.sortColumn = col;
        state.sortDirection = col === 'timestamp' || col === 'mag' || col === 'staLta' ? 'desc' : 'asc';
      }
      renderEventsTable();
    });
  });

  document.querySelectorAll('#mlEventsTable th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.getAttribute('data-ml-col');
      if (!col) return;

      if (state.mlSortColumn === col) {
        state.mlSortDirection = state.mlSortDirection === 'desc' ? 'asc' : 'desc';
      } else {
        state.mlSortColumn = col;
        state.mlSortDirection = col === 'timestamp' || col === 'pga' || col === 'duration' ? 'desc' : 'asc';
      }
      renderMlTable();
    });
  });

  // Quick tag buttons
  document.querySelectorAll('.btn-tag').forEach((btn) => {
    btn.addEventListener('click', () => {
      const label = btn.getAttribute('data-label');
      const category = btn.getAttribute('data-category') || 'human_indoor';
      const notes = btn.getAttribute('data-notes') || '';
      annotateCurrentWindow(label, category, notes, 30.0);
    });
  });

  // Custom annotation form
  const mlSaveBtn = document.getElementById('mlSaveCustomBtn');
  if (mlSaveBtn) {
    mlSaveBtn.addEventListener('click', () => {
      const labelInput = document.getElementById('mlCustomLabel');
      const catSelect = document.getElementById('mlCustomCategory');
      const durSelect = document.getElementById('mlCustomDuration');
      const notesInput = document.getElementById('mlCustomNotes');

      const label = labelInput ? labelInput.value.trim() : '';
      if (!label) {
        alert('Please enter an Event Label before saving.');
        return;
      }
      const category = catSelect ? catSelect.value : 'custom';
      const duration = durSelect ? parseFloat(durSelect.value) : 30.0;
      const notes = notesInput ? notesInput.value.trim() : '';

      annotateCurrentWindow(label, category, notes, duration);
      if (labelInput) labelInput.value = '';
      if (notesInput) notesInput.value = '';
    });
  }
}
