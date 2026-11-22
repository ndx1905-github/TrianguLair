# Tasks

The [specification](SPEC.md) broken down into tasks. Each task is also a GitHub issue (same ID in the title).
Generated from `scripts/tasks.py`: edit that file, then run `python3 scripts/gen_tasks_md.py`.

To contribute: pick a "to do" task whose dependencies are done, comment on the issue to claim it, then open a PR (see [CONTRIBUTING](../CONTRIBUTING.md)).

## Phase 0 — scoping and prototypes

| ID | Task | Areas | Depends on | Status |
|---|---|---|---|---|
| T-001 | Encrypted format prototype (packages/crypto) | crypto | — | done |
| T-002 | Independent review of the crypto prototype | crypto, review | T-001 | done |
| T-003 | Storage adapters prototype (packages/storage) | storage | — | done |
| T-004 | Expo app skeleton with map and pins (apps/mobile) | app, map | — | done |
| T-005 | Mockups of the main screens | design | — | to do |
| T-006 | Continuous integration with GitHub Actions | infra | — | done |
| T-007 | Automatic deployment of the web test build | infra, app | T-004, T-006 | to do |
| T-008 | Administrative and legal checks | legal, maintainer | — | to do |
| T-009 | Mapstr and Pin Drop export formats | import, maintainer | — | to do |
| T-010 | Forgejo mirror of the repository | infra, maintainer | — | to do |

## Phase 1 — local app

| ID | Task | Areas | Depends on | Status |
|---|---|---|---|---|
| T-101 | Local SQLite database with spatial index | data | — | done |
| T-102 | Yjs model and merging across devices | sync, data | T-101 | done |
| T-103 | Map: clustering when zoomed out and filtered display | map | T-004, T-101 | to do |
| T-104 | List view: sorting, text search | app | T-101 | done |
| T-105 | Add a place: nearby places, search, long press | app, osm | T-106, T-101 | done |
| T-106 | OSM client: Overpass, Photon/Nominatim | osm | — | done |
| T-107 | Enriched place card: info, opening hours, free photos | osm, app | T-106 | done |
| T-108 | Personal tags, colors, icons, sub-tags | app, design | T-101 | done |
| T-109 | Full filter bar | app, osm | T-107, T-108 | done |
| T-110 | Zones: neighborhoods, street segments, freehand drawing | map, app | T-103 | done |
| T-111 | Comments, status, price, personal photos | app | T-101 | done |
| T-112 | Lists from saved filters or manual selection | app | T-109, T-110 | done |
| T-113 | Monthly detection of closed places | osm | T-106 | done |
| T-114 | Import from Google Takeout, Mapstr, Pin Drop, CSV, KML, GeoJSON | import | T-009, T-106 | done |
| T-115 | Full GeoJSON export | import | T-101 | done |
| T-116 | Directions and opening in Apple Maps / Google Maps | app | — | done |
| T-117 | Screen adaptation: foldables, iPad, Mac, font sizes | app, design | — | done |
| T-118 | Languages and dark mode | app, i18n | — | done |
| T-119 | End-to-end tests on simulators | infra, tests | T-006 | done |

## Phase 2 — sharing

| ID | Task | Areas | Depends on | Status |
|---|---|---|---|---|
| T-201 | Final v1 encrypted format and test vectors | crypto | T-002 | done |
| T-202 | Production storage adapters and tests against real servers | storage | T-003 | done |
| T-203 | Storage settings and migration between storages | app, storage | T-202 | done |
| T-204 | Sync: publishing and reading packs | sync | T-102, T-201, T-202 | done |
| T-205 | Recovery kit and first launch | crypto, app | T-201 | done |
| T-206 | Adding a device (transfer code, QR) | crypto, app | T-205, T-204 | done |
| T-207 | Loss and theft: key rotation, remote wipe | crypto, sync | T-206 | done |
| T-208 | Invitation by link, QR code and return link | crypto, app | T-204 | done |
| T-209 | Access management and revocation | crypto, sync | T-208 | done |
| T-210 | Friends' places, counters and What's new view | app, sync | T-204 | done |
| T-211 | Public lists (GeoJSON) and "View on uMap" link | sharing | T-112, T-204 | done |
| T-212 | Link-only lists (key in the URL fragment) | sharing, crypto | T-211 | done |
| T-213 | Error cases from the spec | app, sync | T-204 | done |
| T-214 | External security audit | crypto, maintainer | T-209 | to do |

## Phase 3 — opening up

| ID | Task | Areas | Depends on | Status |
|---|---|---|---|---|
| T-301 | Release on App Store, Play Store, F-Droid | release, maintainer | T-214 | to do |
| T-302 | User and self-hosting documentation | docs | — | to do |
| T-303 | Contribution guide, code of conduct, security policy | docs | — | done |
| T-304 | Funding: Liberapay / Open Collective, NLnet | maintainer | — | to do |

## Details

### T-001 — Encrypted format prototype (packages/crypto)

Identity from 12 words, Ed25519 master key and replaceable X25519 sharing key, XChaCha20-Poly1305 packs, anonymous per-recipient wraps, groups, signed index, 7-day invitation and return link, Argon2id transfer code, revocation. See "Architecture › Encrypted sharing" and "Format versions".

Acceptance criteria:

- [ ] `npm test` and `npm run typecheck` pass
- [ ] Format README (byte layout, JSON, algorithms) and THREATS.md present

### T-002 — Independent review of the crypto prototype

Review by an agent or a person who did not write T-001: primitive choices, wrap anonymity, canonical serialization, anti-rollback, invitation, transfer code. Decide the 5 open questions from T-001 (`seq` field, meaning of `etag`, stable pack id, invitation link size, out-of-band verification of the return link).

Acceptance criteria:

- [ ] Review report in docs/reviews/
- [ ] Open questions decided and reflected in the spec

Depends on: T-001

### T-003 — Storage adapters prototype (packages/storage)

Common get/put/delete/list/head interface with conditional writes (ETag) and typed errors; WebDAV, S3, read-only HTTPS and SFTP (Node only) adapters; in-memory adapter; shared conformance suite; publishSnapshot/fetchSnapshot. See "Storage protocols" and "Layout on storage".

Acceptance criteria:

- [ ] Conformance suite green on every adapter against a local server
- [ ] Per-protocol README (CORS, public read, ETag semantics)

### T-004 — Expo app skeleton with map and pins (apps/mobile)

Expo + expo-router, native MapLibre / web MapLibre GL JS behind a common interface, configurable OpenFreeMap Positron style, SVG pins (white icon with strong halo, multi-tag bands, faded friends' pins), bottom sheet, collapsible filter bar, dark mode. See "Interface" and "Base map".

Acceptance criteria:

- [ ] `tsc --noEmit` passes, web export succeeds
- [ ] Web screenshot in apps/mobile/docs/
- [ ] eas.json ready for a development build

### T-005 — Mockups of the main screens

Map, list, add place, place card, filters, sharing list, invitation, first launch, storage settings. Follow the palette, pins and icon style sheet (24 px grid, 2 px stroke).

Acceptance criteria:

- [ ] Mockups published and linked from the spec

### T-006 — Continuous integration with GitHub Actions

Lint + typecheck + tests of all workspaces on every PR; web export; Dependabot; read-only permissions by default.

Acceptance criteria:

- [ ] Green CI badge on main
- [ ] PR blocked when tests fail

### T-007 — Automatic deployment of the web test build

Deploy the web export to static hosting on every merge (GitHub Pages or similar), with a test WebDAV storage configured for CORS.

Acceptance criteria:

- [ ] Test link published in the README

Depends on: T-004, T-006

### T-008 — Administrative and legal checks

Cryptology declaration to ANSSI (current procedure); ODbL impact on public lists; triangulair / triangulaire domains; TMview trademarks in classes 9 and 42.

Acceptance criteria:

- [ ] Results reflected in "Legal and publishing"

### T-009 — Mapstr and Pin Drop export formats

Get a real export from a Mapstr and a Pin Drop account, document columns and formats, anonymize a sample for tests.

Acceptance criteria:

- [ ] Samples in packages/import/fixtures/
- [ ] Columns documented in the spec

### T-010 — Forgejo mirror of the repository

Automatic mirror from GitHub to the maintainer's Forgejo instance, with a read-only token.

Acceptance criteria:

- [ ] Mirror up to date after each push

### T-101 — Local SQLite database with spatial index

Schema from "Data model" (people, groups, places, saves, tags, save_tags, tag_mappings, lists, list_items, access, media), migrations, "places in this area" queries.

Acceptance criteria:

- [ ] Tests on 10,000 places within performance targets

### T-102 — Yjs model and merging across devices

CRDT document (Yjs: pure JavaScript, no WebAssembly, runs on Hermes) for places, tags, lists; projection to SQLite; merge rules kept explicit where Yjs's last-writer-wins differs (shared base update, one save per place with folding of concurrent creations, deletion and privacy win via per-device slots, character-level comments, unknown fields kept); property-based tests of merging.

Acceptance criteria:

- [ ] Two simulated devices converge after concurrent edits
- [ ] No WebAssembly in the runtime dependency tree (tested)

Depends on: T-101

### T-103 — Map: clustering when zoomed out and filtered display

Clusters, matching pins in color / others greyed and smaller, zones displayed, 10,000-place performance. Done on web with JS clusters; native needs map-engine layers for 10,000 pins.

Acceptance criteria:

- [ ] 60 fps on the reference device

Depends on: T-004, T-101

### T-104 — List view: sorting, text search

Sort by recent / distance / name, full-text search, "N friends" mention.

Acceptance criteria:

- [ ] Unit tests for sorting and search

Depends on: T-101

### T-105 — Add a place: nearby places, search, long press

Add screen listing nearby OSM places by increasing distance, Photon/Nominatim search, long press, current location; "already mine / saved by friends" indicator.

Acceptance criteria:

- [ ] End-to-end flow on simulator

Depends on: T-106, T-101

### T-106 — OSM client: Overpass, Photon/Nominatim

Clients with caching, rate limits respected, identifying User-Agent, configurable URLs.

Acceptance criteria:

- [ ] Tests with recorded responses

### T-107 — Enriched place card: info, opening hours, free photos

Opening hours (opening_hours), cuisine, diets, terrace, entrance fee; Wikimedia Commons and Panoramax photos with attribution.

Acceptance criteria:

- [ ] Attribution shown for every photo

Depends on: T-106

### T-108 — Personal tags, colors, icons, sub-tags

Create and edit tags, palette, CC0 icons, sub-tags ("Restaurant › Pizza").

Acceptance criteria:

- [ ] Tests of the palette and band rendering

Depends on: T-101

### T-109 — Full filter bar

Categories, sub-filters, OSM criteria (open now, happy hour, terrace, diet, reservation, free entry, price), status, visibility, price level, text; collapsible, state remembered.

Acceptance criteria:

- [ ] Unit tests for each criterion

Depends on: T-107, T-108

### T-110 — Zones: neighborhoods, street segments, freehand drawing

Existing OSM neighborhood, one or more street segments, drawing by points or finger painting; zone icon.

Acceptance criteria:

- [ ] Zones stored as valid GeoJSON

Depends on: T-103

### T-111 — Comments, status, price, personal photos

Comment visibility (private / friends / public), to try / tried / favorite status, €–€€€€, personal photos.

Acceptance criteria:

- [ ] Visibility respected in exports

Depends on: T-101

### T-112 — Lists from saved filters or manual selection

Dynamic lists (categories, tags, zones by name via OSM boundaries or drawn) and manual lists; a private place never enters a list.

Acceptance criteria:

- [ ] Property-based tests on excluding private places

Depends on: T-109, T-110

### T-113 — Monthly detection of closed places

Monthly check via OSM (disused:, shop=vacant, deletion), notify the user.

Acceptance criteria:

- [ ] Tests with recorded OSM cases

Depends on: T-106

### T-114 — Import from Google Takeout, Mapstr, Pin Drop, CSV, KML, GeoJSON

Parsing, matching with OSM places, preview before import, deduplication.

Acceptance criteria:

- [ ] T-009 samples imported without loss

Depends on: T-009, T-106

### T-115 — Full GeoJSON export

Export all places, zones, tags, comments.

Acceptance criteria:

- [ ] Re-import without loss

Depends on: T-101

### T-116 — Directions and opening in Apple Maps / Google Maps

Deep links to navigation apps.

Acceptance criteria:

- [ ] Tested on iOS and Android

### T-117 — Screen adaptation: foldables, iPad, Mac, font sizes

Adaptive layout, dual screens (Galaxy Fold, iPhone Duo), iPad, Apple Silicon Mac, dynamic type, iOS display zoom.

Acceptance criteria:

- [ ] Automatic screenshots per form factor

### T-118 — Languages and dark mode

i18n (English and French first), Weblate; complete dark mode.

Acceptance criteria:

- [ ] No hard-coded strings

### T-119 — End-to-end tests on simulators

Maestro or Detox: first launch, add, filter, list, import.

Acceptance criteria:

- [ ] Run in CI

Depends on: T-006

### T-201 — Final v1 encrypted format and test vectors

Format v4 frozen on main at 5b10faf after five independent reviews (docs/reviews/). Remaining before the external audit: a standalone format specification in docs/format/ with pseudocode for every check, known-answer test vectors (positive and negative, from seeded randomness), fuzzing of every parser, a second minimal reader in another language, and a map from each spec promise to the code that enforces it.

Acceptance criteria:

- [x] Standalone format specification in docs/format/: byte layouts, JSON shapes, size limits, versioning rules and pseudocode for every check
- [x] Known-answer vectors for every structure, positive and negative, from seeded randomness, checked by the library (`npm test`) and regenerated by `npm run vectors`
- [x] Fuzz and property tests of every parser (fixed seed in CI, `npm run fuzz:long`)
- [x] Map from each spec promise to the code that enforces it (docs/format/promises.md)
- [x] A second minimal reader (Python, docs/format/reference-reader/) checks the signed-index, pack and invitation-link vectors
- [x] Vectors checked by a second implementation: the Python reader implements every op and agrees on all 473 vectors (`npm run reader`, in CI)

Depends on: T-002

### T-202 — Production storage adapters and tests against real servers

Nextcloud, MinIO, SFTP, web server in CI; simulated failures (timeout, quota, credentials, interrupted write). SFTP on mobile: native module or unsupported. Support `index.v<N>.json` next to `index.json` for major format transitions (spec "Format versions").

Acceptance criteria:

- [ ] Conformance suite green against each server

Depends on: T-003

### T-203 — Storage settings and migration between storages

Choice of local only / WebDAV / S3 / SFTP, HTTPS read address, connection test, full copy when switching.

Acceptance criteria:

- [ ] Lossless migration tested

Depends on: T-202

### T-204 — Sync: publishing and reading packs

While in use and right after closing, no periodic task; ETag, signed index, friends' cache. ETag compare-and-swap is best effort on some servers: after publishing, re-read the index and check it carries our `seq`; merge and republish otherwise. A real Nextcloud takes ~0.4 s per request: upload packs in parallel and avoid needless round trips.

Acceptance criteria:

- [ ] Headless multi-user simulation
- [ ] A full sync against a real Nextcloud stays within the performance targets

Depends on: T-102, T-201, T-202

### T-205 — Recovery kit and first launch

Three entry points, 12-word phrase, recovery kit, standard flow.

Acceptance criteria:

- [x] End-to-end flow: e2e `recovery.spec.ts` against Apache WebDAV: places, a photo and a friend, the kit saved, browser storage wiped, restored on a fresh launch from the pasted kit or the printed page (words, QR code of the address): places, photos, friends, names and storage access back

Depends on: T-201

### T-206 — Adding a device (transfer code, QR)

Argon2id code and QR code.

Acceptance criteria:

- [ ] Two devices in sync

Depends on: T-205, T-204

### T-207 — Loss and theft: key rotation, remote wipe

Sharing key rotation, re-encryption, key deletion at sync on the removed device.

Acceptance criteria:

- [ ] "Stolen device" scenario simulated

Depends on: T-206

### T-208 — Invitation by link, QR code and return link

7-day temporary invitation key, content visible immediately, return link, asymmetric relationships.

Acceptance criteria:

- [ ] Full scenario between two simulated users

Depends on: T-204

### T-209 — Access management and revocation

Choose what each friend can open; revoking access removes the content from the friend's cache.

Acceptance criteria:

- [ ] End-to-end revocation tests

Depends on: T-208

### T-210 — Friends' places, counters and What's new view

"Also saved by friends" filters, choice of displayed friends, unknown tags keeping their original color, What's new view.

Acceptance criteria:

- [ ] Tests of tag matching

Depends on: T-204

### T-211 — Public lists (GeoJSON) and "View on uMap" link

Publish public/lists.geojson in clear, ODbL attribution, uMap link.

Acceptance criteria:

- [ ] List opened in uMap

Depends on: T-112, T-204

### T-212 — Link-only lists (key in the URL fragment)

Follow a list without following the person.

Acceptance criteria:

- [ ] Link opened on a second device

Depends on: T-211

### T-213 — Error cases from the spec

Implement every row of the "Error cases" table.

Acceptance criteria:

- [x] One test per row (mapped in [`error-cases.md`](error-cases.md))

Depends on: T-204

### T-214 — External security audit

Audit of encryption and sync before release.

Acceptance criteria:

- [ ] Report published and fixes made

Depends on: T-209

### T-301 — Release on App Store, Play Store, F-Droid

Store listings, screenshots, reproducible F-Droid builds.

Acceptance criteria:

- [ ] Apps published

Depends on: T-214

### T-302 — User and self-hosting documentation

Guides for Nextcloud, NAS, S3, self-hosted tiles.

Acceptance criteria:

- [ ] Guides reviewed by a non-technical person

### T-303 — Contribution guide, code of conduct, security policy

Complete CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.

Acceptance criteria:

- [x] Files present and linked from the README

### T-304 — Funding: Liberapay / Open Collective, NLnet

Open donations, apply to NLnet.

Acceptance criteria:

- [ ] Application sent
