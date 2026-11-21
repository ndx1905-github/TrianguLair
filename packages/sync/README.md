# @triangulair/sync

Publishing and reading packs (task T-204): it ties `@triangulair/crypto` (format v4, unchanged),
`@triangulair/storage` and `@triangulair/data` together. My devices publish my places, encrypted per
audience, to my storage; my other devices merge my Yjs document from there; friends read my storage
directly and keep a decrypted cache. Pure JavaScript (libsodium, Yjs, fflate): no WebAssembly, no
Node API outside the tests, so it runs in React Native (Hermes) and on the web. License: MPL-2.0.

```sh
cd packages/sync
npm install --workspaces=false   # also install crypto, storage and data (npm_config_nodedir=… for data)
npm test                         # simulations, units (the performance suite is separate)
npm run typecheck
npm run test:perf                # 1,000 and 10,000 places (PERF_REPORT=1 prints the table)
npm run test:real                # against real servers: run packages/storage/scripts/real-servers.sh (root) first
```

No UI here (the app's screens are in apps/mobile).

## API

```ts
import { ready } from '@triangulair/crypto';
import { SyncEngine, SyncScheduler, SqliteStateStore } from '@triangulair/sync';

await ready();
const engine = new SyncEngine({
  store,                         // DataStore (@triangulair/data)
  state: new SqliteStateStore(driver), // same database: table sync_state
  sharing,                       // SharingKey { keyPair, cert, vaultDataKey } from the system vault
  device,                        // DeviceSigner { keys, cert }: needed to publish
  storage,                       // my write adapter (WebDAV, S3, SFTP…); absent = local only (can still read friends)
  readAdapter: (url) => new HttpsReadOnlyAdapter({ baseUrl: url }), // the default
  onSharingKey: (k) => keychain.save(k), // a new key adopted from keys/ (rotation)
  previousVaultKeys,             // engine.own.previousVaultKeys, persisted with the sharing keys
  wipe: { secrets: () => keychain.eraseAll() }, // remote wipe; the database is erased by DataStore.wipe()
  // limits: { packBytes, friendReadBytes, … }  // SyncLimits, defaults below
});
const scheduler = new SyncScheduler({ run: (reason, opts) => engine.sync(opts), onReport, onStatus });
scheduler.appForeground('launch');   // AppState "active"
scheduler.localChange();             // after each edit (debounced publish)
scheduler.pullToRefresh();
scheduler.setOnline(netInfo.isConnected);
await scheduler.appBackground();     // AppState "background": last pass, then no timer at all
```

| Export | Role |
| --- | --- |
| `SyncEngine` | `sync({ publish?, readFriends? })` (one pass: pull my storage, read the people I follow, publish what changed; concurrent calls share the pass; a device found revoked stops the pass and wipes, `report.wiped`), `wipe()`, `isWiped`, `addContact(verifiedIndex, { share, follow, verified })`, `setPolicy(owner, { share, follow })`, `removeContact(owner)`, `addInvitation(invitation)`, `contacts()`, `keys()`; option `friendKeys(owner)` (extra keys for one friend at every pass, e.g. an invitation key before my answer is accepted); `own` (`OwnSync`), `reader` (`FriendReader`), `book` (`ContactBook`) |
| `OwnSync` | `pull({ full? })` (my index, my other devices' document changes, a new sharing key from `keys/`, the vault), `publish({ force? })`, `rotate(newSharingKey, otherDeviceCerts)` (primary device), `pushVault()`, `index`, `previousVaultKeys`, `limits` |
| `FriendReader` | `read({ owner, location, anchor?, extraKeys?, retiredOwners? }, { pass? })` → `FriendReport { status, whatsNew: { added, changed: [{ placeId, meaningful, fields }], removed }, index, keyChanged, movedTo, problem, downloaded }`, `readAll` (one pass budget), `forget(owner)`, `lastSuccess(owner)`, `friendLists(owner)` (their lists shared with me) |
| Lists (T-211/T-212) | engine: `setListAccess(owner, listId, on)`, `previewList(fragment)` → `ListPreview` (throws `ListGoneError { gone: 'deleted' / 'link-dead' }`), `followList(fragment)`, `unfollowList(id)`, `followedLists()` → `FollowedListInfo[]`, `lists` (`ListReader`), `SyncReport.lists`; book: `listViewers(listId)`, `followedLists()`; links: `listLinkFragment`, `parseListLinkFragment`, `encodeListLink` / `decodeListLink`, `followIdOf`, `newListKey`, `listSecretOf`, `listKeyPair` (after `listsReady()`), `publicListsUrl(location)`, `umapUrl(fileUrl, { lang })` |
| `SyncScheduler` | `run(reason, { publish })`; `appForeground`, `appBackground`, `localChange`, `pullToRefresh`, `setOnline`, `resume`, `getStatus()` → `{ state: idle / syncing / offline / blocked / background / wiped, pending, lastSuccess, failingSince, problem, banner }` |
| `ContactBook`, `mergeBooks` | contacts and their switches in the recovery vault |
| `classifyError(e, 'own' / 'friend', online)` | → `SyncProblem { kind, retryable, blocksWrites, situation, message, detail }` (table below) |
| `planPacks`, `computeAudiences`, `featureFor`, `parsePlaces`, `encodePayload` / `decodePayload`, `buildPublicLists` | the pure parts, exported for tests and tools |
| `MemoryStateStore`, `SqliteStateStore` | local state (ETags, anchors, pack caches, the local vault copy) |
| `SyncLimits`, `DEFAULT_LIMITS`, `ByteBudget`, `LimitError`, `Semaphore` | size limits (see "Limits") |

Added to `@triangulair/data` for this task: `DataStore.snapshot()`, `isAt(snapshot)`, `exportSince(snapshot)`
and `snapshotOfUpdates(updates)` (Yjs state vector **and** delete set: a pure deletion, such as a trash purge,
adds no struct and would be invisible to a state-vector comparison); after the review, schema 2
(`saves.place_snapshot`, `places.osm_fields`, `Repository.savePlaceSnapshot(saveId)`: what I publish comes from my
own description of each place, and a friend's save never overwrites a row someone else uses) and
`DataStore.wipe()`. In `@triangulair/storage`: `get(path, { maxBytes })` (streamed limit, `TooLarge`) and
`maxBytes` on `fetchSnapshot` / `fetchHighestIndex` / `fetchPack`. In `@triangulair/storage` (T-202
follow-up): `indexPath(major)`, `indexMajorOf(path)`, `publishSnapshot({ newerIndexes })`,
`fetchHighestIndex(adapter, majors, lastEtags)`, `fetchSnapshot(…, { path })`.

## Who reads what

`computeAudiences` (spec "Sharing a place", "Encrypted sharing", "Invitation link and return link"):

- a **private** save never leaves my devices: it is only in my own document;
- a save shared with friends is wrapped for every contact whose "they see my places" switch is on
  (`share: true`), or, for a contact restricted to some lists (`share: { lists }`: partial acceptance of a
  return link), when the save is in one of those lists;
- and for every open invitation that my index lists and that is not accepted yet (direct recipient, never a
  group), so the invitee sees it right away; acceptance or expiry changes the recipient set, so the packs are
  re-sealed with new pack keys;
- and **always** for my own sharing key, so that any of my devices can open, check and re-encrypt every pack.
- Comments: in friends' packs only when marked friends or public; in the public file only when public.

Items are grouped by identical recipient set (fingerprint = BLAKE2b of the sorted public keys) and each group is
cut into packs of at most 200 places, in Z-order (geographic) on a first build. Contacts and their switches live
in the recovery vault (`app.triangulair_sync`, merged per contact, latest change wins, removals kept as
tombstones), so every device publishes the same audiences.

## Storage layout

| Path | Content | Who reads it |
| --- | --- | --- |
| `index.json` | signed index (crypto 4.0), written last with `If-Match`, then read back | everyone |
| `packs/b2b256-<hash>.bin` | **places packs**: GeoJSON, one or more per recipient set, my key included; content-addressed, never modified | friends (only the new ones) and my devices |
| `media/b2b256-<hash>.bin` | **my Yjs document** (one full snapshot + up to 8 deltas, then a new snapshot) and a **manifest** (logical pack id → recipient-set fingerprint; recipient sets of the photo keys), sealed to my key only; **photos**: one file per image (full ~1,600 px, and its thumbnail), sealed to the photo's own key (below) | my devices; friends fetch `media/` only on demand (a thumbnail, a photo they open), never the document or manifest |
| `packs/b2b256-<hash>.bin` | **lists packs** (payload kind 4, below): list definitions sealed to the friends with access; a link-only list (definition + places) sealed to its list key; tombstones of deleted link-only lists | those friends; whoever holds the link |
| `public/lists.geojson` | public lists in plaintext, ODbL attribution, uMap styles, listed in the index with its hash | anyone, uMap, followers of a public list |
| `vault.bin` | recovery vault (`TLVD`), written with `If-Match`, merged on conflict | my devices |
| `keys/<device id>.bin` | the current sharing key sealed to each of my other devices (`TLSK`), written by `rotate` and before each publication | that device |
| `keys/<owner id>.bin` | the current sharing key sealed with the phrase-derived key (`TLSK` mode 2), written by `rotateKey` and by the app | a device restored with the 12 words |

Packs are written first (in parallel, `If-None-Match: *`), then the public file, then the index (`If-Match` of the
index the pass started from, `If-None-Match: *` on the first publication). The index is then **read back**:
compare-and-swap is best effort on several servers (T-202: Apache with weak ETags, WsgiDAV, Nextcloud with coarse
ETags, emulated conditions on SFTP), so a publication counts only if the storage now holds exactly our bytes;
otherwise the pass pulls again (merging the other device's document), and republishes (up to 5 attempts). Right before
the index write, the index on the storage is downloaded and compared with the one the attempt is based on (servers
with coarse ETags, Nextcloud and WsgiDAV, can show another device's index under the same ETag), and a retry always
downloads the index in full. A lost race that still goes unnoticed (both devices read back their own index, then
one overwrote the other in the window after the check) shows up as a fork at the other device, which republishes
its whole document from its local state; files superseded meanwhile can give friends a 404 until then (they keep
their cache). Files that a publication superseded, and the files of our lost attempts, are
deleted only after a successful publication; other unlisted files are left alone (they may be another device's
upload in progress).

Incremental publication: only packs whose content changed are rewritten; a new place goes into the least filled
pack of its group; two packs below a quarter of the capacity in a group are merged; when exactly one existing pack
would be replaced, one unchanged pack is rewritten too (spec: "blurs by grouping replacements"). Editing one place
of 10,000 uploads 3 files (29 KB): its pack, one blurred pack and the document delta.

Own devices: an index of mine is trusted only at or after my anchor and under my current sharing certificate
(not an older rotation, not signed by a device it revokes); a rolled-back, forked or older-rotation index is never
imported: my device republishes everything from its local state above the anchor and deletes the files it listed.
A device without a local anchor (restored from the recovery kit) takes the anchor recorded in the vault. Then each
pass imports the own-document files it has not seen (Yjs updates commute) and compares the local
document with the snapshot of what the storage holds (`isAt`); if it differs, it publishes a delta
(`exportSince`) or, every 8 deltas (or when the deltas outweigh the base), a full snapshot that replaces them.

## Payloads (inside the pack encryption)

```
"TLSY" | version u8 = 1 | kind u8 (1 places, 2 own document, 3 manifest) | codec u8 (0 stored, 1 raw DEFLATE)
       | body length u32be | body | zero padding up to 4 KiB (checked by readers)
```

Places (kind 1), version 1, a GeoJSON FeatureCollection (so a decrypted pack is a GeoJSON file):

```json
{"type":"FeatureCollection","triangulair":{"kind":"places","version":1},"features":[
 {"type":"Feature","id":"osm:node/123","geometry":{"type":"Point","coordinates":[2.35,48.85]},
  "properties":{"name":"Chez Lili","category":"amenity=restaurant","comment":"Great pizza","comment_visibility":"friends",
   "status":"tried","price_level":2,"tags":[{"name":"Pizza","color":"#EF4444","icon":"pizza","parent":"Restaurant"}],
   "created":"2026-10-13T15:10:00.000Z","updated":"2026-10-14T09:00:00.000Z"}}]}
```

- `id` is the place id (OSM `osm:<type>/<id>` or `local:…`); optional properties are omitted when empty
  (`kind` only for `"zone"`, `edge` only for `"blurred"`). Personal data only, never the OSM record.
- Readers refuse duplicate keys and non-written forms (`JSON.stringify(JSON.parse(s)) === s`, the crypto rule for
  canonical JSON, which itself allows no floats), unknown fields unless `triangulair.minor` is higher than theirs,
  ids that are not place ids, invalid or oversized geometries (20,000 positions), more than 1,000 features, 32 tags,
  over-long strings, tag colors other than `#RRGGBB`, icons other than symbol names, control characters (line
  breaks only in comments) and bidi overrides; dates more than 24 h ahead are clamped. My own writer drops or
  cleans what readers would refuse. Decompression stops at the limit of each kind (see "Limits"). Version 2 would
  be refused ("Update the app").
- Lists (kind 4, added before any release; T-211/T-212), version 1, again a GeoJSON FeatureCollection:
  `{"type":"FeatureCollection","triangulair":{"kind":"lists","version":1,"author"?:…,"lists":[{"id","name","description"?,"updated","items":[place ids]} | {"id","deleted":true,"updated","until"}]},"features":[…]}`.
  For friends: `features` is empty (the places are in their places packs) and `items` are places they can read; for a
  link-only list: `features` are the list's places as in a places payload (public comments only), at most 500 per
  pack, with the author's name. Same strict reading rules as places (written form, minor, bounded arrays, control
  characters, place ids).
- Own document (kind 2): `mode u8 (1 full, 2 delta) | Yjs update v1`. Manifest (kind 3):
  `{"kind":"manifest","packs":{"<logical id>":"<recipient fingerprint>"},"version":1}`. Both only for my key.
- Public lists file: a FeatureCollection with `attribution` (ODbL notice), `license`, `triangulair: { kind:
  "public-lists", version, owner, author?, lists: [{ id, name, description?, updated }] }`, one feature per (list,
  place) with `list`, `list_name`, `description` (the public comment), `url` (openstreetmap.org page of an OSM place)
  and `_umap_options` (uMap's per-feature style: main tag color, "Drop" marker for points, 20 % fill and thin outline
  for zones, a 5 px line for streets); each list's `count`. Dates (places and lists) are rounded to the UTC day and
  places carry no `tags` unless I opted in to publishing my tag names (`engine.setPublicTagNames(true)`, kept in the
  vault: `app.triangulair_sync.publish`, latest change wins); the same holds for link-only list packs (review L-03). A place that looks like a home (`home.ts`: a dwelling
  category, no category with an address, a point placed by hand; never a zone) that a *filter* list took by itself
  stays out of the file until the author confirms it as an explicit `include` of the filter (`heldPublicPlaces` lists
  the ones waiting; the app warns before a place enters a public list by hand: review M-02). "View on uMap" = `umapUrl(publicListsUrl(location))`:
  `https://umap.openstreetmap.fr/<lang>/map/new/?dataUrl=<file>&dataFormat=geojson` (uMap's own query parameters,
  read by `loadDataFromQueryString`; the instance fetches the file through its proxy, so no CORS rule is needed for
  uMap). It opens a new uMap map with a copy of the file's current content, all my public lists in one layer.

## Personal photos (T-111b)

`photos.ts`, `photo-service.ts`, `media-cache.ts`, `image-meta.ts`; `OwnSync.preparePhotos`. Spec: "recompressed
on upload (about 1,600 px wide, WebP or AVIF) with a separate thumbnail; friends download the full photo only when
opening it", "GPS metadata removed on upload", quota full: "photos wait, text goes first", the friends' cache cap
("their photos are evicted first").

- **Format caps** (the media format's rules; a reader refuses an image above them, so every client MUST stay
  within them; review photos F-03 and the product decision in docs/reviews/photos.md):

  | | Longest side | File (the image inside the media file) |
  |---|---|---|
  | Photo (`full`) | 2,048 px (`MAX_PHOTO_SIDE`) | 1.5 MiB, 1,572,864 bytes (`MAX_PHOTO_BYTES`) |
  | Thumbnail (`thumb`) | 512 px (`MAX_THUMB_SIDE`) | 128 KiB, 131,072 bytes (`MAX_THUMB_BYTES`) |

  The side is read from the image headers (`imageSize`: JPEG SOFn, WebP VP8X/VP8/VP8L, AVIF `ispe`), the byte cap
  applies to the photo payload once the media file is opened (the download bound adds the envelope and Padmé,
  `mediaFileBytes`). A reference's `w` and `h` are bounded by the photo side cap too (a larger one makes the places
  payload invalid). The app writes 1,600 px (1,200 px with "Smaller") and 400 px (320 px) thumbnails, so the caps
  leave a margin; 1.5 MiB is a 2,048 px image at about 3 bits per pixel, above what a good encoder produces for a
  detailed scene (a 1,600 px WebP at quality 0.8 is 150–600 KB). **Writers never refuse a photo for its size**:
  the app downscales to the setting's side, then lowers the quality step by step (0.1 down to 0.3) and, if needed,
  the side (×0.75) until both images fit (`encodeToFit`, apps/mobile/src/photos/model.ts). Only a file that is not
  an image is refused.
- **Adding** (`engine.photos.add(placeId, { full, thumb, width, height }, { createdAt? })`): the app recompresses
  (about 1,600 px and a 400 px thumbnail, WebP, AVIF where the platform encodes it, JPEG as a last resort, made to
  fit the caps); here the metadata containers are removed again (JPEG APP1, APP2 but ICC, APP3–15 and COM, also
  between progressive scans, and anything after the end of the image; WebP `EXIF`/`XMP ` and chunks the format
  does not define; an AVIF with an Exif or XMP item is refused) and the result checked (`imageMetadata` must be
  empty), against the caps above (`photoBytes` / `thumbBytes`, by default the byte caps, and `checkImage`, like a
  reader). Both images are kept on the device (`media_cache`, the app's SQLite database: covered by its encryption
  and by the remote wipe) under their content hash, and recorded in my document (`m:<id>`: hashes, format, size,
  dimensions, date). Removing (`photos.remove`) deletes the record; the files go at the next publication.
- **Publishing**: each image is a media file (frozen `sealPack(…, { type: "media" })`, payload kind 5 `photo`,
  stored, padded to the 4 KiB floor then Padmé, 2 wraps like my own document), sealed to a random **photo key**
  (X25519), one per photo. The key and the two files' hashes are written in my document (`u:<id>`, all my
  devices) and, for a save friends can read, in its places pack: `"photos":[{"id","key","full","thumb","type","w",
  "h","created"}]` (places payload minor 1, declared only by packs with photos; at most 24 per place). Photos are
  uploaded before the packs that reference them; the index lists both files.
- **Who can open a photo**: whoever reads the save's places pack (same audience as the save), and my devices.
  Adding a reader uploads nothing (the key travels in the re-sealed places pack). When a reader is removed (a
  friend, a "some lists" restriction, an accepted or expired invitation, a save made private, a declaration of
  loss that changes my sharing key), the photo is re-sealed under a new key and its old files are no longer
  listed and are deleted after the publication (spec "Direct recipient": "a photo key … is renewed too"). To tell
  "readers added" from "a reader removed", each `u:` record names the recipient set its key was given to and my
  manifest keeps those sets (`aud`: fingerprint → keys), so every device of mine decides alike. A device that
  never opened the photo fetches it with the old key to re-seal it. If it cannot (no local copy, and the pull saw
  a rollback or a fork, so there is no index to fetch through; or the files are gone), the photo is **dropped**
  from my document (`report.own.photos.dropped`; review photos F-07, product decision: privacy wins over keeping
  the photo): every device and friend then forgets it as if it had never been added (no row, no cache entry, no
  tile, nothing retried). A photo never uploaded and not on this device waits for the device that has it.
- **Friends**: a read projects the references into `media` (key and file hashes; `Repository.setForeignMedia`) and
  fetches the **thumbnails of new photos** in the same pass (`thumbPrefetchBytes`, 8 MiB per pass, a failed file
  counted at `thumbBytes`); the **full photo** is downloaded by `photos.full(id)` only (the app calls it when the
  photo is opened). A friend's photo is stored under `foreignMediaId(saveId, id)`, and its images in the cache
  under `friendCacheId(owner, hash)` (review photos F-08), so their ids never meet mine or another friend's; a
  friend's cache entry never replaces one of mine. Every file is downloaded with a bound that allows for its padding (`mediaFileBytes`), opened
  only if the friend's verified index (kept by the reader, `indexFor`) lists it and it was served at its own path,
  and its image checked before it is cached or shown (`checkImage`: the format its reference names, and the pixel
  bounds above, against decompression bombs). What's new: `whatsNew.photos` (new photos on a place already there; the change is `meaningful`).
- **Cache**: friends' images are evicted beyond `friendsCacheBytes` (default 500 MiB; `photos.setFriendsCacheBytes`):
  full photos first, least recently used first, then thumbnails; their places are never evicted. A photo that
  leaves my cache (removed, access lost, friend removed) leaves the image cache at once (`photos.prune`). My own
  images are never evicted.
- **Losing access** (what a friend's app does with my photos): when its read of my index finds that it can no
  longer open a save (I removed them, restricted or made the save private, revoked their invitation, or deleted
  all my content: the signed "content deleted" marker lists nothing for anyone), the save and its photo rows go,
  and every thumbnail and full photo of mine leaves its cache in the same pass (`photos.prune`). Removing or
  unfollowing a contact on their side also erases every image of that owner (`photos.forget`). Images live only
  in the database (`media_cache`); no image file is written to disk. This relies on the friend's app: a modified
  app can keep what it already downloaded (THREATS).
- **Quota full**: an upload refused with 507/413 makes the photos wait (`report.own.photos.waiting`), the text is
  published anyway, and the pass reports a `quota` problem; the next pass tries again.
- **My devices**: a pull that meets photo files another device uploaded keeps them (still encrypted) until my
  document gives their keys, then stores the images, so each device downloads each photo once; `photos.syncOwn`
  (each pass, `ownPhotoPassBytes`) fetches the rest. `spaceUsed().photos` counts them on the storage.

## Lists: friends, link-only, public (T-211, T-212)

`lists.ts`, `list-packs.ts`, `followed.ts`. A list (data package: `visibility` link / public, `linkKey`) leaves my
devices in three ways:

- **Friends with access** ("they see some of my lists", or a contact who sees everything and was picked in the
  list's share sheet: `ContactPolicy.lists`, set by `setListAccess`, kept in the vault like the other switches): one
  lists pack per set of viewers with the definitions. Restricted contacts already receive the places of their lists
  (`computeAudiences`); friends only learn the membership of places they can read. A friend's reader keeps them
  (`reader.friendLists(owner)`). The picks only count while the contact sees everything: a restricted contact sees
  exactly the lists of the restriction (`listsSeenBy`), and any change of `share` drops the picks, so they never come
  back after true → some lists → true (review M-01). As a second barrier, each friends' lists pack only names the
  places that every one of its viewers can read according to the places packs' audiences.
- **Link-only**: the list's own random X25519 key pair, whose 32-byte secret is `ListRecord.linkKey` (base64url, in
  my Yjs document, so all my devices publish the same packs). The list pack (definition and places, public comments
  only: a link can be forwarded) is sealed with the frozen `sealPack` to my sharing key and the list's public key, a
  plain direct recipient (never a group: re-sealing really cuts it), and listed in my signed index. The link
  `https://triangulair.app/l#<b64url>` carries version, kind, my master key, the list secret and my read address
  (`encodeListLink`, about 170 characters for a typical address). Whoever holds it reads my index at that address
  (verified for that master key; a signed redirect is followed once, only to the address it certifies; then never
  older than the last index accepted for this list), tries my `packs/` with the list key only, and checks every pack
  against the verified index (`openPack`). **New link** = a new key in `linkKey`: the next publication seals the pack
  to the new key (new batch key, new file) and deletes the old file; an old link opens nothing ("This link no longer
  works"). Taking the link away (`linkKey: null`, or switching to public) does the same; leaving link-only clears
  `linkKey` (data package `updateList`), so going back needs "Create the link" (a new key) and the old link stays
  dead (review L-01). **Deleting** the list
  publishes a tombstone sealed to its last key, kept 180 days (also after the list leaves the trash, by every device
  that sees the tombstone in the index, and across a rotation of my sharing key: review L-04): "This list no longer exists".
- **Public**: `public/lists.geojson` (above). A public list can also be followed by link (`kind: public`, the list id
  instead of a key): the file is checked against the hash in the verified index, filtered by list id.

**Why the key never reaches a server**: the fragment (after `#`) is not part of an HTTP request (RFC 3986 §3.5,
RFC 9110 §7.1): the `triangulair.app` site gets `/l` only when the app is missing, and a phone with the app hands the
whole URL to it without a request. The reader then contacts only my storage (index, packs), never with the link. What
must hold: the site never sends `location.hash` anywhere (the app's web export reads it on its `/l` route, by design,
and removes it from the address bar at once), links are
never logged. The link stays forwardable until renewed (spec threat model, "Holder of a list link").

**Following** (`followList`, no account, no request, no consent): the list is read first and recorded only when
that read worked (a failed or gone read leaves nothing, review L-05); the followed list is kept in my vault
(`app.triangulair_sync.lists`, per list, latest change wins, `removed` tombstones), so all my devices follow it. An
unfollowed list keeps only `{ at, removed }`, never its link (the list key), and the entry is dropped 180 days later;
at most `MAX_FOLLOWED_LISTS` (200) lists are followed (`TooManyFollowedListsError`; review L-02). Its
places go to my cache as foreign saves whose owner is the followed-list id (`list:` + 22 characters of BLAKE2b over
author, address and key): they show like friends' places, never mix with the author's own cache if I also follow
them, feed What's new (`SyncReport.lists[].whatsNew`), and leave when the list is unfollowed or gone. Each pass reads
the followed lists after the friends (one HEAD when nothing changed; packs already seen are not downloaded again;
smaller byte limits than a friend: `listPackBytes` 1 MiB per file tried, a bigger one is skipped; `listReadBytes`
8 MiB per list per read, `listPreviewBytes` 4 MiB for a preview; friends and followed lists share one `passBytes`
budget per pass; review L-07). The author does not learn who follows; their host sees readers' IP addresses.

## Limits

Every download is bounded before its hash is checked, decompression is bounded per kind, and friends' reads are
bounded in total (`SyncLimits`, `limits` option of the engine; review R-06):

| Limit | Default |
| --- | --- |
| `indexBytes` (mine or a friend's) | 4 MiB |
| `packBytes` (a places pack) | 8 MiB |
| `ownFileBytes` (own document, manifest under `media/`) | 96 MiB |
| `placesPayloadBytes` / `manifestPayloadBytes` / `ownDocPayloadBytes` (decompressed) | 4 MiB / 1 MiB / 64 MiB |
| `friendReadBytes` (downloaded + decompressed, one friend, one read) | 32 MiB (`too-large`, not retried) |
| `passBytes` (same, every friend of one pass) | 128 MiB (`too-large`, the rest is read next pass) |
| `photoBytes` / `thumbBytes` (an image added; a photo or thumbnail file downloaded) | 1.5 MiB / 128 KiB (the format caps) |
| `thumbPrefetchBytes` (friends' new thumbnails fetched with their places, one pass) | 8 MiB |
| `ownPhotoPassBytes` (my photos one of my devices fetches in one pass) | 64 MiB |

Pack downloads and decryptions share `concurrency` (default 6) slots across all the friends read at once
(`friendConcurrency`, default 8, index checks).

## Reading friends

One HEAD per friend when nothing changed (a full GET every 10 minutes anyway: coarse ETags); the index is verified
at the address it was read from, against the anchor kept in the vault (rollback, fork, jump; a master-signed
redirect is followed once, only to the certified address; a newer rotation is accepted and reported as
`keyChanged`, and the contact's certificate is updated so my next publication wraps to their new key). Only packs
never seen are downloaded; packs none of my keys opens are remembered (until my keys change). A pack is accepted only at
its own path (the host cannot serve another listed pack there). The readable set is
the union of the packs I can open: anything no longer in it (deleted, made private, my access removed) is removed
from the cache, with the places its data created. Everything is projected in one transaction, and only if every
needed pack was fetched and verified: otherwise the last valid content stays. The difference feeds What's new
(`meaningful`: a new comment, or a switch to tried / favorite; the rest is a minor touch-up).

## My devices, declaration of loss, identity moves (T-206, T-207)

- **Device list** (`devices.ts`, vault `app.triangulair_devices`, version 2): per device id, its full
  **master-signed device certificate**, a removal date (display only) and display entries (name, date added,
  primary mark), **one signed slot per signer** (`sign.ts`: Ed25519, prefix `TrianguLair-app-signature-v1`, domain
  `vault-device-info`; a stolen device can only write its own slot). Security decisions use only what a thief
  cannot forge (review F-02):
  - which devices exist: the certificates that verify for my owner id (merged as a union; one that does not verify
    never replaces one that does);
  - which are removed: the current sharing certificate's `revoked_devices` (`removed` is set for those only);
  - display entries count only from a valid signer (my master key, or a certified device the current certificate
    does not revoke); the primary mark only from the device's own slot.
- **App values** (vault `app.triangulair_values`, version 2): small named values (the app keeps its storage
  settings and my first name there for a new device), one signed slot per signer (domain `vault-value`). The
  visible value is the newest slot of a valid signer (review F-01). Times more than `MAX_SKEW_MS` (10 min) ahead are
  refused when merging and reading; a new value is stamped after every valid one seen (a later change by the user
  wins), never past `MAX_SAFE_INTEGER`. Unsigned version 1 values are dropped.
- Engine: `devices()`, `putDevice`, `updateDevice`, `value`, `setValue` (all signed by this device, judged against
  the current certificate); `mergeBooks(a, b, { revoked, now })`. `now` also bounds the unsigned followed-list and
  publish-preference entries of `app.triangulair_sync` (refused when more than `MAX_SKEW_MS` ahead).
- **Key delivery**: before each publication the engine seals the current sharing key to every listed device that does
  not have it yet (`keys/<device>.bin`, marker per device in the state).
- **`rotateKey(newKey, { cancelInvitations, recoveryCopy })`**: adopts a rotation made on this device with the master
  key (declaration of loss, a removed device), cancels every open invitation (`cancelAllInvitations`, V4-02), seals the
  key to the remaining certified devices it does not revoke, deletes the lost device's `keys/` file, drops every
  slot the lost device signed, resets the app values to this device's (`values`), and writes the
  phrase-protected copy (TLSK mode 2) at `keys/<owner id>.bin` (restore with the 12 words). Then `sync()` re-encrypts
  and publishes; the lost device finds itself in `revoked_devices` at its next pass and wipes (existing remote wipe).
- **Identity move**: engine option `move` (written in every index, R-11). A friend whose index carries a valid move from
  the identity I follow (`FriendReport.identityMove`) is followed: the old identity is retired, the contact continues
  under the new one with the same switches and `verified: false`, their cache is read again (`followed: true`).
- `SyncReport.pulled` (the pull that starts the pass) and `PullResult.importedFrom` (the device that signed the index
  whose own-document changes were imported), for the app's "changes since the theft".
- Storage layout additions: `keys/<owner id>.bin` (recovery copy), and the app's `transfer/<slot>.*` files (adding a
  device, at most 15 minutes, see the app README).
- Tests: `test/devices.test.ts` (list merge and forged entries, signed values, declaration with invitations
  cancelled, key delivered, lost device wiped, friend told; delivery to a device added later; following an identity
  move); `test/review-devices.test.ts` (the devices review's F-01 and F-02 reproductions).

## Error cases (spec table) → `SyncProblem`

| Situation | Kind | Behavior |
| --- | --- | --- |
| No network | `offline` | nothing attempted, changes counted as pending, a pass when back online |
| My storage unreachable | `unreachable` | retried with backoff (30 s … 30 min) while in use; `banner` after 24 h |
| Credentials rejected | `auth` | `blocked`: writes stop (queue kept) until `resume()`; friends are still refreshed on launch, foreground and pull to refresh (`publish: false`) |
| Quota full (507/413) | `quota` | retried, nothing lost; photos wait and the text is published (`report.own.photos`); `OwnSync.spaceUsed()` gives the bytes by content type for the app's suggestions |
| Interrupted write | — | packs first, index last; the packs of an attempt are recorded as garbage before they are written (deleted later if the index never lists them); a listed pack found missing (checked by listing at the first pull and every full check) is rewritten from local state |
| Two of my devices write at the same time | `conflict` | If-Match + read-back, pull, merge, republish |
| A friend's storage unreachable | `unreachable` | their cache stays; `lastSuccess(owner)` for "Updated 12 days ago" |
| A friend changes storage | (`movedTo`) | redirect followed to the certified address only |
| Tampered content | `tampered` / `rollback` | rejected, last valid version kept |
| Unsupported format version | `unsupported` | content ignored, "Update the app to see Léa's places" |
| Key missing (newer rotation, no key for me) | `needs-key` | blocks writes: request for the recovery kit |
| Device declared lost | `device-revoked` | the pass stops at once; the engine erases keys (`wipe.secrets`), sync state and database; `state: 'wiped'`, nothing runs again |
| A file over a size limit | `too-large` | refused before verification; cache kept (a pass limit is retried next pass) |
| Any non-retryable problem of mine (`retryable: false`) | `tampered`, `unsupported`, `bug` | shown, retried at the next foreground, not in a loop |

| An invitation record that can never be listed (invalid, by a revoked device, expired past the 7-day grace) | — | dropped from the vault before each publication (`ContactBook.sweepInvitations`, `SyncReport.invitationsDropped`); `not-yet` and superseded records are kept |

Every row of the spec's table, with the app's side (messages, the 3-month offer, keys missing), is mapped to its code and tests in [`docs/error-cases.md`](../../docs/error-cases.md); `test/error-cases.test.ts` has one test per row.

## Tests

- `scenarios.test.ts` (in-memory storage, real SQLite): owner publishes and friend reads (private places never
  leave, comment visibility, tags with colors, one pin); edits and What's new (meaningful or not, trash and
  private remove); revocation (re-encrypted packs, old files deleted, other friends unaffected); a friend limited
  to one list; removing a friend; two own devices converging (concurrent edits on one save, a deletion, contacts
  through the vault, nothing republished when idle); own-document compaction.
- `adversarial.test.ts`: concurrent publishers on an atomic and on a **non-atomic** server (both changes land, a
  fresh device restores everything, no listed file missing); a lost race retried after merging; **coarse ETags**
  (a same-ETag change is caught by the periodic full read); **rollback** of the index refused by friends and
  repaired by the owner; modified packs and a forged index rejected with the cache kept; packs re-listed in
  someone else's signed index do not open; **key rotation** (re-encryption of everything, adoption by my other
  device from `keys/`, friend told and switching to the new key); a device without the new key stops
  (`needs-key`); a revoked device (`device-revoked`); an invitee reading with the invitation key; incremental
  publication of 1,000 places; listed packs deleted from the storage are rewritten; public lists file (verified through the index, ODbL, removed with the last public list).
- `lists.test.ts` (T-211/T-212): list links (round trip, refusals), the public file address and the uMap link; a
  link-only list previewed and followed without being a contact (public comments only, never a private place, What's
  new on updates, unfollow); **"new link" cuts the old holder** ("This link no longer works", old files deleted, the
  new link works, removing the link too); deletion gives "This list no longer exists", also after the trash is
  purged on another device (tombstone kept); nothing re-sealed when idle, another device keeps the same packs; a link
  naming another storage or a list pack re-listed in someone else's index is refused; a friend who sees everything
  sees no list name until picked; **a friend with "some lists" sees only those** (definitions and places), renames
  reach them, removing access removes both, access settings travel through the vault; the **public file** is valid
  GeoJSON with ODbL attribution, uMap styles and OSM links, and a public list is followed by link and goes away when
  deleted; followed lists shared between my devices through the vault; my own list cannot be followed.
- `error-cases.test.ts` (T-213): one test per row of the spec's "Error cases" table, on real engines with injected storage faults (network down, 401, 507, a write cut before the index, altered files, a newer format, a storage move, invitation records, a missing key).
- `photos.test.ts` (T-111b): owner adds a photo (metadata removed, nothing in clear on the storage, padded files),
  friend gets the thumbnail with the places and the full photo when opening it; "new photo" in What's new; a
  private save's photo reaches my other device only; refusals; removal deletes the files and the friend's copy;
  a friend whose access is removed cannot fetch the photo (old files deleted) while the others get it under a new
  key, and adding a friend uploads nothing; a save made private renews the key from a device that never opened it;
  quota full (text first, photo later); cache eviction (full photos first, LRU) and the SQLite cache; JPEG/WebP
  metadata removal, AVIF detection, strict references. Review (docs/reviews/photos.md): a friend
  reusing photo ids, broken thumbnails within the pass budget, decompression bombs, a photo near the byte cap, MPF
  and trailing data, metadata between progressive scans, unknown WebP chunks, header sizes, the trash (restore,
  renewal on restore, delete forever). Decisions: the caps (and a friend's oversized files refused), F-07 (a
  renewal through a rolled-back index drops the photo on every device and friend, once), F-08 (a friend naming
  my file hashes), friends' cache ids by owner, and a friend who loses access (removed, content deleted, save
  made private) purging every image of mine.
- `no-wasm.test.ts`: fflate and the sources use no WebAssembly (the package also depends on the crypto package's
  `libsodium-wrappers-sumo`, for the list key's public half; asm.js where WebAssembly is missing).
- `units.test.ts`: planner, payload (decompression bomb), strict places parsing, vault policy merge, state
  stores, the error table, the scheduler with fake timers (launch, interval, debounce, close then no timer,
  offline queue, backoff, banner, blocked and resume).
- `review.test.ts`: the reproductions of the independent review (R-01 to R-07), now normal tests.
- `fixes.test.ts`: the behaviour added by the review fixes (restored device and an old-rotation index, the vault
  anchor, OSM-synced rows, swapped and malformed own packs, the remote wipe and its hooks, size limits per file,
  per friend and per pass, shared concurrency, coarse-ETag races, vault order and previous vault keys, scheduler
  read-only passes and non-retryable problems, strict strings and dates, the padding floor, the injected clock).
- `review-lists.test.ts`: the shared-lists review (docs/reviews/2026-11-10-lists-review.md), its reproductions now
  normal tests, plus the fixes' behaviour: stale picks and the per-viewer membership filter (M-01), home-like places
  held by a public filter list (M-02), the dead link after public and back (L-01), the vault without unfollowed links,
  the 180-day pruning and the 200-list cap (L-02), day-rounded dates and the tag-name opt-in shared by my devices
  (L-03), tombstones across a rotation (L-04), follow only after a first read (L-05), the list bounds and the shared
  pass budget (L-07).
- `real-servers.test.ts` (`TL_REAL_SERVERS=1`): the main scenarios, rollback and rotation, and the review fixes
  (a race under an unchanged ETag, a declared-lost device's injection) on **Apache mod_dav** (friends over its
  public HTTP folder), **WsgiDAV** (coarse ETags, emulated conditions), **moto S3** and **OpenSSH sftp**: 12/12
  pass (2026-11-07, after the review fixes). The storage package's conformance suite, including the
  `index.v<N>.json` and `maxBytes` cases, passes 76/76 on the same servers.

## Measurements

(Measured before the review fixes; the 4 KiB payload floor adds at most a few KB per small file. The performance
suite still passes after them.) `npm run test:perf` with `TL_REAL_SERVERS=1`, 2 vCPU Xeon 2.1 GHz container, Node 22, 2026-11-07. Dataset like the
data package's (60 % in Paris, 20 tags, 30 % with a comment, 10 % private, 5 % in the trash), one friend. "Publish
to a friend" is the publication after adding the friend (every places pack sealed for the new recipient set);
"new own device" restores my whole document from the storage alone.

| Storage | Places (shared) | Places packs | Index | Places JSON raw → deflated | Yjs document raw → deflated | Publish to a friend | Friend's first read (downloaded) | Friend, unchanged | Edit one place: publish | Friend reads the edit | New own device |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| memory | 1,000 (846) | 5 files, 46 KB | 2 KB | 351 → 40 KB | 374 → 69 KB | 58 ms | 235 ms (46 KB) | 12 ms | 123 ms (3 files, 16 KB) | 37 ms (2 packs) | 0.34 s |
| memory | 10,000 (8,547) | 43 files, 235 KB | 7 KB | 3,556 → 396 KB | 3,781 → 662 KB | 0.35 s | 0.93 s (235 KB) | 41 ms | 0.19 s (3 files, 29 KB) | 74 ms (2 packs) | 2.28 s |
| Apache WebDAV | 1,000 (846) | 5 files, 46 KB | 2 KB | 351 → 40 KB | 374 → 69 KB | 0.28 s | 0.20 s (46 KB) | 25 ms | 83 ms (3 files, 24 KB) | 37 ms (2 packs) | 0.53 s |
| Apache WebDAV | 10,000 (8,547) | 43 files, 234 KB | 7 KB | 3,556 → 395 KB | 3,793 → 662 KB | 0.57 s | 1.00 s (234 KB) | 121 ms | 0.28 s (3 files, 29 KB) | 145 ms (2 packs) | 3.03 s |

- About 28 bytes per shared place on the storage at 10,000 (Z-order packs compress well), far under the spec's
  "under 1 MB for 1,000 places"; compression divides the places JSON by about 9 and the Yjs document by about 6.
- Spec targets: first read of a friend with 1,000 places under 10 s (0.2 s here, plus network); 1,000 places
  decrypted under 1 s. On a real Nextcloud (~0.4 s per request, T-204 note) a friend's first read of 10,000 places
  is 1 HEAD + 1 GET + 43 GETs at 6 in parallel, about 3–4 s; an unchanged friend costs one HEAD, so 50 friends at 8
  in parallel stay under the 5 s target. Not measured against a real Nextcloud yet (acceptance criterion open).
- Before moving my document to `media/`, a friend downloaded 910 KB at 10,000 places, three quarters of it my own
  (unreadable to them) Yjs document.

## Open questions

1. **Own document in `media/`**: photos now share `media/` with my document (same envelope, 2 wraps, padding), but
   sizes still differ (a document is usually bigger than a photo and changes in deltas). A device of mine classifies
   an unknown media file by downloading it once; for photos that download is kept (own devices sync photos), so
   it costs nothing extra, but a device restored from the recovery kit downloads every photo at its first pull.
2. **More than 255 recipients** in one pack (MAX_WRAPS = 256 with my own key): `TooManyRecipientsError` for now;
   crypto groups (a group key in a group-key pack) would lift it, at the cost of re-keying the group on removal.
3. **Friends' lists** (answered by T-211/T-212): a friend sees a list's name and membership only when given access
   to it (restricted to it, or picked for it); seeing everything I share with friends does not reveal my list names.
   Open: should a friend with access also get the list's link (so they can forward it)? Not done: no list key is
   reachable from friends' content, so retiring an invitation never needs to renew one.
4. **Version negotiation**: the index advertises `reads: ["4"]`; the places payload has its own version (1).
   Choosing the newest version every recipient reads (spec) needs the readers' `reads` to cover payload versions.
5. **Refresh period** while the app is open (spec open question): 5 minutes by default here.
6. **Public file in place**: `public/lists.geojson` keeps a stable name (uMap), so between its upload and the index
   commit a reader may see a hash mismatch (`verifyPublicFile`); it resolves at the next read.
7. **Forks seen by friends**: on a server without atomic compare-and-swap, two of my devices can briefly both
   publish the same `seq`; a friend who saw the first reports a fork on the second, then accepts the next
   (republished) one. The index format cannot avoid it without an atomic server.
8. **Unlisted files**: files left by a device that crashed between upload and index are only deleted by that
   device; a sweep needs file dates (not in the adapter interface).
9. **HTTP Range** on pack headers would let a friend learn that a pack is not for them without downloading it.
   Followers of a link-only list download every `packs/` file once (then only new ones) to find theirs.
10. **Comments in link-only lists**: only public comments travel with a link (like a public list), since the link
    can be forwarded to anyone. Should "friends" comments be shown to link holders?
11. **Author name** in link-only lists is the one given to `author` (my first name): devices with different names
    rewrite the list pack in turn. The public file has the same rule.
12. **uMap**: the query-string import is a copy, not uMap's "remote data" layer that follows file changes; a uMap
    map made by the author with the file as remote data (dynamic) does follow it.
13. **Photo key renewal cost**: removing a reader re-uploads every photo that reader could open (an accepted
    invitation re-seals every shared photo, as the spec asks for content opened to an invitation). Adding readers
    costs nothing.
14. **Thumbnails with the pack**: thumbnails are separate files fetched right after the places (new photos only,
    bounded per pass), not inlined in the places pack: a pack is rewritten on every edit of one of its places, and
    200 places with photos would make it megabytes.
