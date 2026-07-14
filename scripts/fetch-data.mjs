#!/usr/bin/env node
/**
 * fetch-data.mjs
 *
 * Fetches resource data for Georgia and writes GeoJSON-style feature arrays
 * to the data/ directory.
 *
 * OSM data strategy (shelters + food banks):
 *   PRIMARY   — Geofabrik daily extract + osmium-tool (used in GitHub Actions / Linux)
 *               Downloads georgia-latest.osm.pbf once, filters with osmium, no API calls.
 *   FALLBACK  — Overpass API (used locally when osmium is not installed)
 *
 * Other sources:
 *   Free Clinics — HRSA Health Center Finder CSV (no auth, filtered to GA)
 *   SNAP / EBT   — USDA FNS bulk retailer CSV (filtered to GA)
 *
 * Requires: Node 18+, no npm dependencies.
 * osmium-tool must be installed for the primary path:
 *   Ubuntu/Debian: sudo apt-get install osmium-tool
 *   macOS:         brew install osmium-tool
 *   Windows:       use WSL, or skip to Overpass fallback
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

const execAsync     = promisify(exec);
const __dirname     = dirname(fileURLToPath(import.meta.url));
const DATA_DIR      = join(__dirname, '..', 'data');
const TMP           = tmpdir();
const GA_PBF        = join(TMP, 'georgia-latest.osm.pbf');
const GEOFABRIK_URL = 'https://download.geofabrik.de/north-america/us/georgia-latest.osm.pbf';

// Georgia bounding box for Overpass fallback [south, west, north, east]
const GA_BBOX = '30.3577,-85.6052,35.0009,-80.8401';

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

async function saveJSON(filename, data) {
  await writeFile(join(DATA_DIR, filename), JSON.stringify(data, null, 2), 'utf8');
  console.log(`  Saved ${data.length} records → data/${filename}`);
}

/** Compute centroid of any GeoJSON geometry, returns [lng, lat] */
function centroid(geometry) {
  const flat = (coords) => {
    if (!Array.isArray(coords[0])) return [coords];
    return coords.flatMap(flat);
  };
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

/** Parse a GeoJSON FeatureCollection from osmium export into our feature format */
function osmiumGeoJSONToFeatures(raw, source) {
  const fc = JSON.parse(raw);
  return (fc.features || []).flatMap(f => {
    const c = centroid(f.geometry);
    if (!c) return [];
    const t = f.properties || {};
    return [toFeature(c[1], c[0], {
      name:    t.name || t['name:en'] || null,
      address: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') || null,
      city:    t['addr:city']     || null,
      state:   t['addr:state']    || 'GA',
      zip:     t['addr:postcode'] || null,
      phone:   t.phone            || t['contact:phone']   || null,
      website: t.website          || t['contact:website'] || null,
      hours:   t.opening_hours    || null,
      source,
    })];
  });
}

// ------------------------------------------------------------------
// PRIMARY PATH — Geofabrik + osmium
// ------------------------------------------------------------------

async function isOsmiumAvailable() {
  try {
    await execAsync('osmium version');
    return true;
  } catch {
    return false;
  }
}

/** Download the Georgia PBF extract once (reused for all OSM categories) */
async function downloadGeofabrikExtract() {
  if (existsSync(GA_PBF)) {
    console.log(`  Georgia PBF already present at ${GA_PBF}, skipping download.`);
    return;
  }
  console.log(`  Downloading ${GEOFABRIK_URL}`);
  console.log('  (337 MB — this takes ~1 min on a typical connection)');

  // Use curl / wget depending on what's available
  try {
    await execAsync(`curl -L --progress-bar -o "${GA_PBF}" "${GEOFABRIK_URL}"`,
      { timeout: 300_000 }); // 5 min max
  } catch {
    await execAsync(`wget -q --show-progress -O "${GA_PBF}" "${GEOFABRIK_URL}"`,
      { timeout: 300_000 });
  }
  console.log('  Download complete.');
}

/**
 * Filter the Georgia PBF by a set of tag expressions using osmium,
 * then export to GeoJSON and parse into our feature format.
 *
 * @param {string}   label       human-readable name for logging
 * @param {string[]} expressions osmium tag-filter expressions, e.g. "social_facility=shelter"
 * @param {string}   source      value for the 'source' property
 */
async function fetchOSMViaOsmium(label, expressions, source) {
  console.log(`  Filtering ${label} with osmium…`);

  const filteredPbf = join(TMP, `civly-${label.replace(/\s+/g, '-')}.osm.pbf`);
  const geojsonFile = join(TMP, `civly-${label.replace(/\s+/g, '-')}.geojson`);

  // Build the tags-filter command
  const exprArgs = expressions.map(e => `"${e}"`).join(' ');
  await execAsync(
    `osmium tags-filter "${GA_PBF}" ${exprArgs} -o "${filteredPbf}" --overwrite`,
    { timeout: 120_000 }
  );

  // Export filtered PBF to GeoJSON
  await execAsync(
    `osmium export "${filteredPbf}" -f geojson -o "${geojsonFile}" --overwrite`,
    { timeout: 120_000 }
  );

  const raw      = await readFile(geojsonFile, 'utf8');
  const features = osmiumGeoJSONToFeatures(raw, source);

  // Clean up temp files
  await unlink(filteredPbf).catch(() => {});
  await unlink(geojsonFile).catch(() => {});

  return features;
}

// ------------------------------------------------------------------
// FALLBACK PATH — Overpass API (for local dev without osmium)
// ------------------------------------------------------------------

const OVERPASS_ENDPOINTS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

async function overpassQuery(query) {
  const body = 'data=' + encodeURIComponent(query);

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`  Trying ${endpoint}`);
      const res = await fetch(endpoint, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept':       'application/json',
        },
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

function osmElementToFeature(el) {
  const lat = el.type === 'node' ? el.lat : el.center?.lat;
  const lng = el.type === 'node' ? el.lon : el.center?.lon;
  if (!lat || !lng) return null;
  const t = el.tags || {};
  return toFeature(lat, lng, {
    name:    t.name || t['name:en'] || null,
    address: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') || null,
    city:    t['addr:city']     || null,
    state:   t['addr:state']    || 'GA',
    zip:     t['addr:postcode'] || null,
    phone:   t.phone            || t['contact:phone']   || null,
    website: t.website          || t['contact:website'] || null,
    hours:   t.opening_hours    || null,
    source:  'OpenStreetMap',
  });
}

async function fetchOSMViaOverpass(label, qlQuery) {
  console.log(`  Querying Overpass for ${label}…`);
  const data     = await overpassQuery(qlQuery);
  const features = (data.elements || []).map(osmElementToFeature).filter(Boolean);
  return features;
}

// ------------------------------------------------------------------
// OSM category definitions
// ------------------------------------------------------------------

const OSM_CATEGORIES = {
  shelters: {
    label: 'shelters',
    osmiumExpressions: [
      'social_facility=shelter',
      'social_facility=homeless_shelter',
      'homeless=shelter',
    ],
    overpassQuery: `
[out:json][timeout:120];
(
  node["social_facility"="shelter"](${GA_BBOX});
  node["social_facility"="homeless_shelter"](${GA_BBOX});
  node["homeless"="shelter"](${GA_BBOX});
  way["social_facility"="shelter"](${GA_BBOX});
  way["social_facility"="homeless_shelter"](${GA_BBOX});
  relation["social_facility"="shelter"](${GA_BBOX});
);
out center;`.trim(),
  },

  foodBanks: {
    label: 'food-banks',
    osmiumExpressions: [
      'social_facility=food_bank',
      'social_facility=food_pantry',
      'social_facility=soup_kitchen',
      'amenity=food_bank',
    ],
    overpassQuery: `
[out:json][timeout:120];
(
  node["social_facility"="food_bank"](${GA_BBOX});
  node["social_facility"="food_pantry"](${GA_BBOX});
  node["social_facility"="soup_kitchen"](${GA_BBOX});
  node["amenity"="food_bank"](${GA_BBOX});
  way["social_facility"="food_bank"](${GA_BBOX});
  way["social_facility"="food_pantry"](${GA_BBOX});
  way["amenity"="food_bank"](${GA_BBOX});
);
out center;`.trim(),
  },
};

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

async function fetchClinics() {
  console.log('Fetching free clinics from HRSA…');
  const URL = 'https://data.hrsa.gov/DataDownload/DD_Files/Health_Center_Service_Delivery_and_LookAlike_Sites.csv';
  const features = [];

  try {
    for await (const row of streamCSV(URL)) {
      if ((row['Site State Abbreviation'] || '').trim().toUpperCase() !== 'GA') continue;
      const lat = row['Geocoding Artifact Address Primary Y Coordinate'] || row['Latitude'] || '';
      const lng = row['Geocoding Artifact Address Primary X Coordinate'] || row['Longitude'] || '';
      if (!lat || !lng || !isFinite(+lat) || !isFinite(+lng)) continue;
      features.push(toFeature(lat, lng, {
        name:    row['Site Name']             || null,
        address: row['Site Address']          || null,
        city:    row['Site City']             || null,
        state:   'GA',
        zip:     row['Site Postal Code']      || null,
        phone:   row['Site Telephone Number'] || null,
        website: row['Site Web Address']      || null,
        source:  'HRSA',
      }));
    }
  } catch (err) {
    console.error('  HRSA fetch failed:', err.message);
  }

  console.log(`  Found ${features.length} HRSA health centers in GA`);
  return features;
}

// ------------------------------------------------------------------
// USDA SNAP / EBT
// ------------------------------------------------------------------

async function fetchSNAP() {
  console.log('Fetching SNAP/EBT stores from USDA FNS…');

  const URLS = [
    'https://usda-snap-retailer-locator.fns.usda.gov/api/retailerLocator/downloadSNAPRetailers',
    'https://www.fns.usda.gov/sites/default/files/snap/stores/Stores.csv',
  ];

  const features = [];

  for (const url of URLS) {
    try {
      console.log(`  Trying ${url}`);
      for await (const row of streamCSV(url)) {
        if ((row['State'] || row['state'] || '').trim().toUpperCase() !== 'GA') continue;
        const lat = row['Latitude']  || row['latitude']  || '';
        const lng = row['Longitude'] || row['longitude'] || '';
        if (!lat || !lng || !isFinite(+lat) || !isFinite(+lng)) continue;
        features.push(toFeature(lat, lng, {
          name:    row['Store Name'] || row['Name'] || null,
          address: row['Address']    || null,
          city:    row['City']       || null,
          state:   'GA',
          zip:     row['Zip5']       || row['Zip'] || null,
          notes:   'Accepts SNAP / EBT',
          source:  'USDA FNS',
        }));
      }
      if (features.length > 0) break; // success, don't try fallback
    } catch (err) {
      console.warn(`  Failed (${url}): ${err.message}`);
    }
  }

  console.log(`  Found ${features.length} SNAP retailers in GA`);
  return features;
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

async function main() {
  console.log('=== Georgia Resources — Data Refresh ===\n');
  await mkdir(DATA_DIR, { recursive: true });

  const useOsmium = await isOsmiumAvailable();

  if (useOsmium) {
    console.log('osmium-tool detected — using Geofabrik extract (fast, no API limits)\n');
    await downloadGeofabrikExtract();
  } else {
    console.log('osmium-tool not found — falling back to Overpass API');
    console.log('Install osmium-tool for faster, more reliable data fetching.\n');
  }

  // -- OSM categories (shelters + food banks) --
  let shelters, foodBanks;

  if (useOsmium) {
    const { osmiumExpressions: se } = OSM_CATEGORIES.shelters;
    const { osmiumExpressions: fe } = OSM_CATEGORIES.foodBanks;

    shelters  = await fetchOSMViaOsmium('shelters',   se, 'OpenStreetMap');
    foodBanks = await fetchOSMViaOsmium('food-banks', fe, 'OpenStreetMap');

    // Clean up the downloaded PBF after we're done with all OSM categories
    await unlink(GA_PBF).catch(() => {});
  } else {
    shelters  = await fetchOSMViaOverpass('shelters',   OSM_CATEGORIES.shelters.overpassQuery);
    await sleep(3000); // be a polite Overpass citizen
    foodBanks = await fetchOSMViaOverpass('food banks', OSM_CATEGORIES.foodBanks.overpassQuery);
  }

  // -- Other sources (not OSM) --
  const clinics = await fetchClinics();
  const snap    = await fetchSNAP();

  // -- Write output --
  console.log('\nWriting output files…');
  await saveJSON('shelters.json',   shelters);
  await saveJSON('food-banks.json', foodBanks);
  await saveJSON('clinics.json',    clinics);
  await saveJSON('snap.json',       snap);
  await writeFile(
    join(DATA_DIR, 'last-updated.json'),
    JSON.stringify({ date: new Date().toISOString() }, null, 2),
    'utf8'
  );

  console.log('\nDone!');
  console.log(`  Shelters:   ${shelters.length}`);
  console.log(`  Food Banks: ${foodBanks.length}`);
  console.log(`  Clinics:    ${clinics.length}`);
  console.log(`  SNAP/EBT:   ${snap.length}`);
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
