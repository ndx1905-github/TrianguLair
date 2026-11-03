# TrianguLair

[![CI](https://github.com/ndx1905-github/triangulair/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ndx1905-github/triangulair/actions/workflows/ci.yml)

**Local-first, end-to-end encrypted app to save and share your favorite places with friends.**
Your data stays on your own storage (WebDAV, S3, SFTP). Built on OpenStreetMap.

## Status

Early development: **phase 0** (prototypes). Nothing is usable yet.

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
| `apps/mobile` | Expo / React Native app (iOS, Android, web for testing) |
| `docs/SPEC.md` | Full specification — the source of truth |
| `docs/TASKS.md` | Spec broken down into tasks (also GitHub issues) |

## Stack

React Native + Expo, MapLibre, SQLite, Yjs, libsodium. TypeScript everywhere.

## Checks

CI (`.github/workflows/ci.yml`) runs on every pull request and on `main`: for each package
(`crypto`, `storage`, `data`, `osm`, `import`) a standalone install, type-check and tests (the
`data` performance suite and the `storage` real-server tests are left out; `crypto` also checks that
the committed test vectors are up to date and runs the Python reference reader); for the app,
type-check, unit tests, the web export in fixture mode and the end-to-end tests.

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
npm run e2e                            # serves dist/ on 127.0.0.1:4319 and runs the suite headless
npm run e2e -- --headed -g "French"    # one test, with a visible browser
```

`E2E_PORT` changes the port. Rebuild `dist/` after changing the app. The tests cover first launch,
filters (tag, open now), adding a place and finding, editing, trashing and restoring it, drawing a
zone, a filter list with a private place, GeoJSON import, export and re-import, French and dark mode.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and pick a task in [docs/TASKS.md](docs/TASKS.md).
Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/):
sign off your commits (`git commit -s`).

## License

[Mozilla Public License 2.0](LICENSE).
Map data © OpenStreetMap contributors, ODbL.
