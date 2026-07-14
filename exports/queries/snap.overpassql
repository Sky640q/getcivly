/*
  SNAP / EBT RETAILERS — Georgia
  NOTE: OSM SNAP tagging is sparse. The USDA FNS CSV source in
  fetch-data.mjs gives much better coverage for authorized retailers.
  Only use this if you want to supplement with OSM-tagged locations.

  Paste this into https://overpass-turbo.eu, click Run, then:
  Export → Download → GeoJSON → save as exports/snap.geojson
*/

[out:json][timeout:90];
area["ISO3166-2"="US-GA"]->.ga;
(
  nwr["payment:electronic_benefits_transfer"="yes"](area.ga);
  nwr["payment:ebt"="yes"](area.ga);
);
out center;
