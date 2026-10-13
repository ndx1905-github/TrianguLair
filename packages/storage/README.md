# @triangulair/storage

Storage adapters for TrianguLair (task T-003, prototype). The owner writes encrypted content to a storage they pick, and friends read it over plain HTTPS. Every adapter has the same small interface, so the rest of the app never knows which protocol is in use.

License: MPL-2.0.

```ts
import { WebDavAdapter, S3Adapter, HttpsReadOnlyAdapter, MemoryAdapter,
         publishSnapshot, fetchSnapshot, fetchPack } from '@triangulair/storage';
import { SftpAdapter } from '@triangulair/storage/sftp';            // Node only
import { runAdapterConformance } from '@triangulair/storage/testing'; // needs vitest
```

## Interface

```ts
interface StorageAdapter {
  capabilities: { readOnly; conditionalWrites; list; publicUrl(path): string | null };
  get(path): Promise<{ data: Uint8Array; etag } | null>;
  head(path): Promise<{ etag; size } | null>;
  put(path, data, { ifMatch?, ifNoneMatch?: '*', contentType? }): Promise<{ etag }>;
  delete(path, { ifMatch? }): Promise<void>;   // idempotent without ifMatch
  list(prefix): Promise<{ path; etag; size }[]>; // recursive, sorted by path
}
```

- Paths are relative (`packs/ab.bin`) and use `/`. They are validated: no leading `/`, no `.` or `..`, and no empty segments. Directories are implicit: `put` creates any missing parents.
- A missing object is `null` from `get`/`head`. It is not an error.
- Typed errors, all subclasses of `StorageError` and carrying a `code`:
  - `NotFound`
  - `PreconditionFailed` (the `ifMatch`/`ifNoneMatch` condition failed)
  - `AuthError` (401/403, or an SSH auth failure)
  - `NetworkError` (transport failure, 5xx, 408 or 429; retryable)
  - `ReadOnly`
  - `Unsupported` (for example `list` over plain HTTPS)
  - `InvalidPath`
  - `ProtocolError` (a response the adapter did not expect)
- Every HTTP adapter takes an injectable `fetch` (React Native, proxies, tests). The default is `globalThis.fetch`. HTTP adapters use no Node APIs, and S3 signing uses WebCrypto through `aws4fetch`.
- `probeConditionalWrites(adapter)` checks at setup time whether a server really enforces `If-Match`/`If-None-Match`. It writes and then deletes a `.triangulair-probe-*` object.

## Layout on storage

| Path | Content |
| --- | --- |
| `index.json` | small signed index (bytes from `@triangulair/crypto`; opaque here) |
| `packs/<id>.bin` | encrypted packs, `id` matching `[A-Za-z0-9_-]{1,128}` (`packPath(id)`) |
| `public/lists.geojson` | public lists, plaintext GeoJSON (uMap-compatible) |

Friends never write to someone else's storage, so there is no inbox. They send a return link instead.

## Snapshot helpers

- `publishSnapshot(adapter, { index, packs, previousIndexEtag, publicLists? })` works in this order:
  1. It uploads the packs first, with bounded parallelism.
  2. It then writes `index.json` conditionally: `If-Match: <previousIndexEtag>`, or `If-None-Match: *` on the first publish (`null`).
  3. Finally it writes the optional public GeoJSON.

  An interrupted publish therefore never leaves an index pointing at missing packs. If another device published in the meantime, it throws `PreconditionFailed`. The caller then fetches, merges (Automerge) and retries. Packs that were uploaded but not referenced are harmless. Pack ids must be unique or content-derived, so a pack upload never overwrites a pack referenced by the live index. Garbage collection is the caller's job, after the index commit.
- `fetchSnapshot(adapter, lastEtag)` sends one `HEAD`. If the ETag has not changed, it returns `{ changed: false }`. Otherwise it sends a `GET` and returns `{ changed: true, etag, index }`. It throws `NotFound` when there is no index.
- `fetchPack(adapter, id)` returns the bytes of a pack. It throws `NotFound` if the pack is missing.

## ETag semantics (all adapters)

- ETags are **opaque**. You may only compare them for equality or pass them back as `ifMatch`. HTTP adapters normalise them to the quoted form (`"abc"`).
- An ETag is only comparable with ETags from **the same adapter or URL**. The owner's write endpoint and the friend's public read URL can report different ETags for the same file. Examples: a Nextcloud DAV ETag versus a public-share ETag, or a CDN in front of S3 that recompresses and weakens ETags. So a friend stores the ETag returned by its own read adapter.
- **Weak ETags** (`W/"..."`) never satisfy `If-Match`, because RFC 9110 requires strong comparison. If a server only returns weak ETags (often gzip by a proxy), every conditional write fails with `PreconditionFailed`. Disable compression on the write endpoint.
- `capabilities.conditionalWrites === true` means the server is asked to enforce the conditions. `false` means the adapter emulates them with a check (`HEAD`) followed by a write. That leaves a race window, and two devices writing at the same moment can both win. Even when the server does enforce the conditions, it may not do so **atomically** (see the WebDAV notes). The conformance suite has a concurrency test that shows this.

## Per-protocol notes

### WebDAV (`WebDavAdapter`)

- Uses `GET`, `HEAD`, `PUT`, `DELETE`, `MKCOL` and `PROPFIND` (`Depth: 1`, walked recursively, because many servers disable `Depth: infinity`). Auth is Basic (use an app password) or Bearer.
- If a server sends no `ETag` header on `GET`/`HEAD`/`PUT`, the adapter falls back to `PROPFIND` `getetag`. Nextcloud returns `ETag`/`OC-ETag` on `PUT`.
- `conditionalWrites` defaults to `true`. Nextcloud (sabre/dav) honours `If-Match`/`If-None-Match`. Set it to `false` for servers that ignore them. The npm `webdav-server` package is one; it is used in the tests to stand in for such lax servers.
- **Friends' read URL**: a read-only public share link, or a public folder, passed as `publicBaseUrl`. For Nextcloud this is the public-share WebDAV URL, which still has to be validated against a real instance in T-202. Since everything is encrypted, a public link is acceptable.
- **CORS (web build)**: the browser sends preflights for `PUT`, `DELETE`, `PROPFIND` and `MKCOL` and for the `Authorization`, `Depth`, `If-Match` and `If-None-Match` headers. The server must answer `OPTIONS` with:
  - `Access-Control-Allow-Origin: <app origin>`
  - `Access-Control-Allow-Methods: GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, OPTIONS`
  - `Access-Control-Allow-Headers: Authorization, Content-Type, Depth, If-Match, If-None-Match`
  - `Access-Control-Expose-Headers: ETag, OC-ETag, Content-Length`

  Without `Expose-Headers`, `ETag` is invisible to scripts. Stock Nextcloud does not send CORS headers on its DAV endpoint. You need a reverse-proxy rule or a CORS app, and this is still to be validated (T-007 needs it for the test build).
- Nextcloud keeps file versions. Limit the version history on the TrianguLair folder (spec, "No duplicates, lightweight storages").

### S3-compatible (`S3Adapter`)

- `fetch` plus SigV4 (`aws4fetch`). The request is signed with the payload SHA-256. Path-style addressing is the default (MinIO, Garage, R2, Scaleway). `pathStyle: false` switches to virtual-hosted style.
- Keys live under `prefix` (for example `triangulair/alice/`). `list` uses ListObjectsV2 with pagination.
- Conditional writes:
  - `PUT` with `If-None-Match: *` (first publish) and `If-Match` (index swap).
  - On a conditional `PUT`, a `409 ConditionalRequestConflict` and a `404` with `If-Match` are both mapped to `PreconditionFailed`.
  - `DELETE` with `ifMatch` always pre-checks with a `HEAD`, because some providers answer `204` for missing keys, and it also sends `If-Match`.
  - AWS supports conditional PUT. Many compatible providers lag behind or silently ignore the headers. Run `probeConditionalWrites()` and set `conditionalWrites: false` when it reports `false`. The adapter then emulates the conditions (racy).
- The ETag is an MD5 only for single-part uploads without SSE-KMS. Treat it as opaque.
- **Public read for friends**: give the prefix a bucket policy that allows anonymous `s3:GetObject` on `arn:aws:s3:::<bucket>/<prefix>*`. On AWS you must also relax "Block Public Access" for that bucket. **Do not** grant `s3:ListBucket`, because friends enumerate content through the signed index and not by listing. Pass the resulting URL (bucket URL plus prefix, or a CDN in front) as `publicBaseUrl`, including the prefix.
- **Access key**: scoped to that bucket or prefix only, with `GetObject`, `PutObject`, `DeleteObject`, and `ListBucket` restricted to the prefix.
- **CORS (web build and friends on web)**: a bucket CORS rule that allows the app origin for `GET`, `HEAD`, `PUT` and `DELETE`. Allow the headers `authorization`, `content-type`, `if-match`, `if-none-match`, `x-amz-*`, and expose `ETag`. Friends reading from a browser need at least `GET` and `HEAD` with `ETag` exposed.

### HTTPS read-only (`HttpsReadOnlyAdapter`)

- This is how friends read, and it serves as the owner's mode when they publish by other means (static pages, Git, a sync tool).
- It only issues `GET` and `HEAD`. `put`/`delete` throw `ReadOnly`, and `list` throws `Unsupported`, so you enumerate through the index.
- When a server sends no `ETag`, the adapter builds a weak substitute from `Last-Modified` and the size. That is enough for "skip if unchanged". Many static hosts and CDNs do send ETags.
- **CORS**: for the web build, the host must send `Access-Control-Allow-Origin` (`*` is fine: the content is encrypted) and `Access-Control-Expose-Headers: ETag`. GitHub Pages and Codeberg Pages send `ACAO: *`, but whether `ETag` is exposed is to be checked (see the open questions).
- Requests use `cache: 'no-store'`. React Native's `whatwg-fetch` turns this into an `_=<timestamp>` query parameter on `GET`/`HEAD`, which static hosts ignore.

### SFTP (`SftpAdapter`, **Node only**, `@triangulair/storage/sftp`)

- Built on `ssh2` (an optional peer dependency), which needs Node's `net` and `crypto`. It is a separate entry point, so the main entry stays usable in browsers and React Native.
- SFTP has no ETags, so the adapter emulates them:
  - `etagMode: 'hash'` (the default) uses `"sha256-<hex>"` of the content. It is exact, but `head` and `list` download every file.
  - `etagMode: 'mtime-size'` uses `stat`. It is cheap, but the mtime has 1-second granularity, so a stale `ifMatch` can wrongly succeed when two writes of the same size land in the same second.
- `capabilities.conditionalWrites === false`:
  - `ifNoneMatch: '*'` is atomic: the adapter writes a temporary file, then uses `RENAME`, which fails when the target exists on OpenSSH. This is tested under concurrency.
  - `ifMatch` checks first and then replaces the file, which leaves a race window.
  - Every write goes to a temporary file and is renamed into place (`posix-rename@openssh.com`, with an unlink-and-rename fallback), so readers never see a partial file.
- **Friends' read URL**: a web server that serves the same folder, passed as `publicBaseUrl`. Configure the same CORS headers as for HTTPS.
- Sets `TCP_NODELAY`. Without it, each SFTP round trip stalled on delayed ACKs (the test suite went from 47 s to 2 s).

### In-memory (`MemoryAdapter`)

This is the reference semantics, used in tests and as a fixture. `putUnchecked` seeds read-only fixtures.

## Tests

`npm test` runs vitest and `npm run typecheck` runs `tsc --noEmit` (strict). Install with `npm install --workspaces=false` inside this package.

`runAdapterConformance(factory)` (or `runAdapterConformance(name, factory)`) is the shared suite. It covers missing objects, path validation, binary round-trips, empty files and Unicode names, capabilities, `publicUrl` fetched anonymously, `ReadOnly`, `list` (recursive, sorted, prefix), the conditional put/delete matrix, concurrent conditional writers, isolation from caller mutations, and publish/fetch snapshots, including a lost race between two devices.

| Adapter | Server used (all local and in-process) |
| --- | --- |
| Memory | none (plus a read-only variant) |
| WebDAV | **Nephele** (express middleware, file system, Basic auth, `/pub` static share) |
| WebDAV | **`webdav-server`** npm (in-memory; ignores conditionals, so it runs with emulated conditionals) |
| S3 | **hand-written mock** (`test/support/s3-mock.ts`, clearly labelled): verifies SigV4 and the payload hash, supports conditional PUT/DELETE, ListObjectsV2 pagination, anonymous public read, and an "ignore conditionals" mode |
| HTTPS | local `node:http` static server, plus 401 and connection-refused cases |
| SFTP | in-process **`ssh2` server** on a temp dir (`test/support/sftp-server.ts`) with OpenSSH-like `RENAME` |

Each adapter also has tests for `AuthError` (bad credentials) and `NetworkError` (connection refused), and `probeConditionalWrites` is checked against both enforcing and lax servers.

## Limitations

- **Not tested against real servers**: Nextcloud, MinIO/Garage/AWS, OpenSSH and real CDNs are all untested. That is T-202. The S3 mock follows AWS documentation but is not S3.
- **Nephele does not enforce conditions atomically**: it checks and then writes without a lock, and concurrent `If-Match` writers can all succeed. The conformance fixture flags this with `nonAtomicConditionals`. Whether Nextcloud is atomic under concurrency (file locking) must be verified in T-202. If it is not, the index needs another guard, such as a version counter inside the signed index that readers verify.
- The SFTP test server does not advertise `posix-rename@openssh.com`, so only the unlink-and-rename fallback is tested. That fallback has a short window where the file is missing.
- There are no timeouts or retries, and no quota error type (`507` and S3 `EntityTooLarge` surface as `ProtocolError`). Simulated failures (timeouts, full quota, interrupted writes) are left to T-202.
- Uploads are single requests (no multipart or resumable uploads). That is fine for packs and photos of a few MB.
- The package ships TypeScript sources (`main: src/index.ts`) and has no build step yet.

## Open questions

- **SFTP on mobile**: `ssh2` cannot run in React Native or Hermes. The options are a native module (for example a Swift/Kotlin SFTP bridge, which would need an Expo dev build), making SFTP a desktop/CLI-only write protocol, or dropping SFTP writes on mobile and having users pair SFTP with a sync tool and the HTTPS read mode.
- How does a web build reach Nextcloud with CORS: a recommended reverse-proxy snippet, or a Nextcloud app?
- Do GitHub Pages and Codeberg Pages expose `ETag` to cross-origin scripts? If not, `fetchSnapshot` on the web falls back to a full `GET` (size and `Last-Modified` may also be hidden).
- Should `fetchSnapshot` use a conditional `GET` (`If-None-Match`, `304`) instead of `HEAD` then `GET`? That saves a round trip when the index changed, but it needs CORS to allow the `If-None-Match` request header.
