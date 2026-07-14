/*
  FOOD BANKS & PANTRIES — Georgia
  Paste this into https://overpass-turbo.eu, click Run, then:
  Export → Download → GeoJSON → save as exports/food-banks.geojson
*/

[out:json][timeout:90];
area["ISO3166-2"="US-GA"]->.ga;
(
  nwr["social_facility"="food_bank"](area.ga);
  nwr["social_facility"="food_pantry"](area.ga);
  nwr["social_facility"="soup_kitchen"](area.ga);
  nwr["amenity"="food_bank"](area.ga);
  nwr["amenity"="food_pantry"](area.ga);
);
out center;
