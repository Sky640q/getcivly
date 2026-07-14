/* ============================================================
   app.js — US Community Resources Map
   Loads pre-fetched JSON data (refreshed weekly by GitHub Actions)
   and renders color-coded, clustered Leaflet markers.
   ============================================================ */

'use strict';

// ------------------------------------------------------------------
// Layer definitions — visual config only, not tied to any one state
// ------------------------------------------------------------------
const LAYER_DEFS = {
  shelter: { file: 'shelters.json',   color: '#3b82f6', label: 'Shelter' },
  food:    { file: 'food-banks.json', color: '#f97316', label: 'Food Bank' },
  snap:    { file: 'snap.json',       color: '#22c55e', label: 'SNAP / EBT' },
  clinic:  { file: 'clinics.json',    color: '#ef4444', label: 'Free Clinic' },
};

const DEFAULT_CENTER = [38.5, -96.0]; // Continental US
const DEFAULT_ZOOM   = 5;

// ------------------------------------------------------------------
// Map init
// ------------------------------------------------------------------
const map = L.map('map', {
  center: DEFAULT_CENTER,
  zoom:   DEFAULT_ZOOM,
  zoomControl: true,
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// ------------------------------------------------------------------
// Marker icon factory — small colored circles
// ------------------------------------------------------------------
function makeIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:13px;height:13px;
      border-radius:50%;
      background:${color};
      border:2px solid rgba(255,255,255,0.85);
      box-shadow:0 1px 4px rgba(0,0,0,0.35);
    "></div>`,
    iconSize:    [13, 13],
    iconAnchor:  [6,  6],
    popupAnchor: [0, -10],
  });
}

// ------------------------------------------------------------------
// Cluster groups — one per layer so toggling works independently
// ------------------------------------------------------------------
const clusterGroups = {};

Object.entries(LAYER_DEFS).forEach(([key, cfg]) => {
  const group = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 40,
    iconCreateFunction(cluster) {
      const count = cluster.getChildCount();
      const size  = count < 10 ? 28 : count < 100 ? 34 : 40;
      return L.divIcon({
        html: `<div style="
          width:${size}px;height:${size}px;
          border-radius:50%;
          background:${cfg.color};
          opacity:0.82;
          color:#fff;
          font-weight:700;
          font-size:${size < 32 ? 11 : 12}px;
          display:flex;align-items:center;justify-content:center;
          border:2px solid rgba(255,255,255,0.7);
          box-shadow:0 2px 6px rgba(0,0,0,0.25);
        ">${count}</div>`,
        className: '',
        iconSize:   [size, size],
        iconAnchor: [size/2, size/2],
      });
    },
  });
  group.addTo(map);
  clusterGroups[key] = group;
});

// ------------------------------------------------------------------
// Popup / detail panel helpers
// ------------------------------------------------------------------
function buildPopup(feature, layerKey) {
  const p    = feature.properties || {};
  const name = p.name || 'Unnamed Location';
  const addr = [p.address, p.city, p.state].filter(Boolean).join(', ');
  return `
    <div class="popup-title">${escHtml(name)}</div>
    ${addr ? `<div class="popup-address">${escHtml(addr)}</div>` : ''}
  `.trim();
}

function buildDetail(feature, layerKey) {
  const cfg  = LAYER_DEFS[layerKey];
  const p    = feature.properties || {};
  const name = p.name || 'Unnamed Location';
  const addr = [p.address, p.city, p.state, p.zip].filter(Boolean).join(', ');

  let html = `
    <div class="detail-card">
      <span class="category-badge" style="background:${cfg.color}">${cfg.label}</span>
      <h2>${escHtml(name)}</h2>
  `;
  if (addr)      html += field('📍', escHtml(addr));
  if (p.phone)   html += field('📞', `<a href="tel:${p.phone}">${escHtml(p.phone)}</a>`);
  if (p.website) {
    const url = p.website.startsWith('http') ? p.website : 'https://' + p.website;
    html += field('🌐', `<a href="${url}" target="_blank" rel="noopener">${escHtml(p.website)}</a>`);
  }
  if (p.hours)   html += field('🕐', escHtml(p.hours));
  if (p.notes)   html += field('ℹ️',  escHtml(p.notes));
  html += '</div>';
  return html;
}

function field(icon, content) {
  return `<div class="field"><span class="field-icon">${icon}</span><span>${content}</span></div>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ------------------------------------------------------------------
// Load a single layer file for one state
// ------------------------------------------------------------------
async function loadStateLayer(stateCode, layerKey) {
  const cfg  = LAYER_DEFS[layerKey];
  const url  = `data/${stateCode}/${cfg.file}?v=${Date.now()}`;
  const icon = makeIcon(cfg.color);
  const detailPanel = document.getElementById('detail-panel');

  let features = [];
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    features = await res.json();
  } catch (err) {
    console.warn(`[${stateCode}/${layerKey}] Failed to load ${url}:`, err.message);
    return 0;
  }

  if (!Array.isArray(features) || features.length === 0) return 0;

  features.forEach(feature => {
    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length < 2) return;
    const [lng, lat] = coords;
    if (!isFinite(lat) || !isFinite(lng)) return;

    const marker = L.marker([lat, lng], { icon });
    marker.bindPopup(buildPopup(feature, layerKey), { maxWidth: 280 });
    marker.on('click', () => {
      detailPanel.innerHTML = buildDetail(feature, layerKey);
      document.getElementById('sidebar').classList.add('open');
    });
    clusterGroups[layerKey].addLayer(marker);
  });

  return features.length;
}

// ------------------------------------------------------------------
// Filter toggles
// ------------------------------------------------------------------
Object.keys(LAYER_DEFS).forEach(key => {
  const checkbox = document.getElementById(`toggle-${key}`);
  if (!checkbox) return;
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) map.addLayer(clusterGroups[key]);
    else                  map.removeLayer(clusterGroups[key]);
  });
});

// ------------------------------------------------------------------
// Mobile sidebar toggle
// ------------------------------------------------------------------
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar       = document.getElementById('sidebar');

sidebarToggle?.addEventListener('click', () => sidebar.classList.toggle('open'));
map.on('click', () => {
  if (window.innerWidth <= 640) sidebar.classList.remove('open');
});

// ------------------------------------------------------------------
// State selector
// ------------------------------------------------------------------
function buildStateSelector(states, stateNames) {
  const container = document.getElementById('state-filter');
  if (!container) return;

  container.innerHTML = '';

  // "All States" button
  const allBtn = document.createElement('button');
  allBtn.className = 'state-btn active';
  allBtn.textContent = 'All';
  allBtn.dataset.state = 'all';
  container.appendChild(allBtn);

  states.forEach(code => {
    const btn = document.createElement('button');
    btn.className = 'state-btn';
    btn.textContent = code;
    btn.title = stateNames[code] || code;
    btn.dataset.state = code;
    container.appendChild(btn);
  });

  container.addEventListener('click', e => {
    const btn = e.target.closest('.state-btn');
    if (!btn) return;
    container.querySelectorAll('.state-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Future: filter visible markers by state
    // For now just a UI placeholder — all markers are already loaded
  });
}

// ------------------------------------------------------------------
// Last updated
// ------------------------------------------------------------------
async function loadManifest() {
  try {
    const res = await fetch('data/manifest.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    // Fall back to legacy single-state layout (GA only, flat data/ files)
    return { states: ['GA'], stateNames: { GA: 'Georgia' }, lastUpdated: null };
  }
}

async function loadLastUpdated(manifest) {
  const date = manifest?.lastUpdated;
  if (!date) {
    // Legacy fallback
    try {
      const res = await fetch('data/last-updated.json');
      if (!res.ok) return;
      const { date: d } = await res.json();
      if (d) setLastUpdated(d);
    } catch (_) { /* silent */ }
    return;
  }
  setLastUpdated(date);
}

function setLastUpdated(isoDate) {
  const el = document.getElementById('last-updated');
  if (!el) return;
  const d = new Date(isoDate);
  el.textContent = 'Data updated ' + d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });
}

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------
async function init() {
  const overlay = document.getElementById('loading-overlay');

  const manifest = await loadManifest();
  await loadLastUpdated(manifest);

  buildStateSelector(manifest.states, manifest.stateNames);

  // Load all layers for all enabled states
  const tasks = [];
  for (const stateCode of manifest.states) {
    for (const layerKey of Object.keys(LAYER_DEFS)) {
      tasks.push(loadStateLayer(stateCode, layerKey));
    }
  }

  const results = await Promise.allSettled(tasks);
  const total   = results.reduce((sum, r) => sum + (r.value || 0), 0);

  // Update count badges (sum across all states)
  const counts = {};
  let taskIdx  = 0;
  for (const stateCode of manifest.states) {
    for (const layerKey of Object.keys(LAYER_DEFS)) {
      counts[layerKey] = (counts[layerKey] || 0) + (results[taskIdx++]?.value || 0);
    }
  }
  Object.entries(counts).forEach(([key, count]) => {
    const el = document.getElementById(`count-${key}`);
    if (el) el.textContent = count.toLocaleString();
  });

  if (total === 0) {
    document.getElementById('detail-panel').innerHTML =
      '<p class="hint">No data loaded yet.<br>Run the fetch script or trigger the GitHub Action.</p>';
  }

  // Fit map to loaded markers if multiple states are active
  if (manifest.states.length > 1) {
    map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  }

  overlay.classList.add('hidden');
}

init();
