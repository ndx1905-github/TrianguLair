# Import fixtures

All files here are **hand-made**: no real user export is committed. Names and
coordinates are those of the synthetic Marais places of
`packages/osm/test/fixtures` (so matching can be tested against them), plus a
few made-up places.

| Folder | Format | Layout based on |
| --- | --- | --- |
| `google/` | Google Takeout: `Saved Places.json` (older property layout), `saved-places-2024.json` (newer layout, with a place without coordinates), `Labeled places.json`, Saved lists as CSV (`Want to go.csv`, `Favorite places.csv`) | Known Takeout formats (documented and widely reproduced); data invented |
| `kml/` | Google My Maps KML (folders, style ids with colors, CDATA, line and polygon), Organic Maps bookmarks KML | KML 2.2 and the styles those apps write; data invented. The KMZ is built from `my-maps.kml` in the test (fflate) |
| `geojson/` | uMap export (`type: "umap"`, layers), overpass-turbo export (`@id`), generic GeoJSON with odd property names | Documented formats; data invented |
| `csv/` | French spreadsheet (`;`, decimal comma, French headers, day-first dates), combined "lat, lon" column, TSV without meaningful headers | Generic CSV |
| `hypothetical/` | **HYPOTHETICAL** Mapstr CSV and GeoJSON, Pin Drop CSV and KML | **Not based on a real export** (task T-009): column names and structure are guesses. Replace with real exports when available |
