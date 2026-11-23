# TrianguLair

[![CI](https://github.com/ndx1905-github/TrianguLair/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ndx1905-github/TrianguLair/actions/workflows/ci.yml)

**Local-first, end-to-end encrypted app to save and share your favorite places with friends.**
Your data stays on your own storage (WebDAV, S3, SFTP). Built on OpenStreetMap.

## Status

**Beta (0.9)**, for a small group of testers, with **no external security audit** yet. Android app, iPhone app (free
sideloading) and an installable web app; releases on the
[Releases page](https://github.com/ndx1905-github/TrianguLair/releases). What it does and its known limitations:
[CHANGELOG.md](CHANGELOG.md). To try it: [docs/beta-testing.md](docs/beta-testing.md).

## What it does

- **Save places** from OpenStreetMap search, nearby places or a point on the map; tags, status (to try, liked…),
  comments, personal photos (stripped of their metadata), zones and lists. Filters by tag, status, "open now",
  zone, and editing many places at once from the list (select, then delete, tag, list or set a status).
- **Share with friends**: an invitation link, then each friend reads what you chose to show them. On the map you
  choose whose places you see (only yours, one friend, several, everyone), each friend has a colour, and small dots
  on the pins show who else has a place.
- **Your own storage**: Nextcloud or any WebDAV, S3, SFTP; everything on it is encrypted. Several devices (phones and
  the web app) share one identity; a recovery kit brings everything back on a new phone.
- **Import and export**: Google Takeout, other place-saving apps' exports, KML/KMZ, CSV, GeoJSON (with your photos).
- **Works offline**, in English and French, light and dark.

The web app hands out links at its own address; the phone apps learn that address when added from the web app, or in
Settings › Friends. Hosting it next to Nextcloud on YunoHost: [docs/self-host-web.md](docs/self-host-web.md).

## Principles

- **Local-first**: everything works offline; the device is the source of truth.
- **No central server**: each person stores encrypted packs on their own storage
  (WebDAV, S3, SFTP, or read-only HTTPS). Friends read them over HTTPS.
- **One key per person**: you decide which content each friend's key can open.
  Revoking a friend means they can no longer read new or re-encrypted content.
- **Open data**: places come from OpenStreetMap (Overpass, Photon/Nominatim),
  photos from Wikimedia Commons and Panoramax, base map from OpenFreeMap.
- **Interoperable**: public lists are plain GeoJSON, viewable in uMap.

## Repository layout

| Path | Content |
|---|---|
| `packages/crypto` | Encrypted format: keys, wraps, signatures, signed index |
| `packages/storage` | Storage adapters: WebDAV, S3, SFTP, HTTPS |
| `packages/data` | Local data: SQLite with spatial and full-text indexes, Yjs merging |
| `packages/osm` | OpenStreetMap client: Overpass, Photon/Nominatim, place cards, closed places |
| `packages/import` | Import (Google Takeout, Mapstr, Pin Drop, KML, CSV) and GeoJSON export |
| `packages/sync` | Sync and sharing: publishing, friends, lists, devices, photos |
| `apps/mobile` | Expo / React Native app (iOS, Android, and an installable web app) |
| `docs/SPEC.md` | Full specification — the source of truth |
| `docs/TASKS.md` | Spec broken down into tasks |
| `docs/spec-coverage.md` | What the spec promises compared with what is implemented |

## Stack

React Native + Expo, MapLibre, SQLite, Yjs, libsodium. TypeScript everywhere.

## Checks

CI (`.github/workflows/ci.yml`) runs on every pull request and on `main`: for each package
(`crypto`, `storage`, `data`, `osm`, `import`, `sync`) a standalone install, type-check and tests (the
`data` performance suite and the `storage` real-server tests are left out; `crypto` also checks that
the committed test vectors are up to date and runs the Python reference reader); for the app,
type-check, unit tests, the phone bundles (Android, iOS), the web export in fixture mode and the end-to-end tests; a
separate job runs the storage and sync tests against real servers (Apache WebDAV, WsgiDAV, an S3 emulator, OpenSSH).
Native builds and an Android emulator smoke test run in `native-android.yml` / `native-ios.yml`, by hand and on
every release.

Each package installs on its own (`npm ci --workspaces=false` in its folder), then
`npm run typecheck` and `npm test`.

### End-to-end tests (app, web build)

Playwright Test against the web export in fixture mode (OSM answered by fixtures, blank base map,
clock fixed on a Friday evening in Paris), in `apps/mobile/e2e/`:

```sh
cd apps/mobile
npm ci --workspaces=false
npx playwright install chromium        # once (add --with-deps on a fresh Linux machine)
npm run export:web:fixtures            # build dist/ with EXPO_PUBLIC_OSM_FIXTURES=1
npm run export:web:pwa:fixtures        # the installable web app, for the PWA tests
bash ../../packages/storage/scripts/real-servers.sh   # local WebDAV/S3/SFTP servers for the sync tests
npm run e2e                            # serves dist/ on 127.0.0.1:4319 and runs the suite headless
npm run e2e -- --headed -g "French"    # one test, with a visible browser
```

`E2E_PORT` changes the port. Rebuild `dist/` after changing the app. The tests cover first launch, places, filters,
zones and lists, bulk editing, import and export, storage setup and sync between people and devices, invitations,
shared lists, friends on the map, photos, recovery from the kit, the trash, privacy actions, error cases, the
installable web app (offline, sub-path, updates), French and dark mode.

## Releases

Builds are published as GitHub Releases (APK for Android, unsigned .ipa for iPhone sideloading, the web app as two
zips, for the root of a domain and for `/triangulair/`, SHA-256 checksums)
by the manual *Release* workflow (`.github/workflows/release.yml`), with the matching [CHANGELOG.md](CHANGELOG.md)
section as notes. Installing them: [docs/beta-testing.md](docs/beta-testing.md),
[docs/run-on-android.md](docs/run-on-android.md), [docs/run-on-iphone.md](docs/run-on-iphone.md). Hosting the web app
(installable on an iPhone from Safari, works offline) on YunoHost next to Nextcloud:
[docs/self-host-web.md](docs/self-host-web.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (setup of each package, tests, rules, pull requests) and pick a task in
[docs/TASKS.md](docs/TASKS.md). Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/): sign off your commits (`git commit -s`).
Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1).

## Security

Report vulnerabilities privately, never in a public issue: see [SECURITY.md](SECURITY.md) (scope, threat model, and
the fact that no external audit has been done yet).

## License

[Mozilla Public License 2.0](LICENSE).
Map data © OpenStreetMap contributors, ODbL.
