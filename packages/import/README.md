# @triangulair/import

Import and export for TrianguLair (tasks T-114 and T-115): file readers to one
`ImportedPlace` model, matching to OpenStreetMap, the import preview (found /
to check / manual point / no position, tag mapping, duplicates), batched writes
to `@triangulair/data` with progress, cancel and undo, and the full GeoJSON
export (a ZIP with my photos) with lossless re-import. MPL-2.0, TypeScript strict, pure JavaScript
(fflate for KMZ; no WebAssembly, no DOM API), so it runs in Hermes, browsers
and Node.

```sh
cd packages/import
npm install --workspaces=false   # links ../data (needs packages/data installed for the tests)
npm test
npm run typecheck
```

## Flow

```ts
import { readImportFile, readCsvWithMapping, matchPlaces, osmLookupFromClient,
         buildPlan, resolveItem, setTagAction, applyImport, undoImport, exportGeoJson } from '@triangulair/import';

const o = readImportFile({ name: file.name, bytes });        // detects the format
// o.kind: 'parsed' | 'needsMapping' (generic CSV: confirm the guessed columns) | 'error'
const result = o.kind === 'needsMapping' ? readCsvWithMapping(o.table, o.mapping, o.fileName) : o.result;
const matches = await matchPlaces(result.places, osmLookupFromClient(osmClient), { signal, onProgress });
let plan = buildPlan(result, matches, store.repo);             // preview, duplicates, existing saves, tag actions
plan = resolveItem(plan, key, { kind: 'osm', candidate }, store.repo);   // user's choices
plan = setTagAction(plan, 'Want to go', { kind: 'map', tagId });
const report = await applyImport(store, plan, { batchSize: 200, signal, onProgress });
await undoImport(store, report);                               // "undo in one gesture"
const json = exportGeoJson(store);                             // T-115
const file = await exportArchive(store, { image: (id, which) => photos.full(id) /* or .thumbnail */ });
// file.name "triangulair-2026-11-21.zip" (or ".geojson" without photos), file.bytes, file.mime
await applyImport(store, plan, { addPhoto: (placeId, p) => photos.add(placeId, { full: p.images.full, … }) });
```

## Formats

| Format | Reader | Status |
| --- | --- | --- |
| Google Takeout `Saved Places.json` | `formats/geojson.ts` | Known format; both property layouts (older `Title` / `Location.Geo Coordinates`, newer `location.name` / `google_maps_url`, `[0, 0]` = no coordinates) |
| Google Takeout `Labeled places.json` | `formats/geojson.ts` | Known format |
| Google Takeout Saved lists (`<list>.csv`: `Title, Note, URL[, Tags, Comment]`) | `formats/csv.ts` | Known format. The list name (file name) becomes a tag; default lists give a status ("Want to go" → to try, "Favorite places" → favorite). Coordinates come from the URL when it has them (`!3d…!4d…`, `?q=lat,lon`, `/search/lat,lon`, `@lat,lon`); otherwise the place is searched by name |
| KML (Google My Maps, Google Earth, Organic Maps…) and KMZ | `formats/kml.ts`, own tolerant XML reader (`xml.ts`), `fflate` unzip | Known format. Folders → tags with their colors (KML styles, My Maps style ids, Organic Maps color names); points → places, lines and polygons → zones; `ExtendedData` fields read |
| GeoJSON (uMap export, overpass-turbo, any) | `formats/geojson.ts` | Property names guessed (name/title/nom, description/comment/notes, tags/category/list, status, url, created…); OSM ids (`@id`, `osm_type`/`osm_id`) kept; uMap layers → tags with colors |
| Generic CSV / TSV | `formats/csv.ts` | `,` `;` or tab, decimal commas, day-first dates; `guessMapping` from headers (en/fr/de/es/it synonyms) and from values (two numeric columns, a "lat, lon" column, Google links); the app's column-mapping screen corrects it |
| **Mapstr export** | `formats/unverified/mapstr.ts` | **UNVERIFIED** (no real export seen, T-009): best-effort CSV and GeoJSON readers on the generic path, plus guesses (JSON tag objects with colors, tag-color column, user/public comments). Every result carries an `unverified-format` warning; the app shows a banner |
| **Pin Drop export** | `formats/unverified/pindrop.ts` | **UNVERIFIED** (T-009): KML through the KML reader, CSV through the generic reader plus guesses (`Group` → tag, `Visited` → tried) |
| TrianguLair export | `formats/triangulair.ts` | This package's own format (below) |

Because the Mapstr and Pin Drop readers sit on the generic paths, an unknown
variant of their files still imports as long as it is CSV, GeoJSON or KML with
recognizable columns. Fixtures: `test/fixtures` (all hand-made; the
`hypothetical/` folder holds the guessed Mapstr and Pin Drop layouts, see its
README).

## Matching to OpenStreetMap

- **Network.** Places are grouped into tiles of 0.01° (about 1 km); each tile
  is **one** Overpass bbox query (named POIs, widened by the 250 m search
  radius, under the osm package's area limit). Places without coordinates are
  searched by name (and address) **with Photon only** (`autocomplete` mode):
  Nominatim's policy discourages bulk geocoding. The osm client's rate limits,
  cache and failover apply. Offline, places become manual points
  (`lookupFailed`), and those without coordinates stay unlocated.
- **Score.** Name similarity from `@triangulair/data` (Sørensen–Dice on
  bigrams, generic words ignored, whole-word containment = 1), +0.15 when the
  candidate's street address appears in the imported address; distance costs
  up to 0.3 at 250 m.
- **Rules** (`MATCH_RULES`). Automatic: similarity ≥ 0.8 within 80 m, or ≥ 0.6
  within 25 m, and the runner-up at least 0.2 less similar. Otherwise, any
  candidate with similarity ≥ 0.45 within 250 m → "to check" (up to 4 offered;
  the best is pre-selected when its similarity ≥ 0.6). Else a manual point.
  A place found by name only is never automatic. Places the source already ties
  to OSM (`@id`, TrianguLair export) and zones are not looked up.
- **Duplicates** (spec "No duplicates"). In the file: same target OSM place, or
  two manual points (or zones) within 30 m with similarity ≥ 0.6 (the data
  package's rule) → folded (tags united, comments joined, best status, earliest
  date). Against my saves: same place id, or a save of mine of the same kind
  within 30 m with a similar name → merged: tags added, comment completed (never
  replaced), status and price only if empty; a save in the trash is restored.

## Writing

`applyImport` writes the new tags in one change, then the saves in batches of
200 per `DataStore.change` (one Yjs + one SQLite transaction each), yielding to
the UI between batches; `signal` stops after the current batch (what is written
stays, and the report can undo it). The OSM tags of matched places are cached on
the place card. `undoImport` puts new saves in the trash, gives merged saves
back their tags, comment and status, and deletes created tags and lists.
Original creation dates are kept: this package added an optional
`SaveInput.createdAt` to `@triangulair/data` (ignored for an existing save).

## Export (T-115)

`buildExport` / `exportGeoJson`: one GeoJSON FeatureCollection (RFC 7946) that
other tools open as is (each feature: name, `osm` reference and URL, category,
tag names, comment, status…), with a foreign member `triangulair`
(`format: "triangulair-export"`, `version` 1 / `minor` 1, as in the spec's
"Format versions") holding what a lossless re-import needs: tags (tree, colors,
icons, OSM categories, trash), lists (filters, manual items, visibility, link
key), tag mappings. Features: every save of mine, places and zones, trash
included, with comment visibility, price, sharing, dates and my photos.

**Photos** (minor 1). Each feature's `media` lists my photos on that place:
`id`, `file` and `thumb` (content hashes of the images), `mime`, `width`,
`height`, `blurhash`, `created_at` (when it was added) and `author` (my owner
id). Friends' photos are never exported, only mine. `exportArchive` makes the
export with the images: a ZIP archive holding the GeoJSON as
`triangulair.geojson` and, for each photo, its full image and thumbnail,
decrypted and without metadata (`photos/0001.webp`, `photos/0001-thumb.webp`;
stored, not recompressed), named by the photo's `image` and `thumb_image`.
`image(id, which)` supplies them (the app: the photo store, which fetches a
photo of mine from my storage when this device does not have it); a photo it
cannot supply keeps its metadata and is counted in `missing`. Without any
image the result is the plain GeoJSON file. The file holds my photos in
clear: the export screen says so.

**Reading it back.** `readImportFile` recognizes the archive (a zip with
`triangulair.geojson`; any other zip is read as KMZ). Only `triangulair.geojson`
(≤ 256 MiB) and `photos/<name>.{webp,avif,jpg}` entries (≤ 16 MiB each) are
unpacked. A photo is imported only with both its images, through the
`addPhoto(placeId, photo)` option of `applyImport` (the app's photo store checks
and strips them again, keeps them on the device, and the next sync uploads
them under new keys); it gets a new id and keeps its date. A photo already on
the save (same content hash) is not added again; on a save the import merged
into, `undoImport` removes the photos it added. A plain GeoJSON export carries
the metadata only: its photos are not imported (`photos-not-included`
warning, `counts.photosSkipped`).

The round-trip test re-imports an export into an empty store and compares the
two exports (tag, list and photo ids aside): equal, over two generations,
photos and their images included; re-importing into the same store changes
nothing. Not carried: `updated_at` (set at import) and the date a save was put
in the trash (set at import). A higher `minor` is read (unknown fields
ignored, warning); a higher `version` is refused.

## Open questions

1. **Mapstr and Pin Drop formats** are guesses until T-009 provides real
   exports (and tells whether Mapstr's export needs the paid plan).
2. **Google Saved CSV without coordinates.** Most list links carry only a
   feature id; the place is found by a Photon name search and always needs a
   check. Resolving the CID would need Google's API (not used).
3. **Link key in the export.** Lists' `link_key` is exported in plain text so a
   re-import keeps shared links working. The export file is then sensitive;
   should it be optional?
4. **Preview on a map.** The spec says doubtful matches are validated "on the
   map"; the preview is a list with distances for now.
5. **Large files.** Parsing is synchronous (a few ms per thousand rows);
   writing is batched. A 10,000-place Takeout would mean about 100 Overpass
   tile queries for a city-scale export, far more for places spread worldwide.
