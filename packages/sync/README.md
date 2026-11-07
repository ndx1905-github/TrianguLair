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

No UI here, and the app is not wired yet.

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
});
const scheduler = new SyncScheduler({ run: () => engine.sync(), onReport, onStatus });
scheduler.appForeground('launch');   // AppState "active"
scheduler.localChange();             // after each edit (debounced publish)
scheduler.pullToRefresh();
scheduler.setOnline(netInfo.isConnected);
await scheduler.appBackground();     // AppState "background": last pass, then no timer at all
```

| Export | Role |
| --- | --- |
| `SyncEngine` | `sync()` (one pass: pull my storage, read the people I follow, publish what changed; concurrent calls share the pass), `addContact(verifiedIndex, { share, follow, verified })`, `setPolicy(owner, { share, follow })`, `removeContact(owner)`, `addInvitation(invitation)`, `contacts()`, `keys()`; `own` (`OwnSync`), `reader` (`FriendReader`), `book` (`ContactBook`) |
| `OwnSync` | `pull()` (my index, my other devices' document changes, a new sharing key from `keys/`, the vault), `publish({ force? })`, `rotate(newSharingKey, otherDeviceCerts)` (primary device), `pushVault()`, `index` |
| `FriendReader` | `read({ owner, location, anchor?, extraKeys?, retiredOwners? })` → `FriendReport { status, whatsNew: { added, changed: [{ placeId, meaningful, fields }], removed }, index, keyChanged, movedTo, problem, downloaded }`, `readAll`, `forget(owner)`, `lastSuccess(owner)` |
| `SyncScheduler` | `appForeground`, `appBackground`, `localChange`, `pullToRefresh`, `setOnline`, `resume`, `getStatus()` → `{ state: idle / syncing / offline / blocked / background, pending, lastSuccess, failingSince, problem, banner }` |
| `ContactBook`, `mergeBooks` | contacts and their switches in the recovery vault |
| `classifyError(e, 'own' / 'friend', online)` | → `SyncProblem { kind, retryable, blocksWrites, situation, message, detail }` (table below) |
| `planPacks`, `computeAudiences`, `featureFor`, `parsePlaces`, `encodePayload` / `decodePayload`, `buildPublicLists` | the pure parts, exported for tests and tools |
| `MemoryStateStore`, `SqliteStateStore` | local state (ETags, anchors, pack caches, the local vault copy) |

Added to `@triangulair/data` for this task: `DataStore.snapshot()`, `isAt(snapshot)`, `exportSince(snapshot)`
and `snapshotOfUpdates(updates)` (Yjs state vector **and** delete set: a pure deletion, such as a trash purge,
adds no struct and would be invisible to a state-vector comparison). In `@triangulair/storage` (T-202
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
| `media/b2b256-<hash>.bin` | **my Yjs document** (one full snapshot + up to 8 deltas, then a new snapshot) and a **manifest** (logical pack id → recipient-set fingerprint), sealed to my key only; photos later | my devices; friends fetch `media/` only on demand (photos), so never these |
| `public/lists.geojson` | public lists in plaintext, ODbL attribution, listed in the index with its hash | anyone, uMap |
| `vault.bin` | recovery vault (`TLVD`), written with `If-Match`, merged on conflict | my devices |
| `keys/<device id>.bin` | the current sharing key sealed to each of my other devices (`TLSK`), written by `rotate` | that device |

Packs are written first (in parallel, `If-None-Match: *`), then the public file, then the index (`If-Match` of the
index the pass started from, `If-None-Match: *` on the first publication). The index is then **read back**:
compare-and-swap is best effort on several servers (T-202: Apache with weak ETags, WsgiDAV, Nextcloud with coarse
ETags, emulated conditions on SFTP), so a publication counts only if the storage now holds exactly our bytes;
otherwise the pass pulls again (merging the other device's document), and republishes (up to 5 attempts). A lost
race that went unnoticed (both devices read back their own index, then one overwrote the other) is healed at the
next pass: the remote document snapshot is always recomputed from the own-document files actually listed, and the
places packs from the actual listing. Files that a publication superseded, and the files of our lost attempts, are
deleted only after a successful publication; other unlisted files are left alone (they may be another device's
upload in progress).

Incremental publication: only packs whose content changed are rewritten; a new place goes into the least filled
pack of its group; two packs below a quarter of the capacity in a group are merged; when exactly one existing pack
would be replaced, one unchanged pack is rewritten too (spec: "blurs by grouping replacements"). Editing one place
of 10,000 uploads 3 files (29 KB): its pack, one blurred pack and the document delta.

Own devices: each pass imports the own-document files it has not seen (Yjs updates commute) and compares the local
document with the snapshot of what the storage holds (`isAt`); if it differs, it publishes a delta
(`exportSince`) or, every 8 deltas (or when the deltas outweigh the base), a full snapshot that replaces them.

## Payloads (inside the pack encryption)

```
"TLSY" | version u8 = 1 | kind u8 (1 places, 2 own document, 3 manifest) | codec u8 (0 stored, 1 raw DEFLATE) | body
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
  ids that are not place ids, invalid or oversized geometries (20,000 positions), more than 5,000 features, 32 tags,
  over-long strings; decompression stops at 64 MiB. Version 2 would be refused ("Update the app").
- Own document (kind 2): `mode u8 (1 full, 2 delta) | Yjs update v1`. Manifest (kind 3):
  `{"kind":"manifest","packs":{"<logical id>":"<recipient fingerprint>"},"version":1}`. Both only for my key.
- Public lists file: a FeatureCollection with `attribution` (ODbL notice), `license`, `triangulair: { kind:
  "public-lists", version, owner, author?, lists: [{ id, name, description?, updated }] }`, one feature per (list,
  place) with `list`, `list_name`, `description` (the public comment) and `_umap_options.color` (main tag color).

## Reading friends

One HEAD per friend when nothing changed (a full GET every 10 minutes anyway: coarse ETags); the index is verified
at the address it was read from, against the anchor kept in the vault (rollback, fork, jump; a master-signed
redirect is followed once, only to the certified address; a newer rotation is accepted and reported as
`keyChanged`, and the contact's certificate is updated so my next publication wraps to their new key). Only packs
never seen are downloaded; packs none of my keys opens are remembered (until my keys change). The readable set is
the union of the packs I can open: anything no longer in it (deleted, made private, my access removed) is removed
from the cache, with the places its data created. Everything is projected in one transaction, and only if every
needed pack was fetched and verified: otherwise the last valid content stays. The difference feeds What's new
(`meaningful`: a new comment, or a switch to tried / favorite; the rest is a minor touch-up).

## Error cases (spec table) → `SyncProblem`

| Situation | Kind | Behavior |
| --- | --- | --- |
| No network | `offline` | nothing attempted, changes counted as pending, a pass when back online |
| My storage unreachable | `unreachable` | retried with backoff (30 s … 30 min) while in use; `banner` after 24 h |
| Credentials rejected | `auth` | `blocked`: automatic passes stop (queue kept) until `resume()` |
| Quota full (507/413) | `quota` | retried; the app shows space used (photos are not synced yet) |
| Interrupted write | — | packs first, index last; a listed pack found missing (checked by listing at the first pull and every full check) is rewritten from local state |
| Two of my devices write at the same time | `conflict` | If-Match + read-back, pull, merge, republish |
| A friend's storage unreachable | `unreachable` | their cache stays; `lastSuccess(owner)` for "Updated 12 days ago" |
| A friend changes storage | (`movedTo`) | redirect followed to the certified address only |
| Tampered content | `tampered` / `rollback` | rejected, last valid version kept |
| Unsupported format version | `unsupported` | content ignored, "Update the app to see Léa's places" |
| Key missing (newer rotation, no key for me) | `needs-key` | blocks writes: request for the recovery kit |
| Device declared lost | `device-revoked` | blocks; the app erases keys and content (remote wipe) |

T-213 will add the remaining rows (invitation links, 3-month cleanup offer, vault records) and the UI.

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
- `no-wasm.test.ts`: fflate and the sources use no WebAssembly.
- `units.test.ts`: planner, payload (decompression bomb), strict places parsing, vault policy merge, state
  stores, the error table, the scheduler with fake timers (launch, interval, debounce, close then no timer,
  offline queue, backoff, banner, blocked and resume).
- `real-servers.test.ts` (`TL_REAL_SERVERS=1`): the main scenarios, rollback and rotation on **Apache mod_dav**
  (friends over its public HTTP folder), **WsgiDAV** (coarse ETags, emulated conditions), **moto S3** and
  **OpenSSH sftp**: 8/8 pass (2026-11-07). The storage package's conformance suite, including the new
  `index.v<N>.json` case, passes 72/72 on the same servers.

## Measurements

`npm run test:perf` with `TL_REAL_SERVERS=1`, 2 vCPU Xeon 2.1 GHz container, Node 22, 2026-11-07. Dataset like the
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

1. **Own document in `media/`**: friends never download it, but a host sees which file is my document once photos
   are not there to hide it (its size reveals the size of my whole collection, private places included, within
   Padmé's 12 %). Photos (T-111 storage part) must be referenced from the places packs, and my devices must not
   download every photo to classify `media/` files (keep photo hashes known from the Yjs media records).
2. **More than 255 recipients** in one pack (MAX_WRAPS = 256 with my own key): `TooManyRecipientsError` for now;
   crypto groups (a group key in a group-key pack) would lift it, at the cost of re-keying the group on removal.
3. **Friends' lists**: lists shared with friends (and link-only lists, T-212) are not in the packs yet; only the
   public file. Should a friend see my list names, and which ones?
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
