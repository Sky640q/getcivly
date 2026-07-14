/*
  SHELTERS — Georgia
  Paste this into https://overpass-turbo.eu, click Run, then:
  Export → Download → GeoJSON → save as exports/shelters.geojson
*/

[out:json][timeout:90];
area["ISO3166-2"="US-GA"]->.ga;
(
  nwr["social_facility"="shelter"](area.ga);
  nwr["social_facility"="homeless_shelter"](area.ga);
  nwr["homeless"="shelter"](area.ga);
  nwr["shelter_type"="basic_hut"](area.ga);
);
out center;
