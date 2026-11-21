# Review of personal photos (T-111b, PR #96)

Reviewer: an independent reviewer who did not write this code. Branch reviewed: `photos` at `5052b90` (already
merged with main, #95 included; `git diff origin/main...origin/photos`: 53 files, about 3,300 lines). Reviewed
against docs/SPEC.md (Personal photos, Direct recipient, Protections, Loss and theft, Error cases), packages/sync
README and THREATS, docs/format/pack.md, docs/error-cases.md and the earlier reviews in docs/reviews/. Main files:
`packages/sync/src/{photos,photo-service,media-cache,image-meta,reader,own}.ts`, the `media` changes in
`packages/data`, and `apps/mobile/src/photos`. `packages/crypto` (frozen, v4) is unchanged.

Unlike the earlier reviews, the clear and contained findings were **fixed on the branch** (commits `1eae365`,
`3b8ec02`, `a56a46b`, `8e52d54` and this document), each one with tests that fail without the fix (checked by
reverting the `src/` changes and keeping the tests). The findings left open need a product or design decision.

Test runs on the branch after the fixes: data `tsc` clean, `vitest` 163 passed; sync `tsc` clean, `vitest` 145
passed, 1 skipped; app `npm run typecheck` clean, `npm test` 350 passed.

## Verdict: **merge** (after this review's fixes)

The cryptographic design holds up. Each photo has its own random X25519 key (`generateX25519KeyPair`). Both of its
files are frozen v4 packs of type `media`, payload kind 5. The pack format gives each file a random content key and
a random 24-byte XChaCha20-Poly1305 nonce, so no nonce is reused. The owner, the payload type and the header are
in the associated data. The key reaches only what can already read the save: my document (`u:<id>`) and the save's
places pack. A friend opens a file only if their verified index lists it, at the path it was requested from
(`openPhoto`), so the host cannot:

- swap the full photo and the thumbnail;
- swap two photos, or a photo and my document;
- replay a deleted file.

Removing a reader renews the key, and the old files leave the index and the storage. Visibility, the trash, "Delete
all my content" and the remote wipe all behave as the spec asks. Only the trash had no test for this; the review
added one.

Before the fixes, the real weaknesses were in the reader:

- a hostile friend could reuse photo ids to break reads (mine or another friend's);
- a hostile friend could make a pass download without bound;
- a hostile friend could crash the app with a decompression bomb;
- on the phone, the original photo (with its GPS) stayed in the app's cache folder after processing.

| Severity | Count | Findings | State |
|---|---|---|---|
| Medium | 4 | F-01, F-02, F-03, F-04 | fixed |
| Low | 2 | F-05, F-06 | fixed |
| Low | 2 | F-07, F-08 | decided and done (see Decisions) |
| Info | – | Notes section | – |

---

## Medium

### F-01 A friend's photo id could collide with mine or another friend's and break reads and my own projection *(fixed)*

`packages/data/src/sqlite/schema.ts` (`media.id TEXT PRIMARY KEY`), `repository.ts` `setForeignMedia` / `writeMedia`
(plain `INSERT`), `packages/sync/src/reader.ts` (the friend's ref `id` stored as is).

Photo ids form one primary key across every owner in the local cache, and a friend's id was stored exactly as their
places pack gives it. My photo ids appear in my friends' packs, and a friend who is also a reader of another
friend's save sees that friend's ids too. So a hostile friend could publish a photo with an id that already exists
on my device:

- If my row (or friend C's) came first, the friend's `INSERT` failed and so did their own read. Only the friend
  is affected.
- If the hostile friend's row came first, **C's read failed at every pass** (the UNIQUE constraint aborts the
  read's transaction), so the hostile friend froze C's places on my device.
- Worse, on a device of mine whose own pull failed once while friend reads went on (a new device, a flaky
  network), my own projection then hit the constraint (`writeOwnSave`). My save's photos could no longer be
  written.

`mediaById(…) ORDER BY mine DESC LIMIT 1` shows the code expected duplicate ids, but the schema never allowed them.

**Fix.** `setForeignMedia` stores `foreignMediaId(saveId, id)` = `<owner>|<place>|<id>`, with the save id prefix
and the friend's id last. Refs ids cannot contain `|` (`[A-Za-z0-9_-]{1,64}`, checked again in `setForeignMedia`),
and my own ids never contain one, so the mapping is injective. The reader and What's new use the stored id. Tests:
data `a friend's photo ids cannot collide with mine or another friend's`; sync `F-01` (a friend reusing Alice's
id and Bob's own id: every read succeeds, every photo keeps its author, and a new device of Bob's still writes his
photo).

### F-02 Thumbnail prefetch counted only successes against its per-pass budget *(fixed)*

`packages/sync/src/photo-service.ts` `prefetchThumbnails`.

`thumbPrefetchBytes` (8 MiB) was charged only for thumbnails that opened. The pass's list holds every new photo of
every updated friend: up to 24 per place, on every place of every pack. A friend (or their host) serving
unopenable files therefore made the pass download each one in turn, up to `mediaFileBytes(512 KiB)` each, with no
bound (8 places × 24 photos × 10,000 places is millions of requests). Neither `friendReadBytes` nor `passBytes`
covers these downloads.

**Fix.** A failed thumbnail is charged at `thumbBytes`. Test `F-02`: a host answering junk for every media file
costs 2 downloads per pass with a 1 MiB budget, against 8 before the fix.

### F-03 Decrypted images went to the platform decoder with no pixel-size check (decompression bomb) *(fixed)*

`packages/sync/src/photo-service.ts` `load` (only `sniffImage`), apps: `usePhotoImage` → `dataUri` → `<Image>`.

A friend's image was checked by its first bytes only. A WebP or JPEG of a few KB can declare a 16,383 × 16,383
canvas. The platform decoder then allocates width × height × 4 bytes, about 1 GB, and the app is killed. A place's
thumbnails are decoded together in the gallery and on What's new, and they are prefetched at every pass, so the
crash repeats whenever that card or What's new is shown. The `w`/`h` of the reference are bounded (10,000) but
never compared with the file.

**Fix.** `imageSize` (`image-meta.ts`) reads the size from the headers without decoding:

- JPEG: the SOFn frame header;
- WebP: the VP8X canvas, VP8 and VP8L (the largest given);
- AVIF: `ispe` (the largest).

`checkImage` (`photos.ts`) checks three things:

- the format is the one the reference names;
- a photo is at most 25 MP and 10,000 px a side;
- a thumbnail is at most 1,024 px a side.

It runs on every friend's image before it is cached or returned, and `Photos.add` applies it too, so my app never
publishes what readers refuse. The app writes at most 1,600 and 400 px. Tests: `F-03` (bombs refused by `add`,
and refused at the reader when a modified app publishes them; nothing cached), `imageSize reads JPEG, WebP (VP8X,
VP8, VP8L) and AVIF headers`. The decoder's own bugs remain out of reach (see Notes).

### F-04 The picked original (with EXIF and GPS) stayed in the app's cache folder *(fixed)*

`apps/mobile/src/photos/pick.native.ts`.

`expo-image-picker` copies the chosen photo into the app's cache folder. `exif: false` only stops it from
returning the EXIF to JavaScript: the copy keeps its EXIF, GPS included. `ImageManipulator.saveAsync` also writes
each WebP (photo and thumbnail) there. None of these files was deleted. They sat outside the SQLCipher database,
so none of the following erased them:

- the database encryption;
- the remote wipe (secrets, then the database);
- "Delete all my content".

They stayed until the OS cleared the cache folder. The module comment ("the original never leaves the picker's
temporary file") was true of the network, not of the disk.

**Fix.** After processing, the picked file and the manipulator's output files are deleted (best effort, only under
`Paths.cache`). Files left by builds made before this fix remain on devices that used them: see Open question 3.
Not unit-testable without the native modules; `typecheck` covers the calls.

## Low

### F-05 Metadata removal: JPEG MPF, trailing images, metadata between scans, unknown WebP chunks *(fixed)*

`packages/sync/src/image-meta.ts`.

The second barrier (after the re-encode) had gaps:

- JPEG: APP2 was kept whole. APP2 holds the ICC profile, but also MPF, the index of the secondary images that
  phones append after the main image's EOI (depth or gain maps, each with its own Exif and GPS).
- JPEG: everything after the first SOS was kept as is, which covers those trailing images and any APPn/COM
  between the scans of a progressive JPEG.
- WebP: chunks other than `EXIF`/`XMP ` were kept, so a writer could put anything in an unknown chunk.

Today the native path always writes WebP and the web canvas writes no MPF, so this was defence in depth only.

**Fix.**

- JPEG: the whole file is walked (entropy-coded data skipped by its stuffing rules). APP2 is removed unless it is
  `ICC_PROFILE`, metadata segments between scans are removed, and everything after EOI goes. `imageMetadata` now
  reports `trailer`.
- WebP: only the chunks the format defines are kept (`VP8 `, `VP8L`, `VP8X`, `ALPH`, `ANIM`, `ANMF`, `ICCP`).

Tests `F-05` ×2 and `WebP: chunks the format does not define are removed too`. The JPEG fixtures now stuff their
0xFF bytes and carry a frame header, as real files do.

### F-06 Download bounds did not allow for the Padmé padding *(fixed)*

`photo-service.ts` (`max + 65_536`), `own.ts` `fetchOwnImage` (thumbnail: **no** slack at all).

Padmé grows with the size. Measured: an image of exactly 8 MiB is an 8,651,151-byte file, 256 KiB over the image,
and a 512 KiB thumbnail is a 541,071-byte file. A photo accepted by `add` (≤ `photoBytes`) could therefore be
refused as `TOO_LARGE` by every friend and by my other devices once it was within about 200 KB of 8 MiB. Any
thumbnail within 16 KB of `thumbBytes` failed on my other devices, and `syncOwn` retried it at every pass.

**Fix.** `mediaFileBytes(n) = n + ⌈n/8⌉ + 64 KiB` (above Padmé's overhead at every size), used for both downloads.
Test `F-06`: a photo of 8 MiB − 64 bytes reaches a friend and another device of mine.

## Open at review time (decided since: see Decisions)

### F-07 A key renewal on a device without the image, against a stale index, drops the photo for good *(decided: kept, made clean)*

`packages/sync/src/own.ts` `preparePhotos` (`stop()`).

When a photo must be re-sealed, the device needs the image. If it does not have the image, it fetches the image
with the old key from `prev`. When the pull saw a rollback or a fork, `prev` is null, so there is no fetch, and
`stop()` clears the `u:` record. The old files then leave the index and are deleted as garbage. If no other device
of mine holds the image (normally every device syncs photos, `syncOwn`), the photo is lost.

The behaviour fails closed, which is right for confidentiality: the removed reader can no longer fetch it. Losing
data is not.

Options:

- keep the old files listed and retry at the next publication, so the removed reader keeps access a little longer;
- fetch the image through the served index, then stop if that fails;
- leave it as it is and document it.

### F-08 The image cache shares one id space between my encrypted files and friends' images *(fixed)*

`media-cache.ts`, `own.ts:465` (a pull keeps my other devices' encrypted files under their **file hash**, `enc`,
`mine: 1`), `photo-service.ts:213` (a friend's image is cached under the hash their reference names).

My file hashes are in my friends' packs. A friend who is also a reader of mine can therefore name one of my file
hashes as their own `full`. Two cases follow:

- If their image is cached between my pull's `put` and `importOwnPhotos`, the entry becomes theirs (`kind`
  changes) yet stays `mine: 1`: never evicted, and my photo is not imported (it is fetched again later).
- In the other order, their card shows ciphertext as a broken image.

Likewise, two friends who both read a third friend's photo can reference each other's files; that discloses nothing,
since each already had access.

No confidentiality loss was found, but the cache should not let foreign data share ids with mine. A simple design:
prefix friends' cache ids with their owner, and never overwrite an entry marked mine from a friend's load. This
was not changed here because it touches the cache's id contract used by `list()` (`thumbLocal` / `fullLocal`).

## Notes (Info)

- **What a removed friend keeps.** Removing a friend renews the key at my next publication. A removed friend keeps:
  - the thumbnail of **every** photo they could see, since thumbnails are prefetched at each pass;
  - the full photos they opened;
  - the old keys and file hashes.

  Until that publication, they can still fetch the old files. Afterwards, a host that kept the old ciphertexts
  could hand them over, but they hold only images that reader already had access to. New photos and renewed
  files use keys they never receive. This matches the spec ("copies cannot be taken back") and THREATS. The app's
  wording should say "thumbnails of all photos" rather than "photos you opened".
- **Visibility.** References go only into the save's own audience packs (`audiences.has(placeId)`), never into
  link-only lists or the public file (the parser refuses `photos` there).
  - Friends → private: the key is renewed and the reference leaves friends' packs.
  - Private → friends: no renewal is needed (only readers were added); the existing key is handed out.
  - Restrictions to lists, invitation links and a sharing key changed by a declaration of loss all go through
    the same audience comparison. The manifest's `aud` is checked against its fingerprint, and a missing entry
    makes the device renew.
- **Trash.**
  - A trashed save leaves friends' packs (their copy and cache go). Its files stay on my storage and its images
    on my devices while it is restorable. Restoring with the same readers re-lists without re-upload; with fewer
    readers it renews (new test `a trashed place takes its photos from friends…`).
  - "Delete forever" deletes the files at the next publication and the local copies on every device.
  - While trashed, the files stay listed under the old key. A modified friend client that kept the key could
    fetch what it already had access to.
  - `Photos.add` accepts a trashed save (`getMySaveForPlace` does not filter `deleted_at`). No UI path was found.
- **"Delete all my content" and the remote wipe.** The document is emptied (purged), so the publication lists no
  photo, and `deleteStorageFiles` removes every unlisted file. On a storage without listing, garbage collection
  deletes the photo files only if this device uploaded or listed them. `media_cache` lives in the same database
  and is emptied by `DataStore.wipe` (the database key is erased first). New mobile test: the photo files leave the
  storage, the friend's copy goes, and `media_cache` is empty when the database closes.
- **On the device.** Images are plaintext rows inside the SQLCipher database (native), as the spec asks. The web
  test build (sql.js) is not encrypted, as its settings say. Eviction (friends' full photos first, LRU, then
  thumbnails; mine never) and `prune` are correct and tested.
- **Host view.**
  - A photo is two files uploaded together (so the host pairs them), Padmé-bucketed, in `media/` beside my
    document and manifest.
  - A renewal re-uploads every affected photo at once, which shows that someone lost access, and roughly which
    group of places they had (THREATS says so).
  - Lazy full photos tell a **friend's** host which photo I open and when, with my IP address. This is inherent in
    "download the full photo only when opening it", and worth a line in THREATS.
- **EXIF on both paths.** Native: expo-image-manipulator re-encodes to WebP, then the sync layer strips again and
  refuses leftovers (`Photos.add`). Web: canvas, then the same check. EXIF is removed before encryption on both.
  Pixels are not inspected (THREATS). Capture time never travels: `created` is when the photo was added.
- **Dead read.** `photoAudiences` reads `own:aud` from the local state, but nothing writes it. It is harmless,
  since local state is trusted, but it should be removed or written.
- **Export.** The GeoJSON export carries `media` ids and hashes but neither images nor keys. Photos are not
  portable today, which is a product choice to state in the export screen.
- **Tests of failure paths.** Before this review, the suite covered:
  - refusals at `add`;
  - quota;
  - revocation;
  - the old file 404 after renewal;
  - eviction;
  - metadata.

  It lacked hostile friends (ids, junk files, bombs, wrong format), the trash, delete-all with photos and size
  edges. Those are added. Still untested: a friend's index missing from state (`indexFor` → null), an image
  whose content hash does not match on my own device (the `DecryptionError` path of `fetchOwnImage`, covered only
  indirectly), and the race of F-08.

## Open questions for the product (all decided: see Decisions)

1. **Pixel bounds** (F-03): 25 MP / 10,000 px a side for photos and 1,024 px for thumbnails are new reader rules.
   They are well above what the app writes. Confirm them, and write them in the photo format section, since
   another client must respect them.
2. **Stale renewal** (F-07): during a renewal that cannot fetch the image, which should win, keeping the photo or
   cutting the reader off at once?
3. **Leftover originals** (F-04): devices that used an earlier build may hold picked originals (with GPS) in
   `Caches/ImagePicker` and `ImageManipulator`. Should the remote wipe and "Delete all my content" also empty those
   cache folders? That is cheap and closes the gap for files written before the fix.
4. **Export of photos**: include the images (and so the plaintext) in the export, or say they are not exported?
5. **What removed friends keep**: say in the UI that friends keep the thumbnails of all the photos they could see.

## Decisions (product owner, after this review)

Implemented on the branch with tests; the commits follow `9d365c4`.

1. **Size caps: smaller, and writers downscale instead of refusing** (open question 1, F-03).
   - Final caps, written in the media format rules (packages/sync README "Personal photos", "Format caps"; constants
     in `sync/src/photos.ts` and `limits.ts`): **2,048 px a side and 1.5 MiB (1,572,864 bytes) for a photo, 512 px a
     side and 128 KiB (131,072 bytes) for a thumbnail**. The 25 MP pixel-count rule is gone (the side cap implies
     4.2 MP). A reference's `w`/`h` is bounded by 2,048 too.
   - Why these values: the app writes 1,600 px (1,200 px with "Smaller") and 400 px (320 px), so 2,048 and 512 leave
     about 28 % of margin for another client's rounding or a slightly larger setting, while bounding the decoded
     memory to about 17 MB per photo and 1 MB per thumbnail (against 100 MB and 4 MB before). 1.5 MiB is a 2,048 px
     image at about 3 bits per pixel, above what a good encoder produces at quality 0.8 for a very detailed scene (a
     1,600 px WebP at 0.8 is 150–600 KB); 128 KiB is the same density at 512 px (a 400 px WebP at 0.6 is 15–40 KB).
     The default `photoBytes` / `thumbBytes` limits are now these caps (they were 8 MiB / 512 KiB).
   - Writers never refuse a photo for its size or dimensions: `encodeToFit` (`apps/mobile/src/photos/model.ts`)
     downscales to the setting's side (capped at 2,048 / 512), then lowers the quality by 0.1 down to 0.3, then the
     side by ×0.75, until the file fits; used by both `pick.native.ts` (expo-image-manipulator) and `pick.web.ts`
     (canvas). Only a file that is not an image is refused ("This image cannot be read."; the "too large" message
     is gone). `Photos.add` keeps its checks as a guard.
   - Readers keep validating: a friend's file over the byte cap is refused by the download bound and
     `openPhoto`, an image over the side caps by `checkImage`; nothing is cached (test *caps: a friend's oversized
     files are refused by the reader*).
2. **F-07: keep the behaviour (privacy wins), but drop the photo cleanly.** When a photo must be re-sealed and
   the device can get no image (no local copy, and a rolled-back or forked index, or its files gone),
   `preparePhotos` removes the photo from my document (`removeMedia(…, { quiet: true })`: not an edit of the save)
   and deletes its local copies, and counts it in `report.own.photos.dropped`. No problem is reported and nothing
   waits or retries; my other devices drop it at their next pull (`prune`), the old files leave the storage, and
   friends lose the row and its images at their next read. What's new forgets photos that left the cache
   (`WhatsNewLog.prunePhotos`: an entry left without photos goes), so no empty strip or broken tile remains. A photo
   never uploaded and not on this device still waits for the device that has it. Documented in THREATS ("A renewal
   that cannot be done") and docs/error-cases.md ("Photos"). Test *F-07: a renewal that cannot get the image (stale
   index, no local copy) drops the photo cleanly everywhere, once* (fails on the code before the decision).
3. **ImagePicker / ImageManipulator cache folders: not purged** on the remote wipe or "Delete all my content".
   F-04 already deletes the picked file and the manipulator's outputs after each photo; files left by builds made
   before that fix stay until the OS clears the cache folder. Recorded in THREATS ("On the device").
4. **Export: my photos are included.** `exportArchive` (`packages/import`) writes a ZIP archive:
   `triangulair.geojson` (the export document, minor 1: each photo's `id`, `file`, `thumb`, `mime`, size,
   `created_at`, `author`, and its `image` / `thumb_image` paths) and each photo's full image and thumbnail,
   decrypted, under `photos/`. The place association is the feature that lists the photo. Friends' photos are never
   exported (only my saves are, and a test checks that a friend's photo on the same place is not asked for). Without
   any photo the export stays the plain GeoJSON file. The import reads the archive (`readImportFile` tells it from a
   KMZ), unpacks only the document and `photos/` images within size bounds, and restores each photo through
   `applyImport`'s `addPhoto` hook (the app: `Photos.add`, which strips and checks again; new id, same date). A
   photo already on the save is not added twice and `undoImport` removes the photos it added to a merged save. A
   plain GeoJSON's photos (metadata only) are not imported and the import says so (`photos-not-included`; this
   replaces the earlier behaviour that created photo records without images). Round-trip tests in packages/import
   (two generations, images byte for byte) and in the app (export through the photo store, import on a new account,
   upload at the next sync). The export screen text says the file holds my places and photos in clear and that
   friends' photos are not exported; the native share step deletes the file from the cache once the sheet closes.
   Docs: packages/import README "Export", apps/mobile README, THREATS ("Export").
5. **Removed friends' cached photos.** There is no way to make a friend's app delete what it holds; what can be
   ensured is that an honest app does, and it now does so completely:
   - Detection already existed: a friend's read that can no longer open a save (I removed them, restricted or made
     the save private, revoked their invitation, or deleted all my content, whose signed marker lists nothing for
     anyone) removes the save; the photo rows go with it (`ON DELETE CASCADE`) and `prune` drops the images in the
     same pass. No new detection was needed. Added: `Photos.forget(owner)`, called with every `reader.forget`
     (contact removed or unfollowed on their side, identity move), which erases every image of that owner from the
     cache whatever the rows say. Images are only in the database: no image file is written to disk.
   - Tests: *a friend whose access is gone (removed as a contact / content deleted / save made private) purges every
     thumbnail, full photo and cache row of mine*, and *removing the friend erases them* on the friend's side.
   - THREATS ("What a removed friend keeps") and the "Remove from my friends" confirmation (and the "They see my
     places" switch help) now say that this relies on the friend's app cooperating, and that a modified app can keep
     what it already downloaded (the thumbnails of all the photos they could see, the full photos they opened).
   - THREATS ("Host view") now has the line from the notes: a friend's storage host can see which of their full
     photos I open and when (with my IP address).
6. **F-08 fixed.** A friend's image is cached under `friendCacheId(owner, hash)` = `<owner>|<hash>` (my ids are bare
   `b2b256:` hashes, without `|`), in `list`, `load`, the prefetch and `prune`; and a friend's `put` never replaces an
   entry marked mine (both caches). Test *F-08: a friend naming one of my file hashes gets another cache entry; mine
   is never replaced* (fails before the fix: the friend's photo was found in the cache under my image's id, so my image would have been shown as theirs).

Test runs after the decisions: see the PR description.

