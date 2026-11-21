# Sync: threat notes

Complements `packages/crypto/THREATS.md` (the format) and the spec's threat model. What the sync layer adds.

## Compression before encryption

Payloads are DEFLATE-compressed (fflate, pure JavaScript) before being sealed. The storage, its host and anyone
who polls the files see the **padded size of the compressed content** (Padmé: at most ~12 % overhead), so the size
now depends on how repetitive the content is, not only on its length.

- **Chosen-plaintext compression attacks (CRIME/BREACH)** need an attacker who can inject text into the same
  compressed stream as a secret and observe the size, many times. Here the attacker would have to get text into
  my own packs: OSM names and categories (anyone can edit OSM, and my app copies names), imported files, or a
  friend's tag that I adopt. A friend can **not** do it through their own saves: since the review fix R-02 my
  packs are built from my own document's snapshot of each place (`saves.place_snapshot`), and a friend's data
  never overwrites a place row that one of my saves uses; only identity fields from my own OSM cache take
  precedence. Each attempt needs me to republish (a sync), and the size is padded (below) and usually shared with
  many places of the same pack. Recovering a comment this way is impractical; we accept it.
- **Padding floor**: every payload is padded with zeros to at least 4 KiB before the pack's own Padmé padding
  (`PAYLOAD_PAD_FLOOR`). Without it, a pack of a small restricted recipient set (a handful of places) or an
  own-document **delta** (one file per edit, private comments included) would have a padded size that follows
  the size of each small edit. Above 4 KiB, Padmé still leaks the size within about 12 %, as before.
- **What size still tells**: roughly how many places each recipient set has (number and size of packs), and that
  a pack changed. That was already true without compression (the spec accepts it: "the storage still sees file
  sizes and update dates").
- **Decompression bombs and oversized files** (review R-06): every download is bounded **before** its hash is
  checked (`get(path, { maxBytes })`: Content-Length first, then a streamed read cancelled past the limit; an
  index 4 MiB, a places pack 8 MiB, a file of mine under `media/` 96 MiB). Decompression is streamed and bounded
  per kind (places 4 MiB, manifest 1 MiB, own document 64 MiB). A friend's read is bounded in total (32 MiB
  downloaded + decompressed) and so is a pass over all friends (128 MiB; the rest waits for the next pass), and
  pack work shares one concurrency limit across the friends read at once. All configurable (`SyncLimits`).
  Parsing limits (1,000 features per pack, positions, tags, string lengths) are checked before anything is
  projected. On a React Native `fetch` without a readable body stream only the Content-Length check is done
  before reading; the size is checked right after.
- Trade-off: without compression, 10,000 places are ~3.5 MB of places packs and ~3.8 MB of document instead of
  ~0.23 MB and ~0.66 MB; a friend's first read would be ~15× larger on mobile networks.

## What the storage learns from the layout

- `packs/` vs `media/`: places packs (what friends read) vs my own document, manifest and photos (T-111b). Photo
  files have the same envelope (2 wraps) and padding as the document; the host still sees sizes, so it can
  guess which file is a thumbnail, a photo or my document, how many photos I have, and when one is added. Packs are grouped by recipient set, so the host also sees how many distinct recipient
  sets I use (one per restricted friend or list), not who is in them.
- Republication timing: every sync that changed something writes a new index (the spec accepts update dates);
  the invitation padding also changes the index from time to time (crypto THREATS).
- Replacing one pack also rewrites another one (blur), so a single-place edit does not point at one file; it is
  a weak defense (it costs one pack upload) against matching successive indexes.

## The manifest

Recipient-set fingerprints (hash of sorted public keys) are written only in a pack sealed to my own key. They are
never in a pack a friend can open: a friend who knows other people's public keys could otherwise test which
friends share a pack with them. Wraps stay anonymous (crypto).

## Own devices

- My document is sealed to my **sharing key**, which every device holds and which a declaration of loss replaces
  (`rotate`: everything is re-sealed for the new key, old files deleted). A stolen device keeps what it had; it
  cannot open what is published after the rotation.
- Own-document updates are trusted because the pack is listed in **my signed index** (only my non-revoked devices
  can sign one that verifies) and opens with my key; sealed boxes alone would not authenticate the sender.
  "Non-revoked" is judged against **my current certificate**, not the one in that index (review R-01): an index
  of an older rotation (which a device declared lost can still sign, with the storage credentials it keeps until
  step 4 of the declaration), one older than my anchor, a fork, or one signed by a device my certificate revokes
  is never imported. It only makes my device republish from its local state, and the files it lists are deleted.
- **Anchor of a restored device**: a device restored from the recovery kit has my current sharing certificate
  (from the vault's phrase-sealed copy) but no local anchor. The certificate rule above already refuses every
  older-rotation index. For rollbacks within the current rotation, my devices record my own anchor in the vault
  (`app.triangulair_sync.own`, at each rotation and every 16 publications, so it is a floor), and a device
  without a local anchor reads the vault before trusting the index. The vault is sealed with the current vault
  data key, which a revoked device does not have. Residual risk: a host that rolls back **both** the index and
  the vault to before a declaration of loss, served to a device restored with the phrase-sealed copy of that
  same old vault, is not detected (nothing on the storage is newer); friends still refuse it (their anchors).
- **Remote wipe** (R-05): a device that reads its own revocation stops the pass at once (friends are not read)
  and erases its keys (app hook `wipe.secrets`), the in-memory keys, its sync state and the database
  (`DataStore.wipe` or `wipe.data`); every later pass returns at once.
- **Previous vault keys** (R-10): a vault sealed with a vault data key I had before a rotation is merged only if
  my current certificate revokes no device the older one did not; otherwise it may come from the revoked device,
  and my copy wins (spec step 1).
- The vault (`vault.bin`) is authenticated by the vault data key only; contact switches in its free-form part are
  as trustworthy as the vault itself (a stolen device could change them until the declaration; they are not
  security fields of the format: they decide who gets wraps, which the owner sees in the app).
- **My devices and app values in the vault** (devices review F-01, F-02): every entry is signed by the device that
  wrote it, in its own slot, and counts only while that device is certified and not revoked by my current sharing
  certificate. Who my devices are, who is removed and who gets the new key come from master-signed device
  certificates and the certificate's `revoked_devices` only. Times more than 10 minutes ahead are refused. A
  declaration drops everything the lost device signed and resets the values to the declaring device's.
  Residual: until the declaration, a stolen device is a valid signer: it can rename devices and set values
  (storage settings included) in its own slot, newest-wins. The app never takes another write endpoint from the
  vault, only new credentials for the same one (apps/mobile README). After the declaration, what it signed is ignored
  even in an old copy merged by a device that had not seen it.
- **Followed lists and publish preferences in the vault** (`app.triangulair_sync`, lists review L-02, L-03): not
  signed, like the contact switches. A stolen device can follow or unfollow lists and turn the tag names of my
  forwardable lists on until the declaration (the share sheet shows the setting; the declaration does not reset
  it). It cannot make such an entry win for good: entries dated more than 10 minutes ahead are refused when merging,
  as for the signed values, so a later change of mine sticks.
- **Link-only list keys and a lost device**: the keys are in my Yjs document, so a stolen device holds every link.
  A declaration of loss (the app's `declareLost`, not "Remove a device") draws a new key for each live link-only
  list; the publication that follows seals them to the new keys and deletes the old files, and the screen lists the
  lists whose new link must be shared again. What the thief read before stays read; the tombstone of a list already
  deleted is still sealed to its last key (it only says "This list no longer exists"). Lists followed by link
  (other people's) are not mine to renew: the thief keeps the links it saw in my vault.

## Friends' cache

- Content is projected only after the index verifies and every needed pack opens **at its own path** (R-03: the
  host cannot serve another listed pack in its place); a failure keeps the last valid content (no partial update
  from a tampered storage). A rollback or fork of a friend's index is refused against the anchor kept in my vault.
- A friend's save never changes a place row that someone else's save uses; their own name and geometry are kept
  in their save (`saves.place_snapshot`). Colors must be `#RRGGBB`, icons symbol names; control characters and
  bidi overrides are refused; dates more than 24 h ahead are clamped (R-13).
- Removing a friend, or a friend removing my access, erases their content and the place records their data
  created; deliberate copies (screenshots, a modified app) are out of reach, as the spec says.
- Coarse ETags on a friend's server can delay an update until the next full read (10 minutes while the app is open).

## Shared lists (T-211, T-212)

- **Holder of a list link** (spec threat model): the link holds the list's X25519 secret; anyone it is forwarded to
  reads the list until a new link is made. "New link" re-seals the list pack to a new key (new batch key, new file)
  and deletes the old file: an old holder keeps only what they already copied. The list key is a direct recipient
  of the list pack only (never a group member, never wrapped inside any other pack), so it opens nothing else of
  mine; link packs carry only public comments and never a private place.
- **Forwardable lists and habits** (L-03): link-only packs and the public file give save, edit and list dates to
  the day only, and tag names only on opt-in (a tag's color still styles uMap). Friends' packs keep exact dates
  (friends already see my places as they change).
- **What a link holder learns** besides the list: my master key and read address (they can read my public index
  like anyone), the number and sizes of my packs, and when I publish. They cannot tell which other packs exist for
  whom (wraps are anonymous); they download each `packs/` file once to find theirs.
- **Forged links**: a link naming my key with someone else's address is refused (the index must be signed for the
  master key in the link and certify the address it was read from); a list pack re-listed in another index does not
  open (owner bound in the AEAD). After the first read, an older index is refused (anchor per followed list).
- **Cost of a link** (L-07): following needs no consent, so its bounds are smaller than a friend's: one file tried at
  most `listPackBytes` (1 MiB; a list pack is about 100 KB), one list's read `listReadBytes` (8 MiB), a preview
  `listPreviewBytes` (4 MiB), at most 200 followed lists, and friends and followed lists share one pass budget. The
  app downloads nothing when a link is opened, only when the user asks for the preview. A follower still downloads
  each `packs/` file of the author once (no hint which one is theirs: README open question 9).
- **Malicious public list or link-only list author**: their places land in my cache like a friend's (same strict
  payload checks, sizes bounded, under their own `list:` owner, never merged into another cache); a public list may
  expose someone's private address: the app warns the author before a place that looks like a home enters a public
  list (going public, the place card, the editor), and a public filter list holds such places out of the public file
  until the author confirms them (M-02); the reader only sees what was published.
- **Friends' lists**: a lists pack is sealed only to the contacts given access to those lists; a friend who sees
  everything does not learn my list names unless picked. Membership never names a place they cannot read: picks
  count only while the contact sees everything and are dropped at any change of scope, and a lists pack keeps only
  the places every one of its viewers can read (audiences of the places packs), whatever the policies say (M-01).
- **Impersonation by name** (L-06): the `author` of a link pack or public file is self-declared. The app never
  shows it as an identity: a followed list shows the author's master key as a short code, the name from my contacts
  when that key is a contact of mine, and otherwise the declared name in quotes with "not in your contacts". Lists
  are grouped by master key, so two authors who declare the same name stay apart. An 8-character short code can be
  ground (about 48 bits): compare the safety code to be sure.
- **My vault and followed lists**: the vault holds the link (and so the key) of every list I follow; an unfollowed
  list keeps only its id and the time (L-02), and the entry goes after 180 days. Whoever opens my vault (recovery
  phrase, an unlocked stolen device) learns the lists I follow now, not the ones I followed before.
- **The fragment** never reaches a server (RFC 3986 §3.5): the `triangulair.app` site must never send
  `location.hash` anywhere (the app's own web export reads it on `/l` by design and removes it from the address bar
  at once; Info 4), links are never logged.
- **Replay to a new holder** (Info 5): indexes do not expire, so a storage host that kept an old index and its old
  pack files can serve them to someone who opens an old link and has no anchor for that list yet. They then see the
  list as it was when that link was current; this never reveals content sealed after "new link", and an anchor
  refuses the rollback once a newer index was seen.
- **A public list made link-only** (Info 6): its public link then says "This list no longer exists" (the public file
  no longer names it), where a renewed link-only list says "This link no longer works". Accepted wording: both mean
  "ask the author for a new link".
- **Key handling outside the crypto package** (Info 2, not changed now: the crypto package is frozen): the list
  key's public half is derived in this package with `crypto_scalarmult_base` from `libsodium-wrappers-sumo`
  (`lists.ts`, `listKeyPair`). The derivation is correct (same public key as `crypto_box_keypair`, clamping inside
  libsodium, any 32 bytes are a valid secret), but it is a second sodium instance and `ready` promise, and Metro's
  hierarchical lookup could bundle a second copy from `packages/sync/node_modules`. To do when the crypto package
  next opens: export `x25519PublicKeyOf(secret)` there and drop the direct dependency.
- **Android app links** (Info 3): exact paths `/i`, `/r`, `/l` (`path`, not `pathPrefix`), so other pages of the
  site stay in the browser.

## Concurrency

- Compare-and-swap is best effort on some servers; the read-back check and the recomputation of the remote
  snapshot from what is actually listed make a lost publication reappear at the next pass. A reader may briefly
  see two indexes with the same `seq` (fork), which it reports and then moves past.
- Coarse ETags (R-08): before writing the index, the index on the storage is downloaded and compared with the one
  this attempt is based on, and a retry after a lost race always downloads the index in full. What is left is the
  window between that check and the write; a loss there shows up as a fork at the other device, which republishes
  its document (nothing is lost; friends may see a 404 on a superseded pack until then).
- Superseded files are deleted right after a successful publication. A friend reading at that moment may get a 404
  for a pack of the previous index: it keeps its cache and reads again at the next pass.

## Known limits (review notes not fixed in this round)

- **N-1 Public file content** (fixed with review L-03): forwardable lists (the public file and link-only list
  packs) carry dates rounded to the day and no tag names unless I opt in (`setPublicTagNames`, kept in my vault so
  all my devices publish the same); they still carry status and price level, which the preview shows.
- **N-2** Removing a contact or `share: false` takes effect at the next publication the app triggers
  (`localChange()`); the engine does not schedule one by itself.
- **N-3** A friend whose index disappears keeps their cache (no signed "content deleted" marker yet, T-213).
- **N-4** `keys/<device>.bin` are never deleted; they reveal my device ids (already in the index) and the time of
  each rotation.
- **N-5** Files uploaded by a device that crashed before its index commit stay until that device runs again.
- **N-6** Concurrent `sync()` calls share the pass in progress even with different options.
- **N-7** Clock skew near an invitation's expiry can make two of my devices re-seal packs for each other until the
  skew window passes (bounded).
- Own packs are still opened with every key I hold (current and previous) once their index is trusted; the index
  rule above is what keeps a revoked device's content out.

## Devices review (PR #86): what is left

Fixed: F-01 to F-08 (signed device list and app values judged against the current certificate; link + code sends no
key before approval; restore checks freshness; the primary device routes to the identity change; the stale-sync lock
survives a clock set back; the identity move asks for the storage access change first and is resumable) and F-04 (a
new device is listed only once it picked its keys up). Partly fixed or documented:

- **F-09 Changes since the theft**: the list shows every change of my other devices since the date by default (the
  device that signed the index is a hint: another device may have merged the lost one's edits and republished
  first). Still not covered: contact policies (`share`/`follow`) in the vault, tags and lists (the storage's version
  history lists them); "Revert" does not put back a place's name; the journal is per device and local.
- **F-10 Remove a device**: rotates without cancelling invitations and without the storage access guide (the screen
  says so: suited to a device erased and given away). Nothing reminds the user later that the access was not
  changed after a declaration; the guide is shown once, on the result screen.
- **F-11 An interrupted declaration**: the new key is stored before `declareLost` publishes. If the publication
  fails, the lost device's `keys/` file is deleted and its slots dropped only at the retry, the screen does not list
  the cancelled invitations, and a retry makes rotation r+2. Nothing leaks: the new certificate still cancels the
  invitations and revokes the device at the next publication. A pending declaration in the state store would make it
  resumable.
- Link + code needs two links (the invitation, and the request link back): the new device has no storage access
  before its approval.

## Photos (T-111b)

- **Metadata**: the app re-encodes every image (no EXIF written by expo-image-manipulator or a canvas) and the sync
  layer strips JPEG APP1/APP2 (but ICC)/APP3–15/COM segments (also between progressive scans) and trailing data,
  and WebP EXIF/XMP and unknown chunks again, then refuses any image that still carries them (an AVIF with an Exif or XMP item is refused: the app falls back to WebP). Pixels are not
  inspected: what the photo shows (a street sign, a face) is the user's choice.
- **Keys**: one random X25519 key per photo, both files sealed to it alone; the key is only inside my document
  (sealed to my sharing key) and inside the places packs of the save's readers. A removed reader (friend,
  restriction, invitation link, save made private, device declared lost: my sharing key changes) gets the photo
  re-sealed under a new key, and the old files are deleted after the publication. What they already downloaded
  stays with them (spec: copies cannot be taken back). Until the owner's next publication a removed friend can
  still fetch the old files with the key they had.
- **Fetching**: a friend's photo file is downloaded with a size limit (the format caps, 1.5 MiB for a photo and
  128 KiB for a thumbnail, plus the envelope and its padding) and opened only if their verified index lists it at
  that path; the key comes from a places pack that verified the same way. The image is checked before it is cached
  or shown: the format its reference names, and a pixel size read from its headers of at most 2,048 px a side for
  a photo and 512 px for a thumbnail, so a small file cannot make the platform decoder allocate more than about
  17 MB (photo) or 1 MB (thumbnail). Decoding itself is left to the platform's image decoder (its own bugs are out
  of reach here). A friend's photo ids are stored inside their save's id, and their images in the cache under
  their owner id (`<owner>|<hash>`): a friend cannot collide with my photos or another friend's, and a friend's
  entry never replaces one of mine. The thumbnails fetched with a pass count failed files too.
- **What a removed friend keeps** (and what their app erases): removing a friend, restricting or making a save
  private, revoking an invitation or deleting all my content renews the photo keys at my next publication; their
  app then finds it can no longer open those saves and erases my saves, photo rows, thumbnails and opened full
  photos (tested). Nothing can make it do so: this **relies on the friend's app cooperating**, and a modified app
  can keep what it already downloaded, which is the thumbnail of **every** photo of mine they could see (prefetched
  at each pass), the full photos they opened, and the old keys and file hashes (spec: copies cannot be taken back).
  The app says so in the "remove a friend" confirmation. Until my next publication they can still fetch the old
  files; afterwards the old files are deleted, and a host that kept them only holds images that reader already had.
- **A renewal that cannot be done** (review photos F-07): if a device must re-seal a photo and can get no image
  (no local copy, and a rolled-back or forked index to fetch through), the photo is dropped from my document
  rather than kept under a key that someone who lost access may hold. Privacy wins over keeping the photo; it is
  lost only if no device of mine holding the image publishes first.
- **Host view**: a new photo is two new files in `media/` at the same time as a document delta; a renewal replaces
  both files of every affected photo, which shows that someone lost access (not who). Full photos are downloaded
  only when opened, so **a friend's storage host can see which of their full photos I open and when** (with my IP
  address); thumbnails are fetched with each pass and show nothing more than the pass itself.
- **On the device**: images are in the app's SQLite database (`media_cache`), with the same protection as the rest
  of the database, and erased by the remote wipe. Since review photos F-04 the picked original and the
  manipulator's outputs are deleted after processing. The `ImagePicker` and `ImageManipulator` cache folders are
  **not** emptied by the remote wipe or "Delete all my content" (product decision): files that builds made before
  that fix may have left there (originals with their GPS) stay until the OS clears the cache folder.
- **Export**: the export with photos is a ZIP file holding my photos decrypted (without metadata) and my places in
  clear; it leaves the app's protection once shared (the export screen says so). Friends' photos are never
  exported. The native share step writes it to the cache folder and deletes it once the share sheet closes.
