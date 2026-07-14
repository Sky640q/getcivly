# Georgia Community Resources Map

Interactive map of free services for residents in need across Georgia — shelters, food banks, SNAP/EBT retailers, and federally-qualified health centers.

**Live site:** https://YOUR-ORG.github.io/YOUR-REPO/

---

## What it shows

| Color | Category | Source |
|---|---|---|
| Blue | Shelters | OpenStreetMap |
| Orange | Food Banks & Pantries | OpenStreetMap |
| Green | SNAP / EBT Retailers | USDA FNS |
| Red | Free Health Clinics | HRSA |

---

## Local development

```bash
# 1. Clone the repo
git clone https://github.com/YOUR-ORG/YOUR-REPO.git
cd YOUR-REPO

# 2. Serve the site
python -m http.server 8080
```

Open **http://localhost:8080**. The `data/` folder has sample entries so the map works immediately.

---

## Updating OSM data (shelters + food banks)

### Option A — Overpass Turbo (manual, works anywhere)

1. Open **https://overpass-turbo.eu**
2. Paste the contents of `exports/queries/shelters.overpassql` into the editor
3. Click **Run**
4. Click **Export → Download → GeoJSON**
5. Save the file as `exports/shelters.geojson`
6. Repeat steps 2–5 for `exports/queries/food-banks.overpassql`
7. Run the normalize script:
   ```bash
   node scripts/normalize.mjs
   ```
8. Reload http://localhost:8080 — the new data appears on the map.

Repeat monthly or whenever you want fresh data. The `exports/` folder is gitignored so the raw downloads don't bloat the repo.

### Option B — GitHub Actions (automatic, free for public repos)

GitHub Actions is **free with unlimited minutes for public repositories**. The workflow in `.github/workflows/refresh-data.yml` runs every Monday, fetches fresh data from all sources, and commits it back automatically.

1. Push the repo to GitHub as a **public** repository
2. Actions will run automatically on Monday mornings
3. You can also trigger it manually: **Actions tab → Refresh Resource Data → Run workflow**

---

## Updating clinic + SNAP data

These two sources are fetched from CSV APIs (not OSM), so Overpass Turbo doesn't apply.

Run the full fetch script (requires Linux/macOS or WSL on Windows — osmium must be installed):
```bash
node scripts/fetch-data.mjs
```

Or rely on GitHub Actions to keep these current automatically.

---

## Deploy to GitHub Pages

1. Push to GitHub (public repo).
2. **Settings → Pages → Source:** `main` branch, `/ (root)`.
3. Site goes live at `https://YOUR-ORG.github.io/YOUR-REPO/` within a minute.

---

## Project structure

```
├── index.html                          # Single-page app
├── css/style.css                       # Styles (mobile-first, responsive)
├── js/app.js                           # Leaflet map + data loading + filters
├── data/
│   ├── shelters.json                   # Committed, updated by Action or normalize script
│   ├── food-banks.json
│   ├── clinics.json
│   ├── snap.json
│   └── last-updated.json
├── exports/
│   ├── queries/
│   │   ├── shelters.overpassql         # Paste into overpass-turbo.eu
│   │   ├── food-banks.overpassql
│   │   ├── clinics.overpassql
│   │   └── snap.overpassql
│   └── *.geojson                       # Your downloads go here (gitignored)
├── scripts/
│   ├── fetch-data.mjs                  # Full automated fetch (needs osmium on Linux)
│   └── normalize.mjs                   # Converts Overpass Turbo exports → data/*.json
└── .github/workflows/
    └── refresh-data.yml                # Weekly cron — free for public repos
```

---

## Data sources

- **OpenStreetMap** via [Overpass Turbo](https://overpass-turbo.eu) or [Geofabrik](https://download.geofabrik.de/north-america/us/georgia.html)
- **HRSA Health Center Finder** — federally qualified health centers. [data.hrsa.gov](https://data.hrsa.gov)
- **USDA FNS SNAP Retailer Locator** — authorized SNAP/EBT retailers. [fns.usda.gov](https://www.fns.usda.gov/snap/retailer-locator)

---

## License

MIT. Data belongs to respective sources (OSM © ODbL, HRSA public domain, USDA public domain).
