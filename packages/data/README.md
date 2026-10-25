# @triangulair/data

The local data layer of TrianguLair (tasks T-101 and T-102): the SQLite
database with spatial and full-text indexes, the Automerge document that holds
the user's own data, and the list filters. MPL-2.0.

```sh
cd packages/data
npm install --workspaces=false
npm test           # unit, property-based and performance tests
npm run typecheck
PERF_REPORT=1 npx vitest run test/perf.test.ts   # print the timing table
```

## Design in one picture

```
            edits (DocTx)                       merge / importChanges
 app ───────────────────────► Automerge doc ◄──────────────────────── my other devices
                                  │  (source of truth for MY saves, zones, tags, lists)
                                  │  deterministic projection, same SQLite transaction
                                  ▼
 app ◄──── queries ──────── SQLite (places, saves, tags, lists, …, R*Tree, FTS5)
                                  ▲
           OSM cache, friends' saves, people (written directly, not mine to merge)
```

- **Storage-agnostic core.** Everything talks to a small synchronous
  `SqlDriver` (`exec`, `run`, `all`, `get`, `transaction`). Two drivers:
  - `@triangulair/data/node`: `NodeSqliteDriver` on better-sqlite3 (tests, tools).
  - `@triangulair/data/expo`: `ExpoSqliteDriver`, a thin adapter over
    expo-sqlite's `*Sync` API. Type-checked against expo-sqlite 57 (SDK 57),
    not run in tests; it imports only types, so it adds no runtime dependency.
- **The document is the source of truth** for my own data. Every edit is an
  Automerge change; the new chunk is appended to `doc_chunks` and projected
  into the tables **in the same SQLite transaction**, so the document and its
  projection never disagree after a crash.
- **Everything else** (OSM data on the place card, friends' decrypted saves,
  people) is a local cache written directly through the repository.

### Using it in the app (not wired yet)

```ts
import { openDatabaseSync } from 'expo-sqlite';
import { DataStore } from '@triangulair/data';
import { ExpoSqliteDriver } from '@triangulair/data/expo';

const store = DataStore.open({
  driver: new ExpoSqliteDriver(openDatabaseSync('triangulair.db')),
  meId: myPublicKey,
  actor: deviceActorHex,          // stable per device
});
const pins = store.repo.mapPins([w, s, e, n]);   // map layer
const id = store.putSave({ place: { osm: { type: 'node', id: 123 }, name, category, geometry } });
```

expo-sqlite compiles FTS5 by default but **not R*Tree**; enable it in
`app.json` (a native rebuild):

```json
["expo-sqlite", { "customBuildFlags": "-DSQLITE_ENABLE_RTREE=1" }]
```

Without it, and on web (expo-sqlite's wa-sqlite build has neither module),
`migrate` detects the missing modules and uses plain B-tree indexes and a
`LIKE`-style scan instead; results are the same (tested in both modes),
only slower. `rebuildIndexes` switches a database to the indexes once the
build supports them. No native dependency was added to apps/mobile in this
task. The app also needs a `crypto.getRandomValues` polyfill (or pass
`newId`) and, more importantly, a way to run Automerge (see Open questions).

## API summary

| Module | Main exports |
| --- | --- |
| `DataStore` (store.ts) | `open(options)`, `change(tx => …)` (one atomic change), `merge(docOrBytes)`, `exportDoc(sinceHeads?)`, `importChanges(bytes)`, `heads()`, `compact()`, `reproject()`, `doc` (lazy), `saveId(placeId)`; shortcuts: `putSave`, `updateSave`, `setSaveTags`, `addSaveTag`, `removeSaveTag`, `deleteSave`, `restoreSave`, `addMedia`, `removeMedia`, `relinkSave`, `createTag`, `updateTag`, `deleteTag`, `restoreTag`, `setTagMapping`, `createList`, `updateList`, `setListFilter`, `addToList`, `removeFromList`, `deleteList`, `restoreList`, `purgeTrash` |
| `Repository` (sqlite/repository.ts) | Reads: `queryPlaces({ bbox, within, text, source, sort, from, limit, offset })`, `mapPins(bbox, source)`, `search(text)`, `getPlace`, `getSave`, `getMySaveForPlace`, `savesForPlace`, `trash`, `getMedia`, `tags`, `tagMappings`, `lists`, `getList`, `listItems`, `listsContaining`, `evaluateList`, `saveMatchesList`, `findDuplicateSuggestions`, `countInBBox`, `dumpOwnData`. Caches: `updatePlaceOsmData`, `upsertForeignSave`, `deleteForeignSave`, `upsertPerson`, `getPerson`, `removePerson`, `pruneOrphanPlaces`. Projection only: `writeOwnSave`, `removeOwnSave`, `writeOwnTags`, `writeOwnList`, `removeOwnList`, `writeTagMappings` |
| Schema (sqlite/schema.ts) | `migrate`, `detectCapabilities`, `readCapabilities`, `rebuildIndexes`, `SCHEMA_VERSION` |
| Document (crdt/doc.ts, project.ts) | `createDataDoc`, `loadDataDoc`, `DocTx` (all edits), `healDoc`, `mergeDataDocs`, `projectAll`, `projectChanges`, `readSave`, `readTags`, `readList` |
| Pure helpers | `placeIdFromOsm`, `parseOsmPlaceId`, `newLocalPlaceId`, `saveIdFor`, `normalizeSnapshot`; `findDuplicateSuggestions`, `duplicateScore`, `nameSimilarity`, `normalizeText`, `ftsMatchQuery`; `normalizeFilter`, `evaluateListPure`, `matchesCriteria`, `isListEligible`; `haversineM`, `pointInArea`, `geometryIntersectsArea`, `representativePoint`, `geometryBBox`, `splitBBox`, `bboxAround` |

`queryPlaces` returns one row per place (a single pin however many friends
saved it) with my save summary (`status`, `sharing`, `priceLevel`, main tag
first then tags by name), `friendsCount`, `lastUpdatedAt` and `distanceM`.
Sorts: `recent` (default), `name` (accent-insensitive), `distance` (from a
point), `relevance` (FTS5 bm25, default with `text`). `within` takes a
Polygon/MultiPolygon and tests shapes exactly after the index. Bboxes may
cross the antimeridian (`west > east`).

## Identity

- A place is keyed by its OSM identity: `osm:node/123`, `osm:way/…`,
  `osm:relation/…` (spec "No duplicates"). Two people, or two of my devices,
  saving the same object always meet on the same id. A place absent from OSM
  (manual point, drawn zone) is `local:<26 random base-32 chars>`.
- One save per owner and place: my saves are keyed by place id in the
  document; in SQLite a save's id is `saveIdFor(owner, place)` =
  `<owner>|<place id>`. List exceptions and manual items hold place ids.
- Duplicate suggestion for manual points (`findDuplicateSuggestions`, pure):
  within 30 m (haversine) **and** a name similarity of at least 0.6
  (Sørensen–Dice on character bigrams of normalized names, generic words like
  "le", "chez", "the" ignored, 1 for whole-word containment of a name of 4+
  characters). Two OSM objects are never suggested. `Repository.
  findDuplicateSuggestions` feeds it with the places found through the spatial
  index; after the user confirms, `relinkSave(from, to)` merges my save into
  the other place (tags and photos united, comments kept, lists re-pointed).
- Identical OSM neighborhoods are the same `osm:relation/…` place; drawn
  zones stay distinct (`local:` ids).

## Schema (version 1)

Tables follow the spec's data model; names in parentheses are additions.

| Table | Notes |
| --- | --- |
| `people` | id (public key), display_name, avatar, public_key, read_url, is_me (exactly one), i_follow, follows_me, request_state, last_etag, last_sync |
| `groups`, `group_members` | local shortcuts, never shared (schema only for now) |
| `places` | `pk` integer key (for R*Tree/FTS), `id` (OSM or local), osm_type/osm_id (unique), name, (`name_key` for sorting), category (`key=value`), kind (place/zone), edge (sharp/blurred), `geom` (GeoJSON Point, LineString, MultiLineString, Polygon, MultiPolygon), lat/lon (representative point: the point, the middle of the longest street segment, or a point inside the polygon), min/max lon/lat, OSM cache (address, opening_hours, website, phone, osm_tags JSON, photos JSON, osm_synced_at, status open/maybe_closed/closed, closed_signals), (`search_text`) |
| `saves` | id, owner_id, place_id (unique per owner), comment, comment_visibility, status (to_try/tried/favorite or none), price_level 1–4, sharing (private/friends, friends by default), main_tag_id, (`their_tags`: a friend's tag names as received), created_at, updated_at, deleted_at (trash) |
| `tags`, `save_tags`, `tag_mappings` | tags: parent_id (cycle-free), name, color, icon, osm_categories JSON, deleted_at, (`active`: not in the trash and no ancestor in the trash); save_tags: position 0 for the main tag |
| `lists`, `list_items` | lists: visibility (link/public), link_key, kind (filter/manual), filter JSON (canonical), (`manual` JSON), (`items_dirty`); list_items: materialized membership, recomputed lazily |
| `access` | save_id or list_id, person_id (schema only, for key wraps later) |
| `media` | id, save_id, file, blurhash, width, height |
| (`places_rtree`) | R*Tree on place bboxes, kept by triggers (if available) |
| (`places_fts`) | FTS5 on `search_text` (name, category, address, live comments, my active tag names), `unicode61 remove_diacritics 2`, external content, triggers (if available) |
| (`doc_chunks`) | the Automerge document: one snapshot then incremental chunks |
| (`meta`) | capabilities chosen at creation, projected heads, projection version |

Migrations run on `PRAGMA user_version`, each in a transaction; a database
from a newer version is refused; a database belongs to one identity.

## The document and merging

`DataDoc` = `{ schema, saves, tags, lists, tagMappings, tombstones }`.

- **Shared root.** The root maps are created by a fixed first change (fixed
  actor, time 0), identical on every device, so two devices that never met do
  not each create their own `saves` map (one of which would hide the other).
- **Same place saved on two devices offline.** Both create `saves[placeId]`;
  Automerge keeps one and hides the other as a conflict. `healDoc` (run after
  every merge) folds the hidden one in once, deterministically: tags and
  photos united, empty comment/status/price/main tag filled, earliest
  creation date, privacy and deletion kept. Folded versions are recorded
  (`absorbed`) so a tag the user removes afterwards does not come back.
- **Data types.** Sets (tags of a save, filter criteria, exceptions, manual
  items) are `key → true` maps, so concurrent additions and removals of
  different keys all survive. Comments and list descriptions are
  collaborative text (character-level merges). Other strings are atomic
  (`ImmutableString`, last writer wins).
- **Deletion wins.** Deleting puts the item in the trash (`deletedAt`). If one
  device deletes while the other edits, the save is in the trash with the edit
  kept; if one deletes while the other restores, any concurrent non-null
  `deletedAt` counts, so the deletion wins (spec "Editing and deleting").
  `purgeTrash` removes items after 30 days and leaves a tombstone, itself
  dropped after six months.
- **Privacy wins.** If two devices set `sharing` concurrently and one chose
  "private", the save is private until someone sets it again.
- **Sub-tag cycles.** Concurrent re-parenting can create a cycle; the
  projection breaks it deterministically (the smallest tag id in the cycle
  loses its parent). Locally, an edit creating a cycle is refused.
- **Projection** is a function of the document only, so devices with the same
  document have the same tables, and incremental projection (from
  `A.diff` between heads) equals a full one. Both are property-tested.
- **Persistence.** `DataStore.open` does not load the document when the
  projection is current: the map is drawn from SQLite immediately; the
  document loads on first edit or merge. Chunks are compacted into one
  snapshot every 200 changes. Large merges (a new device receiving the whole
  document) reload the concatenated documents and re-project fully.

## List filters

Stored as canonical JSON `{ tags, categories, statuses, priceLevels, zones,
include, exclude }` (zones: an OSM boundary with its simplified shape, or a
drawn polygon). Groups are ANDed, values inside a group ORed, an empty group
does not constrain; a tag matches its sub-tags; `include` bypasses the
criteria, `exclude` wins over `include`. Always: only my own saves, never one
in the trash, **never a private save** (even if included by hand or selected
in a manual list), and a public list drops places known to be closed. A group
naming only tags that no longer exist matches nothing, so a list never widens
by itself to "everything". `Repository.evaluateList` runs in SQL (recursive
CTE on the tag tree, indexes, R*Tree for zones, then an exact shape test);
`evaluateListPure` is the reference it is property-tested against.

## Tests

- `geo`, `dedup`: haversine, point in polygon with holes, line/polygon
  intersections, representative points (property: always inside), OSM id
  round-trip, name similarity (properties: symmetric, bounded), duplicate
  suggestions (properties: never beyond 30 m, never with dissimilar names,
  symmetric, never two OSM objects).
- `repository`: schema and migrations (idempotent, fallbacks, upgrade of
  indexes, newer version refused, one identity), bbox (antimeridian),
  polygon, sorts, pagination, FTS (accents, prefixes, comments, tag names,
  friends' comments, injection), OSM cache precedence, friends' saves and
  removal, duplicate suggestions, map pins; every query test runs with and
  without R*Tree/FTS5.
- `lists`: each filter rule, materialization, and a property test comparing
  the SQL evaluator to the pure one on random data (tag trees with trashed
  tags, zones, closed places, friends' saves, exceptions), in both modes.
- `crdt`: every merge rule above as a two-device scenario, persistence and
  lazy loading, stale projection repair, incremental exchange, relink.
- `crdt.property`: fast-check runs of 2–3 devices applying random edits and
  merging in random order: (1) after a full exchange all devices have the
  same heads and the same SQLite projection, equal to a fresh full projection;
  (2) at every step on every device, no list contains a private or trashed
  save.
- `perf`: below.

## Performance (10,000 places)

Spec targets: filter under 100 ms (map), local search under 300 ms, launch
under 2 s. Dataset: 10,000 saves (60% in Paris, the rest across France), 2%
zones, 20 tags in a two-level tree, 1–3 tags per save, 30% with a comment,
10% private, 5% in the trash. Median of 5–7 runs, Node 22 + better-sqlite3
(SQLite 3.53), 2 vCPU Xeon 2.1 GHz container. A mid-range phone is expected
to be several times slower; the margins below are meant for that.

| Operation | R*Tree + FTS5 | Fallback (no modules) | Target |
| --- | ---: | ---: | ---: |
| Cold open of the database + first viewport query (document not loaded) | 9 ms | 13 ms | < 2 s launch |
| `mapPins`, all of Paris (5,697 pins) | 20 ms | 21 ms | < 100 ms |
| `queryPlaces` bbox, street-level viewport (211 places) | 2 ms | 4 ms | < 100 ms |
| `queryPlaces` bbox, all of Paris (5,697 places, full rows) | 68 ms | 56 ms | < 100 ms |
| `queryPlaces` within a polygon (3,025 places, exact test) | 66 ms | 49 ms | < 100 ms |
| List view: nearest 100 of all, by distance | 20 ms | 14 ms | < 300 ms |
| Text search, top 50 (`pizz`, `cafe soleil`, `vraiment`, `sub 3`) | 2–14 ms | 4–27 ms | < 300 ms |
| List filter: tag tree + statuses + zone (429 saves) | 25 ms | 10 ms | < 100 ms |
| List filter: tag tree only (3,009 saves) | 23 ms | 14 ms | < 100 ms |
| List items: recompute and materialize / read | 16 / 0.1 ms | 14 / 0.1 ms | — |
| Single edit (one change + incremental projection) | 9 ms | 9 ms | — |
| Import 10,000 saves (20 changes of 500) | 9.6 s | 7.4 s | — |
| Document: size / `save()` / `load()` | 656 KB / 95 ms / 0.9 s | same | — |
| New device: merge the 10k document + full projection | 4.4 s | 3.2 s | — |

The query targets hold with a wide margin. The Automerge side is the cost
center: an import spends most of its time in `A.change` (about 0.5 ms per
new save), and loading the 10k document takes about a second, which is why
the store opens without it and why an import should run in batches with
progress (T-114).

## Open questions

1. **Automerge on the phone.** `@automerge/automerge` is Rust compiled to
   WebAssembly. Hermes (the app's JS engine) has historically had no
   WebAssembly, and community attempts with WASM interpreters failed on
   Automerge's use of reference types. Options to evaluate in a spike before
   T-204: WebAssembly in recent Hermes versions, ahead-of-time compilation of
   the WASM to native code (Callstack's Polygen), or native Automerge bindings
   (Rust core behind an Expo module). The package keeps Automerge confined to
   `crdt/` and `store.ts`; the SQLite side does not depend on it.
2. **R*Tree in expo-sqlite** needs the config plugin flag above (native
   rebuild, T-103/T-104). Until then the fallback indexes are used; web has no
   R*Tree or FTS5 at all.
3. **Synchronous driver.** expo-sqlite's sync API blocks the JS thread; a
   large import or a new-device merge (seconds at 10k) should run in small
   batches or behind a progress screen. An async driver variant may be needed.
4. **Sharing granularity.** `sharing` is private/friends per spec; per-friend
   access (`access` table) and the effect of `comment_visibility` on what is
   published are left to the packing step (T-204).
5. **What goes in the document.** A save carries a snapshot of its place
   (name, category, geometry), as packs do. Once a place is synced from OSM,
   the OSM name and geometry win on the card; the snapshot is only a
   fallback. Should a manual rename of an OSM place be allowed (currently
   refused)?
6. **Tag merge across devices.** Two devices creating a tag with the same name
   offline get two tags; merging them (by name) is not automatic. Worth a
   "merge tags" action (T-108)?
7. **Trash purge with concurrent restore.** Purging removes the key; a restore
   made concurrently on another device is lost (the tombstone remains). This
   only happens 30 days after the deletion; acceptable?
8. **Closed places in link-only lists.** Closed places are dropped from public
   lists only (spec step 4); link-only lists keep them (with the badge).
