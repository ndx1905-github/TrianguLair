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
| `mapstr/` | Mapstr export: `mapstr.zip` (with macOS junk), the same `mapstr/mapstr.csv` and `mapstr/mapstr.geojson` alone, and `invalid.geojson` (cut short: the "invalid file" error case) | The layout of a real Mapstr export (T-009): BOM, header, US dates, `#`-separated tags, photo URLs, `{name, color}` tags. Places, addresses, comments and photo URLs are **invented** (photos on `images.example.invalid`); generic tag words only. Rebuilt by `make_fixtures.py` |
| `pindrop/` | Pin Drop export: `pindrop.json` (tags, pins, a message; secret, favourite, wish-list pins; references to tags absent from the file; media and hero images; dates with and without microseconds; missing, empty and multi-line descriptions) and `invalid.json` (cut short) | The layout of a real Pin Drop export (T-009). Every value is **invented** (places, people, random UUIDs, images on `pins.example.org`). Rebuilt by `make_fixtures.py` |
