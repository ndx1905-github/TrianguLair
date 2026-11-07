# Review of the sync package (T-204, PR #71)

- **Date:** 2026-11-07
- **Reviewer:** independent agent. I did not write T-204 or any of the packages it builds on.
- **Scope:** branch `t-204-sync` at `b2746c9` (`git diff origin/main...HEAD`): all of `packages/sync/src`, `README.md`,
  `THREATS.md` and `test/`; the additions to `packages/data` (`snapshot`, `isAt`, `exportSince`, `snapshotOfUpdates`)
  and `packages/storage` (`indexPath`, `fetchHighestIndex`, `newerIndexes`); `packages/crypto/README.md` and
  `THREATS.md`; `docs/SPEC.md` sections "Encrypted sharing", "Organization on the storage", "Asymmetric relationships",
  "Format versions", "What we accept to lose", "Editing and deleting", "Loss and theft", "Error cases",
  "Synchronization and background", "Data model", "Privacy, security, moderation" and "Threat model".
- **Method:** line-by-line reading, then attacks for each adversary in the spec's threat model: storage host, followed
  friend, thief of a device (before and after the declaration, with the storage credentials it still has), and my own
  devices racing on lax servers. Every finding marked *(test)* is reproduced in `packages/sync/test/review.test.ts` as an
  `it.fails(...)` test that states the **desired** behaviour. I ran each one as a plain `it` to check that it fails at
  the intended assertion and not earlier. `src/` was not modified.
- **Build:** `npm install --workspaces=false` in crypto, storage, data (`npm_config_nodedir=/opt/node22`) and sync.
  `npm test` in `packages/sync`: 5 files passed, 1 skipped (real servers), 37 tests passed, 7 expected failures (the
  reproductions below). `npm run typecheck` is clean. I did not run the real-server suite.

## Verdict: **merge after fixes**

The design holds up well. Audiences are computed in one place, private saves and private comments never reach
`featureFor(…, 'friends')`, and the public file only takes comments marked public. The manifest keeps recipient-set
fingerprints out of every pack a friend can open. Every pack is opened only through `openPack` with an index returned
by `verifyIndex({ expectedOwner })` or `signIndex`, so the crypto gates are not bypassed. Friends' indexes are anchored
in the vault, and the friend cache is projected in one transaction. The read-back after the conditional write is the
right answer to the T-202 servers. The scheduler leaves no timer after `appBackground()`. The tests are good, and so
are the simulations with non-atomic servers and coarse ETags.

Two problems should be fixed before this is wired into the app. Both break the integrity of **my own** data, which
the crypto layer otherwise protects well:

1. **R-01:** when my own index has been rolled back, the code still imports what that index lists. So a device
   declared lost, which still has the storage credentials (spec step 4 comes after the declaration), can inject any
   Yjs update into all my devices. Through those updates it can make my legitimate devices publish my private places
   to my friends, or in plaintext in a public list.
2. **R-02:** a friend's feature overwrites the shared `places` row of a place I saved too. `readOwnItems` publishes
   from that row, so the friend's name or geometry goes out in **my** packs and **my** public file.

Three medium findings should be fixed in the same round, because the fixes are small:

- R-03: a pack served at the path of another listed pack is accepted.
- R-05: reading friends continues after "device revoked".
- R-06: no size bounds before the hash check, and a 64 MiB inflate budget for each pack.

The THREATS reasoning on compression is mostly sound. Two corrections are needed (see "Compression before encryption").

| Severity | Count | Ids |
| --- | --- | --- |
| Critical | 0 | |
| High | 2 | R-01, R-02 |
| Medium | 4 | R-03, R-05, R-06, R-08 |
| Low | 8 | R-04, R-07, R-09 to R-14 |
| Note | 7 | N-1 to N-7 |

## High

### R-01 Own pull imports the content of a rolled-back (older-rotation) index: a declared-lost device can inject into my document *(test)*

`own.ts:216-226`: when `verifyIndex(text, { lastSeen: anchor })` throws `RollbackError`, the index is verified again
**without** the anchor. It is then used as the current index for everything that follows:

- its listed packs are fetched, opened with `this.keys()` and classified (`own.ts:239-268`);
- `own-doc` updates are imported into the store (`own.ts:270`);
- places and manifest info goes into `own:packs`.

The thief has three things: its own device key (revoked only by the **new** certificate), the **old** sharing
certificate and old vault data key, and the storage credentials, which stay valid until the user completes step 4.
With them it can sign an index of the old rotation, with any `seq`, that lists an own-document pack. That pack is
sealed to my **new** sharing public key, which is public because it is in my index (sealing needs no secret).
`verifyIndex` without `lastSeen` accepts this index, because the old certificate does not revoke the thief.
`index.revoked_devices` (`own.ts:228`) is the old list. `rotation < this.rot` is not checked. The update is merged
into my document, then republished by my device in a new index signed under the new certificate, so friends and my
other devices accept it.

The same import happens on a device with no anchor yet, for example a device just restored from the recovery kit:
any index of an older rotation than `this.sharing.cert` is taken at face value.

The impact goes beyond "the thief keeps what it had". In my document the thief can:

- flip private saves to `friends`, which leaks them to all my friends;
- create a public list over all my saves and mark comments public, which leaks them in plaintext through
  `public/lists.geojson`;
- delete or rewrite places.

All of this would then be signed by my legitimate devices. Repro:
`review R-01 … a device declared lost cannot inject own-document updates through an index of the old rotation`.

**Fix:**

- On `RollbackError` (rollback **or** fork), use the stale index only to decide to republish. Do not fetch, classify
  or import anything it lists, and do not use it as `prev` in `build()`: rebuild from the local state and the anchor.
  For a genuine fork between my own devices, the other device republishes its changes itself at its next pass (its
  document is not at the remote snapshot), so nothing is lost.
- Independently of the anchor, refuse an own index whose `sharing_cert.rotation < this.sharing.cert.rotation`, and
  check `index.device_cert` against `this.sharing.cert.revoked_devices` (the revocations I hold). This covers the
  no-anchor case.
- Consider opening own packs with the **current** key only, plus older keys only for packs listed in an index of the
  current rotation (`classify`).

### R-02 A friend's feature overwrites my own place row, and I republish it *(test)*

`reader.ts:269-271` calls `repo.upsertForeignSave(toForeignSave(owner, f))`, which calls `upsertPlaceSnapshot`
(`packages/data/src/sqlite/repository.ts:403-418`). That function overwrites `name`, `category`, `geom`, `lat/lon` and
the bbox of an existing row unless `osm_synced_at` is set, and overwrites `kind` and `edge` **unconditionally**. The
place row is shared between my save and friends' saves ("No duplicates"), and `readOwnItems` (`features.ts:125-157`)
builds my published features from that shared row (`p.name`, `p.geom`, `p.kind`, `p.edge`), not from my document.
So:

- a friend I follow who saves the same OSM id (or the same `local:` id: they learn my local ids from my own packs)
  with another name or geometry renames or moves **my** place in my own app;
- at my next publication that touches the pack, I send their name and geometry to all my other friends, in a pack
  signed by me, and to the world in my public list.

The owner projection rewrites the row only when my document touches that save, so the injected value can stay for a
long time. Repro: `review R-02 … the name and geometry I publish for my place come from my document`.

**Fix:**

- In the reader, never let a foreign snapshot overwrite a place row that has a save of mine (or any row that already
  exists). Insert only when missing, or keep per-owner snapshots.
- In `readOwnItems`, take name, category, kind, edge and geometry from my own document (the projected own save
  snapshot), not from the shared `places` row.
- Add a test with an OSM-synced row too: `kind` and `edge` are overwritten even then.

## Medium

### R-03 A listed pack served at another listed pack's path is accepted (friend cache erased; own side mis-classified) *(test)*

`openPack` checks that the downloaded bytes hash to **some** entry of the index and returns that entry's `file`
(`crypto/src/pack.ts:355-379`). The reader stores the result under the entry it asked for (`reader.ts:210-241`:
`st.packs[p.hash] = { items }`) without comparing `opened.file` with `p.file`. A storage host can therefore serve pack
B's bytes at pack A's path. The reader then believes A holds B's items. A's places drop out of the readable set and
are **deleted** from my cache, and the read is reported `updated`. The spec says tampered content is rejected and the
last valid version kept. On the owner side, `classify` (`own.ts:252-256, 290-312`) records B's info under A's hash.
The planner can then keep A as if it held B's items: friends lose those places until the next full rewrite. Repro:
`review R-03 … a pack served at another listed pack's path is rejected and the cache kept`.

**Fix:** after `openPack`, require `opened.file === p.file` (or compare `packHash(bytes)` with `p.hash` before opening)
in both `reader.ts` and `own.ts`, and throw a tampering error otherwise.

### R-05 Reading friends continues after "this device was declared lost" *(test)*

`engine.ts:154-175`: a failed own pull only sets `ownOk = false`. The friends step then still runs. A device that
has just read its own revocation goes on fetching and decrypting its friends' content into its database, with the old
sharing key, which friends keep wrapping to until they read the new certificate. The spec says that "at its next sync,
the stolen phone's app reads it, verifies the signature and erases its keys and all its local content", and that "the
app checks revocations before displaying anything". The engine never erases anything either. The README leaves that
to the app, but nothing in the API makes it hard to miss. Repro: `review R-05 … does not go on reading and caching
friends in the same pass`.

**Fix:**

- On `DeviceRevokedError`, stop the pass before step 2.
- Expose a single `engine.wipe()` (state store, friend caches, own store, sharing keys through a callback) and call it
  or require an `onRevoked` handler.
- Make the scheduler never run another pass once blocked with `device-revoked`.

### R-06 No size bounds before verification; 64 MiB inflate budget for each pack and kind *(test for the budget)*

- `HttpsReadOnlyAdapter.get` (`storage/src/https.ts:57-62`) reads the whole body with `arrayBuffer()`, and
  `reader.ts:211` / `own.ts:253` call it for every listed path **before** the hash check. A friend's storage host
  (untrusted in the threat model) can therefore stream an unbounded body at any listed path, or at `index.json`
  (`MAX_INDEX_BYTES` is checked only after the download), and exhaust the phone's memory.
- `MAX_PAYLOAD_BYTES` = 64 MiB applies to every kind (`payload.ts:283`). With `concurrency` 6 and `friendConcurrency`
  8, up to 48 packs inflate at once: about 3 GiB in the worst case on a mid-range phone, followed by `JSON.parse` of a
  64 MiB string. A real 200-place pack is about 70 KB of JSON. The limits in `parsePlaces` (5,000 features × 20,000
  positions) are also far above what the writer produces. Repro: `review R-06 … a places payload is bounded far below
  the generic 64 MiB`.

**Fix:**

- Give `get` a `maxBytes` (streamed; abort when `Content-Length` or the received bytes exceed it): 16 MiB for an index,
  a few MiB for a pack.
- Use a budget for each kind: places about 4 MiB inflated. Own document: keep 64 MiB; it is my own data.
- Keep a total byte budget for each friend read.

### R-08 Retrying after a lost race trusts the HEAD ETag: on coarse-ETag servers the retry overwrites the other device

`publish()` calls `pull()` again for each attempt (`own.ts:436-437`). `pull()` reuses `own:index` when the HEAD ETag is
unchanged and `fresh` (`own.ts:188-196`). The failed attempt did not update `own:index`. On Nextcloud and WsgiDAV
(coarse ETags, T-202), the other device's index of the same size, written in the same second, has the same ETag. The
retry then builds on the **stale** text, `If-Match` succeeds with the coarse ETag, and the read-back shows our bytes.
The other device's publication is silently replaced, and the files it superseded and deleted after its own read-back
may still be listed by us. The missing-file check runs only on a full check or on the first pull of a session
(`own.ts:246`), so friends get 404s, and keep a stale cache, for up to `fullCheckMs` (10 minutes). The same
interleaving can happen on the first attempt (both devices read back their own index). The README calls it "healed at
the next pass", which is not quite right for the missing files.

**Fix:**

- In the retry loop, after a conflict, pull with a full GET (skip the HEAD shortcut).
- When `pull.forked` or `pull.rolledBack` is set, run the missing-file listing immediately, rather than at the next
  full check.
- Correct the README sentence.

## Low

### R-04 Reader state aliasing after an address change: changed places are never projected *(test)*

`reader.ts:152-154`: when `prev.location !== t.location`, `st` is built with `packs: prev?.packs` and `items:
prev?.items` **by reference**. The catch block then saves `{ ...prev }` (`reader.ts:299-302`), so packs opened before
the failure are kept in `prev.packs` as seen, with their items, but nothing was projected. At the next read they are
not downloaded, `features.get(ph)` is empty (`reader.ts:267-268`, the comment there says "cannot happen"), the new
hashes are written to `st.items` anyway, and those places keep their old content until they change again. This
happens after a friend's move that another device followed (the vault brings the new certificate) combined with any
transient failure. Repro: `review R-04`. **Fix:** `structuredClone(prev)` in both branches. In the projection, treat a
missing feature as an error (refetch), not as `continue`.

### R-07 A blocked state stops reading friends as well *(test)*

`scheduler.ts:173`: in `blocked` (credentials rejected, needs-key), every automatic pass is skipped, including the one
on opening the app. The engine can read friends without my storage (`engine.ts:168-188`), and the spec only asks that
"writes stop, queue kept". Friends then appear stale ("Updated N days ago") because of a problem with *my* storage.
Repro: `review R-07`. **Fix:** in `blocked`, run `engine.sync({ publish: false })` on launch, foreground and
pull-to-refresh (except for `device-revoked`, see R-05). Pass the options through `run(reason, opts)`.

### R-09 A removed contact can be re-added by another device until the vault arrives

The vault is pushed **after** the index commit (`own.ts:504`), and only after a successful publication. When device A
removes a friend, device B, until it pulls the new vault, computes audiences from its old book and republishes packs
wrapped for the removed friend. That friend reads new content in the window, and A then re-seals again. **Fix:** push
the vault first when the change narrows an audience (removal, `share: false`, fewer lists), then publish.

### R-10 A vault that does not open is overwritten, which loses another device's concurrent contact edits

`own.ts:388-396`: if `openVault` fails with the current vault data key, this device "starts from our copy" and the next
`pushVault` overwrites the remote one. Around a rotation (the primary has adopted the new vault key, a secondary still
writes with the old one), the secondary's contact changes are lost. **Fix:** keep the previous vault data keys next to
`previousKeys` and try them before giving up, then merge.

### R-11 The scheduler ignores `retryable`

`scheduler.ts:196-204`: a non-retryable own problem that does not block writes (`bug`, `tampered`, `unsupported`, for
example an own pack written by a newer app version, see R-12) is retried with backoff for as long as the app is open.
**Fix:** for `retryable: false`, stop retrying automatically and show the problem; retry at the next foreground.

### R-12 One malformed own pack stops every own pull

`classify` throws on any `PayloadError` (`own.ts:301-312`, through `parsePlaces` / `parseJsonBody`). One bad listed
pack, from a bug or a newer payload version on another of my devices, makes every `pull()` fail, so this device never
publishes again. **Fix:** classify an unreadable own pack as `other` (rewritten or dropped by `build()`), and report
`unsupported` only for a newer version.

### R-13 Friend-controlled strings and dates are only loosely checked

`features.ts:273-280`: tag `color` (any 32 characters) and `icon` (any 64) reach the UI and uMap styles, and `created`
and `updated` can be far in the future, which pins a friend's items at the top of the "recent" sorts and What's new.
**Fix:**

- Require `#RRGGBB` for colors and an allow-listed icon name.
- Clamp dates to now + 24 h, like the index `updated`.
- Reject C0/C1 controls and bidi overrides in names, comments and tags.

### R-14 Wall clock instead of the injected clock

`own.ts:189, 282, 467` and `reader.ts:158-195` use `Date.now()` while the rest uses `o.now`, so the freshness and
full-check logic cannot be tested with a fake clock and drifts from `now()`. **Fix:** use `this.now()` everywhere.

## Notes

- **N-1 Public file content.** `buildPublicLists` (`public-lists.ts:372-377`) publishes, in plaintext, all
  `featureFor(it, 'public')` properties: my **personal tag names** and parents, status, price level, and
  creation/update dates (which reveal when I went where). The spec makes public only "what the user puts in a public
  list (or a comment marked public)". Consider publishing only name, category, geometry, the public comment and the
  list color, or show the exact fields in the "make public" preview.
- **N-2 Removing access is not immediate.** `removeContact` / `setPolicy(…, { share: false })` erase the friend from my
  cache but republish only at the app's next `localChange()`. Have the engine signal that a publication is due, so the
  app cannot forget to call it.
- **N-3 A friend whose index disappears keeps their cache forever.** `NotFound` is an error that keeps the cache
  (`reader.ts:212`, `299-306`). The signed "content deleted" marker of the spec ("Delete all my content") is not
  implemented. Track it for T-213.
- **N-4 `keys/<device>.bin`** are never deleted. In the public read folder they reveal my device ids (already in the
  index) and the time of each rotation. Delete them once every listed device has adopted the key.
- **N-5 Orphans after a crash** between pack upload and index are never collected (README open question 8). Record
  the planned writes in `own:garbage` **before** uploading, not only after a failed attempt.
- **N-6 Concurrent `sync()` calls share the pass in progress** (`engine.ts:136-142`), even when they ask for different
  options: a `publish: false` pass answers a caller who wanted to publish. The scheduler's `again` covers its own
  calls; direct callers are not covered.
- **N-7 Clock skew near invitation expiry** makes two of my devices disagree on the base audience
  (`invitationStatus(…, now)`). Each pass then re-seals every friends pack on the other device's behalf until the skew
  window passes. This is bounded, not a livelock, but costly at 10,000 places. Consider using the index's `updated`
  of the pass, or a margin.

## Compression before encryption (THREATS.md)

The reasoning is mostly sound: a CRIME/BREACH-style attack needs repeated injection into the same compressed stream
as the secret, and the observer only sees Padmé-bucketed sizes of files I republish at my own pace. Two corrections:

1. **The injection vector is wider than "OSM names, imports, an adopted tag".** Through R-02, any friend I follow can
   place a string of their choice (a name) into my places packs, change it as often as they republish, and have it
   resealed together with my friends-only comments at each of my publications that touch the pack. Fixing R-02 brings
   the attack surface back to what THREATS describes. Until then the sentence "the attacker would have to get text
   into my own packs" understates the friend case.
2. **"Shared with up to 200 places of the same pack" is not always true.** A restricted recipient set (`share: {
   lists }`, one per restricted contact or list combination) can have a pack of a handful of places. The 256-byte
   Padmé minimum then hides only small differences, and the pack's (compressed) size reflects few items. The same holds
   for own-document **deltas**, which are separate files whose padded size follows the size of each edit, private
   comments included. Without compression the length would leak too, so this is not a regression. Padding deltas and
   small packs to a coarser floor (for example 4 KiB) is cheap and would make the THREATS claim true.

The decompression bomb defence is correct (streamed `Inflate`, aborting in the callback, 4 KiB input steps), but the
budget is too generous (R-06) and the download before it is unbounded.

## What I checked and found sound

- Audiences (`audience.ts`): private saves skipped before anything else. Removed contacts and `share: false`
  excluded. Restricted contacts get only their lists' non-private saves. Only listed, unaccepted invitations, as
  direct recipients, are included, and expiry or acceptance changes the recipient set, so packs are re-sealed with
  new keys. My own key is always present. Recipient-set fingerprints appear only in the manifest, sealed to me alone.
- Comments: friends only for `friends`/`public`, the public file only for `public` (`features.ts:171`). Private
  comments and private places stay in my own document, which is sealed to my sharing key only, under `media/`, and
  never fetched by friends (`reader.ts:204`).
- Revocation: a changed recipient set changes the fingerprint, so every affected pack is resealed with `sealPack` (a
  new batch key), not re-wrapped. Superseded files are deleted after the commit, and failures are kept in
  `own:garbage`. On the friend side, the readable set is recomputed as a union, and places no longer readable are
  deleted and pruned. Rotation: everything sealed with an older key is rewritten (`rot` check). Other devices adopt
  the new key from `keys/` with `lastSeen`, and a missing key blocks writes (`needs-key`).
- Friend reader: index verified at the certified address with `expectedOwner`, the anchor and `retiredOwners`; only
  one redirect is followed, to the certified address; `openPack` is the only decryption path; payload parsing is
  strict (`JSON.stringify(JSON.parse(s)) === s`, unknown fields only under a higher minor, id, geometry and size
  checks); everything is projected in one SQLite transaction and only after every needed pack opened; the local
  database is accessed only through parameterized queries.
- Scheduler: no timer after `appBackground()` (`schedule` checks `foreground`); offline queue; backoff; the 24 h
  banner; auth errors block until `resume()`.
- Data and storage additions: `snapshotOfUpdates` / `isAt` / `exportSince` correctly take the delete set into
  account. `newerIndexes` are written conditionally, after the packs and before `index.json`.
