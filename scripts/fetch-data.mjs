#!/usr/bin/env node
/**
 * fetch-data.mjs
 *
 * Fetches resource data for all enabled states and writes per-state
 * GeoJSON-style feature arrays to data/{STATE}/ directories.
 *
 * Configuration:
 *   config/states.json  — which states are enabled, bboxes, Geofabrik slugs
 *   config/sources.json — universal API endpoints and field mappings
 *
 * OSM data strategy (shelters + food banks):
 *   PRIMARY  — Geofabrik daily extract + osmium-tool (GitHub Actions / Linux)
 *   FALLBACK — Overpass API (local dev without osmium)
 *
 * Run: node scripts/fetch-data.mjs
 */

import { writeFile, mkdir, readFile, unlink } from 'fs/promises';
import { existsSync }   from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { Readable }     from 'stream';
import { exec }         from 'child_process';
import { promisify }    from 'util';
import { tmpdir }       from 'os';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const DATA_DIR  = join(ROOT, 'data');
const TMP       = tmpdir();

// ------------------------------------------------------------------
// Load config
// ------------------------------------------------------------------

const STATES  = JSON.parse(await readFile(join(ROOT, 'config', 'states.json'),  'utf8'));
const SOURCES = JSON.parse(await readFile(join(ROOT, 'config', 'sources.json'), 'utf8'));

const ENABLED_STATES = Object.entries(STATES)
  .filter(([, cfg]) => cfg.enabled && !cfg['_comment'])
  .map(([code, cfg]) => ({ code, ...cfg }));

// ------------------------------------------------------------------
// Shared utilities
// ------------------------------------------------------------------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function toFeature(lat, lng, props) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
    properties: props,
  };
}

async function saveJSON(stateCode, filename, data) {
  const dir = join(DATA_DIR, stateCode);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), JSON.stringify(data, null, 2), 'utf8');
  console.log(`  Saved ${data.length} records → data/${stateCode}/${filename}`);
}

/** Compute centroid of any GeoJSON geometry, returns [lng, lat] */
function centroid(geometry) {
  const pts =
    geometry.type === 'Point'           ? [geometry.coordinates] :
    geometry.type === 'MultiPoint'      ? geometry.coordinates :
    geometry.type === 'LineString'      ? geometry.coordinates :
    geometry.type === 'MultiLineString' ? geometry.coordinates.flat() :
    geometry.type === 'Polygon'         ? geometry.coordinates[0] :
    geometry.type === 'MultiPolygon'    ? geometry.coordinates[0][0] :
    [];
  if (!pts.length) return null;
  const sum = pts.reduce((a, c) => [a[0] + c[0], a[1] + c[1]], [0, 0]);
  return [sum[0] / pts.length, sum[1] / pts.length];
}

// ------------------------------------------------------------------
// PRIMARY PATH — Geofabrik + osmium
// ------------------------------------------------------------------

async function isOsmiumAvailable() {
  try { await execAsync('osmium version'); return true; }
  catch { return false; }
}

async function downloadGeofabrikExtract(slug, pbfPath) {
  if (existsSync(pbfPath)) {
    console.log(`  PBF already present at ${pbfPath}, skipping download.`);
    return;
  }
  const url = `${SOURCES.osm.baseUrl}/${slug}-latest.osm.pbf`;
  console.log(`  Downloading ${url}`);
  try {
    await execAsync(`curl -L --progress-bar -o "${pbfPath}" "${url}"`, { timeout: 600_000 });
  } catch {
    await execAsync(`wget -q --show-progress -O "${pbfPath}" "${url}"`, { timeout: 600_000 });
  }
  console.log('  Download complete.');
}

function osmiumGeoJSONToFeatures(raw, stateCode) {
  const fc = JSON.parse(raw);
  return (fc.features || []).flatMap(f => {
    const c = centroid(f.geometry);
    if (!c) return [];
    const t = f.properties || {};
    return [toFeature(c[1], c[0], {
      name:    t.name || t['name:en'] || null,
      address: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') || null,
      city:    t['addr:city']     || null,
      state:   stateCode,
      zip:     t['addr:postcode'] || null,
      phone:   t.phone            || t['contact:phone']   || null,
      website: t.website          || t['contact:website'] || null,
      hours:   t.opening_hours    || null,
      source:  SOURCES.osm.attribution,
    })];
  });
}

async function fetchOSMViaOsmium(label, expressions, pbfPath, stateCode) {
  console.log(`  Filtering ${label} with osmium…`);
  const slug        = label.replace(/\s+/g, '-');
  const filteredPbf = join(TMP, `civly-${slug}.osm.pbf`);
  const geojsonFile = join(TMP, `civly-${slug}.geojson`);

  const exprArgs = expressions.map(e => `"${e}"`).join(' ');
  await execAsync(
    `osmium tags-filter "${pbfPath}" ${exprArgs} -o "${filteredPbf}" --overwrite`,
    { timeout: 120_000 }
  );
  await execAsync(
    `osmium export "${filteredPbf}" -f geojson -o "${geojsonFile}" --overwrite`,
    { timeout: 120_000 }
  );

  const raw      = await readFile(geojsonFile, 'utf8');
  const features = osmiumGeoJSONToFeatures(raw, stateCode);
  await unlink(filteredPbf).catch(() => {});
  await unlink(geojsonFile).catch(() => {});
  return features;
}

// ------------------------------------------------------------------
// FALLBACK PATH — Overpass API
// ------------------------------------------------------------------

async function overpassQuery(query) {
  const body = 'data=' + encodeURIComponent(query);
  for (const endpoint of SOURCES.osm.overpassEndpoints) {
    try {
      console.log(`  Trying ${endpoint}`);
      const res = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      console.warn(`  Failed (${endpoint}): ${err.message}`);
      await sleep(2000);
    }
  }
  throw new Error('All Overpass endpoints failed.');
}

function buildOverpassQuery(tags, bbox) {
  const bboxStr = `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`;
  const lines = tags.flatMap(([k, v]) => [
    `  node["${k}"="${v}"](${bboxStr});`,
    `  way["${k}"="${v}"](${bboxStr});`,
  ]);
  return `[out:json][timeout:120];\n(\n${lines.join('\n')}\n);\nout center;`;
}

function osmElementToFeature(el, stateCode) {
  const lat = el.type === 'node' ? el.lat : el.center?.lat;
  const lng = el.type === 'node' ? el.lon : el.center?.lon;
  if (!lat || !lng) return null;
  const t = el.tags || {};
  return toFeature(lat, lng, {
    name:    t.name || t['name:en'] || null,
    address: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') || null,
    city:    t['addr:city']     || null,
    state:   stateCode,
    zip:     t['addr:postcode'] || null,
    phone:   t.phone            || t['contact:phone']   || null,
    website: t.website          || t['contact:website'] || null,
    hours:   t.opening_hours    || null,
    source:  SOURCES.osm.attribution,
  });
}

async function fetchOSMViaOverpass(label, tags, bbox, stateCode) {
  console.log(`  Querying Overpass for ${label}…`);
  const query    = buildOverpassQuery(tags, bbox);
  const data     = await overpassQuery(query);
  return (data.elements || []).map(el => osmElementToFeature(el, stateCode)).filter(Boolean);
}

// ------------------------------------------------------------------
// HRSA — Free health clinics
// ------------------------------------------------------------------

async function fetchWithRetry(url, opts = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
      return res;
    } catch (err) {
      if (i === retries - 1) throw err;
      await sleep(2000 * (i + 1));
    }
  }
}

function parseCSVLine(line) {
  const result = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim()); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

async function* streamCSV(url) {
  const res  = await fetchWithRetry(url);
  const rl   = createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
  let headers = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseCSVLine(line);
    if (!headers) {
      headers = cols.map(h => h.replace(/^\uFEFF/, '').trim());
      continue;
    }
    const row = {};
    headers.forEach((h, i) => { row[h] = (cols[i] ?? '').trim(); });
    yield row;
  }
}

async function fetchClinics(stateCode) {
  const src = SOURCES.clinics;
  console.log(`  Fetching clinics from ${src.attribution} for ${stateCode}…`);
  const features = [];
  try {
    for await (const row of streamCSV(src.url)) {
      if ((row[src.stateField] || '').trim().toUpperCase() !== stateCode) continue;
      const lat = row[src.latField] || '';
      const lng = row[src.lngField] || '';
      if (!lat || !lng || !isFinite(+lat) || !isFinite(+lng)) continue;
      features.push(toFeature(lat, lng, {
        name:    row[src.nameField]    || null,
        address: row[src.addressField] || null,
        city:    row[src.cityField]    || null,
        state:   stateCode,
        zip:     row[src.zipField]     || null,
        phone:   row[src.phoneField]   || null,
        website: row[src.websiteField] || null,
        source:  src.attribution,
      }));
    }
  } catch (err) {
    console.error(`  Clinics fetch failed for ${stateCode}:`, err.message);
  }
  console.log(`  Found ${features.length} clinics in ${stateCode}`);
  return features;
}

// ------------------------------------------------------------------
// USDA SNAP / EBT — ArcGIS FeatureServer
// ------------------------------------------------------------------

async function fetchSNAP(stateCode) {
  const src = SOURCES.snap;
  console.log(`  Fetching SNAP/EBT from ${src.attribution} for ${stateCode}…`);

  const features = [];
  const pageSize = src.pageSize || 1000;
  let   offset   = 0;

  while (true) {
    const params = new URLSearchParams({
      where:             `${src.stateField}='${stateCode}'`,
      outFields:         src.fields,
      f:                 'geojson',
      resultRecordCount: String(pageSize),
      resultOffset:      String(offset),
    });

    console.log(`  Records ${offset + 1}–${offset + pageSize}…`);
    let data;
    try {
      const res = await fetch(`${src.url}?${params}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      console.error(`  SNAP fetch failed at offset ${offset} for ${stateCode}:`, err.message);
      break;
    }

    const batch = data.features || [];
    for (const f of batch) {
      const [lng, lat] = f.geometry?.coordinates ?? [];
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const p = f.properties || {};
      features.push(toFeature(lat, lng, {
        name:    p.Store_Name           || null,
        address: p.Store_Street_Address || null,
        city:    p.City                 || null,
        state:   stateCode,
        zip:     p.Zip_Code             || null,
        notes:   p.Store_Type ? `${p.Store_Type} · Accepts SNAP / EBT` : 'Accepts SNAP / EBT',
        source:  src.attribution,
      }));
    }

    if (batch.length < pageSize) break;
    offset += pageSize;
    await sleep(300);
  }

  console.log(`  Found ${features.length} SNAP retailers in ${stateCode}`);
  return features;
}

// ------------------------------------------------------------------
// Extra sources (state-specific, defined in states.json)
// ------------------------------------------------------------------

async function fetchExtraSource(extra, stateCode) {
  if (extra.type === 'geojson_url') {
    console.log(`  Fetching extra source: ${extra.url}`);
    try {
      const res = await fetch(extra.url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fc = await res.json();
      return (fc.features || []).map(f => {
        const c = centroid(f.geometry);
        if (!c) return null;
        const p = f.properties || {};
        return toFeature(c[1], c[0], { ...p, state: stateCode, source: extra.attribution || extra.url });
      }).filter(Boolean);
    } catch (err) {
      console.error(`  Extra source failed (${extra.url}):`, err.message);
      return [];
    }
  }
  console.warn(`  Unknown extra source type: ${extra.type}`);
  return [];
}

// ------------------------------------------------------------------
// Per-state fetch orchestrator
// ------------------------------------------------------------------

async function fetchState(stateCfg, useOsmium, pbfPath) {
  const { code, name, bbox, geofabrikSlug, sources = [], extraSources = [] } = stateCfg;
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  State: ${name} (${code})`);
  console.log(`${'─'.repeat(50)}`);

  const results = { shelters: [], foodBanks: [], clinics: [], snap: [] };

  // OSM (shelters + food banks)
  if (sources.includes('osm')) {
    const osmCfg = SOURCES.osm.categories;
    if (useOsmium) {
      results.shelters  = await fetchOSMViaOsmium(`${code}-shelters`,   osmCfg.shelters.osmiumExpressions,  pbfPath, code);
      results.foodBanks = await fetchOSMViaOsmium(`${code}-food-banks`, osmCfg.foodBanks.osmiumExpressions, pbfPath, code);
    } else {
      results.shelters  = await fetchOSMViaOverpass('shelters',   osmCfg.shelters.overpassTags,  bbox, code);
      await sleep(3000);
      results.foodBanks = await fetchOSMViaOverpass('food banks', osmCfg.foodBanks.overpassTags, bbox, code);
    }
  }

  if (sources.includes('clinics')) {
    results.clinics = await fetchClinics(code);
  }

  if (sources.includes('snap')) {
    results.snap = await fetchSNAP(code);
  }

  // Extra sources (state-specific)
  for (const extra of extraSources) {
    const extraFeatures = await fetchExtraSource(extra, code);
    const target = extra.category || 'shelters';
    if (results[target]) {
      results[target] = results[target].concat(extraFeatures);
    }
  }

  // Write output
  await saveJSON(code, 'shelters.json',   results.shelters);
  await saveJSON(code, 'food-banks.json', results.foodBanks);
  await saveJSON(code, 'clinics.json',    results.clinics);
  await saveJSON(code, 'snap.json',       results.snap);

  return {
    code,
    shelters:  results.shelters.length,
    foodBanks: results.foodBanks.length,
    clinics:   results.clinics.length,
    snap:      results.snap.length,
  };
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

async function main() {
  console.log('=== US Community Resources — Data Refresh ===');
  console.log(`  Enabled states: ${ENABLED_STATES.map(s => s.code).join(', ')}\n`);

  await mkdir(DATA_DIR, { recursive: true });

  const useOsmium = await isOsmiumAvailable();
  if (useOsmium) {
    console.log('osmium-tool detected — using Geofabrik extracts\n');
  } else {
    console.log('osmium-tool not found — falling back to Overpass API\n');
  }

  const summary = [];

  for (const stateCfg of ENABLED_STATES) {
    let pbfPath = null;

    if (useOsmium && stateCfg.sources?.includes('osm')) {
      pbfPath = join(TMP, `civly-${stateCfg.code.toLowerCase()}.osm.pbf`);
      await downloadGeofabrikExtract(stateCfg.geofabrikSlug, pbfPath);
    }

    const stats = await fetchState(stateCfg, useOsmium, pbfPath);
    summary.push(stats);

    // Clean up PBF after processing each state (saves disk space)
    if (pbfPath) await unlink(pbfPath).catch(() => {});
  }

  // Write manifest (tells app.js which states + files exist)
  const manifest = {
    states:      ENABLED_STATES.map(s => s.code),
    stateNames:  Object.fromEntries(ENABLED_STATES.map(s => [s.code, s.name])),
    lastUpdated: new Date().toISOString(),
  };
  await writeFile(join(DATA_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log('\n  Wrote data/manifest.json');

  // Print summary table
  console.log('\n=== Summary ===');
  console.log('State  Shelters  Food Banks  Clinics  SNAP/EBT');
  console.log('─────  ────────  ──────────  ───────  ────────');
  for (const s of summary) {
    console.log(
      `${s.code.padEnd(5)}  ${String(s.shelters).padEnd(8)}  ${String(s.foodBanks).padEnd(10)}  ${String(s.clinics).padEnd(7)}  ${s.snap}`
    );
  }
  console.log('\nDone!');
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
