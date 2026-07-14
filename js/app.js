/* ============================================================
   app.js — Georgia Community Resources Map
   Loads pre-fetched JSON data (refreshed weekly by GitHub Actions)
   and renders color-coded, clustered Leaflet markers.
   ============================================================ */

'use strict';

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------
const LAYERS = {
  shelter: { file: 'data/shelters.json',   color: '#3b82f6', label: 'Shelter' },
  food:    { file: 'data/food-banks.json', color: '#f97316', label: 'Food Bank' },
  snap:    { file: 'data/snap.json',       color: '#22c55e', label: 'SNAP / EBT' },
  clinic:  { file: 'data/clinics.json',    color: '#ef4444', label: 'Free Clinic' },
};

const GEORGIA_CENTER = [32.75, -83.5];
const GEORGIA_ZOOM   = 7;

// ------------------------------------------------------------------
// Map init
// ------------------------------------------------------------------
const map = L.map('map', {
  center: GEORGIA_CENTER,
  zoom: GEORGIA_ZOOM,
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
    iconSize:   [13, 13],
    iconAnchor: [6,  6],
    popupAnchor:[0, -10],
  });
}

// ------------------------------------------------------------------
// Cluster groups — one per layer so toggling works independently
// ------------------------------------------------------------------
const clusterGroups = {};

Object.entries(LAYERS).forEach(([key, cfg]) => {
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
        iconSize: [size, size],
        iconAnchor: [size/2, size/2],
      });
    },
  });
  group.addTo(map);
  clusterGroups[key] = group;
});

// ------------------------------------------------------------------
// Popup helpers
// ------------------------------------------------------------------
function buildPopup(feature, layerKey) {
  const cfg  = LAYERS[layerKey];
  const p    = feature.properties || {};
  const name = p.name || 'Unnamed Location';
  const addr = [p.address, p.city, p.state].filter(Boolean).join(', ');

  return `
    <div class="popup-title">${escHtml(name)}</div>
    ${addr ? `<div class="popup-address">${escHtml(addr)}</div>` : ''}
  `.trim();
}

function buildDetail(feature, layerKey) {
  const cfg  = LAYERS[layerKey];
  const p    = feature.properties || {};
  const name = p.name || 'Unnamed Location';
  const addr = [p.address, p.city, p.state, p.zip].filter(Boolean).join(', ');

  let html = `
    <div class="detail-card">
      <span class="category-badge" style="background:${cfg.color}">${cfg.label}</span>
      <h2>${escHtml(name)}</h2>
  `;

  if (addr) {
    html += field('📍', escHtml(addr));
  }
  if (p.phone) {
    html += field('📞', `<a href="tel:${p.phone}">${escHtml(p.phone)}</a>`);
  }
  if (p.website) {
    const url = p.website.startsWith('http') ? p.website : 'https://' + p.website;
    html += field('🌐', `<a href="${url}" target="_blank" rel="noopener">${escHtml(p.website)}</a>`);
  }
  if (p.hours) {
    html += field('🕐', escHtml(p.hours));
  }
  if (p.notes) {
    html += field('ℹ️', escHtml(p.notes));
  }

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
// Load data and populate layers
// ------------------------------------------------------------------
async function loadLayer(key) {
  const cfg = LAYERS[key];
  const icon = makeIcon(cfg.color);
  let features = [];

  try {
    const res = await fetch(cfg.file + '?v=' + Date.now());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    features = await res.json();
  } catch (err) {
    console.warn(`[${key}] Failed to load ${cfg.file}:`, err.message);
    return 0;
  }

  if (!Array.isArray(features) || features.length === 0) return 0;

  const detailPanel = document.getElementById('detail-panel');

  features.forEach(feature => {
    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length < 2) return;

    const [lng, lat] = coords;
    if (!isFinite(lat) || !isFinite(lng)) return;

    const marker = L.marker([lat, lng], { icon });
    marker.bindPopup(buildPopup(feature, key), { maxWidth: 280 });

    marker.on('click', () => {
      detailPanel.innerHTML = buildDetail(feature, key);
      // On mobile, open the sidebar
      document.getElementById('sidebar').classList.add('open');
    });

    clusterGroups[key].addLayer(marker);
  });

  // Update count badge
  const countEl = document.getElementById(`count-${key}`);
  if (countEl) countEl.textContent = features.length.toLocaleString();

  return features.length;
}

// ------------------------------------------------------------------
// Filter toggles
// ------------------------------------------------------------------
Object.keys(LAYERS).forEach(key => {
  const checkbox = document.getElementById(`toggle-${key}`);
  if (!checkbox) return;

  checkbox.addEventListener('change', () => {
    if (checkbox.checked) {
      map.addLayer(clusterGroups[key]);
    } else {
      map.removeLayer(clusterGroups[key]);
    }
  });
});

// ------------------------------------------------------------------
// Mobile sidebar toggle
// ------------------------------------------------------------------
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar       = document.getElementById('sidebar');

sidebarToggle?.addEventListener('click', () => {
  sidebar.classList.toggle('open');
});

// Close sidebar when user taps the map on mobile
map.on('click', () => {
  if (window.innerWidth <= 640) {
    sidebar.classList.remove('open');
  }
});

// ------------------------------------------------------------------
// Last updated
// ------------------------------------------------------------------
async function loadLastUpdated() {
  try {
    const res = await fetch('data/last-updated.json');
    if (!res.ok) return;
    const { date } = await res.json();
    if (date) {
      const d = new Date(date);
      document.getElementById('last-updated').textContent =
        'Data updated ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  } catch (_) { /* silent */ }
}

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------
async function init() {
  const overlay = document.getElementById('loading-overlay');

  await loadLastUpdated();

  const results = await Promise.allSettled(
    Object.keys(LAYERS).map(key => loadLayer(key))
  );

  const total = results.reduce((sum, r) => sum + (r.value || 0), 0);

  if (total === 0) {
    document.getElementById('detail-panel').innerHTML =
      '<p class="hint">No data loaded yet.<br>Run the fetch script or trigger the GitHub Action.</p>';
  }

  overlay.classList.add('hidden');
}

init();
