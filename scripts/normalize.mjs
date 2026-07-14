#!/usr/bin/env node
/**
 * normalize.mjs
 *
 * Converts raw Overpass Turbo GeoJSON exports into the normalized format
 * used by the map (data/*.json).
 *
 * Workflow:
 *   1. Run a query in https://overpass-turbo.eu
 *   2. Export → Download → GeoJSON  →  save to exports/<category>.geojson
 *   3. node scripts/normalize.mjs
 *   4. Reload the browser — new data appears on the map.
 *
 * Expected files in exports/:
 *   exports/shelters.geojson
 *   exports/food-banks.geojson
 *   exports/clinics.geojson    (optional — HRSA is more complete for clinics)
 *   exports/snap.geojson       (optional — USDA is more complete for SNAP)
 *
 * Any file not found in exports/ is left untouched in data/.
 */

import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const EXPORTS_DIR = join(__dirname, '..', 'exports');
const DATA_DIR    = join(__dirname, '..', 'data');

// Map export filename → output data filename
const FILE_MAP = {
  'shelters.geojson':   'shelters.json',
  'food-banks.geojson': 'food-banks.json',
  'clinics.geojson':    'clinics.json',
  'snap.geojson':       'snap.json',
};

// ------------------------------------------------------------------
// Geometry helpers
// ------------------------------------------------------------------

function centroid(geometry) {
  if (!geometry) return null;

  const pts =
    geometry.type === 'Point'           ? [geometry.coordinates] :
    geometry.type === 'MultiPoint'      ? geometry.coordinates :
    geometry.type === 'LineString'      ? geometry.coordinates :
    geometry.type === 'MultiLineString' ? geometry.coordinates.flat() :
    geometry.type === 'Polygon'         ? geometry.coordinates[0] :
    geometry.type === 'MultiPolygon'    ? geometry.coordinates[0][0] :
    [];

  if (!pts || pts.length === 0) return null;
  const sum = pts.reduce((a, c) => [a[0] + c[0], a[1] + c[1]], [0, 0]);
  return [sum[0] / pts.length, sum[1] / pts.length];
}

// ------------------------------------------------------------------
// OSM tag → normalized property mapping
// ------------------------------------------------------------------

function normalizeProperties(raw) {
  // raw has OSM tags plus Overpass meta like @id, @timestamp, etc.
  const t = raw || {};

  const addrParts = [t['addr:housenumber'], t['addr:street']].filter(Boolean);

  return {
    name:    t.name          || t['name:en']       || null,
    address: addrParts.length ? addrParts.join(' ') : (t['addr:full'] || null),
    city:    t['addr:city']  || null,
    state:   t['addr:state'] || 'GA',
    zip:     t['addr:postcode'] || null,
    phone:   t.phone         || t['contact:phone'] || null,
    website: t.website       || t['contact:website'] || null,
    hours:   t.opening_hours || null,
    notes:   t.description   || null,
    source:  'OpenStreetMap',
    osm_id:  t['@id']        || null,
  };
}

// ------------------------------------------------------------------
// Convert one Overpass Turbo GeoJSON export → our feature array
// ------------------------------------------------------------------

function convertExport(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('Invalid JSON: ' + e.message);
  }

  // Accept either a FeatureCollection or a bare array
  const features = Array.isArray(parsed)
    ? parsed
    : (parsed.features || []);

  const result = [];
  let skipped = 0;

  for (const feature of features) {
    const coords = centroid(feature.geometry);
    if (!coords) { skipped++; continue; }

    const [lng, lat] = coords;
    if (!isFinite(lat) || !isFinite(lng)) { skipped++; continue; }

    result.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: normalizeProperties(feature.properties),
    });
  }

  if (skipped > 0) {
    console.log(`    (skipped ${skipped} features with no usable geometry)`);
  }

  return result;
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

async function main() {
  console.log('=== Normalize Overpass Turbo exports ===\n');

  let processed = 0;

  for (const [exportFile, dataFile] of Object.entries(FILE_MAP)) {
    const exportPath = join(EXPORTS_DIR, exportFile);
    const dataPath   = join(DATA_DIR,    dataFile);

    if (!existsSync(exportPath)) {
      console.log(`  Skipping ${exportFile} — not found in exports/`);
      continue;
    }

    console.log(`  Processing ${exportFile} → data/${dataFile}`);

    try {
      const raw      = await readFile(exportPath, 'utf8');
      const features = convertExport(raw);

      await writeFile(dataPath, JSON.stringify(features, null, 2), 'utf8');
      console.log(`    ✓ ${features.length} features written`);
      processed++;
    } catch (err) {
      console.error(`    ✗ Error: ${err.message}`);
    }
  }

  if (processed === 0) {
    console.log('\nNo exports found. Add .geojson files to the exports/ folder first.');
    console.log('See exports/queries/*.overpassql for the queries to run in Overpass Turbo.');
  } else {
    // Update last-updated timestamp
    await writeFile(
      join(DATA_DIR, 'last-updated.json'),
      JSON.stringify({ date: new Date().toISOString() }, null, 2),
      'utf8'
    );
    console.log(`\nDone. Updated ${processed} data file(s).`);
    console.log('Reload http://localhost:8080 to see the changes.');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
