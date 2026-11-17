# TrianguLair mobile app

An Expo / React Native app for iOS and Android. The web build is for testing only.
Wired to the workspace packages `@triangulair/data` (local SQLite + document) and
`@triangulair/osm` (Overpass, Photon, opening hours, photos):

- **Map** (index): pins from `Repository.mapPins` for the visible area, clustering when zoomed
  out (T-103 basic), filter bar driven by my tags and OSM criteria (open now, terrace, happy
  hour, vegetarian), filtered display (matching pins in color, the others grey, faded, smaller).
- **Add a place** (`/add`, T-105): nearby OSM places around the map center sorted by distance,
  search as you type (Photon session) plus the local part (my and friends' places), long press /
  right click on the map or "drop a point" for a manual point; each candidate says "Already in my
  places" / "Saved by N friends"; the form sets tags (first = main), status, price, comment and its
  visibility, sharing.
- **Place card** (sheet on the map, side panel on wide screens, `/place/[id]` page; T-107 UI):
  category, address, opening line ("Open, closes at 10 pm"), happy hour, terrace/diet/cuisine/
  reservation/fee chips, free photos with credit lines, friends who saved it, my tags/status/price/
  comment/sharing (saved immediately), move to trash (with "Undo" on the map and the list for 15 s). OSM data is refreshed when stale.
- **List** (`/list`, T-104 basic): sort recent / distance / name, text search (FTS or fallback),
  same filter bar; two panes (list + card) on wide screens.
- **Import / export** (`/import`, T-114/T-115; link "Import / export" in the list header): pick a
  file (Google Takeout, KML/KMZ, GeoJSON, CSV with a column-mapping step, Mapstr and Pin Drop
  exports, which are **unverified** and flagged as such), match to OpenStreetMap with progress and
  cancel, preview (to check / found / manual points / no position, per-place choice among
  candidates, manual point or leave out; what each source tag becomes), batched write with
  progress and cancel, summary and undo for 7 days; export everything as GeoJSON (download or
  share sheet on web, share sheet on native). Logic in `@triangulair/import` (see its README).
  Native file access uses `expo-document-picker`, `expo-file-system` and `expo-sharing`
  (new native modules: a new development build is needed). Screenshots: `docs/*-import-*.png`.
- **Filter bar** (T-109, `components/FilterBar.tsx`, logic in `src/places/filters.ts` and `src/filters/`):
  my tags (choosing a sub-tag of a chosen tag narrows to it), friends' unmapped tags in their
  author's color, categories (OSM groups) then their sub-filters (type, cuisine, museum type, shop
  type), practical criteria (open now, happy hour, terrace, takes reservations, free entry,
  second-hand, organic, also at my friends'), diets (all chosen ones required), "entry ≤ €X", my
  status, "maybe closed" / "closed" (closed places are hidden unless chosen), visibility (only me /
  shared / friends' places), price level, text. Groups ANDed, values ORed; a place lacking source
  info is "unknown" and drawn faded. Collapses to one line of removable pills; moving the map folds
  it without changing the remembered choice. Filter and open state are kept per device (versioned
  JSON, parsed defensively; storage falls back to memory when blocked).
- **Tags** (`/tags`, T-108): tree of my tags with color (spec palette), icon (curated set, below),
  places, linked OSM categories and linked friends' tags; create (color and icon suggested from the
  name), edit, re-parent (no cycles offered), delete to the trash with undo. "My friends' tags":
  matched by manual mapping, then by name (case, accents, plurals, en/fr synonyms), else kept in
  their author's color, with "Link to my tag", "Adopt" and a warning when the color equals one of
  mine. The card shows tag paths ("Restaurant › Pizza"); the first tag is the main one.
- **Closed places** (T-113, `src/closure/`): the osm package's `ClosureChecker` and monthly schedule
  run while the app is open only (on open, on return to the foreground at most every 6 h, aborted
  when the app leaves the foreground), in batches of 50 never-checked-first places, and when a card
  of mine opens with a check over a month old (every OSM refresh of my places is a check). Results go
  to the place cache (`status`, `closedSignals`, `osmSyncedAt` = last check). A grouped notice at
  most monthly; the card shows "Maybe closed" with reasons and date, "Confirm closed" / "Still open"
  (answers kept per device and fed back so dismissed signals do not return); the pin gets a small
  grey cross; "Report closed" on my places.
- **Go there** (T-116): directions in the phone's navigation app (`geo:` on Android, Apple Maps on
  iOS, Google Maps on web) and "open in" Apple Maps / Google Maps / OpenStreetMap (new tab on web).
- **Zones** (`/zone/new`, T-110): from an OSM neighbourhood (Overpass `place=neighbourhood|quarter|suburb`
  in the visible area, tap one on the map, or Nominatim search by name), from street segments (tap a
  start and an end, the path follows the streets through intersections; "Add a segment" chains
  contiguous or separate ones; saved as LineString / MultiLineString), or drawn by points (tap the
  first point to close, then move a vertex or add one on an edge; self-intersections refused) or by
  painting (three thicknesses, eraser, "move map"; strokes rasterized in metres, merged, traced,
  Douglas–Peucker + Chaikin, saved as a "fuzzy outline" polygon). Zones are drawn with a ~20 % fill
  and a 2.5 px outline (painted: three blurred rings; streets: thick translucent line + centre line),
  a rounded-square badge without tip, greyed outside the filter. The zone card has the same personal
  fields as a place plus "places inside" (`src/zones/`).
- **Lists** (`/lists`, `/lists/[id]`, `/lists/edit`, T-112): saved filter (tags with sub-tags,
  categories, statuses, prices, zones from my zones / by name via Nominatim / outlined on the map,
  exceptions added or removed by hand) or manual selection; live preview (map with the zones, members
  in color, others faded, count) and, for every place, why it is in or out ("Private: never in a
  list", "Does not match: tags, zones"…). Membership always comes from `Repository.evaluateList`.
  Visibility (link / public) is stored and used by the share screen below (`src/lists/`). Going public from the
  editor shows the warning (anyone can read it, the author's responsibility, places that may be a home) and asks to
  tick "I understand" before saving. In a list that is already public, places that look like a home and are not in
  it yet ask for their own confirmation; on a filter list, the confirmed ones become explicit "include"s (the public
  file holds the others back, below). Adding such a place to a public list from the place card asks first too
  (`HomeConfirm`, review M-02).
- **Sharing a list** (`/lists/share?id=`, "Share" on a list, T-211/T-212; logic in `@triangulair/sync`, see its
  README "Lists"): *link only*: "Create the link" makes the list's key (in my document, all my devices) and publishes
  before showing `https://triangulair.app/l#…` with its QR code, share / copy; "New link" (confirmed: everyone with
  the old link loses it) and "Stop sharing by link"; *public*: the warning first (`PublicWarning.tsx`, with the places
  that look like a home: a dwelling category, no category, a point placed by hand, the sync package's
  `looksLikeHome`; on a filter list, confirming includes them), the places a public filter list took by itself but
  holds out of the public file because they look like a home ("Publish them" = include, "Leave them out" = exclude,
  `heldPublicPlaces`), then the GeoJSON file's address
  on my storage, "View on uMap" (`umapUrl`: a new uMap map importing the file) with its address shown, and the
  in-app link to follow it; *friends*: pick who sees the list (its name and places) among my contacts
  (`setListAccess`: a contact who sees nothing gets this list only, a restricted one gets it added, one who sees
  everything also gets the list's name). Everything needs a storage: the "storage needed" card's button goes through
  `useStorageForSharing().ensure()` and comes back to the share screen.
- **Following a list by link** (`/lists/follow`, deep link `/l#…` in `src/app/l.tsx`: the fragment is taken from the
  address bar, removed from it and handed over in memory; an opened link waits for "Show the list", so nothing is
  downloaded by a single tap, review L-07): paste or open → preview (map with the author's tag colors,
  places with public comments, author, date, number of places) → "Follow this list"; no account, no request, not a
  contact. The author is shown by their key (`authorLabel`: "By Marie, in your contacts (AbCd…WxYz)" when the key is
  a contact, else "Signs as “Marie” (AbCd…WxYz), not in your contacts": the name in a list is self-declared, review
  L-06). The list is followed only once its first read worked; otherwise nothing is kept and the button stays to
  try again (L-05). Problems in plain words: not a list link, "This link no longer works" / "This list no longer
  exists" (ask for a new link), my own list, unreachable, 200 lists already followed.
- **Followed lists** (`/lists/followed`, from My lists and Friends): by author, with places, date and the gone
  message; a list's screen (`/lists/followed/[id]`, `ListPlacesView.tsx`: map + rows, card) with Refresh and Unfollow
  (its places leave now, on all my devices through the vault). Lists friends shared with me
  (`/lists/friend?owner=&list=`). Their places show on the map like friends' places, in What's new (a followed list's
  first places as one item, named after the list) and on the card ("List “…”" among who saved it).
- **First launch** (`/welcome/*`, T-205, local part): the spec's three entries. *Get started*: first
  name and optional photo (cropped, 256 px) while the keys are made in the background, app lock offer,
  location (explained before the system prompt, kept on the device to center the map), import or
  "Later", then the map with a hint on "+". *I already have TrianguLair on another device*: see Devices below.
  Local-only mode; a storage is offered later.
- **Identity** (`src/identity/`, glue in `create.ts`, tested): `@triangulair/crypto` makes the 12-word
  phrase, the master key (owner id `ed25519:…`), this device's keys and master-signed device certificate,
  a random sharing key with its certificate (rotation 0, no read address in local-only mode), a random
  vault data key sealed with it to this device, and, on the **primary device** (on by default: the first
  device keeps the master key so the next one can be added by QR code), the `TLPI` blob. Each secret is
  its own secret-store entry (below); on start the device certificate, the sealed sharing key and the
  primary blob are checked to belong together. The format package is unchanged.
- **Owner migration**: databases created under the placeholder owner `local-me` move to the new
  identity on first open (`reassignOwner` in the data package: the owner-keyed projection is dropped and
  rebuilt from the document). A database owned by another identity is never overwritten.
- **Recovery kit** (`/kit`): "Protect your places" card on the map after 10 places or 3 days ("Later"
  turns it into a dot on the Settings button for 7 days). The phrase is shown on demand, exported as a
  password-manager entry (share sheet: title, phrase as password, address as URL, key fingerprint and
  protocol in the notes), copied field by field (clipboard cleared after one minute, also checked on
  return to the foreground), or printed (expo-print; on web a print view in a hidden frame). Then
  3 random words are asked; once they match, the phrase is erased from the device for good. In
  local-only mode the kit says the phrase alone does not bring the places back and points to the export.
- **App lock**: on by default only when the phone has no screen lock (expo-local-authentication
  `getEnrolledLevelAsync`), then with an app code (salted hash in the secret store; 30 s doubling wait
  after 5 wrong codes); otherwise offered with Face ID / fingerprint / phone code. Locks on start and
  after 5 min in the background (choice: right away, 1, 5, 15 min); an opaque cover hides the app in
  the app switcher. The screens stay mounted underneath (nothing typed is lost). "Lock or wipe after
  N days without sync": see Devices below.
- **Settings** (`/settings`, button in the filter bar): profile, kit status, storage (summary, link to Settings › Storage),
  app lock, this device (date added, identity and device key fingerprints, primary device on/off:
  turning it back on asks for the 12 words once the phrase is gone), theme and language (both kept per
  device now).
- **Storage** (`/storage`, `/storage/setup`, `/storage/move`, T-203; logic in `src/storage/`, tested): Settings ›
  Storage shows local only or the current storage (where my devices write, the certified read address for friends,
  last test), the connection test, and the previous storages that keep a signed redirect. The wizard offers
  Nextcloud (server + user + app password → `<server>/remote.php/dav/files/<user>/TrianguLair/`; the public share link
  `…/s/<token>` → `…/public.php/dav/files/<token>/` as read address), generic WebDAV, S3 (endpoint, bucket, region,
  keys, prefix, path or host style; read address suggested as `<endpoint>/<bucket>/<prefix>`), SFTP (shown, marked
  "Desktop only": `ssh2` needs Node) and HTTPS only (published by other means). Fields are validated as typed
  (http write URL: warning; the read address must pass the crypto package's `checkLocation`: public https, no query,
  no credentials). Credentials live in the secret store (`storage` entry; web: the test-only store).
  - **Test connection** (`connectionTest.ts`): reach (HEAD `index.json` with the credentials; on the web a transport
    failure is told apart: a `no-cors` request that gets through means CORS), write/read back/delete a test file (creates
    the folder), `probeConditionalWrites` (emulated conditions are kept in the config), an anonymous GET of a test file
    at the read address (401/403, 404 "another folder", other bytes, CORS), ETag visible to scripts (web), certifiable
    address, existing `index.json`. Each failure comes with fixes, some to copy: Nextcloud share-link steps, S3 bucket
    policy (anonymous `GetObject` on the prefix only, never `ListBucket`), AWS "Block public access", S3 CORS rules,
    Apache / nginx CORS rules for WebDAV with this app's origin, read-address CORS headers.
  - **First storage**: after a passing test, the master key (one tap on the primary device, else the 12 words, checked
    first) issues sharing certificate rotation r + 1 with `location` = the read address (`certify.ts`); the kit then
    carries the address and protocol.
  - **Move** (`migration.ts`): plan (files, size, conflicts, files already there), copy with progress and cancel (packs and
    photos in parallel with `If-None-Match: *`, index files last; identical files already there are skipped, so a
    cancelled move resumes; different ones are a conflict and nothing is overwritten; the source is listed again
    and changes copied in another round, compared by content because weak/coarse ETags change on their own), verify
    (every destination file read back, BLAKE2b compared), then certify the new address (master key) and switch: the
    old storage becomes a redirect kept 180 days (`REDIRECT_KEEP_MS`), the invitations warning is shown and the
    cancelled ones are listed when the sync engine provides them. HTTPS-only destination: the owner copies the folder,
    the app verifies it at the new address. A crash between the certificate and the state write is finished on the
    next start (`pendingMove`).
  - **Right moment** (`useStorageForSharing.tsx`): `ensure(reason, returnTo)` for the sharing flows (opens the wizard
    with `?reason=invite|link-list|public-list|backup&return=…` and returns false), `StorageNeeded` /
    `StorageNeededIfMissing` cards (used in the list editor and the list share screen; the card's button calls
    `ensure()`); the "Protect your places" card now opens the wizard too.
  - **For the sync engine** (`interfaces.ts`): `StorageAccess` (current config, write and read adapters, certified read
    address, redirects with their adapters, `republishPending` / `markRepublished`), `SharingCertRotation`
    (`IdentityApi.currentSharingCert` / `rotateSharingCert({ location?, revokeDevices?, newKey? }, master)`, also meant
    for "Declare a device lost") and `StorageMoveHooks` (`publishAfterMove({ cert, to, redirects })`,
    `openInvitations(previousCert)`), registered with `registerStorageMoveHooks`. Until hooks exist, a connect or move
    sets `republishPending`: the next sync publishes the index signed with the new certificate at the new storage and
    the same index at every redirect. Other devices and the recovery vault receive the rotated sharing key from the
    sync engine (`RotationResult.sharing`, `vaultCopy`).
- **Sync** (T-210, `src/sync/`; logic in `controller.ts`, tested in `sync.test.ts`): `SyncProvider` builds one
  `SyncController` per identity and database. The controller builds the `SyncEngine` from the identity's keys
  (`device-keys`, `sharing-key`, and `sync-keys`: earlier sharing key pairs and vault data keys), the storage settings
  (`StorageAccess`; HTTPS-only mode and local only publish nothing but still read friends) and the data store (state in
  the same SQLite database, table `sync_state`). A `SyncScheduler` runs it as `(reason, opts) => engine.sync(opts)`: on
  launch, on return to the foreground, 3 s after my last edit (only edits that changed my document: `onLocalEdit` in
  the DataProvider), on pull to refresh (list, What's new, sync status) and once when the app goes to the background;
  nothing after that. Network status from the browser on web (`online` / `offline`); native assumes online for now.
  - **Storage moves**: the controller is the registered `StorageMoveHooks`: `publishAfterMove` removes the copy of my
    old index at the new storage (it certifies the old address), publishes there with the new certificate, then
    writes the same index at every previous storage (the signed redirect friends follow); an index of another identity
    stops it (`ForeignIndexError`). `republishPending` does the same at the next pass. `openInvitations` lists the
    open invitations of the previous certificate (named through `invitationName`, from the ContactsService).
  - **Remote wipe**: the engine's hooks erase every secret-store entry, then the database (`DataStore.wipe()`, then
    the file itself: `AppStore.erase()`), then the device settings; the whole app is replaced by "This device was
    removed" (`DeviceRemoved.tsx`).
  - **Status** (`problems.ts`, `noteText.ts`, the spec's error table): a note under the map's filter bar ("Offline · 3
    changes pending", "Your storage hasn't responded since yesterday" after 24 h, "Reconnect your storage" leading to
    Settings › Storage, quota, missing key, content of mine that does not verify); nothing for transient problems.
    Settings › Sync status (`/sync`): my storage (state, last success, pending, the problem with what to do), each
    person I follow ("Updated 12 days ago", "Léa's content could not be verified", "Update the app to see Léa's
    places"), "Sync now" (resumes after reconnecting), and the local technical log (error names and paths only).
  - **Contacts** (T-208/T-209 wiring): `controller.port()` is the contacts screens' `SyncPort` over the controller's
    own engine (`engineSyncPort`); the SyncProvider registers it with `registerSyncPort` (`src/contacts/registry.ts`),
    again after each new engine (storage connected or moved), so there is one engine and one publisher per database.
    The port's `publish` and `readFriend` run inside the controller's lock, between passes. At every pass a friend
    whose invitation link I answered is also read with that invitation key (engine option `friendKeys`, loaded from
    the secret store's `invitations-received` before each pass), until they accept my answer: otherwise a regular pass
    would erase what the invitation showed. Names given in the flows (the name typed when inviting, when answering,
    a rename) go to the person row (`nameContact`, and `contactName` fills a row without one), so places, What's new
    and the sync status show them rather than "A friend". `addContact({ location, owner?, … })` remains for the unit
    tests.
- **Devices** (T-206, T-207; logic in `src/devices/`, tested in `devices.test.ts` and `flow.test.ts`):
  - *First launch "I already have TrianguLair on another device"* (`/welcome/device`): the device name, then QR code,
    link + 6-word code, or the 12 words with the storage read address (`restoreWithPhrase`: the phrase copy of the
    sharing key at `keys/<owner>.bin`, then the vault). Devices review F-05: the copy must hold the certificate my
    index publishes there (same rotation and key) and the vault must open with it, else "stale" (a copy put back from
    before a declaration is refused); a kit naming a previous storage follows its signed redirect. The copy is kept
    in the secret store with the certificate it was made for (`identity/recovery.ts`) and uploaded only for the
    current key; a primary device (or a pending phrase) seals a fresh one when it is missing or older, any 12-word
    prompt (adding a device, a key change) refreshes it, and otherwise Settings › Devices says that restoring with
    the 12 words is not ready and asks for them once (`IdentityApi.writeRecoveryCopy`). The new device makes its own keys; its master-signed device
    certificate comes from the other device (primary: one tap; else the 12 words) or from the words typed here; the
    sharing key, vault data key, storage access and first name come with it (storage settings from the vault value
    `storage`); no demo seed; then it syncs.
  - *Settings › Devices* (`/devices`): every device with a master-signed certificate in the vault (name, date added,
    "This device", "Primary"), rename, remove, declare lost, add, changes since a date, primary device lost. Removed
    (struck through) means revoked by my current sharing certificate, nothing else; names, dates and the primary mark
    are display entries signed by the device that wrote them (`packages/sync` devices.ts, devices review F-02).
  - *Add a device* (`/devices/add`): QR (default) or link + code. The request shows the new device's name and the
    first 8 digits of a 12-digit number of its key; the user types the last 4 digits shown on the new device (devices
    review F-03), then approves with the master key. **No key leaves the old device before that**: the device
    certificate and the sharing key with the vault data key (TLSK mode 1, sealed to the new device key) are sent only
    then, and the storage access follows from the vault. The new device is listed (`register`) only once it has
    picked its package up (review F-04): "Cancel" before that leaves nothing behind. "Not my device" (or digits
    that differ) gives nothing and offers **Change my key now** (`/devices/lost?rogue=<id>`: a key change that revokes
    that device id for good and cancels the open invitations). The transfer is cancelled when the screen closes, and
    its files are deleted at expiry by the controller anyway.
  - *App-level wrappers* (`channel.ts`, not crypto formats; the crypto package is unchanged). Link + code: the
    **device link** `https://triangulair.app/d#<b64url(1 | slot 16 B | read address)>`; `transfer/<slot>.bin` = the
    frozen TLTX blob (Argon2id from the 6 words, 15-minute authenticated expiry) of an invitation to enrol `{owner,
    read address, slot, random channel key}` (no key of mine), fetched anonymously at the read address; the new
    device answers with a **request link** `https://triangulair.app/d#<b64url(2 | slot | request)>` (its public keys
    and name, XChaCha20-Poly1305 under the channel key), which the user sends back to the old device (the new device
    has no storage access yet); the old device drops `transfer/<slot>.ok` = {device cert, TLSK sealed to the new
    device} under the channel key; the new device deletes the files once it has them. QR: the new device shows
    `TLDA1:<b64url(sign pk | box pk | ephemeral X25519 pk | name)>`, the old one answers `TLDB1:<b64url(slot |
    ephemeral pk | read address)>` and drops `transfer/<slot>.qr` = {device cert, TLSK sealed to the new device}
    under BLAKE2b(X25519(ephemerals) | both pks | slot): the shared temporary key of the spec.
  - *Declare a device lost / remove it* (`/devices/lost`): a device that keeps, or may keep, the master key is not
    declared this way (devices review F-06, `risk.ts`): its own primary mark sends the user to the identity change;
    when neither this device nor another one says it is primary, the screen asks "Did it keep your master key?"
    (yes: identity change). Otherwise the master key (`rotateSharingCert({ revokeDevices, newKey })`:
    new random sharing key and vault data key, rotation + 1), then `SyncController.declareLost` (`rotateKey`: every open
    invitation cancelled for a declaration, key delivered to the remaining devices, recovery copy, re-encryption,
    publication). A declaration (not a removal) also gives every live link-only list a new link (the lost device held
    the keys); the result lists those lists, each opening its share sheet. The result lists the people invited who had
    not answered, guides the storage access change per
    protocol for the current storage and every previous one still redirecting (`guide.ts`: Nextcloud Devices & sessions
    link, AWS access keys link, steps for WebDAV and HTTPS-only, "Type the new credentials"), and links to the changes.
    New credentials typed on one device reach the others through the vault value; a device whose credentials are
    refused reads the vault anonymously at the read address and takes them. Devices review F-01: the value counts
    only when signed by my master key or a certified device my current certificate does not revoke (the declaration
    drops what the lost device signed and resets the values to the declaring device's), and a device takes **only new
    credentials for the same storage** (`sameWriteTarget`: kind, read address, WebDAV URL or S3 endpoint, bucket,
    prefix, region, path style): another write endpoint is never adopted from the vault.
  - *Changes since a date* (`/devices/changes`, `journal.ts`): at each pass that imports my other devices' changes,
    the controller records my saves before and after, with the device that signed them (120 days, 400 changes);
    filtered by date and by the lost device; "Revert" puts back the values kept here (trash / restore, comment, status,
    price, sharing, tags) as a new edit; a place purged for good cannot be brought back here.
  - *Declare the primary device lost* (`/devices/identity`): the 12 words → new phrase and master key, move signed by
    both (`issueIdentityMove`), this device re-certified and primary, new sharing key, same read address; the old
    index and files are removed, the vault records continue under the new owner (no invitation, only this device), the
    database is reassigned (`identity-moved-from`), every index carries the move, and the new kit is shown. Friends
    follow the move ("… changed their identity" in What's new and contacts, verified mark removed).
    Devices review F-08: the screen shows the storage access guide first and the button works only once the user
    confirms the access was changed (the thief still holds it); it says that the stolen device is not erased and the
    other devices stop. The move is recorded first (`pending-move` secret; an interrupted move finishes at the next
    launch), the old controller only stops, and the new identity's controller carries the vault records over
    (`migrateMovedBook`) and replaces any index of the old identity at each publishing pass (`clearMovedIndex`: an
    old index put back by whoever still has the access does not stay).
  - *Lock if no sync for N days* (Settings › App lock: off, 3, 7, 14, 30 days, optional erase): after N days without
    reaching my storage the app is covered until a sync succeeds (which wipes it if it was declared lost), or erased.
    Devices review F-07: the days count up to the latest time this device ever saw (`clock-mark` device setting,
    moved forward at launch, each pass and every minute; reset only by a successful sync), and a clock set back more
    than 10 minutes before a time already seen (the last sync, the option, the mark) locks at once ("the clock was set
    back").
- **Friends' places** (T-210): one pin per place (no badge); "Also at my friends'" filter; a friends row in the
  filter bar opens "Friends shown" (all, none or a selection, with search, avatar and number of places; remembered
  per device, `friendsSelection.ts`; a friend's place of nobody shown is not displayed, and a removable pill shows the
  selection in the folded bar); "N friends" in the list rows, on the card and on the add screen. The card's friends
  section (`FriendsSection.tsx`) opens who saved it, when, their status, comment (within its visibility) and their
  tags in their author's color.
- **What's new** (`/whatsnew`, `whatsNew.ts`): built from the reader's differences after each pass and kept in the sync
  state (erased by a remote wipe): places added (someone's first places as one item), new comments, switches to
  tried / favorite, key changes and moves; minor touch-ups are left out, and the news of a place that left their shared
  places goes with it. Grouped by day, filtered by type and by friend, a dot on items newer than the last visit, a
  badge on the map's What's new button; "See on the map" highlights their places (the others faded, a removable pill).
- **Invitations and access** (`/invite`, `/invite/answers`, `/invite/received`, `/invite/face`, `/contacts`,
  `/contacts/[owner]`, deep links `/i#…` and `/r#…`; T-208, T-209; logic in `src/contacts/`, tested). Screens talk to
  `ContactsService` (`service.ts`) only, which sits on a `SyncPort` (`port.ts`): the sync package's contact API
  (`addContact`, `setPolicy`, `removeContact`, `addInvitation`, `contacts`) plus `records` / `updateRecords` (answers and
  the accepted responder in the vault, a contact without storage), `publish`, `fetchIndex`, `readFriend`. `engineSyncPort`
  is the adapter from a `SyncEngine`; the SyncProvider registers the one over its own engine with `registerSyncPort`
  (the screens show "loading" until then), and the ContactsProvider registers the service back
  (`registerContactsService`) for names and invitation keys.
  - *Invite a friend* needs a storage (`useStorageForSharing().ensure('invite', '/invite')`), publishes the index that
    lists the invitation, then shows the short link (≤ 200 characters) and its QR code (`qrcode-generator`, version ≤ 10),
    share sheet / copy; pending invitations with expiry, phase (waiting, answered, several, accepted, someone else
    answered after acceptance, expired in the 7-day grace, cancelled by a key change) and cancel (withdrawn: not
    listed, the packs it opened are re-sealed); a field to paste a return link.
  - *Answers*: one card per responder with the warnings of the spec (several answers, a second one after acceptance with
    "Remove …", opened after expiry, no storage to check them), the safety code, then what they see (everything shared
    with friends by default, some lists, nothing), "I see their places", "I compared the code"; acceptance publishes:
    the invitation key is no longer a recipient, packs re-sealed with new pack keys.
  - *Received*: the link (pasted, any text holding it, or the deep link: the fragment is removed from the address bar
    and passed in memory) is checked against the inviter's index read only at the link's address; I name the person
    (no format carries names: names are petnames kept on this device), see the safety code, optionally share back,
    and get the return link (`https://triangulair.app/r#<b64url>`, app-level wrapper of the frozen bytes) with QR.
    Their places show right away with the invitation key (kept in the secret store, `invitations-received`;
    `invitationKeysFor(owner)` gives the SyncProvider the extra keys to read with until acceptance).
  - *First launch "I received an invitation link"*: checks the link before any identity exists (`verify.ts`), keeps it
    in the secret store (`pending-invitation`) and opens the answer once the first launch is done.
  - *Face to face*: the compact format is not specified (R-13), so the existing invitation link and return link are
    exchanged as QR codes (scan with `expo-camera`, web: browser camera + BarcodeDetector when available, or paste);
    both sides mark the other verified automatically.
  - *Contacts*: two switches, share scope, safety code as 12 × 5 digits or QR (`tlsafe1:` payload compared with
    `matchSafetyQr`), the "verified" mark (local, never sent), rename, remove (wraps gone, pack keys renewed), notices
    "… changed their key" (higher rotation) and "… changed their identity" (retired owner: the mark is removed).
  - *Follow a list by link*: see "Following a list by link" above (T-212).
  - New native module: `expo-camera` (camera permission text in `app.json`); `app.json` also declares the
    `applinks:triangulair.app` associated domain and Android intent filters for `/i` and `/r` (the site must serve the
    matching `apple-app-site-association` and `assetlinks.json`).
- **Lists on the place card** (`components/ListsSection.tsx`): every list with a tick; manual lists are
  toggled, filter lists say why the place is in or out ("Does not match: tags") with "Add by hand",
  "Leave out" or "Follow the filter" (the list's exceptions).
- **i18n**: English and French (`src/i18n`), device language, `EXPO_PUBLIC_LOCALE` or `?lang=fr`
  on web to force one. No UI string is hard-coded in components.

- **Expo SDK 57** (React Native 0.86, New Architecture, React 19.2), TypeScript, expo-router
- **Map:** `@maplibre/maplibre-react-native` 11 on native and `maplibre-gl` 5 on web, behind one
  component interface (`src/components/map/types.ts`)
- **Base map:** OpenFreeMap Positron (`https://tiles.openfreemap.org/styles/positron`). The dark
  mode uses OpenFreeMap `dark`. Both URLs are set in `src/config.ts`.

## Run

Install dependencies from this folder. The app currently has its own lockfile, like the other packages:

```sh
npm install --workspaces=false
```

The workspace packages are used from their TypeScript sources (`../../packages/*/src`), with no
build step and no change to the root `package.json`:

- `metro.config.js` watches `packages/data`, `packages/osm` and `packages/import`, maps their names to their folders
  (`extraNodeModules`, package `exports` honored) and resolves their runtime dependencies
  (`yjs` and its `lib0`, `opening_hours`) from this app's `node_modules`. On web it empties
  sql.js's Node-only imports. Outside fixture mode it replaces `src/osm/fixtures.ts` by an empty
  module, so the OSM fixture JSON never reaches a production bundle.
- `tsconfig.json` maps the package names to their sources (`paths`) and allows `.ts` import
  extensions; `vitest.config.mts` has the same aliases.

### Web (testing)

```sh
npx expo start --web          # dev server
npx expo export --platform web # static build in dist/
```

### iOS / Android: development build (Expo Go is not supported)

MapLibre Native needs native code. Its config plugin is listed in `app.json`, so you need a
**development build**:

```sh
npx eas-cli@latest login
npx eas-cli@latest build --profile development --platform android   # or ios
# iOS simulator: --profile development-simulator
npx expo start --dev-client
```

You can also build locally with `npx expo run:android` / `npx expo run:ios` (needs Android Studio / Xcode).
`eas.json` defines three profiles: `development` (dev client, internal), `preview` (internal) and `production`.

The bundle ID / package `org.triangulair.app` is a **placeholder** until the final identifier is chosen.
Before the first EAS build, run `eas init` to link a project (it adds `extra.eas.projectId`).

### Data on each platform

- **Native**: `expo-sqlite` through the package's `ExpoSqliteDriver` (`src/data/openStore.native.ts`).
  `app.json` enables R*Tree (`customBuildFlags: -DSQLITE_ENABLE_RTREE=1`, needs a native rebuild).
  Type-checked, not run on a device yet (the document is Yjs, pure JavaScript, so Hermes is no
  longer a blocker).
- **Web**: sql.js (SQLite in WebAssembly, inline build) behind `SqlJsDriver` (`src/data/sqljsDriver.ts`),
  the database file saved to IndexedDB after each write (debounced, and on page hide). When
  IndexedDB is unavailable the data stays in memory and the map says so. sql.js has no R*Tree/FTS5:
  the package's fallback indexes are used.
- **Demo data**: on first launch the 15 sample places in Paris are seeded as tags, my saves (status,
  price, comments), a friend's saves ("Léa") and illustrative OSM info (opening hours, terrace,
  happy hours) so the filters have data (`src/data/demo.ts`).
- Owner id: my identity's master key (`ed25519:…`, see Identity); the document actor is a
  per-device random id kept in localStorage / expo-sqlite's kv-store.

### Secrets on each platform

- **Native**: `expo-secure-store` (iOS Keychain, Android Keystore), `WHEN_UNLOCKED_THIS_DEVICE_ONLY`:
  readable only while the phone is unlocked, never in backups nor restored to another device. Entries:
  `identity` (public record), `device-keys`, `sharing-key` (TLSK sealed to this device), `primary-identity`
  (primary device only), `pending-phrase` (only until the kit is confirmed), `lock-code`. Native also
  needs `crypto.getRandomValues`, installed from `expo-crypto` (`src/polyfills.native.ts`).
- **Web (test build only)**: a separate IndexedDB database, each value encrypted with AES-GCM under a
  random **non-extractable** WebCrypto key kept in the same database (the entry name is the associated
  data). This keeps raw key bytes out of storage exports and disk copies, but any script running on the
  page can ask the browser to decrypt: no protection against XSS, extensions or someone using the
  browser profile. Without WebCrypto (plain http on a LAN address) values are stored unencrypted; without
  IndexedDB they live in memory. All three are labelled on the welcome screen and in the settings
  ("Don't use it for your real places"). A passcode-derived key was not chosen: a prompt on every load of
  a build that must not hold real secrets anyway.
- **Fixture mode, web**: `?autostart=1[&name=…]` creates the identity without the first-launch screens
  (screenshots and end-to-end tests; the other shot scripts use it).

New native modules (a new development build is needed): expo-secure-store, expo-local-authentication,
expo-clipboard, expo-print, expo-image-picker, expo-image-manipulator, expo-location, expo-crypto; their
permission texts are in `app.json`. `libsodium-wrappers-sumo` (asm.js on Hermes, not yet timed on a device)
and `@scure/bip39` are resolved from this app like the other packages' dependencies.

### OSM services, offline and fixture mode

All OSM calls go through one `createOsmClient()` (`src/osm/client.ts`). Failures never block a
screen: the add screen falls back to the places on this device ("Nearby, on this device") with a
clear message, the card keeps its cached info. **Fixture mode** answers every OSM request with the
osm package's test fixtures (synthetic places in the Marais), for offline demos:

```sh
EXPO_PUBLIC_OSM_FIXTURES=1 npx expo export --platform web
```

Zone sources have their own synthetic fixtures (`src/osm/zoneFixtures.ts`: four quarters of the
Marais, a few streets with shared intersection nodes, "Paris" for Nominatim), routed by
`zoneFixtureFetch.ts`. Real queries carry a `/* tl:… */` marker comment.

In fixture mode the demo seed also saves "Trattoria Da Lucia" (a fixture place), so the add screen
shows "Already in my places".

### Checks

```sh
npm run typecheck   # tsc --noEmit (also type-checks the packages' sources used by the app), then e2e/
npm test            # vitest: pins, clustering, filters, card wording, add-place logic, list query,
npm run typecheck   # tsc --noEmit (also type-checks the packages' sources used by the app)
npm test            # vitest: identity creation glue, kit export formats, lock and "protect" rules,
                    # no hard-coded UI strings (scans every .tsx), pins, clustering, filters, card wording, add-place logic, list query,
                    # sql.js driver + DataStore + demo seed, fixture fetch, i18n (en/fr parity),
                    # import screen logic
npm run export:web:fixtures && npm run e2e   # end-to-end tests (Playwright, Chromium, headless)
```

End-to-end tests (T-119, `e2e/`, `playwright.config.ts`): Playwright Test against the fixture-mode
web export served by `scripts/serve.py` (port `E2E_PORT`, default 4319). `e2e/helpers.ts` fixes the
clock (Friday 23 October 2026, 18:30 in Paris), answers the base map style and photos with
placeholders, and fails a test on any uncaught page error. Each test has a fresh browser context
(new IndexedDB, demo seed). Selectors are test ids, roles and visible text; the map is driven
through `window.__tlMap`. First time: `npx playwright install chromium`.

Screenshots in fixture mode: `python3 scripts/shots.py docs importer` (phone) or `importer_tablet`
(the import preview uses `packages/import/test/fixtures/kml/my-maps.kml`, matched against the OSM
fixtures; `SHOTS_BASE` overrides the server address).

## Configuration

`src/config.ts` reads these variables at build time:

| Variable | Default |
|---|---|
| `EXPO_PUBLIC_MAP_STYLE_URL` | `https://tiles.openfreemap.org/styles/positron` |
| `EXPO_PUBLIC_MAP_STYLE_URL_DARK` | `https://tiles.openfreemap.org/styles/dark` |

The attribution "© OpenStreetMap contributors, OpenFreeMap" is drawn by our own overlay
(`MapAttribution`), so it is always visible. When a place sheet is open, the overlay moves above it.

## Layout

```
src/app/              expo-router screens: index (map), list, add, place/[id], welcome/*, kit, settings, storage/*, _layout (providers)
src/contacts/         invitation and access flows: ContactsService, SyncPort and engine adapter, links, phases and
                      warnings, QR codes, scanner, provider, deep links
src/storage/          storage config and URL builders, adapters, connection test and fixes, migration, certificate
                      rotation, state (secret store), provider, sharing prompt, interfaces for the sync engine
src/sync/             sync controller (engine, scheduler, move hooks, wipe), provider, What's new, friends'
                      places (card section, friends shown), sync status wording
src/identity/         identity creation (create), secret store (native / web), kit formats, app lock, protect card
src/firstLaunch/      first-launch frame, profile and code fields, steps
src/components/map/   Map.native.tsx, Map.web.tsx, Map.tsx (type fallback), types.ts, cluster.ts
src/components/       FilterBar, PlaceSheet, PlaceCard, SaveEditor, ScreenHeader, DataGate, ui
src/data/             DataProvider, openStore.{web,native}, sqljsDriver, webPersistence, demo, usePlaces
src/osm/              client (one OSM client), fixtureFetch + fixtures (fixture mode), errors
src/zones/            zone geometry (raster painting/buffer, simplify, streets graph, drawing), OSM zone
                      queries, map shapes and badges, zone editor and card
src/lists/            list draft/filter building and "why in/out", list editor and map; sharing helpers (links,
                      "looks like a home", followed lists by author, preview pins), public warning, preview
                      map, someone else's list view
src/places/           pure logic: filters, clustering, model, card, add, list, camera
src/pins/             bands.ts, pinSvg.ts, build.ts (pins from places and the filter)
src/i18n/             core (plurals, placeholders), en, fr (+ filtersTags.en/fr), provider
src/filters/          filter storage, collapsed-summary pills, labels, usePrunedFilter
src/tags/             tag tree, friends' tags mapping, suggested color/icon, icon set, text folding
src/closure/          closed-place glue (pure), runner, useClosureCheck, signal wording
src/state/            AppState (filter, last map area, focus) shared by the screens
src/theme/            tags.ts (palette, demo tags, category icons), icons.ts, colors.ts
src/config.ts         map style URLs, attribution, initial camera, fixture flag
```

## Pins

- **Shape:** teardrop pin with an SVG `viewBox` of 40×52. The tip is the anchor point.
- **Tag colors:** the colors are saturated and set in `src/theme/tags.ts`.
- **Tag icons:** Material Design Icons paths (Apache-2.0, `src/theme/icons.ts`, `iconsExtra.ts`), about
  50 curated in 8 groups (`src/tags/iconSet.ts`); not the spec's Maki/Temaki set yet.
- **Maybe closed:** small grey disc with a white cross at the top right.
- **Icon:** the icon of the first tag, drawn **white** with a dark halo. The halo is the same path
  drawn first with a dark stroke.
- **Several tags:** the round body is split into up to **3 horizontal color bands** of equal height,
  stacked in tag order and centered on the body. The tail takes the color of the last band.
  Tags hidden by the filter are removed from the bands.
- **Friends-only places** (`ownerIsMe: false`): the bands are drawn at 50% opacity over white, which
  gives a lighter pin, and the whole pin is slightly translucent.
- **Selected pin:** drawn 1.3× larger.
- **Filter active:** matching pins take the color and icon of the filtered tag; the others (and
  places lacking the information, spec "unknown info") are grey, 40% opacity and 0.72× smaller.
- **Clusters:** computed in JS on the viewport's pins (radius 56 px, none from zoom 15); a bubble in
  the majority color of its matching members, grey if none matches; tapping zooms in.

Both platforms use the same SVG string (`pinSvg()`):

- **Web:** inline SVG in a `maplibregl.Marker` HTML element.
- **Native:** `SvgXml` from react-native-svg inside a MapLibre RN `Marker`.

This is simple, and native and web look the same, which is good enough for tens or a few hundred
pins. **Later:** move native rendering to a `GeoJSONSource` + `SymbolLayer`, with one pre-rendered
image per color/icon combination (made at build time or with Skia) and engine-side clustering.

## Responsiveness and accessibility

- **Light/dark:** follows the system setting for both the UI and the map style. The "Theme" button in
  the filter bar cycles Auto / Light / Dark; the choice is kept per device (also in Settings).
- **Text size:** text follows the system font size. Chips and labels cap it with
  `maxFontSizeMultiplier`, and nothing uses a fixed height.
- **Layout:** pure size classes in `src/theme/layout.ts` (Material breakpoints: compact < 600 ≤ medium
  < 840 ≤ expanded), fed by `useWindowDimensions`. On wide windows (tablets, unfolded foldables,
  landscape phones) the filter bar becomes a floating panel with wrapped chips and the place card opens
  as a side panel on the right. On compact windows (phones, outer screens, Display Zoom) the chips
  scroll sideways and the card is a bottom sheet docked full width. Layout changes never reset state.
- **Initial camera:** fits all places in the visible area (`src/places/camera.ts`), computed once; with no
  place yet, the position found at the first launch's location step.
- **T-117/T-118 pass** (`scripts/shots_first_launch.py adapt` and a matrix run of every screen at 320, 344,
  430, 690, 834 pt wide and 844×390 landscape, text at 1.0 / 1.5 / 2.0, light and dark, checking for text
  outside the window and cut text): headers wrap (title without a line limit, actions move to a second
  line), buttons and pills never get wider than their container (text wraps), search fields shrink and
  their button wraps below, fixed line heights removed (they do not grow with Dynamic Type), the place
  page is a 680 pt column on wide windows. The first-launch, kit and settings screens are one centered
  column (560/640 pt) with the actions after the content.

## Screenshots

Taken from the web export in fixture mode with Playwright (Chromium), clock set to Friday
23 October 2026, 18:30 in Paris (`scripts/shots.py`). The sandbox had no access to the tile server
or photo hosts: the map style is answered with a background-only placeholder (blank base map) and
photos with a placeholder image; pins, clusters, UI, data and credit lines are real.

| File | Shows |
| --- | --- |
| `docs/phone-map-clusters.png` | Map zoomed out: clusters in the majority tag color, multi-tag pins, friends' places faded |
| `docs/phone-map-filters.png` | Filters Bar + Terrace: matching pins in color, the others and their clusters grey |
| `docs/phone-place-card.png` | Card of an OSM place: opening line, address, chips, Panoramax photos with credits |
| `docs/phone-add-nearby.png` | Add screen: nearby places by distance, "Already in my places" |
| `docs/phone-add-search.png`, `docs/phone-add-form.png` | Search as you type, then the save form |
| `docs/phone-list.png`, `docs/phone-list-search.png` | List (recent), text search in comments |
| `docs/tablet-map-filter-card.png` | Tablet: "Open now" filter, card as side panel with happy hour |
| `docs/tablet-list.png` | Tablet: list by distance and card side by side |
| `docs/phone-dark-card.png` | Dark mode |
| `docs/phone-fr-add.png` | French UI |

Filter bar, tags and closed places (`scripts/shots_filters.py`, same setup; `SHOTS_BASE` picks the server):

| File | Shows |
| --- | --- |
| `docs/phone-closure-notice.png` | Monthly check on open: grouped "maybe closed" notice |
| `docs/phone-filters-expanded.png` | Expanded bar: tag + its sub-tags, friends' tags, Eat & drink with type and cuisine, Terrace |
| `docs/phone-filters-collapsed.png` | Collapsed summary: one removable pill per filter, matching pins in color, the rest grey |
| `docs/phone-maybe-closed-card.png`, `docs/phone-dark-maybe-closed.png` | Card: "Maybe closed" with reason, date, confirm / still open |
| `docs/phone-card-directions.png` | Card: directions and open in Apple Maps / Google Maps / OSM |
| `docs/phone-tags.png`, `docs/phone-tag-editor.png` | Tag tree; editor of the sub-tag "Restaurant › Pizza" |
| `docs/phone-friend-tags.png` | Friends' tags: author colors, color clash warning, link picker |
| `docs/tablet-filters-expanded.png`, `docs/tablet-tag-new.png` | Tablet: Culture + "Entry ≤ €20"; new tag with suggested icon |
| `docs/phone-fr-filters.png` | French filter bar |
First launch, kit, settings, card lists and screen adaptation (`scripts/shots_first_launch.py`, same setup;
font scale is mimicked by enlarging every text of the page, see the script):

| File | Shows |
| --- | --- |
| `docs/phone-welcome.png` | Welcome: the promise, three entries, web test-build warning |
| `docs/phone-welcome-profile.png`, `docs/phone-welcome-lock.png` | First name and photo (key made meanwhile); app lock with a code (mismatch shown) |
| `docs/phone-welcome-location.png`, `docs/phone-welcome-import.png` | Location explained before the prompt; import or later |
| `docs/phone-welcome-invitation.png` | The invitation entry |
| `docs/phone-map-hint.png`, `docs/phone-protect-card.png` | Map with the "+" hint; "Protect your places" card and reminder dot |
| `docs/phone-lock-screen.png` | App lock on the next launch, wrong code |
| `docs/phone-kit.png`, `docs/phone-kit-export.png` | Recovery kit: the 12 words; export (clipboard cleared in one minute) |
| `docs/web-kit-print.png` | Printable page (web print view) |
| `docs/phone-kit-check.png`, `docs/phone-kit-done.png` | 3 words asked again (one wrong); kit saved, phrase erased |
| `docs/phone-settings.png`, `docs/tablet-fr-settings.png` | Settings (phone; tablet in French) |
| `docs/phone-card-lists.png`, `docs/tablet-dark-fr-card-lists.png` | Lists on the place card: manual tick, filter reasons and exceptions |
| `docs/small-font2-welcome.png`, `docs/small-font2-map.png`, `docs/small-font2-settings.png` | 320 pt wide, text at 2.0 |
| `docs/large-font15-kit.png` | Large phone, text at 1.5 |
| `docs/fold-outer-profile.png`, `docs/fold-inner-profile.png` | Foldable: outer screen, then unfolded with the typed name kept |
| `docs/landscape-dark-welcome.png`, `docs/landscape-dark-kit.png` | Landscape phone, dark mode |

Zones and lists (`scripts/shots_zones.py`, same setup):

| File | Shows |
| --- | --- |
| `docs/phone-zone-neighbourhood.png`, `docs/tablet-zone-neighbourhood.png` | OSM neighbourhoods to tap, one picked |
| `docs/phone-zone-draw-points.png`, `docs/phone-dark-zone-draw.png` | Drawing by points (closed; a vertex selected to move, dark mode) |
| `docs/phone-zone-paint.png` | Painted zone with fuzzy outline |
| `docs/phone-zone-streets.png` | Street segment following the streets between two handles |
| `docs/phone-zone-card.png`, `docs/tablet-map-zone-card.png` | Zone card (places inside, tags, status…) |
| `docs/phone-map-zones.png` | Zones on the map: outlined, painted, street, badges |
| `docs/phone-list-editor.png`, `docs/tablet-list-editor.png` | List editor: tags, statuses, zones (mine, by name), visibility |
| `docs/phone-list-preview.png`, `docs/phone-list-reasons.png` | Preview map and count; why each place is in or out (private never) |
| `docs/phone-list-view.png`, `docs/phone-list-view-rows.png`, `docs/tablet-list-view.png` | A list: map, rows, card |
| `docs/phone-fr-list-editor.png` | French, manual list |

Storage settings (`scripts/shots_storage.py`, against the Apache WebDAV server of
`packages/storage/scripts/real-servers.sh` through a CORS proxy started by the script; friends' read address
`https://friends.triangulair.test/pub/…` answered from Apache's anonymous `/pub`):

| File | Shows |
| --- | --- |
| `docs/phone-storage-local.png`, `docs/phone-storage-choose.png` | Local only; the protocols (SFTP "Desktop only") |
| `docs/phone-storage-nextcloud-form.png` | Nextcloud helper: folder URL built from server and user, problems after "Test" |
| `docs/phone-storage-test-cors.png`, `docs/phone-dark-storage-test-cors.png` | Web build against a server without CORS: diagnosis and rules to copy |
| `docs/phone-storage-test-ok.png`, `docs/phone-dark-storage-test-ok.png`, `docs/phone-storage-certify.png` | Every step passed; certify with the master key |
| `docs/phone-dark-storage-connected.png` | Connected storage, dark mode |
| `docs/phone-storage-move-plan.png`, `docs/phone-storage-move-progress.png` | Move: plan, invitations warning; copy progress with cancel |
| `docs/phone-storage-move-verified.png`, `docs/phone-storage-move-done.png` | All files verified; moved, redirect date, kit and access hints |
| `docs/phone-storage-overview.png` | Settings › Storage after a move: previous storage kept as redirect |
| `docs/tablet-fr-storage-s3.png` | Tablet, French: S3 form, empty prefix warning, key policy to copy |
| `docs/tablet-fr-list-storage-needed.png` | The "right moment": a link-only list asks for a storage |

Shared lists (`SHOTS=1 npm run e2e -- lists-sharing`, same Apache setup, two browser contexts: Anna with a storage,
Ben without one and not her contact):

| File | Shows |
| --- | --- |
| `docs/phone-list-share-link.png` | Share sheet, link only: the link, its QR code, share / copy, New link, Stop sharing |
| `docs/phone-list-share-new-link.png` | "New link": the old link stops working for everyone who has it |
| `docs/phone-list-follow-preview.png`, `docs/phone-fr-list-follow-preview.png` | Ben opens the link: preview (map, places, author, date), "Follow this list" |
| `docs/phone-list-followed.png` | The followed list: its places (rows) |
| `docs/phone-list-followed-gone.png` | After Anna's new link: "This link no longer works", places gone |
| `docs/phone-lists-followed.png` | Followed lists by author: the dead link-only list and the public one |
| `docs/phone-list-public-warning.png` | Before publishing: anyone can read it, author's responsibility, homes |
| `docs/phone-list-share-public.png`, `docs/phone-dark-list-share-public.png` | Public: the GeoJSON file, "View on uMap" and its address, the in-app link (dark mode) |
| `docs/tablet-fr-list-followed.png` | Tablet, French: a followed public list, map and card side by side |

End-to-end: `e2e/lists-sharing.spec.ts` (the exchange is skipped without Apache): Anna connects a storage, saves a
place, makes a manual list and creates its link (published first; the QR code holds the same link); Ben, with no
storage and no contact, opens the `/l#…` deep link (the fragment leaves the address bar), sees the preview without
Anna's friends-only comment, follows it, sees the places in the list screen and in his places, and has no contact;
Anna makes a new link: after Ben's next pass the list says "This link no longer works" and its places are gone,
pasting the old link says so, the new one opens; Anna makes the list public after the warning: the file at the read
address is valid GeoJSON with the ODbL notice, list names and uMap colors, the uMap link is
`https://umap.openstreetmap.fr/en/map/new/?dataUrl=<file>&dataFormat=geojson` and the button opens exactly it; Ben
follows the public list by its link. Without a storage, going public asks to acknowledge the warning and "Share" asks
for a storage with `?reason=public-list&return=/lists/share…`.

Shared lists open questions:

- **Universal links for `/l`**: `app.json` declares the Android intent filter (exact paths `/i`, `/r`, `/l`, so
  `/lists`, `/legal` and the like stay on the site: review Info 3); the site must serve the matching
  `apple-app-site-association` / `assetlinks.json`, and its `/l` page must never send the fragment anywhere (it only
  sends people without the app to the store page; the app's own web export reads it and removes it from the address
  bar).
- **"Add places to my places" and "Ask to follow the author"** (spec, preview actions) are not done: the card's "Add to
  my places" works on each place; asking to follow needs a return link without an invitation.
- **A switch per followed list on the map** (spec "Followed lists panel") is not done: followed lists' places follow
  the friends shown setting (all by default).
- **A followed list that later turns out to be a contact's** is not attached to them automatically (spec: "attach it
  to the author if they are followed later"): it stays a separate source.
- Only public comments travel with a link-only list (sync README open question 10).

Invitations and access (`E2E_SHOTS=1 npm run e2e -- e2e/invitations.spec.ts`, same Apache setup, links exchanged
between browser contexts):

| File | Shows |
| --- | --- |
| `docs/phone-invite-storage-needed.png` | Invite a friend without a storage: the right-moment card |
| `docs/phone-invite-link.png`, `docs/tablet-fr-invite-link.png` | The short link, its QR code, share / copy, pending invitation (tablet, French) |
| `docs/phone-received-verified.png`, `docs/phone-dark-received-verified.png` | The invitee: link checked, name, safety code (dark mode) |
| `docs/phone-received-answer.png` | The return link to send back, with its QR code |
| `docs/phone-received-problem.png` | A forged link: "This link no longer works" |
| `docs/phone-answer-accept.png` | Accepting an answer: what they see, follow, compared |
| `docs/phone-answers-several.png`, `docs/phone-answers-late.png` | Two answers to one link; a second one after acceptance |
| `docs/phone-contacts.png`, `docs/phone-contact-verified.png`, `docs/phone-contact-remove.png`, `docs/phone-dark-contact.png` | Friends: badges and switches; safety code matched by QR; removal |
| `docs/phone-face-show.png`, `docs/phone-face-answer.png` | Face to face: invitation code, then the answer code |

`e2e/invitations.spec.ts` runs the storage-less checks always and the exchanges against Apache (skipped without it): invite,
answer through the `/i#…` deep link, accept, safety-code match by QR payload, access changes, removal; two answers to one link
with a forged link refused; the face-to-face exchange verified on both sides. Each run serves `dist/` on a free port of its
own (never another worktree's server); `E2E_PORT` picks a fixed one.

End-to-end: `e2e/storage.spec.ts` runs against the same Apache server (skipped when it is not running): wrong
password, CORS diagnosis, private read address refused, connect, lossless move of packs, a photo, a public list and the
index (byte for byte on the new storage, old one untouched, redirect listed), and a move onto a folder with other
content that overwrites nothing.

Sync and friends' places (`e2e/sync.spec.ts` with `SHOTS=1`, against the Apache WebDAV server, two browser
contexts: Anna and Ben):

| File | Shows |
| --- | --- |
| `docs/phone-friends-map.png` | Ben's map with "Also at my friends'": friends' places in color; What's new badge |
| `docs/phone-card-friends.png`, `docs/tablet-fr-card-friends.png` | "1 friend" on the card, opened: who, when, status, comment, their tag in their color |
| `docs/phone-friends-picker.png` | Friends shown: all, none or a selection, with places per friend |
| `docs/phone-whatsnew.png`, `docs/phone-fr-whatsnew.png` | What's new: a comment and a favorite (unseen dots), her first places as one item |
| `docs/phone-sync-status.png`, `docs/phone-dark-sync-status.png` | Sync status: my storage up to date, Anna updated just now |
| `docs/phone-sync-offline.png` | Offline · 1 change pending |
| `docs/phone-sync-reconnect.png`, `docs/phone-sync-reconnect-status.png` | Credentials rejected: "Reconnect your storage", writes stopped |

End-to-end: `e2e/sync.spec.ts` (skipped without Apache): both connect a storage and publish; Anna invites Ben from the
invitation screen, Ben opens the link in his browser context, names her and answers, Anna pastes his return link and
accepts (the name she typed when inviting is his contact name); Ben sees her shared place and not her private one, with "1 friend" and her
comment on the card; Anna edits the comment and marks it favorite, Ben gets both in What's new (badge, dots, "See on the
map"); the friends panel hides and shows her places; offline with a pending change, then a 401 ("Reconnect your
storage", back to normal after "Sync now"); Anna sets "They see my places" to nothing on Ben's contact and Ben's cache
drops her places. Passes are triggered with "Sync now" on the sync status screen (no test hook).

Devices, loss and theft (`SHOTS=1 npm run e2e -- devices.spec.ts --workers=1`, same Apache setup, three browser
contexts: Anna, Ben and Anna's new device):

| File | Shows |
| --- | --- |
| `docs/phone-welcome-device.png`, `docs/phone-dark-welcome-device.png` | "Already on another device": the three ways (dark mode) |
| `docs/phone-add-link.png`, `docs/phone-add-confirm.png` | Link + 6-word code on the old device; the new device's request with the number to compare |
| `docs/phone-device-waiting.png` | The new device waiting for approval, the same number |
| `docs/phone-devices.png` | Settings › Devices: this device (primary) and the tablet |
| `docs/phone-dark-lost-confirm.png`, `docs/phone-lost-done.png` | Declare a device lost (dark mode); done, with the storage access guide |
| `docs/phone-changes.png` | Changes since a date, from the lost device, with Revert |
| `docs/phone-device-removed.png` | The lost device after its next sync |
| `docs/phone-whatsnew-key.png` | Ben: "Anna changed their key" |
| `docs/tablet-fr-device-qr.png`, `docs/tablet-fr-add-qr.png` | French tablet: the new device's QR code; the old device's answer code |

End-to-end: `e2e/devices.spec.ts` (skipped without Apache): Anna and Ben become friends; Anna adds a device by link +
code (a wrong code first; the request link back; wrong last digits first), both list the same places and an edit on the tablet reaches the phone, both list the two
devices; Anna declares the tablet lost from her phone: the tablet is wiped at its next sync, Ben keeps reading Anna (a
place added after the declaration) and sees "Anna changed their key". With `SHOTS=1`, a second test adds a device by QR
codes (French tablet).

Devices open questions:

- **Other devices after an identity change** are not carried over: they stop at the move (their index check fails) and
  must be added again; the declaring device becomes the only, primary device.
- **Storage moves with several devices**: other devices get the new certificate through `keys/`, but they keep reading
  the old storage (the redirect) until their settings follow; the move of the storage settings through the vault is
  not automatic yet.
- **Request authentication** (link + code): whoever intercepts the link and the code can write a request; the number
  (last 4 digits typed) is what authenticates the new device, and nothing is released before it.
- **Link + code needs two links**: the invitation to the new device, the request link back (the new device cannot
  write to my storage before its approval).
- **Revert** covers my saves (fields, trash, tags); lists, zones and tags edited by the lost device are only listed by
  the storage's own version history.
- The QR flow needs both devices to scan (two codes); on the web build without camera the codes are pasted.

Sync open questions:

- **Network status on native**: no NetInfo module yet (a new native module): native assumes online, so "Offline" is
  only shown on web; a failure without network is classified as "storage unreachable" (banner after 24 h).
- **Friends' names**: the protocol carries no display name; the name typed in the invitation flow is kept on this
  device. Contacts added on another device (through the vault) show "A friend" until renamed here.
- **Restart after a remote wipe on native**: the removed screen asks to close and reopen the app (no reload API
  without expo-updates).
- **Background grace period**: the last pass runs on AppState "background"; on iOS it needs a background task
  (`expo-background-task` or `beginBackgroundTask`) to be sure to finish; not added.
- Previous sharing keys are persisted only when the engine adopts a new key from another device; a local rotation
  (storage move) keeps the same key pair.

Storage open questions:

- **S3 on a phone**: `aws4fetch` signs with WebCrypto `crypto.subtle`, which Hermes lacks; S3 works in the web build
  only until a SubtleCrypto polyfill (or another signer) is chosen.
- **Nextcloud Login Flow v2** (spec: connection through the browser creating the app password, and the share link made
  automatically through the OCS API) is not done: an app password and a pasted share link for now. The public DAV URL
  (`public.php/dav/files/<token>/`, Nextcloud 29+) is still to be checked against a real instance; older servers need
  another form.
- **Back to local only** from a storage is not offered (it would need a certificate without `location`, and friends
  would lose access): to decide.
- **Redirect period**: 180 days chosen for "a few months"; the old storage's packs are kept as they are (nothing is
  deleted by the app); emptying the old folder after the period is left to the user or a later task.
- The other devices learn the move through the sync engine (new sharing certificate sealed to them, recovery vault
  copy): T-204/T-206.
