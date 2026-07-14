# US Community Resources Map

Interactive map of free services for residents in need — shelters, food banks, SNAP/EBT retailers, and federally-qualified health centers. Currently covers Georgia, with easy expansion to any US state.

Live site: **https://sky640q.github.io/getcivly/**

---

## What it shows

| Color | Category | Source |
|---|---|---|
| Blue | Shelters | OpenStreetMap |
| Orange | Food Banks & Pantries | OpenStreetMap |
| Green | SNAP / EBT Retailers | USDA FNS |
| Red | Free Health Clinics | HRSA |

---

## Adding a new state

Open `config/states.json` and set `"enabled": true` for the state you want:

```json
"FL": {
  "enabled": true,
  ...
}
```

Then trigger **Actions → Refresh Resource Data → Run workflow**. That's it — data is fetched automatically from all three universal sources (SNAP, HRSA, OSM) for the new state, written to `data/FL/`, and the map updates.

States already pre-configured (just flip `enabled`): GA, FL, TX, NC, SC, AL, TN.

---

## Configuration files

### `config/states.json`
Controls which states are active and their geographic settings.

```jsonc
"GA": {
  "enabled": true,          // flip to false to disable
  "name": "Georgia",
  "center": [32.75, -83.5], // map default center for this state
  "zoom": 7,
  "bbox": [...],            // used for Overpass fallback queries
  "geofabrikSlug": "north-america/us/georgia",
  "sources": ["snap", "clinics", "osm"], // which universal sources to fetch
  "extraSources": []        // state-specific APIs (see below)
}
```

### `config/sources.json`
All universal API endpoints and field mappings in one place. If an API URL changes, update it here — no need to touch the fetch script.

```jsonc
{
  "snap":    { "url": "...", "stateField": "State", ... },
  "clinics": { "url": "...", "stateField": "Site State Abbreviation", ... },
  "osm":     { "baseUrl": "https://download.geofabrik.de", "overpassEndpoints": [...], ... }
}
```

### Adding a state-specific source

If a state has its own API (e.g. a state food bank locator), add it to `extraSources`:

```json
"extraSources": [
  {
    "category": "food",
    "type": "geojson_url",
    "url": "https://state-api.gov/food-banks.geojson",
    "attribution": "State Dept of Agriculture"
  }
]
```

Supported `type` values: `geojson_url` (more can be added in `fetch-data.mjs`).

---

## Local development

```bash
# 1. Clone the repo
git clone https://github.com/Sky640q/getcivly.git
cd getcivly

# 2. Serve the site
python -m http.server 8080
```

Open **http://localhost:8080**. Each state's `data/{STATE}/` folder has sample entries so the map works immediately.

---

## Refreshing data

### Option A — GitHub Actions (recommended)

The workflow in `.github/workflows/refresh-data.yml` runs every Monday at 03:00 UTC.
Trigger it manually: **Actions tab → Refresh Resource Data → Run workflow**

### Option B — Run locally (Linux/macOS/WSL)

```bash
# Requires osmium-tool: sudo apt-get install osmium-tool
node scripts/fetch-data.mjs
```

osmium-tool is optional — without it the script falls back to the Overpass API automatically.

### Option C — Manual OSM export (works on any OS)

1. Open **https://overpass-turbo.eu**
2. Paste `exports/queries/shelters.overpassql` → Run → Export GeoJSON → save as `exports/shelters.geojson`
3. Repeat for `food-banks.overpassql`
4. Run: `node scripts/normalize.mjs`

---

## Project structure

```
├── index.html
├── css/style.css
├── js/app.js                           # Leaflet map, loads data/manifest.json
├── config/
│   ├── states.json                     # Enable/disable states, set bboxes
│   └── sources.json                    # Universal API URLs and field mappings
├── data/
│   ├── manifest.json                   # Generated — lists enabled states + timestamp
│   ├── GA/
│   │   ├── shelters.json
│   │   ├── food-banks.json
│   │   ├── clinics.json
│   │   └── snap.json
│   └── {STATE}/                        # One folder per enabled state
├── exports/
│   ├── queries/                        # Overpass Turbo .overpassql files
│   └── *.geojson                       # Manual exports (gitignored)
├── scripts/
│   ├── fetch-data.mjs                  # Automated fetcher (reads config/)
│   └── normalize.mjs                   # Converts manual Overpass exports
└── .github/workflows/
    └── refresh-data.yml                # Weekly cron, free for public repos
```

---

## Data sources

- **OpenStreetMap** via [Geofabrik](https://download.geofabrik.de) (primary) or [Overpass Turbo](https://overpass-turbo.eu) (fallback)
- **HRSA Health Center Program** — federally qualified health centers. [data.hrsa.gov](https://data.hrsa.gov)
- **USDA FNS SNAP Retailer Locator** — authorized SNAP/EBT retailers. [services1.arcgis.com](https://usda-snap-retailers-usda-fns.hub.arcgis.com/)

---

## License

MIT. Data belongs to respective sources (OSM © ODbL, HRSA public domain, USDA public domain).
