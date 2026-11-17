# @triangulair/data

The local data layer of TrianguLair (tasks T-101 and T-102): the SQLite
database with spatial and full-text indexes, the Yjs document that holds the
user's own data, and the list filters. MPL-2.0.

```sh
cd packages/data
npm install --workspaces=false   # add npm_config_nodedir=… where nodejs.org is unreachable
npm test           # unit, property-based, no-WebAssembly and performance tests
npm run test:ci    # the same without the performance suite (what CI runs)
npm run typecheck
npm run test:perf  # performance suite only, prints the timing table
```

## Design in one picture

```
            edits (DocTx)                       merge / importChanges
 app ───────────────────────► Yjs doc (Y.Doc) ◄────────────────────── my other devices
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
- **The document is the source of truth** for my own data. Every edit is a
  Yjs transaction; its update is appended to `doc_chunks` and projected into
  the tables **in the same SQLite transaction**, so the document and its
  projection never disagree after a crash.
- **Pure JavaScript.** Yjs (and its only dependencies, lib0 and
  isomorphic.js) has no WebAssembly and no native code, so the same package
  runs in Node and in Hermes. `test/no-wasm.test.ts` walks the runtime
  dependency tree and fails on any `.wasm` file or `WebAssembly.` call.
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
`newId`); Yjs itself needs nothing else.

## API summary

| Module | Main exports |
| --- | --- |
| `DataStore` (store.ts) | `open(options)`, `change(tx => …)` (one atomic change), `merge(docOrUpdate)`, `exportDoc(sinceStateVector?)`, `importChanges(update)`, `heads()` (state vector), `snapshot()` / `isAt(snapshot)` / `exportSince(snapshot)` and `snapshotOfUpdates(updates)` (for the sync step, T-204: state vector and delete set, so a pure deletion also counts as a change), `compact()`, `reproject()`, `wipe()` (remote wipe: every row erased, store closed), `doc` (lazy), `saveId(placeId)`; shortcuts: `putSave`, `updateSave`, `setSaveTags`, `addSaveTag`, `removeSaveTag`, `deleteSave`, `restoreSave`, `addMedia`, `removeMedia`, `setMediaUpload`, `relinkSave`, `createTag`, `updateTag`, `deleteTag`, `restoreTag`, `setTagMapping`, `createList`, `updateList`, `setListFilter`, `addToList`, `removeFromList`, `deleteList`, `restoreList`, `purgeTrash` |
| `Repository` (sqlite/repository.ts) | Reads: `queryPlaces({ bbox, within, text, source, sort, from, limit, offset })`, `mapPins(bbox, source)`, `search(text)`, `getPlace`, `getSave`, `getMySaveForPlace`, `savesForPlace`, `trash`, `getMedia`, `tags`, `tagMappings`, `friendTags`, `lists`, `getList`, `listItems`, `listsContaining`, `evaluateList`, `saveMatchesList`, `findDuplicateSuggestions`, `countInBBox`, `dumpOwnData`. Caches: `updatePlaceOsmData`, `upsertForeignSave`, `deleteForeignSave`, `upsertPerson`, `getPerson`, `removePerson`, `pruneOrphanPlaces`. Projection only: `writeOwnSave`, `removeOwnSave`, `writeOwnTags`, `writeOwnList`, `removeOwnList`, `writeTagMappings` |
| Schema (sqlite/schema.ts) | `migrate`, `detectCapabilities`, `readCapabilities`, `rebuildIndexes`, `SCHEMA_VERSION` |
| Document (crdt/doc.ts, project.ts) | `createDataDoc`, `loadDataDoc`, `baseDocUpdate`, `clientIdFor`, `DocTx` (all edits), `healDoc`, `mergeDataDocs`, `roots`, `saveEntry`, `saveEntryKeys`, `savePlaceIds`, `hasSave`, `tagIdsOf`, `listIdsOf`, `readTombstones`, `readDeletedAt`, `readSharing`, `updateText`; `trackChanges`, `projectAll`, `projectChanges`, `readSave`, `readTags`, `readList`, `readTagMappings` |
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

### Friends' tags

`ForeignSaveInput.theirTags` takes names or `{ name, color, icon }` (the
author's choice, shown until I map the tag to one of mine). Plain names are
still stored as strings, so the `their_tags` format of existing rows is
unchanged. `Repository.friendTags()` lists them per live foreign save;
`parseTheirTags` reads a stored value tolerantly.
### Additions for the app (T-110, T-112)

- `updateList(id, patch)` also takes `kind` (`ListPatch`, exported): switching between `filter` and
  `manual` keeps both the saved filter and the manual selection (switching back restores them).
- A `drawn` filter zone may carry an optional `name` (label only; the key and matching stay the shape).

### Owner migration (T-205)

`reassignOwner(driver, from, to)` hands a database created under a placeholder owner id (the app's
`local-me`, before identities existed) to the real identity, before `DataStore.open({ meId: to })`. My data
lives in the Yjs document, which holds no owner id, so it removes the owner-keyed projection of my saves,
tags, lists (and their items, media, access rows), renames my `people` row and clears `projected_heads`;
the next open re-projects the unchanged document under `to`. Friends' saves, the OSM cache, people and tag
mappings stay. It does nothing on a new database or one already owned by `to`, and refuses a third owner or
a `to` that is already a person in the database. `databaseOwner(driver)` tells who owns a database
(`null` when new). Tests: `test/owner.test.ts`.

## Schema (version 2)

Tables follow the spec's data model; names in parentheses are additions.

| Table | Notes |
| --- | --- |
| `people` | id (public key), display_name, avatar, public_key, read_url, is_me (exactly one), i_follow, follows_me, request_state, last_etag, last_sync |
| `groups`, `group_members` | local shortcuts, never shared (schema only for now) |
| `places` | `pk` integer key (for R*Tree/FTS), `id` (OSM or local), osm_type/osm_id (unique), name, (`name_key` for sorting), category (`key=value`), kind (place/zone), edge (sharp/blurred), `geom` (GeoJSON Point, LineString, MultiLineString, Polygon, MultiPolygon), lat/lon (representative point: the point, the middle of the longest street segment, or a point inside the polygon), min/max lon/lat, OSM cache (address, opening_hours, website, phone, osm_tags JSON, photos JSON, osm_synced_at, status open/maybe_closed/closed, closed_signals), (`osm_fields`, v2: which identity fields among name, category, geom came from my own OSM cache; only those override snapshots), (`search_text`) |
| `saves` | id, owner_id, place_id (unique per owner), comment, comment_visibility, status (to_try/tried/favorite or none), price_level 1–4, sharing (private/friends, friends by default), main_tag_id, (`their_tags`: a friend's tag names as received), created_at, updated_at, deleted_at (trash), (`place_snapshot`, v2: the place as this save's owner describes it: my document for my saves, their pack for a friend's; `Repository.savePlaceSnapshot(saveId)`) |

The shared `places` row (T-204 review R-02): my own save writes it (except OSM-sourced fields); a friend's save (`upsertForeignSave`) only creates it when missing, or updates it while every save on it is that friend's, so a friend never changes the name, geometry, kind or edge of a place I (or another friend) saved. What the sync step publishes comes from `place_snapshot`.
| `tags`, `save_tags`, `tag_mappings` | tags: parent_id (cycle-free), name, color, icon, osm_categories JSON, deleted_at, (`active`: not in the trash and no ancestor in the trash); save_tags: position 0 for the main tag |
| `lists`, `list_items` | lists: visibility (link/public), link_key (cleared when the list leaves `link`), kind (filter/manual), filter JSON (canonical), (`manual` JSON), (`items_dirty`); list_items: materialized membership, recomputed lazily |
| `access` | save_id or list_id, person_id (schema only, for key wraps later) |
| `media` | id, save_id, file, blurhash, width, height; (v3, photos) `thumb`, `mime`, `bytes`, `upload` (JSON: key and encrypted file hashes on the storage). My photos: `file`/`thumb` are the content hashes of the local copies; a friend's: the hashes of their encrypted files, usable only with `upload.key` (`Repository.setForeignMedia`, `mediaForPlace`, `mediaById`) |
| (`places_rtree`) | R*Tree on place bboxes, kept by triggers (if available) |
| (`places_fts`) | FTS5 on `search_text` (name, category, address, live comments, my active tag names), `unicode61 remove_diacritics 2`, external content, triggers (if available) |
| (`doc_chunks`) | the Yjs document: one snapshot (`Y.encodeStateAsUpdate`) then incremental updates |
| (`meta`) | capabilities chosen at creation, `doc_format` (`yjs-update-v1`), projected state vector, projection version |

Migrations run on `PRAGMA user_version`, each in a transaction; a database
from a newer version is refused; a database belongs to one identity.

## The document and merging

The document is a `Y.Doc` with named root maps: `meta` (`schema`, the major
version), `saves`, `tags`, `lists`, `tagMappings`, `tombstones`. Every merge
rule of the Automerge version is kept; where Yjs's own semantics differ
(a `Y.Map` key is last-writer-wins, and the losing value, nested contents
included, is garbage-collected), the rule is implemented explicitly.

| Rule | Automerge version | Yjs version |
| --- | --- | --- |
| Devices that never met do not hide each other's data | fixed first change (fixed actor, time 0) creating the root maps | root types are named, never created by a write; the only initial write (`meta.schema`) is one fixed base update (client 0, clock 0) applied by every replica, so it deduplicates instead of conflicting |
| One save per place; concurrent creations folded | `saves[placeId]`, hidden conflict folded by `healDoc` | save entries keyed `<placeId>\n<creating client>`, so concurrent creations are two visible entries; `healDoc` (after every merge or import) folds every entry into the canonical one (smallest key) and records it as `a:<key>`. Entries are kept (hidden), not deleted: a fold may be redone into a later canonical entry (three devices, test) |
| Fold contents | tags and photos united, empty fields filled, earliest creation, privacy and deletion kept | same, plus both comments kept (written as a new `Y.Text`, so two devices healing at once do not duplicate the text) and unknown fields copied |
| Sets (tags of a save, filter criteria, exceptions, manual items) | `key → true` maps | same: keys of the entry (`t:<tagId>`, `m:<mediaId>`) or nested `Y.Map`s; concurrent additions and removals of different keys all survive |
| Comment, list description | collaborative text | `Y.Text`, edited by a minimal diff (common prefix and suffix kept), merged per character |
| Other fields | atomic, last writer wins | plain values, last writer wins (ties by client id); a manual place's snapshot (name, geometry, category, edge) is one atomic value |
| Deletion wins over a concurrent restore | any concurrent non-null `deletedAt` (Automerge conflicts) | observed-remove register: deleting writes the device's own slot `d:<client>` and drops the slots it has seen; restoring drops the slots it has seen. A deletion the restoring device did not see is in a slot it did not drop, so it survives (also when that device deleted and restored itself meanwhile). Tags and lists alike |
| Privacy wins over a concurrent "friends" | any concurrent value "private" | same register on `s:<client>`: private if any slot says so, until someone sets it again |
| Trash 30 days, tombstones 6 months | `purgeTrash` | unchanged (all entries of the place are removed) |
| Sub-tag cycles | broken by the projection (smallest id loses its parent) | unchanged; a local edit creating a cycle is refused |
| Unknown fields (spec "Format versions") | kept by Automerge | kept: edits only touch the keys they know; keys, nested types and whole root types written by a newer version are re-exported as they are, survive compaction, and are copied by folds and relinks (test) |

Every rule above has a two-device (or three-device) test, run with both
client-id orders where last-writer-wins could otherwise decide.

- **Save entry layout** (the bulk of the document, kept flat and small):
  `place` (snapshot: name, category, kind and edge if not default, geometry
  as `[lon, lat]` for a point or GeoJSON text; the OSM identity is the place
  id), `comment` (`Y.Text`), `commentVisibility`, `status`, `priceLevel`,
  `mainTagId`, `createdAt`, `updatedAt`, `t:<tagId>`, `m:<mediaId>` (photo
  metadata: content hashes of the photo and its thumbnail, format, size, dimensions), `u:<mediaId>` (where
  the sync package uploaded it and its key: `setMediaUpload`; kept apart so that an upload racing a removal
  cannot bring the photo back), `s:<client>`, `d:<client>`, `a:<entryKey>`. Absent means the
  default (friends, no status, no price, updated = created).
- **Clients.** A Yjs client id must never be used by two replicas at once.
  `actor` (any stable per-device string) is hashed to a 32-bit client id; it
  is set only after the stored updates are loaded (otherwise Yjs takes its
  own updates for another client using its id and switches to a random one).
  This is safe because every update a device writes is stored before it can
  leave the device. Without `actor`, Yjs picks a random id per session.
- **Atomic edits.** `change(tx => …)` is one Yjs transaction. Yjs has no
  rollback: `DocTx` validates before writing, and if `fn` throws after
  writing, the in-memory document is dropped and reloaded from SQLite on next
  use (the SQLite transaction never ran), so a failed change leaves nothing.
- **Projection** is a function of the document only, so devices with the same
  document have the same tables, and incremental projection (from the Yjs
  events of the transactions: `trackChanges`) equals a full one. Both are
  property-tested; more than 2,000 touched saves re-project everything.
- **Persistence.** Each change or merge appends the Yjs update it produced
  (the `update` event; several merged with `Y.mergeUpdates`) to `doc_chunks`
  in the projection's transaction. Every 200 chunks they are compacted into
  one `Y.encodeStateAsUpdate` snapshot. `DataStore.open` does not load the
  document when the projection is current: the map is drawn from SQLite
  immediately; the document loads (all chunks applied in one Yjs
  transaction) on first edit or merge. An update that arrives before its
  dependencies (out-of-order delta) is stored as received and integrated
  when they arrive, also across a restart (test). A database whose chunks are
  not Yjs updates (`meta.doc_format`) is refused with a clear error; the
  Automerge prototype was never released, so there is no migration.
- **Exchange.** `heads()` is the state vector (`Y.encodeStateVector`);
  `exportDoc(stateVector)` is `Y.encodeStateAsUpdate(doc, stateVector)`,
  everything the other device lacks; `importChanges(update)` /
  `merge(update | Y.Doc)` apply it, heal and project.

### API changes from the Automerge version

- `DataStore.doc` and `DataDoc` are a live `Y.Doc` (was an immutable
  `A.Doc<DataDoc>` with `doc.saves[placeId]`…). Read it with `savePlaceIds`,
  `hasSave`, `saveEntry`, `tagIdsOf`, `listIdsOf`, `readTombstones`,
  `roots`, or better through the repository; edit it only through `change`.
- `heads()` returns the state vector (`Uint8Array`, was `A.Heads`);
  `exportDoc(sinceStateVector?)` takes it. `merge` accepts a Yjs update or a
  `Y.Doc`; `importChanges` takes a Yjs update.
- `actor` may be any stable string (was Automerge hex), hashed to a Yjs
  client id (`clientIdFor`).
- `change(fn, message?)`: `message` is now the transaction origin only (Yjs
  updates carry no message).
- `DocTx` takes the `Y.Doc` (`doc.transact(() => new DocTx(doc, ctx)…)`, was
  an Automerge draft). `healDoc(doc)` heals in place and returns whether it
  wrote; `mergeDataDocs(local, remote)` merges into `local` in place.
- `projectChanges(doc, repo, touched)` takes the `Touched` set collected by
  `trackChanges` (was the heads before the change).
- `SaveInput.createdAt` (optional): creation date of a new save, for imports
  that carry the original date (added by T-114, `@triangulair/import`).
- Unchanged: every `DataStore` edit shortcut, `Repository`, the schema,
  `SaveInput`/`SavePatch`/`TagInput`/`ListInput`/`MediaInput`, `readSave`,
  `readTags`, `readList`, `readTagMappings`, `projectAll`.

### Why Yjs

`@automerge/automerge` is Rust compiled to WebAssembly, and Hermes (the app's
JS engine) has no WebAssembly; the workarounds (a WASM interpreter, ahead-of-
time compilation of the WASM, native bindings behind an Expo module) all add
native build complexity to the app. Yjs is pure JavaScript, mature, small
(three runtime packages), and fast on this workload (below). What it lacks
compared with Automerge (multi-value conflicts, a shared genesis change) is
rebuilt explicitly above; what it costs is document size: about 4× larger
uncompressed (but smaller once deflated).

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
- `crdt`: every merge rule above as a two- or three-device scenario (the
  last-writer-wins-sensitive ones with both client-id orders), concurrent
  healing, a change that throws, unknown fields of a newer version,
  persistence and lazy loading, actor reuse across sessions, refused old
  format, out-of-order updates across a restart, stale projection repair,
  incremental exchange by state vector, relink.
- `crdt.property`: fast-check runs of 2–3 devices applying random edits and
  merging in random order: (1) after a full exchange all devices have the
  same state vector and Yjs snapshot (state vector and deletions) and the
  same SQLite projection, equal to a fresh full projection; (2) at every step
  on every device, no list contains a private or trashed save. 250 runs each
  in `npm test` (also run with 2,000).
- `no-wasm`: the runtime dependency tree (yjs, lib0, isomorphic.js) has no
  `.wasm` file and no `WebAssembly.` call, and nothing imports Automerge.
- `perf`: below.

## Performance (10,000 places)

Spec targets: filter under 100 ms (map), local search under 300 ms, launch
under 2 s. Dataset: 10,000 saves (60% in Paris, the rest across France), 2%
zones, 20 tags in a two-level tree, 1–3 tags per save, 30% with a comment,
10% private, 5% in the trash. Median of 5–7 runs, Node 22 + better-sqlite3
(SQLite 3.53), 2 vCPU Xeon 2.1 GHz container. A mid-range phone is expected
to be several times slower; the margins below are meant for that.

Queries (SQLite only, unchanged by the CRDT switch; measured with Yjs):

| Operation | R*Tree + FTS5 | Fallback (no modules) | Target |
| --- | ---: | ---: | ---: |
| Cold open of the database + first viewport query (document not loaded) | 7 ms | 9 ms | < 2 s launch |
| `mapPins`, all of Paris (5,697 pins) | 17 ms | 33 ms | < 100 ms |
| `queryPlaces` bbox, street-level viewport (211 places) | 2 ms | 4 ms | < 100 ms |
| `queryPlaces` bbox, all of Paris (5,697 places, full rows) | 57 ms | 61 ms | < 100 ms |
| `queryPlaces` within a polygon (3,025 places, exact test) | 42 ms | 56 ms | < 100 ms |
| List view: nearest 100 of all, by distance | 15 ms | 26 ms | < 300 ms |
| Text search, top 50 (`pizz`, `cafe soleil`, `vraiment`, `sub 3`) | 2–9 ms | 4–18 ms | < 300 ms |
| List filter: tag tree + statuses + zone (429 saves) | 19 ms | 11 ms | < 100 ms |
| List filter: tag tree only (3,009 saves) | 14 ms | 15 ms | < 100 ms |
| List items: recompute and materialize / read | 20 / 0.1 ms | 12 / 0.1 ms | — |

The document side, Automerge 3.5 (previous version, same machine and
dataset, R*Tree + FTS5 / fallback) against Yjs 13.6:

| Operation | Automerge | Yjs |
| --- | ---: | ---: |
| Import 10,000 saves (20 changes of 500, with projection) | 10.1 s / 8.1 s | 2.0 s / 1.5 s |
| Single edit (one change + incremental projection) | 9.7 ms / 9.0 ms | 0.6 ms / 0.3 ms |
| Document size (full-document transfer) | 656 KB | 2,817 KB (update v1); 2,203 KB (v2) |
| … deflated (informative) | (already compressed) | 545 KB (v1); 383 KB (v2) |
| Serialize the whole document | 99 ms (`save`) | 44 ms (`encodeStateAsUpdate`) |
| Load the whole document | 0.9 s (`load`) | 0.2 s (`applyUpdate`) |
| Lazy document load from `doc_chunks` on first edit | 1.4 s / 0.9 s | 0.3 s / 0.15 s |
| New device: merge the 10k document + full projection | 4.1 s / 2.9 s | 1.8 s / 1.1 s |

Yjs is 4–15× faster on every document operation, which removes the cost
center of the Automerge version (about 0.5 ms of `A.change` per new save);
the remaining import and new-device time is mostly SQLite (projection, FTS
and R*Tree triggers). The price is size: about 280 bytes per save instead
of 65 (Yjs keeps per-item metadata uncompressed). A full-document transfer
between my devices is therefore about 2.8 MB at 10,000 places; deflating it
(or using the v2 encoding, which compresses better) before encryption brings
it under Automerge's size. That choice belongs to the sync step (T-204); a
pure-JavaScript deflate (e.g. fflate) keeps the no-WebAssembly rule.

## Open questions

1. **Document size and compression.** The Yjs document is about 4× the
   Automerge one uncompressed (see the table). Compress (v2 encoding and/or
   deflate) in the sync packs (T-204)? `doc_chunks` stays uncompressed v1 for
   now (fast, and local storage is cheap).
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
7. **Trash purge with concurrent restore.** Purging removes the entry; a
   restore or an edit made concurrently on another device is lost (the
   tombstone remains). This only happens 30 days after the deletion;
   acceptable?
8. **Closed places in link-only lists.** Closed places are dropped from public
   lists only (spec step 4); link-only lists keep them (with the badge).
9. **Edits racing a fold.** If a device keeps editing its own entry of a
   duplicated save after another device has already folded that entry
   (before receiving the fold), those later edits stay in the hidden entry
   (as with Automerge's hidden conflicts). Rare (both devices must have
   created the same save offline); re-fold on later edits?
