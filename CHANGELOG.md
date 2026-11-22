# Changelog

All notable changes to TrianguLair are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The release workflow
(`.github/workflows/release.yml`) uses the section of the version it publishes as the release notes.

## [Unreleased]

### Changed

- The links the app hands out (invitations, answers, lists, devices) use a placeholder address, `example.org`, set
  at build time with `EXPO_PUBLIC_LINK_ORIGIN` (also for Android App Links and iOS Associated Domains). Use a domain
  you control: the keys are after the `#`, which the page served there could read. Links from any address are
  recognised, since a friend's build may use another one.

## [0.9.0-beta.2] - 2026-11-22

Fixes from the first days on real devices.

### Added

- An app icon and favicon: a white map pin on a blue gradient, with a triangle of three coloured places in its
  head. The phone apps had Expo's default icon; Android gets an adaptive icon and a themed (monochrome) icon, and
  the web app's icons and favicon use the same design (`apps/mobile/scripts/app-icons.mjs`).

### Fixed

- The phone apps crashed right after launch ("Maximum update depth exceeded", from the web app's update bar).
- Android: "center on me" and QR scanning work without Google Play services; the APK contains no Google, Firebase
  or ML Kit library (checked in CI), as F-Droid requires.
- A Nextcloud share link used as the read address of a storage set up as generic WebDAV (any folder path) was read
  as is: friends, and the web app's connection test, got Nextcloud's HTML page instead of your files. It is now
  read through its public WebDAV address, also for storages already set up.
- Two of your devices syncing at the same moment on a storage without atomic writes (WsgiDAV, SFTP) or with coarse
  ETags (Nextcloud) could leave one device's latest changes only on that device until it synced again. The device
  whose publication was overwritten now merges the other one at its next sync, the index is checked once more after
  a publication, and your document's old files are kept one publication longer so the storage always holds it whole.

## [0.9.0-beta.1] - 2026-11-21

First beta, for a small group of friends. It is the first time the app is installed on real phones: expect bugs,
and keep a copy of your places (list view › Import and export › Export). What the app does today:

### Added

**Your places, on your phone (works offline)**

- Full-screen OpenStreetMap map (OpenFreeMap tiles) with your places and zones; pins clustered when zoomed out; dark
  mode; English and French.
- Add a place from the known places around the map, by searching a name (Photon, with Nominatim as fallback), or by
  dropping a point (long press). The add screen says when a place is already yours or saved by friends.
- Place card filled from OpenStreetMap: category, address, opening hours ("Open, closes at 10 pm", public holidays
  included), phone and website buttons, terrace, Wi-Fi and diets, free photos from Wikimedia Commons and Panoramax
  with their credit, directions in your navigation app.
- Your own notes on each place: tags with colors and icons (and sub-tags), status (to try / tried / favorite), price
  level, a comment with its own visibility (private, friends or public), and personal photos (GPS and other metadata
  removed, resized, encrypted before upload; friends download the full photo only when they open it).
- Zones: an existing neighborhood, street segments that follow the streets, or a shape drawn by points or painted;
  the zone card lists the places inside.
- Filter bar: tags and sub-tags, status, visibility, price level, text, and criteria from OpenStreetMap (open now,
  happy hour, terrace, cuisine, diets, reservation, admission price, shop and museum types, second-hand, organic);
  filtered-out pins stay visible in grey; the bar collapses to one line and remembers its state.
- List view with sorting (recent, distance, name) and full-text search.
- Closed places: a monthly OpenStreetMap check flags places that may have closed, with the reason; you confirm
  "closed" or "still open".
- Import from Google Takeout (GeoJSON, CSV), Mapstr and Pin Drop (unverified formats, flagged as such), KML and any
  CSV (column-mapping wizard), matched to OpenStreetMap, without duplicates, undoable for 7 days. Full GeoJSON export.
- Trash: Settings › My content › Trash (restore, delete forever), emptied after 30 days.
- "Center on me" button on the map (◎): one position when pressed, never stored or sent; it says when the
  permission is refused, location is off or no position was found.
- Android without Google Play services: location uses Android's own location service and QR codes are read with
  ZXing, instead of Google Play services location and ML Kit, so both work on phones without Google services
  (tested on an emulator without Google APIs). The Android build contains no Google Play services, Firebase or ML
  Kit library, and CI fails if one comes back (a step towards F-Droid).

**Sharing with friends, end to end encrypted**

- An identity made of 12 recovery words, a recovery kit, an optional app lock.
- Your encrypted places live on your own storage: WebDAV (Nextcloud, with its browser login and an automatic
  read-only share link, or any WebDAV server), S3-compatible storage, or local only. The storage only ever sees
  encrypted files.
- Invite friends by link or QR code, answer with a return link; compare a safety code to verify a contact. You choose
  what each friend can open: everything shared, or only some lists. A private place never leaves your phone.
- Friends' places on your map ("Friends shown": all, none or a selection), "3 friends" in the list, the card and the
  add screen, and a What's new screen (additions, comments, status, photos, key and identity changes).
- Lists from a saved filter or a hand-picked selection, shared link-only or public. Anyone can follow a list from
  its link without an account; a public list is plain GeoJSON and opens in uMap. "New link" cuts off the old one.
- Several devices: add one by QR code, by link and a 6-word code, or with the 12 words; declare a lost device (new
  keys, re-encryption, the device is wiped at its next sync); move to a new identity if the main device is stolen;
  lock the app when it has not synced for a chosen number of days.
- Store rules: "Delete all my content" (on the phone and on the storage, with a signed note so friends' apps drop
  it), block and unblock a person, report a public list.
- Sync on launch, on return to the app, after edits and on pull to refresh; plain-language status ("Offline · N
  changes pending", storage unreachable, reconnect your storage) and Settings › Sync status.
- On the phone: the local database is encrypted (SQLCipher, key in the system vault); keys and storage credentials
  live in the Keychain / Keystore.

**Web app (PWA), to host yourself**

- The web version is an installable web app that works offline: manifest and icons, Add to Home Screen on iPhone
  (Safari › Share) and Install on Android and desktop browsers, a service worker that keeps the app's own files for
  offline use (never storage requests or map tiles), "A new version is ready · Reload" after an update.
- It asks the browser to keep its data; Settings › Storage in this browser shows whether it does, and why the recovery
  kit matters more in a browser.
- Built for the root of a domain or for a sub-path such as `/triangulair/` (`TL_WEB_BASE`); deep links work under
  both. Releases include `TrianguLair-web-<version>-root.zip` and `TrianguLair-web-<version>.zip` (sub-path).
- Guide for YunoHost next to Nextcloud (`docs/self-host-web.md`): "My webapp" and SFTP, the nginx CORS rule for
  Nextcloud WebDAV and public share links (or the same domain, without CORS), installing on a phone, updating.
- The web version says when a storage, yours or a friend's, probably does not allow it (CORS), and links to the guide.

**Project**

- Frozen encrypted format v4, specified byte for byte in `docs/format/`, with test vectors, fuzzing and a second
  reader in Python.
- CI: every package tested standalone, real WebDAV, S3 and SFTP servers, Android and iOS bundles, end-to-end tests of
  the web build; manual native Android and iOS builds; a release workflow that publishes the APK, the .ipa and their
  SHA-256 checksums.
- Beta-testing guide (`docs/beta-testing.md`), contribution guide, code of conduct (Contributor Covenant 2.1) and
  security policy.

### Known limitations

- **Never run on a real phone before this beta.** Everything was tested in the web build and automated tests; the
  native builds compile, but the Android and iOS apps had not been used on a device. Native-only parts (the database
  encryption and its migration, the camera and QR scanning, the system vault, the iOS last sync before the app is
  suspended, the map's native rendering) are the most likely to break.
- **No external security audit yet.** The format had five internal reviews and the sharing code one review per area,
  but no independent audit. Do not use it to protect anyone at risk. See `SECURITY.md`.
- **iPhone only through free sideloading**: an unsigned .ipa installed with Sideloadly or AltStore and a free Apple
  ID. The app stops opening after **7 days** and must be re-signed (installed again); at most 3 such apps per
  iPhone; no universal links, so invitation and list links open in the browser and must be pasted in the app.
  The self-hosted web app (`docs/self-host-web.md`) avoids the 7-day limit, with its own limits: data kept by the
  browser (keep the recovery kit), no background sync, a local database that is not encrypted, links to paste.
- **Android**: the APK is signed with a test key. A later store or F-Droid version will need an uninstall (export your
  places first). Not on F-Droid yet: no reproducible build and no F-Droid recipe so far.
- **Storage**: SFTP works only in desktop builds, not on phones. S3 on phones uses a new pure-JavaScript signer, so far
  tested against a local S3 emulator only. The Nextcloud browser login and automatic share link were tested against
  mocks, not a real Nextcloud. A storage is needed to share: there is no central server.
- **Map**: on phones pins are drawn one by one; thousands of places will be slow (the 10,000-pin target is not met yet).
- **Not done yet** (from `docs/spec-coverage.md`): for followed lists, "add all to my places", "ask to follow the
  author", a per-list switch on the map and a "Source" filter; the friends' average price and the price in list rows;
  the "moved" answer for closed places and sharing friends' "closed" reports; e-mail and social buttons, Wikipedia
  excerpt and "contribute to OpenStreetMap" on the card; "my position" on the add screen; "open at a chosen time";
  right-to-left layout and place names in your language; groups; a published privacy policy.
- After "Delete all my content", a device that was offline and still has the old data could publish it again; after
  an identity change, other devices must be added again.

[Unreleased]: https://github.com/ndx1905-github/TrianguLair/compare/v0.9.0-beta.1...HEAD
[0.9.0-beta.1]: https://github.com/ndx1905-github/TrianguLair/releases/tag/v0.9.0-beta.1
