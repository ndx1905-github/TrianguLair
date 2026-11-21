# Error cases: traceability (T-213)

Every row of the spec's [Error cases](SPEC.md#error-cases) table, and the error-related rows of
[Synchronization and background](SPEC.md#synchronization-and-background), mapped to the code that
implements it and to the tests that check it.

Each row has a dedicated test in one of these two files, named after the row:

- **Behavior** (what the app does): [`packages/sync/test/error-cases.test.ts`](../packages/sync/test/error-cases.test.ts),
  real sync engines on in-memory storages with injected faults (network down, 401, 507, a write cut
  before the index, a storage host altering files).
- **What the user sees**: [`apps/mobile/src/errorCases.test.ts`](../apps/mobile/src/errorCases.test.ts),
  the notes and messages in English and French, from the pure functions the screens use.

The "Other tests" column lists earlier tests that cover the same row more deeply (review fixes,
end-to-end flows on the real Apache WebDAV server of `packages/storage/scripts/real-servers.sh`).

Paths are relative to the repository root; `sync/` is `packages/sync/src/`, `app/` is `apps/mobile/src/`.

## Error cases

| # | Situation | Code | Tests (row) | Other tests |
| --- | --- | --- | --- | --- |
| 1 | No network | `sync/errors.ts` `classifyError` (`offline` when the app's network status says so); `sync/scheduler.ts` (`setOnline`: nothing attempted offline, a pass when the network is back; `pending` counts the queue); `app/sync/problems.ts` `ownNote` (`sync.note.offlinePending`); `app/sync/SyncBar.tsx`; network status from the browser (web) or `expo-network` (phones), `app/sync/network.*.ts` | sync: *No network*; app: *No network* | sync `units.test.ts` *offline: changes wait…*; e2e `sync.spec.ts` (offline with 1 change pending, then back online); app `sync/network.test.ts` (native readings) |
| 2 | My storage unreachable | `classifyError` (`unreachable`, retryable); scheduler backoff (30 s … 30 min) and `banner` after `bannerAfterMs` (24 h); `ownNote` (nothing, then `sync.note.banner`), `app/sync/noteText.ts` (`since.yesterday`) | sync: *My storage unreachable*; app: *My storage unreachable* | sync `units.test.ts` *retries transient failures with backoff…* |
| 3 | Credentials rejected | `classifyError` (`auth`, `blocksWrites`); scheduler `blocked` state (no automatic write, read-only pass on opening, `resume()`); `ownNote` (`sync.note.reconnect`), `noteHref`: straight to the connection form (`/storage/setup?mode=edit`), saving it rebuilds the engine and syncs (`app/sync/SyncProvider.tsx`) | sync: *Credentials rejected*; app: *Credentials rejected* | sync `review.test.ts` R-07, `fixes.test.ts` R-07/R-11; e2e `sync.spec.ts` (401 from the server, "Reconnect your storage", the form, back to normal) |
| 4 | Quota full | `classifyError` (`quota` for 507/413, retryable: the queue stays on the device); `OwnSync.spaceUsed()` (`sync/own.ts`, bytes by content type); `app/sync/controller.ts` `spaceUsed`; `app/app/sync.tsx` (space used section, `quotaTips`: version history, photo quality, other files); `app/sync/problems.ts` `spaceRows`, `formatBytes` | sync: *Quota full*; app: *Quota full* | app `sync/sync.test.ts` *space used on my storage by content type* |
| 5 | Interrupted write | `OwnSync.publish` (`sync/own.ts`): packs first, the index last, read back; the packs of an attempt are recorded as garbage before they are written, so a pass cut before the index deletes them later | sync: *Interrupted write*; app: *Interrupted write* | sync `adversarial.test.ts` *a listed pack missing from the storage is rewritten…* |
| 6 | Two of my devices write at the same time | `OwnSync.publish`: `If-Match` / `If-None-Match`, content check before writing the index (coarse ETags, R-08), re-read in full, merge, retry (5 attempts) | sync: *Two of my devices write at the same time*; app: *Two of my devices…* | sync `adversarial.test.ts` *concurrent publishers*, `fixes.test.ts` R-08; `real-servers.test.ts` |
| 7 | A friend's storage unreachable | `sync/reader.ts` (a failed read leaves the cache and `lastSuccess` as they were); `classifyError` (friend: `Updated {age} ago`); `app/sync/problems.ts` `friendNote` (`sync.friend.updatedAgo`; after `FRIEND_STALE_MS`, 3 months, `sync.friend.stale` with *Keep their places* / *Remove their places*); `app/sync/controller.ts` `keepFriend` (asked again 3 months later), *Remove* = stop following (`setPolicy(owner, { follow: false })`) | sync: *A friend's storage unreachable*; app: *A friend's storage unreachable* | app `sync/sync.test.ts` *a friend unreachable for 3 months: keep … or remove them* |
| 8 | A friend changes storage | `sync/reader.ts` (a signed redirect: `StorageMovedError` gives the address the master-signed certificate names, read once, there only; `movedTo`); `sync/contacts.ts` `noteIndex` (the contact's address follows the newer certificate); `app/sync/whatsNew.ts` (`wn.moved`) | sync: *A friend changes storage*; app: *A friend changes storage* | app `sync/sync.test.ts` *storage move: … friends follow it*; e2e `storage.spec.ts` *move to another storage…*; crypto `verifyIndex` tests (a link or device cannot choose an address) |
| 9 | Tampered content | `sync/reader.ts` (verify before use, `R-03` path binding), `classifyError` (`tampered` / `rollback`, message without technical detail); `friendNote` (`sync.friend.tampered`) | sync: *Tampered content*; app: *Tampered content* | sync `adversarial.test.ts` *attacks on the storage*, `review.test.ts` R-03 |
| 10 | Unsupported format version | `classifyError` (`UNSUPPORTED_VERSION`, `PayloadError(unsupported)`); `friendNote` (`sync.friend.unsupported`) | sync: *Unsupported format version*; app: *Unsupported format version* | sync `units.test.ts` *error cases (spec table)*, *payload: … refuses what it does not know* |
| 11 | Invalid invitation or list link | `app/contacts/problems.ts` `linkProblemOf` (`expired`, `no-longer-works`, `not-genuine`), `contacts/ui.tsx` (adds *Ask for a new link* when not retryable); `sync/followed.ts` `ListGoneError`, `app/lists/sharing.ts` `goneKey` | app: *Invalid invitation or list link* | app `contacts/links.test.ts`, `contacts/flow.test.ts`; sync `lists.test.ts` *"new link" cuts the old link*, *a deleted list says "This list no longer exists"*; e2e `invitations.spec.ts`, `lists-sharing.spec.ts` |
| 12 | Answer opened after the invitation expired | crypto `openInvitationResponse` (grace period, `openedAfterExpiry`); `app/contacts/model.ts` `answerSet` (`after-expiry`: a second confirmation, never automatic) | app: *Answer opened after the invitation expired* | app `contacts/flow.test.ts` *… one opened after expiry*, `contacts/model.test.ts` |
| 13 | I change storage, or my sharing key changes | crypto `signIndex` (only invitations of the current rotation are listed: `superseded`); `sync/engine.ts` `rotateKey` (records kept), `cancelAllInvitations` for a declaration of loss; `app/sync/controller.ts` `openInvitations` (the people who had not answered), `lost.cancelled`, `storage.move.cancelledList` | sync: *I change storage or my sharing key changes*; app: *I change storage…* | sync `devices.test.ts` *revokes it, cancels every open invitation…*; app `sync/sync.test.ts` *open invitations under the previous certificate…* |
| 14 | An invitation record in the vault is invalid | `sync/contacts.ts` `ContactBook.sweepInvitations` (invalid, revoked, expired past the 7-day grace: dropped), called by `SyncEngine` before each publication (`SyncReport.invitationsDropped`); the index is still published; `app/sync/problems.ts` `invitationsLogLine` (local log, no ids; nothing on screen) | sync: *An invitation record in the vault is invalid*; app: *An invitation record … is invalid* | crypto `signed-index` tests (`onSkip` reasons) |
| 15 | An invitation record cannot be listed yet | crypto `signIndex` (`not-yet`: created more than 5 min ahead, or under a newer rotation); `sweepInvitations` keeps it; listed once the clock or the certificate catches up | sync: *An invitation record cannot be listed yet*; app: *… cannot be listed yet* | crypto `signed-index` tests (R5-02) |
| 16 | Map tiles unavailable | MapLibre's own cache of the areas viewed (native ambient cache, the browser's HTTP cache on web): only a load error the cache could not answer reaches the app. Then `app/components/map/baseMap.ts` `BaseMapFallback`: the configured style, each address of `MAP_STYLE_FALLBACK_URLS` (`app/config.ts`, build-time `EXPO_PUBLIC_MAP_STYLE_FALLBACK_URLS[_DARK]`), then a built-in blank style (pins, zones, long press still work); switch on a style load error, a failed TileJSON, or 4 tile failures in a row with no tile loaded (`Map.web.tsx`: `error` / `sourcedata` events of maplibre-gl 6, `setStyle(…, { diff: false })`; `Map.native.tsx`: `onDidFailLoadingMap`, MapLibre React Native reports no tile error); the address reached is kept for the session. `app/components/map/BaseMapNote.tsx` on the home map: nothing on the configured address, `map.tiles.fallback` ("Map possibly less detailed"), `map.tiles.unavailable` | app: *Map tiles unavailable*; e2e `error-cases.spec.ts` (*map tiles unavailable*: style 404, tiles failing, no address answering, the configured address answering) | app `components/map/baseMap.test.ts` |
| 17 | OSM search or data unavailable | `packages/osm` `search.ts` (Photon, then Nominatim as the fallback on an explicit search), `http/cache.ts` (stale entries served when a service fails); `app/osm/errors.ts` `osmFailureKey` (`osm.searchUnavailable`), `app/app/add.tsx` (long press and *Drop a point* need no service; the nearby list falls back to the places on the device); `app/components/PlaceCard.tsx` (enrichment not marked done on failure: retried at the next opening) | app: *OSM search or data unavailable* | osm `search.test.ts`, `http.test.ts` *serves a stale entry when the service fails*, `overpass.test.ts` (fail-over); app `osm/osm.test.ts` |
| 18 | App not opened for a long time | scheduler: a pass at each launch and foreground, no timer while closed; `sync/reader.ts` full re-read of a friend's index after `fullCheckMs` | sync: *App not opened for a long time*; app: *App not opened for a long time* | sync `units.test.ts` *syncs on launch…* |
| 19 | Key missing from the phone's vault | `app/identity/create.ts` `storedIdentityKind`, `app/identity/IdentityProvider.tsx` (`none` with `keysMissing`: nothing opens, no sync), `app/app/welcome/index.tsx` (*Restore with my recovery kit*); a device without the current sharing key: `NeedsKeyError` → `needs-key`, `blocksWrites` (`sync/own.ts`), `sync.note.needsKey` | sync: *Key missing from the phone's vault*; app: *Key missing from the phone's vault*; e2e `error-cases.spec.ts` | sync `adversarial.test.ts` *a device without the new key stops publishing and asks for the recovery kit* |

The "Sync status" screen under the table (`app/app/sync.tsx`): last successful sync of my storage
and of each person followed, pending changes, space used by content type, and the local technical
log (`logLine`, `invitationsLogLine`: error names and counts, never content, keys or ids).

## Synchronization and background (error-related)

| Rule | Code | Tests |
| --- | --- | --- |
| On launch: immediate sync, the map first from the cache | `SyncScheduler.appForeground('launch')`; `app/sync/SyncProvider.tsx` | sync `units.test.ts` *syncs on launch…*; sync *App not opened for a long time* |
| During use: regular refresh and pull to refresh; transient failures retried with a growing delay | scheduler `intervalMs`, `pullToRefresh`, `backoffMs` | sync `units.test.ts` *retries transient failures…*; sync *My storage unreachable* |
| Right after closing: pending changes sent once, then nothing | `appBackground` (one pass, every timer cleared) | sync `units.test.ts` *… finishes on close, then nothing* |
| A device revocation takes effect at the next opening; lock (or wipe) after no sync for X days | engine remote wipe (`DeviceRevokedError`); `app/identity/lock.ts` `staleSyncAction`, `app/sync/StaleSyncLock.tsx` | sync `fixes.test.ts` R-05; app `devices/devices.test.ts` (stale sync lock, clock set back); e2e `devices.spec.ts` |

## Open questions

- **Map tiles: which public fallback address.** The fallback mechanism is in place, but the
  default list is empty: OpenFreeMap has a single public host, and the spec's other public options
  need a style of their own (OSM vector tiles: Shortbread schema, app identification that a
  browser cannot send) or a key (Protomaps). Until a mirror in the OpenMapTiles schema is chosen
  (or a style for one of those), an outage beyond the cache gives the blank background with
  "Map background unavailable for now". On native, a tile host failing while its style loads is
  covered by the cache only (no per-tile error event in MapLibre React Native 11).
- **Quota full: "photos wait, text goes first".** Since T-111b photos are uploaded before the
  packs that reference them (a pack must not name a file that is not there), and a 507/413 on a
  photo only makes it wait: the text is published without it (`report.own.photos.waiting`, sync
  `photos.test.ts` *quota full*). `OwnSync.spaceUsed()` counts listed photo files separately, and
  the photo-quality tip appears only when photos take space.
- **Credentials rejected: Nextcloud connection relaunched.** The Nextcloud Login Flow is not
  implemented (T-203: app password typed by hand), so "Reconnect" opens the connection form filled
  with the current settings; the Login Flow should start from there once it exists.
- **Invalid invitation records: message.** The row allows "Nothing, or 'An invitation could not be
  verified and was removed'": the app writes a line in the local log only.
