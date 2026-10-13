# TrianguLair

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

React Native + Expo, MapLibre, SQLite, Automerge, libsodium. TypeScript everywhere.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and pick a task in [docs/TASKS.md](docs/TASKS.md).
Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/):
sign off your commits (`git commit -s`).

## License

[Mozilla Public License 2.0](LICENSE).
Map data © OpenStreetMap contributors, ODbL.
