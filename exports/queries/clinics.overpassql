/*
  FREE CLINICS — Georgia
  NOTE: OSM coverage for clinics is sparse. The HRSA CSV source in
  fetch-data.mjs gives much better coverage for free health centers.
  Only use this if you want to supplement with OSM-tagged clinics.

  Paste this into https://overpass-turbo.eu, click Run, then:
  Export → Download → GeoJSON → save as exports/clinics.geojson
*/

[out:json][timeout:90];
area["ISO3166-2"="US-GA"]->.ga;
(
  nwr["amenity"="clinic"]["fee"="no"](area.ga);
  nwr["amenity"="clinic"]["healthcare:speciality"="general"](area.ga);
  nwr["healthcare"="centre"]["fee"="no"](area.ga);
  nwr["social_facility"="healthcare"](area.ga);
);
out center;
