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
let plan = buildPlan(result, matches, store.repo, { closureSignals }); // preview, duplicates, existing saves, tag actions, maybe closed
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
| Mapstr export (`mapstr.zip`, or its `mapstr.csv` / `mapstr.geojson` alone) | `formats/mapstr.ts` | Known format, checked on a real export (T-009); see "Mapstr" below |
| Pin Drop export (one JSON file) | `formats/pindrop.ts` | Known format, checked on a real export (T-009); see "Pin Drop" below |
| TrianguLair export | `formats/triangulair.ts` | This package's own format (below) |

A CSV named `mapstr.csv` without Mapstr's header goes to the column-mapping
screen; a KML or CSV named after Pin Drop goes through the plain KML reader or
the column-mapping screen (Pin Drop exports JSON). Fixtures: `test/fixtures`
(all hand-made; `mapstr/` and `pindrop/` mirror real exports with invented
places; see its README).

### Mapstr

Mapstr exports a ZIP (`mapstr.zip`) holding `mapstr/mapstr.csv` and
`mapstr/mapstr.geojson`, plus macOS junk (`__MACOSX/…`, `._*`, `.DS_Store`),
which is ignored. Detection is by content: a ZIP holding either file (any
name), a CSV with exactly Mapstr's header, a GeoJSON whose properties have
`userComment` and `tags` objects `{name, color}`.

| File | What it holds |
| --- | --- |
| `mapstr.csv` | UTF-8 with a BOM; header `date,name,address,icon,userComment,rating,tags,photos`. `date` is US style without seconds (`6/17/23 18:36`: month/day/2-digit year, local time). `icon` is Mapstr's category key (`restaurant`…). `rating` is often empty, scale not documented. `tags`: names separated by `#` (`Bar#Salon de thé / café#Restaurant`; names hold spaces, accents and `/`). `photos`: comma-separated URLs on Mapstr's image server. **No coordinates** |
| `mapstr.geojson` | FeatureCollection of Points `[lon, lat]`; properties `name`, `address`, `icon`, `userComment`, `tags` as `[{name, color: "#ff5161"}]`. No date, rating or photos |

- **Both files** (the ZIP): position, tag colors, icon and comment from the
  GeoJSON; date, rating and photos from the CSV. Rows are joined by order when
  both files have as many places and every name + address agrees, otherwise
  by normalized name + address. A CSV row without a feature keeps no position
  (`row-not-joined`); a feature without a row has no date.
- **The CSV alone** has no positions: the matching step searches each place by
  name and address (Photon), so places come out "to check" or without a
  position; the preview says the ZIP (or the GeoJSON) gives exact positions
  (`positions-from-address`).
- **An invalid GeoJSON** (not valid JSON, e.g. cut short) is an error
  (`invalid-json`) on its own; in the ZIP, the CSV is used and the preview says
  why (`invalid-geojson`).
- **Mapping.** name, address; `userComment` → comment; tags with their colors
  (the tag step then maps them to my tags), the first one being the main tag;
  `icon` → OSM category (`MAPSTR_ICON_CATEGORIES`: `restaurant` →
  `amenity=restaurant`, `bar`, `cafe`, `museum`, `park`, `hotel`…; only
  `restaurant` has been seen in a real export, an unknown key gives none);
  `date` → creation date.
- **Rating.** The data model has no rating, and Mapstr's scale is not known:
  the rating is kept as written in `ImportedPlace.rating`, never written as
  such. The preview offers "Add Mapstr's rating to the comment"
  (`ratingsInComments`), off by default.
- **Photos** are on Mapstr's server: see "Photos on the source's server"
  below.

### Pin Drop

Pin Drop exports one JSON file: `{ data: [...], users, org, largeNumberOfPins,
pinResultLimit, largeOrgFilteredPinTotal }`, `data` mixing items by `type`
(`tag`, `pin`, `message`); a bare array of those items is read too. Detected by
content (any file name); a file that starts like one but does not parse (cut
short, edited by hand) is the error `invalid-pindrop`. The full layout and the
mapping are in the header of `formats/pindrop.ts`; in short:

- `name`, `lat`/`lng` (else the `location` Point), `address` (used to match
  to OpenStreetMap); `description` → comment; `date_dropped` → date saved
  (ISO with microseconds and an offset: parsed by hand, `parsePinDropDate`);
  `id` → `ids.sourceId`. `website`, `phoneNumber`, `email` are not read (no
  field, not used for matching).
- `favourite` → favorite, `wishList` → to try; status-like tags ("À essayer")
  → status, criteria stay tags, as for Mapstr.
- `isSecret` → `sharing: 'private'` and `commentVisibility: 'private'` (the
  `secret-places` warning counts them; a folded entry that is private keeps
  the place private).
- Tags (`tag_ids`) by name with their color; a reference to a tag absent from
  the file, or nameless, is left out (`missing-tags` warning, one per place).
  Only tags some place uses are listed. The tag icon gives an OSM category
  (`PINDROP_ICON_CATEGORIES`: `coffee` → `amenity=cafe`, `croissant` →
  `shop=bakery`, `martini-glass` → `amenity=bar`, `hotdog` →
  `amenity=fast_food`…): the place's category (pin icon, "maybe closed"
  check) and the new tag's `osmCategories`. Pin Drop icon names are not kept
  as tag icons (not the app's set).
- Photos: `media` (else `heroImageFull`/`heroImageThumb`), full size first,
  keyed by Pin Drop's file name.

### Photos on the source's server

Mapstr and Pin Drop keep photos on their own servers. Their URLs stay in memory
(`ImportedPlace.remotePhotos`, never written to my data or an export) and the
preview counts them (`remote-photos`). It offers "Download the N photos from
…", off by default, with a note that it contacts that server
(`setDownloadRemotePhotos`). Then, once the places are written, `applyImport`
downloads them through `ApplyOptions.fetchPhoto` (injected: the app's fetch
without cookies or referrer), 3 at a time, 30 s per attempt, each URL of a
photo in turn, and hands each file to `addDownloadedPhoto` (the app shrinks it
like a picked photo and stores it with `Photos.add`). A failure is counted
(`remotePhotosFailed`), never an import error; cancel stops the downloads.
The photo id is `remotePhotoId(placeId, key)`: a re-import does not download
or add a photo already there. A `PhotoDownloadBlockedError` from the fetcher
(a browser's cross-origin refusal) stops the rest and sets
`photoDownloadBlocked`: the app says photos can be downloaded from the phone
app. Undo removes them with the import (new places to the trash with their
photos, `addedMediaIds` on merged ones).

### Tags that are not categories

`tagRole` (tagMatch.ts) recognizes, in English and French, tag names that
stand for something else (owner feedback on Mapstr exports):

- a **status**: "À essayer", "à tester", "to try" → the tag action
  `{ kind: 'status', status: 'to_try' }`, preselected: places with it get the
  status, and no tag is created. The user can make it a tag again.
- a **practical criterion**: "Openair" / "terrasse" (terrace), "Vege friendly" /
  "veggie" (vegetarian), "A emporter" / "takeaway" (takeaway). TrianguLair reads
  criteria from OpenStreetMap only (a save has no criterion of its own), so
  these stay tags; the tag step says why.

No tag is ever preselected as "Don't import".

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
  two manual points (or zones) within 50 m (`IMPORT_MERGE_RADIUS_M`; the data
  package's duplicate suggestions use 30 m, but an app's pin and the OSM object
  are often further apart) with similarity ≥ 0.6 → folded (tags united,
  comments joined, best status, earliest date). Against my saves: same place
  id, or a save of mine of the same kind within 50 m with a similar name →
  "already in my places". Such places are left as they are unless the user
  chooses to merge (`plan.mergeExisting`, `setMergeExisting`): then tags are
  added, the comment completed (never replaced), status and price set only if
  empty, and a save in the trash restored. Re-importing the same file writes
  nothing (`counts.alreadySaved`, or `counts.unchanged` when merging).
- **Maybe closed** (spec "Closed place detection"). `buildPlan(…, { closureSignals })`
  takes the osm package's `osmSignals` (the app passes it; this package does not
  depend on `@triangulair/osm`): a matched OSM object with a closed signal
  (lifecycle prefix, `disused=yes`, vacant, `end_date` passed, hours `off`) is
  flagged, and so is a manual point whose source gives a category while OSM
  has no place of that name within 250 m (signal `not_found_nearby`, low;
  never when OSM could not be reached). `PlanItem.closure` holds the signals,
  `summarizePlan(…).maybeClosed` the count; `setMaybeClosedSkipped` leaves them
  all out or keeps them (kept by default). Written places get the closure
  system's flag (`status: 'maybe_closed'` and `closedSignals` in the place
  cache), so the card shows the "Maybe closed" badge. No extra network query:
  the tags come with the tile queries. The tile query returns live POIs only,
  so a place mapped only as `disused:amenity=…` is seen as "not found nearby".

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

1. **Mapstr and Pin Drop formats** are verified on one real export each;
   whether Mapstr's export needs the paid plan is not known.
   Criteria from tags ("Openair" → terrace) would need a criterion of my own on
   a save, which the data model does not have.
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
