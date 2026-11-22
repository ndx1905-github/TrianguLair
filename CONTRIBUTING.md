# Contributing to TrianguLair

Thanks for your interest! The project is in its first beta; contributions are by invitation for now.

## Getting started

1. Read the package READMEs, the encrypted format in [docs/format/](docs/format/) and the threat models
   (`packages/*/THREATS.md`): together they describe what the app promises and how.
2. Pick a task in [docs/TASKS.md](docs/TASKS.md) or in the issues (`T-xxx` in the title) that is "to do" and whose
   dependencies are done.
3. Comment on the issue to claim it, so nobody works on the same thing twice.

## Setting up

You need **Node.js 22** and npm, and git. Python 3 is used by a few scripts (the crypto reference reader, screenshot
and task scripts).

There is **no root install**: every package and the app has its own `package-lock.json` and installs on its own, as
CI does.

```sh
cd packages/<name>              # crypto, storage, data, osm, import or sync
npm ci --workspaces=false
npm run typecheck
npm test
```

Package specifics:

| Package | Notes |
|---|---|
| `packages/crypto` | `npm run vectors` regenerates the test vectors in `docs/format/vectors` (CI fails if they differ from the committed ones); `npm run reader` runs the Python reference reader (`pip install pynacl`); `npm run fuzz:long` fuzzes for longer. |
| `packages/data` | `better-sqlite3` builds a native module and downloads the Node headers from nodejs.org. Where that site is unreachable, point npm at a local Node source or header tree: `npm_config_nodedir=/path/to/node npm ci --workspaces=false`. CI runs `npm run test:ci` (no performance suite); `npm run test:perf` prints the timing table. |
| `packages/import` | Imports `data` and `osm` from their sources: run `npm ci --workspaces=false` in `packages/data` and `packages/osm` too. |
| `packages/sync` | Imports `crypto`, `storage` and `data` from their sources: install those three as well (with `npm_config_nodedir` for `data` if needed). |
| `packages/storage`, `packages/osm` | Nothing special. |

The app:

```sh
cd apps/mobile
npm ci --workspaces=false       # the app uses the packages from their sources, with its own node_modules
npm run typecheck
npm test                        # vitest
npx expo start --web            # web build for development
```

Phones: [docs/run-on-android.md](docs/run-on-android.md) and [docs/run-on-iphone.md](docs/run-on-iphone.md).

### End-to-end tests (web build)

Playwright against the web export in fixture mode (OSM answered by fixtures, a blank base map, the clock fixed on a
Friday evening in Paris):

```sh
cd apps/mobile
npx playwright install chromium        # once (add --with-deps on a fresh Linux machine)
npm run export:web:fixtures            # rebuild dist/ after every change to the app
npm run e2e                            # serves dist/ on 127.0.0.1:4319 (E2E_PORT) and runs the suite
npm run e2e -- --headed -g "French"    # one test, with a visible browser
```

The sharing tests (storage, sync, invitations, lists, devices, photos, privacy) need the Apache WebDAV server below
on `127.0.0.1:8081`; they are skipped when it is not running.

### Real storage servers

`packages/storage/scripts/real-servers.sh` starts real servers on an Ubuntu machine (run it as root; it installs
Apache, OpenSSH, moto and WsgiDAV, and is safe to run twice): Apache mod_dav on `:8081` (with a 507 and a 413
folder), WsgiDAV on `:8082`, moto (S3 API) on `:5005` and OpenSSH sftp on `:2222`, all with the account
`alice` / `s3cret`. Then:

```sh
sudo bash packages/storage/scripts/real-servers.sh
(cd packages/storage && TL_REAL_SERVERS=1 npx vitest run test/integration)
(cd packages/sync && npm run test:real)
```

CI runs the same in its *storage (real servers)* job.

### What CI checks

`.github/workflows/ci.yml`, on every pull request and on `main`: for each package a standalone install, type-check and
tests; the crypto vectors and the Python reader; the real-server job; for the app, type-check, unit tests, the
Android and iOS JavaScript bundles, the fixture web export and the end-to-end tests. The native builds
(`native-android.yml`, `native-ios.yml`) and the release (`release.yml`) are run by hand.

## Rules

- **One branch per task**, named `t-xxx-short-description`.
- **Tests are the contract**: new behavior comes with tests, and a PR is merged only when CI is green.
- **Discuss first**: any change of behavior or format is discussed in an issue before it is coded, and the docs
  that describe it (`docs/format/`, the package README and THREATS) change in the same PR.
- **The encrypted format is frozen.** `packages/crypto` implements format v4, frozen after five reviews
  (`docs/format/`, `docs/reviews/`). Do not change its byte layouts, JSON shapes, checks, primitives or their order,
  and do not regenerate the vectors to make a test pass. A real format change needs a spec PR, a new format version
  and an independent review before any code. Other packages use the crypto package's exported functions; they never
  build keys, wraps or signatures of their own. Report a disagreement between the code and `docs/format/` as a bug.
- **Sensitive areas** (encryption, sync, keys, devices, invitations): a review by someone who did not write the code
  is mandatory before merge.
- **Strict TypeScript**, no dependency on proprietary services (the app must stay buildable for F-Droid).
- **English only**: code, comments, commit messages, issues, pull requests and docs. The app's user interface is
  translated through its i18n files (English and French today); no hard-coded UI strings.
- **No secrets** in the repository: no credentials, tokens, keys or personal addresses, not even in tests (tests use
  throwaway values such as `alice` / `s3cret`).

## Pull requests

1. Branch from an up-to-date `main`.
2. Keep the PR to one task; reference its issue (`Closes #n`).
3. Run the type-check and tests of every package you touched (and the e2e suite if you changed the app).
4. Fill in the PR template: what it does, how it was tested, what is left open.
5. Update the docs that describe what you changed (the package README, `docs/format/`, THREATS,
   `CHANGELOG.md` under "Unreleased").
6. A maintainer reviews; sensitive areas also need the independent review above. PRs are merged once CI is green and
   the review comments are resolved.

## Developer Certificate of Origin (DCO)

Every commit must be signed off with `git commit -s`, which adds:

    Signed-off-by: Your Name <email>

This certifies that you have the right to submit the code under the project's license
([Developer Certificate of Origin 1.1](https://developercertificate.org/)). No copyright assignment is required.

## License

Code under [MPL-2.0](LICENSE). Icons and visuals: CC0 or a compatible license.

## Conduct and security

See the [code of conduct](CODE_OF_CONDUCT.md). Security vulnerabilities: see [SECURITY.md](SECURITY.md), never in a
public issue.
