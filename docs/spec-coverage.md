# Spec coverage audit

What [SPEC.md](SPEC.md) promises, compared with what `packages/*` and `apps/mobile` implement on `main`
(commit `2ec44c8`, 17 November 2026). This is a read-only audit: no code was changed. The
[Error cases](SPEC.md#error-cases) table is mapped row by row in [error-cases.md](error-cases.md), so it gets one
summary row here.

Statuses:

- **done**: implemented, with a test (unit or end to end) or a screenshot that shows it.
- **partial**: implemented in part. The evidence column says what is missing.
- **missing**: nothing in the code yet (at most a schema column or a library function that nothing calls).
- **deferred**: the spec itself places it in v2 or v3, or "later".

Paths: `app/` is `apps/mobile/src/`, `e2e/` is `apps/mobile/e2e/`, `data/`, `osm/`, `sync/`, `crypto/`, `storage/`
and `import/` are `packages/<name>/src/`. Tests are named by file; "shot" means a screenshot in `apps/mobile/docs/`.

## Prioritized gaps

MVP-blocking first: these are on the spec's MVP list or in the v1 rows of the features ported from other apps, or they stop the native app (not
the web test build) from meeting a v1 promise.

1. **Personal photos, end to end** (MVP item "personal photos", ported-features v1 row, data model `media`). Only the
   schema, the Yjs records (`data/store.ts` `addMedia`) and the `media/` pack type (`crypto/pack.ts`) exist. Still
   missing: a picker on the card, EXIF and GPS removal, recompression to about 1,600 px in WebP or AVIF, a
   thumbnail and blurhash, encrypted upload under `media/`, references from the places packs, friends downloading
   the full photo only when they open it, eviction from the friends' cache, "photos wait, text goes first" when the
   quota is full, and "new photo" in What's new. *Task: T-111b, personal photos (data, sync, app).*
2. **Native map at 10,000 pins** (MVP "clustered when zoomed out", performance targets). On native, pins are
   `Marker` views with an SVG each and the clustering runs in JS (`app/components/map/Map.native.tsx`). T-103 is
   still "to do". *Task: T-103, GeoJSONSource + SymbolLayer with pre-rendered images, clustering in the engine,
   60 fps measured on the reference device.*
3. **Storage on a real phone.** S3 signs with `crypto.subtle`, which Hermes lacks, so S3 works only in the web
   build. SFTP is marked "Desktop only" because `ssh2` needs Node. The Nextcloud Login Flow v2 and the automatic
   share link through OCS are not done (an app password and a pasted link are used instead). WebDAV, the MVP
   protocol, works. *Tasks: an S3 signer that runs on Hermes, SFTP on mobile (or drop it from v1 in the spec),
   Nextcloud Login Flow and OCS share (T-203b).*
4. **Network status on native** (error case 1). There is no NetInfo module: native assumes it is always online, so
   "Offline · N changes pending" shows only on web, and a failure with no network is counted as "storage
   unreachable". *Task: add `@react-native-community/netinfo` and wire it to `SyncScheduler.setOnline`.*
5. **iOS background grace period** (Synchronization and background). The last pass runs on AppState
   "background" with no `beginBackgroundTask`, so iOS can suspend it before it ends. *Task: a background task,
   F-Droid-safe on Android.*
6. **Store rules: "Delete all my content", blocking and reporting.** Apple requires account deletion and ways to
   block and report. None of these exists. "Remove from my friends" comes close to blocking, but it neither
   prevents the person from being added again nor reports a public list. *Tasks: delete-all, with the signed
   "content deleted" marker friends act on; block; report a public list.*
7. **Local database encryption** (Protections on the device). `openDatabaseSync('triangulair.db')` opens it
   without encryption. The spec asks for a database key in the secure vault, so that deleting the key wipes the
   data at once. *Task: SQLCipher (expo-sqlite `useSQLCipher`) with a key from the secret store.*
8. **Trash** (Editing and deleting: "trash for 30 days, restorable"). Deleted items go to the trash in the
   document, but the only way back is a 15-second "Undo" (`app/components/TrashUndo.tsx`). There is no trash
   screen, and the app never calls `purgeTrash()`. *Task: a trash screen and a periodic purge.*
9. **F-Droid: no proprietary services** (Tech stack). *Done for the dependencies:* on Android, `expo-location`
   (`play-services-location`) and `expo-camera` (ML Kit barcode scanning) are no longer linked
   (`package.json` `expo.autolinking.android.exclude`). Two local Expo modules replace them for every Android build
   (no separate flavor): `modules/tl-location` (platform `LocationManager`: fused, GPS, network and passive
   providers, last known position, `getCurrentLocation` or `requestLocationUpdates`, timeout) and
   `modules/tl-qr-scanner` (CameraX + ZXing core, Apache-2.0). MapLibre's location engine is its `default` one
   (platform `LocationManager`, pinned in `app.json`), and the app does not use MapLibre's user-location layer.
   iOS and web keep `expo-location` and `expo-camera`. The *Native Android build* workflow now **fails** if any
   `com.google.android.gms`, `com.google.firebase`, `com.google.mlkit` or `com.google.android.play` library is in
   the release runtime classpath (`scripts/fdroid-deps.mjs --fail`, unit test `app/fdroidDeps.test.ts`; ZXing
   allowed). Its emulator smoke test runs on an AOSP image without Google APIs, with a mock GPS position: the
   location step and "center on me" work there. *Still missing for F-Droid (T-301):* a reproducible build, the
   fdroiddata metadata (build recipe, description, screenshots), and the F-Droid scanner's view of the source tree
   (`node_modules/expo-location` and `expo-camera` still name Play services and ML Kit in their Gradle files, and
   `expo-dev-launcher` has ML Kit as a debug-only dependency: the recipe must delete or patch them).
10. **Map attribution** (Legal, Base map rules). The overlay reads "© OpenStreetMap contributors, OpenFreeMap".
    The "© OpenMapTiles" credit and the "Report an error" link to OpenStreetMap are both missing. *Task: a small fix
    in `app/config.ts` `MAP_ATTRIBUTION` and `app/components/MapAttribution.tsx`.*
11. **Following a list** (Features). There is no per-list switch on the map, no "Source" filter (my places, my
    friends or a given list), no "Add all places to my places", no "Ask to follow the author", and a list is not
    attached to its author once that author is followed. *Task: followed lists, the second pass.*
12. **Price level everywhere.** The friends' average is not computed (`app/places/model.ts` sets only my price).
    The price appears neither in list rows nor in the friends section of the card. *Task: show the price in rows,
    the card's friends section and the add screen, and compute the average.*
13. **Closed places.** The "moved (with the new address)" answer is missing. Friends' "closed" reports are not
    shared or fed to `reportSignals` (my own report changes the status directly). The OSM correction is a hint,
    with no link. *Task: closure, the second pass.*
14. **Place card.** E-mail and social network buttons are missing, and so are the Wikipedia description
    (`osm/endpoints.ts` holds only its attribution), the Mapillary option and the offer to fill in missing info or
    contribute it to OSM. *Task: place card, the second pass.*
15. **Non-MVP items still due for v1.** RTL layout, place names in the user's language (`names` is parsed by
    `osm/normalize.ts` and used nowhere), miles and currencies, ICU files and Weblate, hinge and tabletop
    awareness, the iPad three-pane layout, hover, right-click and keyboard shortcuts, the Apple Pencil, the
    screenshot matrix on every release, a cap on the friends' cache, a default sharing preference, groups, the
    "copies cannot be taken back" reminder, an encrypted backup file in local-only mode, "open at a chosen time",
    "current position" on the add screen, the offer to merge two manual points, the custom map style and the
    Liberty option, and the tile address in the settings.

## Counts

| Status | Rows |
| --- | --- |
| done | 174 |
| partial | 53 |
| missing | 36 |
| deferred | 9 |
| **total** | **272** |

## Coverage table

### Features: MVP (v1) list

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| MVP | Identity creation: key pair, recovery phrase | done | `app/identity/create.ts`, `crypto/identity.ts`; `app/identity/identity.test.ts`, crypto `identity.test.ts` | — |
| MVP | Profile: name, avatar | done | `app/firstLaunch/ProfileFields.tsx` (photo cropped to 256 px); shot `phone-welcome-profile.png` | — |
| MVP | Optional connection to a WebDAV storage | done | `app/app/storage/setup.tsx`, `storage/webdav.ts`; e2e `storage.spec.ts`, storage `real-servers.test.ts` | — |
| MVP | Full-screen map with places and zones | done | `app/app/index.tsx`, `app/zones/zoneLayer.ts`; e2e `map-filters.spec.ts`, `zones-lists.spec.ts` | — |
| MVP | Clustered when zoomed out | partial | JS clustering `app/places/clustering.ts` (`clustering.test.ts`), majority color. Native draws `Marker` views, not engine layers, so 10k pins are out of reach (T-103 "to do") | T-103 native layers |
| MVP | List view: sort recent / distance / name, text search | done | `app/app/list.tsx`, `data/sqlite/repository.ts` (FTS5 or fallback); data `repository.test.ts`, `perf.test.ts`; e2e `places.spec.ts` | — |
| MVP | Add: known places around the visible area sorted by distance | done | `app/app/add.tsx`, `app/places/add.ts`; `add.test.ts`; shot `phone-add-nearby.png` | — |
| MVP | Add: "or my position" / "current position" | partial | Nearby places use the map center, and long press and "Drop a point" work. The map has "center on me" (`app/location/LocateButton.tsx`; e2e `locate.spec.ts`, Android smoke test), so the add screen opened next lists the places around the position; there is no "Here" button on the add screen itself | Add "Here" (current position) |
| MVP | Add: search by name (Photon/Nominatim), long press | done | `osm/search.ts` (Photon, Nominatim fallback); `search.test.ts`; e2e `places.spec.ts` | — |
| MVP | Each suggestion: already mine / saved by friends | done | `app/app/add.tsx` (`add.friends`: "Saved by N friends", "Already in my places") | — |
| MVP | Add a zone: neighborhood, street segments, drawing by points or painting | done | `app/zones/*`; `zones.test.ts`; e2e `zones-lists.spec.ts`; shots `phone-zone-*.png` | — |
| MVP | Enriched place card | partial | See "Place card" below (no e-mail/social, no Wikipedia, no user photos) | Place card, second pass |
| MVP | Personal tags with color and icon | done | `app/app/tags.tsx`, `app/components/TagEditor.tsx`; `tags.test.ts`, `pins/bands.test.ts`, `theme.test.ts` (palette) | — |
| MVP | Sub-tags ("Restaurant › Neapolitan pizza") | done | `parent_id` (`data/sqlite/schema.ts`), `app/tags/tree.ts`; card paths, sub-tag narrowing in the filter; shot `phone-tag-editor.png` | — |
| MVP | Filter bar: categories, sub-filters, OSM criteria, status, visibility, price level, text | done | `app/components/FilterBar.tsx`, `app/places/filters.ts`; `filters.test.ts`, `filters/pills.test.ts`; e2e `map-filters.spec.ts` | — |
| MVP | Filter bar collapsible into one line, state remembered | done | `app/filters/storage.ts`, `pills.ts`; `storage.test.ts`; shot `phone-filters-collapsed.png` | — |
| MVP | Filtered display: matching pins in color, others grey, faded, smaller | done | `app/pins/build.ts`, `pinSvg.ts` (grey, 40 %, 0.72×); shot `phone-map-filters.png` | — |
| MVP | Comment with its own visibility (private / friends / public; friends by default) | done | `app/components/SaveEditor.tsx`; schema default `friends`; friends see non-private comments (`repository.ts` ~514), public lists carry public comments only (`sync/public-lists.ts`); sync `scenarios.test.ts` "comments by visibility" | — |
| MVP | Status "to try / tried / favorite" | done | `SaveEditor.tsx`; status filter; list rows show it | — |
| MVP | Price level € to €€€€ | partial | Entered in `SaveEditor.tsx`, filterable. Not shown in list rows (`app/app/list.tsx`) or the card's friends section; the friends' average is not computed | Price everywhere |
| MVP | Personal photos | missing | Only `media` table, `DataStore.addMedia`, `media/` pack type; no UI, no upload (see Prioritized gaps 1) | T-111b photos |
| MVP | Sharing section of the card: private / friends / lists | done | `SaveEditor.tsx` (sharing friends/private + hint), `app/components/ListsSection.tsx` (tick lists); shot `phone-card-lists.png` | — |
| MVP | A private place never appears for others, in friends counters or in any list | done | `data/filter.ts`, `repository.ts` (`sharing <> 'private'`); data `crdt.property.test.ts` "a private save never enters a list"; e2e `zones-lists.spec.ts`, `sync.spec.ts` | — |
| MVP | Follow and share in each direction: invitation link, return link, QR face to face, subscription to a list | done | `app/contacts/*`, `crypto/invitation.ts`; contacts `flow.test.ts`; e2e `invitations.spec.ts`, `lists-sharing.spec.ts` | — |
| MVP | "Also at my friends'" filter, choice of friends shown (remembered) | done | `app/sync/FriendsPicker.tsx`, `friendsSelection.ts`; e2e `sync.spec.ts`; shot `phone-friends-picker.png` | — |
| MVP | "3 friends" in the list, the card and the add screen (not on the pin) | done | list `list.friends`, card `FriendsSection.tsx`, add `add.friends`; pins without a badge | — |
| MVP | The mention opens who saved it, when, their comments | partial | On the card (`FriendsSection.tsx`, shot `phone-card-friends.png`). On the add screen and in list rows it is text only and opens nothing | Make the add-screen mention open the friends section |
| MVP | What's new view since the last visit | partial | `app/sync/whatsNew.ts`, `app/app/whatsnew.tsx`; e2e `sync.spec.ts`. Kinds: added, comment, status, key, moved, identity, followed list's first places. Missing: lists shared with me, closures reported, new photo, later changes in a followed list | What's new kinds |
| MVP | Lists from a saved filter or a manual selection | done | `app/lists/*`, `data` `evaluateList`; data `lists.test.ts`, `listLogic.test.ts` | — |
| MVP | Visibility of lists: public or link-only; never a private place | done | `sync/lists.ts`, `public-lists.ts`; sync `lists.test.ts`; e2e `lists-sharing.spec.ts` | — |
| MVP | Closed places: monthly check and flagging | partial | See "Closed places" below | Closure, second pass |
| MVP | Sharing a place, a zone or a list by web link | partial | Lists: done (`/l#…`). A single place or zone has no web link of its own (only through a list) | Decide: a place link, or a one-place list |
| MVP | Directions in the navigation app; open in Maps / Google Maps | done | `app/places/directions.ts` (`geo:` on Android, Apple Maps on iOS); `directions.test.ts`; shot `phone-card-directions.png` | — |
| MVP | Import from Google, Mapstr, Pin Drop (Takeout, CSV, KML, GeoJSON) | done | `import/*`; import `parsers.test.ts`, `match.test.ts`, `apply.test.ts`; e2e `import-export.spec.ts`. Mapstr and Pin Drop parsers are unverified (T-009) | T-009 real samples |
| MVP | Full GeoJSON export | done | `import/formats/triangulair.ts`; `roundtrip.test.ts`; e2e `import-export.spec.ts` (re-import on a fresh device) | — |
| MVP | Android and iOS apps (React Native) | partial | Expo SDK 57 app, `eas.json`; native builds not yet run on a device (README: the native SQLite driver and libsodium on Hermes are not timed or run on a device) | Native smoke test on devices |
| MVP | "View on uMap" for public lists | done | `umapUrl` (`app/lists/sharing.ts`); e2e `lists-sharing.spec.ts` checks the exact URL | — |

### Creating a sharing list

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| Create list | New places meeting the criteria enter automatically | done | `Repository.evaluateList`; data `lists.test.ts` | — |
| Create list | Categories and tags, sub-filters, statuses | done | `app/lists/ListEditor.tsx`; shot `phone-list-editor.png` | — |
| Create list | Zones by name (OSM admin boundaries), several | done | Nominatim by name in `ListEditor.tsx`, saved as OSM id + simplified shape | — |
| Create list | Zones by outlining (points or painting) | done | Same tools as zones; README "outlined on the map" | — |
| Create list | Exceptions: add or remove by hand | done | `ListsSection.tsx` ("Add by hand", "Leave out", "Follow the filter"); shot `phone-list-reasons.png` | — |
| Create list | Preview: map, colored or faded, count | done | `app/lists/PreviewMap.tsx`; shot `phone-list-preview.png` | — |
| Create list | Sharing: link-only or public | done | `/lists/share`; e2e `lists-sharing.spec.ts` | — |
| Create list | Filter stored as JSON, zones by OSM id + simplified polygon | done | `lists.filter` JSON (`data/sqlite/schema.ts`), `app/zones/simplify.ts` | — |

### Following a list without following the person

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| Follow list | No account, request or key: the link is enough | done | `sync/followed.ts` `ListReader`; e2e `lists-sharing.spec.ts` (Ben has no storage, no contact) | — |
| Follow list | Preview: map, places, author, date | done | `app/app/lists/follow.tsx`; shot `phone-list-follow-preview.png` | — |
| Follow list | Action "Follow this list" | done | Same | — |
| Follow list | Action "Add places to my places" (one by one or all) | partial | One by one from the card ("Add to my places"); there is no "all" (README open question) | Followed lists, second pass |
| Follow list | Action "Ask to follow the author" | missing | README: needs a return link without an invitation | Followed lists, second pass |
| Follow list | App not installed: public list in uMap, link-only to the store page | partial | The app side is ready (exact Android intent paths). The `/l` page of the site, `apple-app-site-association` and `assetlinks.json` do not exist yet | Site pages for `/i`, `/r`, `/l` (T-007/T-301) |
| Follow list | "Followed lists" panel | done | `app/app/lists/followed/index.tsx`; shot `phone-lists-followed.png` | — |
| Follow list | A switch per list to show it on the map | missing | README: followed lists follow the "friends shown" setting | Followed lists, second pass |
| Follow list | Same style as friends' places, same filters | done | Treated as friends' places (README "Followed lists") | — |
| Follow list | "Source" filter: my places, my friends, a given list | missing | No source criterion in `app/places/filters.ts` | Followed lists, second pass |
| Follow list | Additions and changes appear in What's new | partial | Only a list's first places, as one item; later additions and changes are not reported | What's new kinds |
| Follow list | No duplicates; same card with the mention of the list | done | Card shows "List “…”" among who saved it (README) | — |
| Follow list | Author does not know who follows; new link cuts the old one ("This link no longer works") | done | sync `lists.test.ts` "new link cuts the old link"; e2e `lists-sharing.spec.ts` | — |
| Follow list | Attach the list to its author once followed | missing | README open question: stays a separate source | Followed lists, second pass |
| Follow list | App keeps address, link key, author key, last version | done | `sync/followed.ts` (`FollowedListInfo`) | — |

### Viewing without the app

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| View w/o app | Public list as plaintext GeoJSON, "View on uMap", author's colors readable by uMap | done | `sync/public-lists.ts` (uMap colors, ODbL notice); e2e `lists-sharing.spec.ts` validates the file. Note: the uMap link is a copy, not a remote-data layer that follows changes (sync README q.12) | Consider a uMap remote-data layer |
| View w/o app | Link-only list: opens the app, otherwise the store page | partial | App side done; site page missing (see above) | Site pages |
| View w/o app | Custom web page that decrypts in the browser | deferred | v2 | — |

### Editing and deleting

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| Edit | Everything edited from the card (tags, comment, status, price, photos, sharing, zone geometry) | partial | Everything except photos (none) | T-111b photos |
| Edit | Only meaningful changes in friends' What's new | done | `sync/reader.ts` (`meaningful`), `app/sync/whatsNew.ts` | — |
| Edit | Two devices merged (CRDT); delete wins, recoverable from the trash | done | `data/crdt/doc.ts`; data `crdt.test.ts`, `crdt.property.test.ts` | — |
| Delete | Delete a place, zone or comment: trash for 30 days, synced, restorable | partial | Trash and `TRASH_RETENTION_MS` exist in `data/crdt/doc.ts`; the app has only a 15 s undo (`TrashUndo.tsx`), no trash screen, and never calls `purgeTrash()` | Trash screen + purge |
| Delete | Friends: disappears from their cache at the next sync | done | `sync/reader.ts` (readable set); sync `scenarios.test.ts` | — |
| Delete | Remove a friend's access to a place or a list | done | `setListAccess`, `setPolicy`; e2e `sync.spec.ts` (cache drops her places) | — |
| Delete | Delete a list: places stay; link says "This list no longer exists" | done | `ListGoneError`; sync `lists.test.ts` | — |
| Delete | Remove a friend: their places leave, they lose all access | done | `contacts.remove` (`app/contacts/service.ts`); e2e `invitations.spec.ts` | — |
| Delete | Delete all my content (local and storage, signed "content deleted" marker, kit useless) | missing | Nothing; also needed for Apple's account-deletion rule | Delete all my content |
| Delete | Signed deletion markers kept 6 months; the index lists all items (safety net) | done | The reader keeps only the packs it can still open, so a deleted item drops out of the cache even without a marker (sync README "Reading friends"); the trash keeps tombstones (`data/crdt/doc.ts`) | — |
| Delete | My copy of a friend's place is independent | done | "Add to my places" creates my own save (`PlaceCard.tsx` `addToMine`) | — |
| Delete | Discreet reminder that copies cannot be taken back when removing access | missing | `contacts.removeHelp` and `contacts.theySeeHelp` do not mention it | Add the sentence |

### Importing your places

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| Import | Google Takeout (GeoJSON, CSV) | done | `import/google.ts`; `parsers.test.ts` | — |
| Import | Mapstr CSV, Pin Drop KML/CSV | partial | `import/formats/unverified/*`, flagged as unverified in the UI; real samples not checked (T-009) | T-009 |
| Import | Generic CSV with a column-mapping wizard | done | `import/formats/csv.ts`; shot `phone-import-mapping.png` | — |
| Import | Matching to OSM (confident automatic, doubtful for validation, else manual point) | done | `import/match.ts`, `plan.ts`; `match.test.ts`; shot `phone-import-preview-check.png` (the check is a list, not "on the map") | — |
| Import | Tags with colors, notes as comments, statuses carried over | done | `import/apply.ts`; `apply.test.ts` | — |
| Import | No duplicates on re-import or across sources | done | `import/plan.ts`; `apply.test.ts`, `roundtrip.test.ts` | — |
| Import | Final summary; undo in one gesture for a few days | done | `undoImport`, 7 days; shot `phone-import-done.png` | — |

### Closed place detection

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| Closure | Monthly recheck, and on card opening if over a month old | done | `osm/closure/schedule.ts`, `app/closure/useClosureCheck.ts`; osm `closure.test.ts`, app `closure.test.ts` | — |
| Closure | OSM signals: deleted, lifecycle prefix, name/category change, hours removed or off | done | `osm/closure/signals.ts`; `closure.test.ts` (recorded cases) | — |
| Closure | User "closed" report | done | "Report closed" on my places (`PlaceCard.tsx`) | — |
| Closure | Friends' "closed" reports read from their shared content; high from 2 reports | partial | `reportSignals` exists in the osm package, but the app passes no `reports`, and reports are not in the sync payload | Share closure reports |
| Closure | "Maybe closed" badge on the map and the list, with reason and date | done | pin cross (`pinSvg.ts`), list row, `ClosureSection.tsx`; shot `phone-maybe-closed-card.png` | — |
| Closure | Grouped notice at most once a month | done | `app/components/ClosureNotice.tsx`; shot `phone-closure-notice.png` | — |
| Closure | User confirms "closed", "still open" or "moved (with the new address)" | partial | Closed and still open only; there is no "moved" | Add "moved" |
| Closure | A closed place stays, hidden by the status filter; removed from public lists | done | `filters.ts` (closed hidden unless chosen); `data/filter.ts` (public lists exclude closed) | — |
| Closure | Offer to correct OSM when the information comes from a user | partial | Hint text `closure.osmHint` with no link or editor | Link to an OSM note or the editor |
| Closure | Overpass in small batches, at most monthly per place | done | Batches of 50 (`app/closure/run.ts`); `overpass.test.ts` | — |

### Place card: info, photos, opening hours

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| Card | Fetched and cached at addition; empty fields hidden | done | `PlaceCard.tsx` (enrichment retried on failure); app `osm.test.ts` | — |
| Card | Category, cuisine, address; default icon | done | `osm/normalize.ts`, `osm/categories.ts`; `normalize.test.ts`, `categories.test.ts` | — |
| Card | Phone, website buttons | done | `PlaceCard.tsx` (call, website) | — |
| Card | E-mail and social network buttons | missing | Not read from `contact:*` or `email`, and no buttons | Place card, second pass |
| Card | Opening hours with opening_hours.js, holidays, "Open, closes at 10 pm" | done | `osm/opening-hours.ts`; `opening-hours.test.ts` | — |
| Card | Accessibility, terrace, Wi-Fi, vegetarian as pictograms | partial | Terrace, Wi-Fi and diets are text chips; `wheelchair` is deliberately not read (`normalize.ts` header), which contradicts this row | Decide on accessibility; pictograms |
| Card | Free photos from Commons and Wikidata, with credit | done | `osm/photos/commons.ts`; credit line linking to the source; `photos.test.ts` | — |
| Card | Street photos from Panoramax; Mapillary as an option | partial | Panoramax done (`osm/photos/panoramax.ts`); no Mapillary | Mapillary option |
| Card | User photos (mine and friends', by visibility) | missing | See Prioritized gaps 1 | T-111b photos |
| Card | Wikipedia description via Wikidata | missing | Only the attribution text in `osm/endpoints.ts`; nothing fetches it | Wikipedia excerpt |
| Card | Info refreshed with the monthly check | done | Every OSM refresh counts as a check (README "Closed places") | — |

### Filters based on source data

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| Filters | Open now | done | `isOpenAt`; e2e `map-filters.spec.ts` "open now" | — |
| Filters | Open at a chosen time | partial | `isOpenAt(at)` exists in osm; the bar offers "now" only | Time picker in the filter bar |
| Filters | Happy hour in progress | done | `happyHourStatus`; shot `tablet-map-filter-card.png` | — |
| Filters | Terrace (yes / no / unknown) | done | `filters.test.ts` | — |
| Filters | Type of cuisine sub-filters | done | `FilterBar.tsx`; shot `phone-filters-expanded.png` | — |
| Filters | Diet, options vs exclusively | done | Diet chips `diet.*.options` / `diet.*.only` (`app/places/card.ts`), diet filter | — |
| Filters | Reservation | done | `filters.ts` CRITERIA | — |
| Filters | Free / paid admission; admission price "under €X" | done | `entryPrice`, `ENTRY_STEPS`; shot `tablet-filters-expanded.png` | — |
| Filters | Museum type, shop type sub-filters | done | `FilterBar.tsx` | — |
| Filters | Second-hand, organic | done | CRITERIA | — |
| Filters | Price level entered by the user, with the friends' average | partial | Entry and filter done; no friends' average (`app/places/model.ts` sets only mine despite its comment) | Price everywhere |
| Filters | A filter appears only if displayed places have the info, with its count | done | `filters.ts` (offered when some place has it; counts); `filters.test.ts` | — |
| Filters | Places without the info shown faded in an "unknown" group | done | `pins/build.ts` (unknown drawn faded) | — |
| Filters | Card offers to fill in missing info and contribute to OSM | missing | Nothing | Place card, second pass |

### Zones

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| Zones | Same tags, notes, visibility and filters as a place | partial | Same as places, except photos | T-111b photos |
| Zones | Existing neighborhood (tap or search) | done | `app/zones/osmZones.ts`; shot `phone-zone-neighbourhood.png` | — |
| Zones | Street segments following the streets, chained | done | `app/zones/streets.ts`; `zones.test.ts` | — |
| Zones | Freehand by points or painting (thickness, eraser, fuzzy outline) | done | `drawing.ts`, `raster.ts`, `PaintOverlay.tsx`; e2e `zones-lists.spec.ts` | — |
| Zones | Display: 20 % fill, 2.5 px outline; fuzzy rings; street line; rounded-square badge at the central point | done | `zoneLayer.ts`, `badgeSvg.ts`, `geo.ts`; shot `phone-map-zones.png` | — |
| Zones | Zone card lists the places inside | done | `ZoneCard.tsx`, `useZonePlaces.ts`; shot `phone-zone-card.png` | — |
| Zones | No opening hours or closure detection for a zone | done | `ZoneCard.tsx` | — |
| Zones | Stored as GeoJSON Polygon / LineString / MultiLineString, simplified | done | `zones.test.ts`; spatial `places_rtree` | — |
| Zones | Apple Pencil drawing | missing | No stylus handling | Screen adaptation, second pass |

### Features ported from other apps: v1 rows

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| v1 | Save a place: search, around me, point on the map | partial | Search, nearby and point done; "around me" uses the map center | Add "Here" |
| v1 | Custom colored tags, combinable filters | done | See above | — |
| v1 | Comments with per-comment visibility | done | See above | — |
| v1 | Personal photos, GPS metadata removed | missing | See Prioritized gaps 1 | T-111b photos |
| v1 | Practical card via OSM | done | See Place card | — |
| v1 | Friends' addresses and comments, choice of friends | done | See MVP | — |
| v1 | Private or public, visibility per place and per list | done | See MVP | — |
| v1 | Sharing by link; public lists in uMap | done | See lists | — |
| v1 | Directions in the chosen navigation app | done | Android `geo:` offers every app; iOS opens Apple Maps (Citymapper and others only through "Open in" Google or OSM) | — |
| v1 | Import from Google | done | See Import | — |
| v1 | Web version: public lists via uMap | done | See above | — |
| v1 | Follow friends by invitation, return link or QR | done | See MVP | — |
| v1 | Plan a trip: lists filtered by zone | done | List zones by name or outline | — |
| v2 / later | Official maps, OCR, collaborative maps, widget, offline maps, Instagram/TikTok import | deferred | v2 / later | — |

### Interface

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| Pins | Round badge with tip, main tag color, white icon outlined dark gray, white border | done | `app/pins/pinSvg.ts` | — |
| Pins | Icon of the tag, else of the OSM category | done | `placeIcon` (`app/places/model.ts`) | — |
| Pins | Sizes 34 / 40 selected / 24 zoomed out; 44 px touch target | partial | Scale factors (selected 1.3×, faded 0.72×), no 24 px zoomed-out size; touch target not checked | Pin sizes |
| Pins | Friends' places: no badge | done | README "Friends' places" | — |
| Pins | "Maybe closed": small gray cross | done | `pinSvg.ts` | — |
| Pins | Clustering bubble with count, majority tag color | done | `app/components/map/cluster.ts`; `clustering.test.ts`; shot `phone-map-clusters.png` | — |
| Colors | Palette of 17 colors; icon outline in the icon files | done | `app/theme/tags.ts`; `theme.test.ts` "tag palette" | — |
| Colors | About 150 free icons (Maki, Temaki CC0) in 8 groups | partial | About 50 Material Design Icons (Apache-2.0) in 8 groups (`app/tags/iconSet.ts`); README "not the spec's Maki/Temaki set yet" | Icon library |
| Colors | Suggested color and icon from the tag name | done | `app/tags/suggest.ts`; `tags.test.ts` | — |
| Colors | Several tags: main tag on top, up to 3 bands, "+N" beyond 4 tags; main color only when zoomed out | partial | Up to 3 bands over the whole body (`bands.ts`, `bands.test.ts`); no "+N"; no zoomed-out simplification | Pin bands per spec |
| Colors | Filter active: filtered tag's color and icon; others grey at 35 % and 28 px | done | `pins/build.ts` (40 % and 0.72×, close to the spec) | — |
| Colors | Card shows all tags as pills; reordering changes the main tag | done | `SaveEditor.tsx` (long press makes a tag the main one) | — |
| Others' tags | Through the common OSM category | done | `tagsByCategory` (`app/tags/friendTags.ts`) | — |
| Others' tags | By name (case, accents, plurals, synonyms) | done | `friendTags.ts`; data `friend-tags.test.ts` | — |
| Others' tags | Manual mapping, remembered per person | done | `tag_mappings`; shot `phone-friend-tags.png` | — |
| Others' tags | No match: author's color; "My friends' tags" panel; recolor, link, adopt; color clash warning | done | `app/app/tags.tsx`, `FilterBar.tsx` | — |
| Others' tags | Followed lists in their author's colors | partial | The preview uses the author's colors; on the map, followed lists look like friends' places, with no option | Followed lists, second pass |
| Others' tags | Add to my places: tags pre-filled through the mappings | done | `addToMine` uses the mapped tag ids | — |
| Screens | Map: search bar, filter bar, "+" | partial | Filter bar with text search and "+"; no separate address search bar on the map (search lives on the add screen) | Decide |
| Screens | Bar collapses itself when the map is scrolled; the friends panel | done | README "Filter bar"; `FriendsPicker.tsx` | — |
| Screens | Tag management: color, icon, count, OSM categories, mappings | done | `app/app/tags.tsx`; shot `phone-tags.png` | — |
| Screens | Card as a bottom sheet (photo, name, status, tags, note, friends) | done | `PlaceSheet.tsx`, `PlaceCard.tsx` | — |
| Screens | List: pills at the start, distance on the right | done | `app/app/list.tsx` | — |
| Screens | What's new grouped by day, filter by type and friend, dots, "See on the map", tab badge | done | `whatsnew.tsx`; e2e `sync.spec.ts` | — |
| Screens | Phase 0 mockups | missing | T-005 "to do" | T-005 |

### First launch

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| First launch | Three entries (Get started, invitation, already have my places) | done | `app/app/welcome/*`; shot `phone-welcome.png`; e2e `recovery.spec.ts` (the third entry on a wiped browser) | — |
| First launch | "I already have my places": restore with the recovery phrase and the storage address | done | `app/app/welcome/device.tsx` (paste the kit, or type the words; QR code of the address scanned), `app/devices/sessions.ts` `restoreWithPhrase`, `app/identity/kit.ts` `parseKitText`; `identity.test.ts`, `devices.test.ts`; e2e `recovery.spec.ts`; shot `phone-restore-kit.png` | — |
| First launch | Invitation entry: friend's places shown at once with the invitation key, no storage | done | `app/contacts/PendingInvitation.tsx`, `invitations-received`; e2e `invitations.spec.ts` | — |
| First launch | Standard flow: welcome, name/photo (key made in the background), location, import, map with hint | done | `welcome/*`; shots `phone-welcome-*.png`, `phone-map-hint.png` | — |
| First launch | "Protect your places" after about 10 places or a few days | done | `app/identity/ProtectCard.tsx`, `protect.ts`; `identity.test.ts` | — |
| First launch | Storage wizard: Nextcloud Login Flow, app password, folder and share link created automatically | missing | App password typed and share link pasted (`storage.field.ncLoginFlowLater`) | T-203b Login Flow + OCS |
| First launch | WebDAV, S3, SFTP forms; HTTPS-only explanation | partial | Forms exist; S3 signs only on web (Hermes lacks `crypto.subtle`), and SFTP is "Desktop only" | S3 signer on Hermes; SFTP on mobile |
| First launch | Full test: write, read, delete, external read | done | `app/storage/connectionTest.ts`; `storage.test.ts`; e2e `storage.spec.ts` | — |
| First launch | First friend: invite, publish the index, share sheet or QR | done | `/invite`; e2e `invitations.spec.ts` | — |
| Kit | 12 words, check of 3 words, password manager entry, clipboard cleared after 1 min, printable PDF with QR | done | `app/app/kit.tsx`, `app/identity/kit.ts` (`kitQrSvg`: QR code of the read address on the printed page), `clipboard.ts`, `print.*`; `identity.test.ts`; e2e `recovery.spec.ts` (the printed QR code decoded with ZXing); shot `web-kit-print-qr.png` | — |
| Kit | Vault: friends, anchors, invitations, retired identities, app data | done | `crypto/vault.ts`; crypto `vault.test.ts`; second reader `docs/format/reference-reader/` (all vault vectors); the app restores friends with their "verified" mark and the names given to them (vault value `contact-names`): `contacts/flow.test.ts`, e2e `recovery.spec.ts` | — |
| Kit | Loss: on the new device the kit is enough, everything is restored (places, photos, friends, storage access) | done | e2e `recovery.spec.ts` against Apache WebDAV: browser storage wiped, restored from the pasted kit and from the printed page; shot `phone-restored-photo.png` | — |
| Kit | Storage credentials changed since: the app asks for them again | done | A vault without them: `devices.test.ts` ("its storage access is asked again"); rejected ones: the "Credentials rejected" error row (`error-cases.md`) opens the storage form | — |
| Kit | Local-only mode: offer an encrypted backup file | partial | The kit points to the plaintext GeoJSON export (`kit.localOnlyNote`); there is no encrypted backup file | Encrypted local backup |
| Devices | Add a device by QR, link + code, or phrase; list, rename, remove | done | `app/devices/*`; `devices.test.ts`, `flow.test.ts`; e2e `devices.spec.ts` | — |
| Loss/theft | Declare lost, key rotation, re-encryption, remote wipe, storage access guide, changes since a date | done | `sync/engine.ts` `rotateKey`, `app/devices/*`; sync `devices.test.ts`; e2e `devices.spec.ts` | — |
| Loss/theft | Primary device lost: identity move | done | `/devices/identity`; sync `review-devices.test.ts` | — |
| Device | App lock by code or biometrics, on by default without a screen lock, auto-lock, lock or wipe after N days without sync | done | `app/identity/LockGate.tsx`, `lock.ts`; `devices.test.ts` (stale sync lock) | — |
| Device | Keys and credentials in the system secure vault | done | `secretStore.native.ts` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) | — |
| Device | Local database encrypted with a key in the vault | missing | `openStore.native.ts` opens `triangulair.db` in plain form | SQLCipher |
| Device | Recovery phrase not kept after setup | done | Erased once the 3 words match (README "Recovery kit") | — |
| First launch | After installation, offer to paste the received link | done | `/welcome/invitation` (paste field) | — |

### Error cases

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| Error cases | 19 rows of the table and the Sync status screen | partial | Every row has a test, mapped in [error-cases.md](error-cases.md). Open points listed there: no public fallback tile address, "photos wait" moot until photos exist, no Nextcloud relaunch, invalid invitation record logged only. Native gap: row 1 cannot fire on phones (no NetInfo) | NetInfo; see error-cases.md |
| Error cases | The technical log can be exported | partial | Shown and selectable on `/sync`; no share or export button | "Share the log" button |

### Non-functional requirements

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| Performance | 10k places, 200 followed, 50k cached, 500 lists | partial | Data and sync perf suites at 10k (`data/test/perf.test.ts`, `sync/test/perf.test.ts`); 200 friends and 50k cached not measured | Perf dataset with 200 friends |
| Performance | Launch under 2 s, map from cache, never waiting on the network | partial | Map from cache, sync in the background (`SyncProvider`); not measured on a device | Device benchmark |
| Performance | 60 fps with 10k pins; filter in under 100 ms across 50k | partial | Filter and bbox under 100 ms at 10k (`perf.test.ts`); native pins are RN views (see Prioritized gaps 2) | T-103 |
| Performance | Nearby under 1 s, local search under 300 ms | done | `perf.test.ts` "text search < 300 ms" | — |
| Performance | 50 unchanged friends under 5 s; friend with 1k places under 10 s; decrypt 1k under 1 s | partial | Measured in Node (sync README "Measurements"); not against a real Nextcloud, not on Hermes (libsodium asm.js not timed) | Hermes timing |
| Performance | App under 50 MB; cache capped at 500 MB, adjustable, photos evicted first | missing | No friends' cache cap or setting; app size not measured | Cache cap |
| Performance | No background activity, no background location | done | Location only at first launch and when "center on me" is pressed (one fix, `app/location/locate.ts`); no periodic task | — |
| Performance | Automated perf tests on a reference device on every release | missing | Node-only suites, not in the release flow | — |
| Sync | On launch, during use (regular, pull to refresh), after closing, then nothing | done | `sync/scheduler.ts`; sync `units.test.ts` | — |
| Sync | iOS grace period / Android one-off task for the last pass | missing | Pass on AppState "background" without `beginBackgroundTask` (README "Sync open questions") | Background task |
| Sync | Closure checks in small batches during use | done | `useClosureCheck.ts` | — |
| Screens | Small phones (320 pt), large, tablets, portrait/landscape, split screen | done | `app/theme/layout.ts`, `useLayout.ts`; `theme.test.ts` "layout"; shots `small-font2-*.png` | — |
| Screens | Tablet: card in a side panel | done | Shot `tablet-map-filter-card.png` | — |
| Screens | Vector icons and pins at screen density | done | SVG pins (`pinSvg.ts`) | — |
| Screens | Font size: Dynamic Type up to the largest, wrapping, chips grow, bar scrolls | done | `maxFontSizeMultiplier` caps, no fixed heights (README "T-117/T-118 pass"); shots `*-font*.png` | — |
| Screens | iOS Display Zoom / Android display size | done | Covered by size classes (narrow windows) | — |
| Screens | Safe areas (notch, island, gesture bar) | done | `react-native-safe-area-context` throughout | — |
| Screens | Pins do not follow the text size | done | Pins are map elements | — |
| Screens | Automatic screenshots across form factor × font size × zoom on every release | partial | Scripts (`apps/mobile/scripts/shots*.py`), run by hand; not in CI or the release flow, not compared with the previous version | Screenshot matrix in CI |
| Foldables | Continuity when folding (no state lost) | done | Layout from window size only; shots `fold-outer-profile.png`, `fold-inner-profile.png` | — |
| Foldables | Unfolded two-pane layout | done | Wide layout (map + card) | — |
| Foldables | Hinge avoidance through Jetpack WindowManager; tabletop mode | missing | No display-feature reading | Foldable posture support |
| Foldables | Tests on foldable emulators and real devices | missing | Web emulation only | — |
| iPad/Mac | Three panes in landscape (filters/lists, map, card), two in portrait | partial | Two panes on wide windows; no three-pane layout | iPad layout |
| iPad/Mac | Hover name preview, right-click actions, keyboard shortcuts, trackpad | partial | Right click drops a point on web (README "Add a place"); no hover, no keyboard shortcuts | Pointer and keyboard |
| iPad/Mac | Mac (Apple Silicon) runs the iPad version | partial | Nothing to block it; untested | Test on a Mac |
| Languages | v1 in French and English, externalized, plurals | done | `app/i18n/*`; `i18n.test.ts` (parity), `hardcoded.test.ts`; e2e `i18n-theme.spec.ts` | — |
| Languages | ICU format, Weblate | partial | Own format with `Intl.PluralRules` (`i18n/core.ts`, "can move to ICU files (Weblate) later") | ICU + Weblate |
| Languages | Right-to-left layout | missing | No `I18nManager` or RTL handling | RTL pass |
| Languages | Place names in the user's language (`name:xx`) | missing | `names` parsed in `osm/normalize.ts`, never used | Localized names |
| Languages | Units and formats by region: km or miles, dates, times, currencies | partial | Dates and numbers through `Intl`; metric only (`card.ts`: "miles come with settings"); entry prices in EUR | Units by region |
| Languages | Tag synonyms per language | done | en and fr synonyms in `app/tags/friendTags.ts` | — |
| Dark mode | Follows the system, manual light / dark / auto | done | `app/theme/themeMode.ts`; `theme.test.ts`; e2e `i18n-theme.spec.ts` | — |
| Dark mode | Dark map from OpenFreeMap Dark with the same adjustments as the light style | partial | OpenFreeMap `dark` used as is; there is no custom style derived from Positron, bundled, and no Liberty "detailed map" option (see Base map) | Custom map style |
| Dark mode | Same pin colors in both modes | done | `pinSvg.ts` | — |
| Dark mode | Theme tokens | done | `app/theme/colors.ts`, `useUiColors` | — |

### Data model

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| Data model | Tables `people`, `groups`, `group_members`, `places`, `saves`, `tags`, `save_tags`, `tag_mappings`, `lists`, `list_items`, `access`, `media` | done | `data/sqlite/schema.ts`; data `repository.test.ts`, `smoke.test.ts` | — |
| Data model | Spatial extension (point, line, polygon, edge) | done | `places_rtree` (R*Tree flag in `app.json`), fallback on web | — |
| Data model | Groups as local shortcuts ("friends", "family") | missing | Tables only; no UI or API uses them | Groups |
| Data model | Signed index (`version`, `seq`, certs, `revoked_devices`, `reads`, `packs`, `public`, `invitations`) | done | `crypto/signed-index.ts`; docs/format; crypto `signed-index.test.ts`, vectors | — |
| Data model | Packs: batch key per recipient set, GeoJSON features once decrypted | done | `crypto/pack.ts`, `sync/payload.ts`; sync `units.test.ts` | — |
| Data model | Media: photos encrypted on the storage | missing | `media/` path accepted by the index; no photo is ever written | T-111b photos |
| Data model | Friends' cache: data kept, photos evicted first at the limit | missing | No cap (see Performance) | Cache cap |
| Data model | Manual point within about 30 m with a similar name: offer to merge | partial | `Repository.findDuplicateSuggestions` (`data/dedup.ts`, `dedup.test.ts`) and import dedup; the app never offers it | Merge suggestion in the UI |

### Privacy, security, moderation

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| Privacy | Default sharing is friends, adjustable to private in the preferences | partial | Default `friends` in the schema and form; no preference to change the default | Default sharing setting |
| Privacy | Never public by default; public only through a list or a public comment | done | `public-lists.ts`; sync `lists.test.ts` | — |
| Privacy | End-to-end encryption; only public lists in plaintext | done | `crypto/*`, `sync/*`; sync `adversarial.test.ts` | — |
| Privacy | No continuous geolocation, no location history | done | Position read once at first launch (kept on the device to center the map) and once per "center on me" press (not stored); no tracking | — |
| Privacy | Photos: EXIF removed before encryption | missing | No photos (the avatar goes through `expo-image-picker` crop; EXIF stripping not checked) | T-111b photos |
| Privacy | Warning when a place looks like a home before a public list | done | `looksLikeHome`, `PublicWarning.tsx`, `HomeConfirm`; shot `phone-list-public-warning.png` | — |
| Privacy | Weak point explained in the app (copies cannot be taken back) | missing | See Editing and deleting | Add the sentence |
| Security | Private key and storage credentials in Keychain / Keystore | done | `secretStore.native.ts` | — |
| Security | All friends' content verified before display | done | `sync/reader.ts`; sync `adversarial.test.ts`, `review.test.ts` | — |
| Security | Safety code (12 × 5 digits or QR), verified badge | done | `crypto/safety.ts`, `app/contacts/*`; `safety.test.ts`; shot `phone-contact-verified.png` | — |
| Security | libsodium, no homemade algorithm; external audit before release | partial | libsodium everywhere; audit T-214 "to do" | T-214 |
| Moderation | Everyone only sees the content of people they accepted | done | By construction (wraps per accepted key) | — |
| Moderation | Blocking a person deletes their key and places and removes all their accesses | partial | "Remove from my friends" does this; there is no block that refuses their future links | Block |
| Moderation | Report a public list to its author and host | missing | Nothing | Report |
| Tech stack | F-Droid: no Firebase or Play Services, no periodic task, reproducible builds | partial | No Firebase, no Play services, no ML Kit in the Android release build: location on `modules/tl-location` (platform `LocationManager`), QR scanning on `modules/tl-qr-scanner` (CameraX + ZXing), MapLibre's `default` location engine; `native-android.yml` fails on any such library (`scripts/fdroid-deps.mjs --fail`, `app/fdroidDeps.test.ts`), and its smoke test finds a mock position on an AOSP emulator without Google APIs. No periodic task. No reproducible build or fdroiddata recipe yet | Reproducible build and F-Droid metadata (T-301) |
| Tech stack | Tile address configurable in settings or by a config update, without a release | partial | Build-time `EXPO_PUBLIC_MAP_STYLE_URL*` and fallback lists (`app/config.ts`); no setting | Tile address setting |
| Tech stack | Custom style from Positron (tinted water and parks, gray shop dots that open the add flow), bundled; Liberty option | missing | OpenFreeMap styles loaded by URL | Custom map style |
| Tech stack | User-Agent with name, version, contact; cache headers respected | done | `buildUserAgent` (`app/osm/client.ts`); osm `http.test.ts` | — |
| Tech stack | Map tiles: cache of viewed areas | done | MapLibre ambient cache, browser HTTP cache (error-cases.md row 16); no size setting | — |
| Tech stack | Offline maps by region (PMTiles) | deferred | v3 | — |
| Tech stack | Apple Maps base map on iOS | deferred | v2 | — |

### Legal and publishing

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| Attributions | "© OpenStreetMap contributors" on the map, with a link to the license | done | `app/components/MapAttribution.tsx` (always visible, links to `/copyright`) on the home map, list maps and the zone editor | — |
| Attributions | OpenFreeMap and OpenMapTiles in the same line | partial | "OpenFreeMap" present, "© OpenMapTiles" missing (`app/config.ts` `MAP_ATTRIBUTION`) | Fix the attribution line |
| Attributions | "Report an error" link to OpenStreetMap | missing | Nothing | Fix the attribution line |
| Attributions | OSM credit on the cards | done | `card.osmAttribution` "Info © OpenStreetMap contributors (ODbL)" (text, no link) | — |
| Attributions | Commons and Panoramax: author, license and source link under each photo | done | `PlaceCard.tsx` credit line linking to `pageUrl`; `photos.test.ts` | — |
| Attributions | Wikipedia: "Source: Wikipedia" under the description | missing | No description shown (attribution string ready in `osm/endpoints.ts`) | Wikipedia excerpt |
| Attributions | ODbL notice in the public GeoJSON | done | `ODBL_ATTRIBUTION` (`sync/public-lists.ts`); e2e `lists-sharing.spec.ts` | — |
| Attributions | Photon search attribution | done | `add.photonAttribution` on the add screen | — |
| Store rules | Published privacy policy listing the third-party services | missing | No policy in the repository or the app | Privacy policy (T-008/T-302) |
| Store rules | Block and report | missing | See Moderation | Block, report |
| Store rules | Account deletion covered by "Delete all my content" | missing | See Editing and deleting | Delete all my content |
| Store rules | Encryption declarations (Apple, ANSSI) | missing | T-008 "to do" (maintainer) | T-008 |
| Crash reports | No automatic sending; the user shares the local log | partial | No crash SDK in `package.json` (no Sentry or Firebase): done. Sharing the log needs copying text from `/sync` | "Share the log" button |

### Deferred by the spec (v2 / v3 lists)

| Section | Statement | Status | Evidence / what is missing | Suggested task |
| --- | --- | --- | --- | --- |
| v2 | Collaborative lists; Remote Storage and Git publishing; one-gesture migration; access history and key renewal; custom web page | deferred | Not started (the storage move T-203 already exists) | — |
| v3 | Offline maps (PMTiles), suggested places, widget, reactions, share from Google Maps, easier OSM contribution | deferred | Not started | — |
| Apple Maps | MapKit base map on iOS | deferred | v2 | — |
| Mac | Native Mac Catalyst version | deferred | v2 | — |
| Viewing | Custom decrypting web page | deferred | v2 (counted above) | — |

## Notes on method

- Every feature sentence of the sections listed in the task was read against the code: by search in
  `packages/*/src` and `apps/mobile/src`, by the README "open questions" of `apps/mobile` and `packages/sync`,
  and by the tests and e2e specs. "done" means at least one test or screenshot exists. It does not mean the
  behavior was run on a native device: the README says the native build has not run on a device yet.
- The rows on loss and theft, invitations and format versions summarize areas already traced in more detail
  in `docs/format/promises.md` and in the reviews under `docs/reviews/`.
