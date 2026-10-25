# Signed index (version 4.0)

One per owner, published as `index.json` at the owner's read address (a newer major goes to `index.v<N>.json` next to
it during a transition). It lists the owner's packs and carries the master-signed sharing certificate, the revoked
devices and the open-invitation listing, so all of them share the index's rollback protection: a reader needs one
freshness anchor per owner. It is signed by a **device** key certified by the master. Vectors:
`vectors/signed-index.json`. Code: `src/signed-index.ts`, `src/invitation-listing.ts`.

## 1. Shape

Canonical JSON (README §4), at most 16 MiB, members in canonical (sorted) order:

```json
{"device_cert":{"box":"x25519:…","device":"ed25519:…","signature":"<master>"},
 "invitations":["b2b256:…","b2b256:…","b2b256:…","b2b256:…"],
 "move":{<identity move>},
 "owner":"ed25519:…",
 "packs":[{"file":"packs/b2b256-<43>.bin","hash":"b2b256:<43>"},{"file":"media/b2b256-<43>.bin","hash":"b2b256:<43>"}],
 "public":{"file":"public/lists.geojson","hash":"b2b256:<43>"},
 "reads":["4"],
 "revoked_devices":["ed25519:…"],
 "seq":42,
 "sharing_cert":{"key":"x25519:…","location":"https://…","rotation":3,"signature":"<master>"},
 "signature":"<device>",
 "updated":"2026-10-13T15:10:00.000Z",
 "version":4}
```

| Member | Required | Value |
|---|---|---|
| `version` | yes | 4; `minor` (reader minor: 0) and `crit` optional (README §6) |
| `seq` | yes | integer `0 … 2^53 − 1`, publication counter (orders indexes within one rotation) |
| `owner` | yes | owner id |
| `updated` | yes | JSON date, informational; at most 24 h after the reader's clock |
| `sharing_cert` | yes | compact sharing certificate (§2), MUST carry `location` |
| `revoked_devices` | yes | the certificate's `revoked_devices` (covered by its master signature) |
| `reads` | yes | 1 to 32 unique strings matching `^[1-9][0-9]{0,3}(\.[0-9]{1,4})?$`: format versions the owner's app reads |
| `device_cert` | yes | compact device certificate of the signing device (§2) |
| `packs` | yes | at most 100 000 entries `{file, hash}`; `file` = `packs/b2b256-<h>.bin` or `media/b2b256-<h>.bin` where `hash` = `b2b256:<h>` is the BLAKE2b-256 of the file's bytes; no hash twice |
| `public` | no | `{file, hash}` of the plaintext public-list file, `file` matching `^public/[A-Za-z0-9_-]{1,64}\.geojson$` |
| `move` | no | identity move leading to `owner` (identity-move.md) |
| `invitations` | no for readers, always written | 1 to 256 tokens (`b2b256:<43>`), sorted, unique (§6) |
| `signature` | yes | device signature, domain `index`, over `canon(index \ {signature})` |

Unknown members of `packs[]` entries and `public` are allowed exactly when the index is extensible (README §6).

## 2. Compact certificates

- `sharing_cert` = the full sharing certificate minus `type`, `version`, `owner`, `revoked_devices`. The reader
  rebuilds `full = sharing_cert ∪ {"type": "sharing-cert", "version": 3, "owner": index.owner, "revoked_devices":
  index.revoked_devices}` and verifies it as a sharing certificate (sharing-cert.md). If the compact form itself
  contains one of the four implied members → ERROR(FORMAT).
- `device_cert` = the full device certificate minus `type`, `version`, `owner`; rebuilt with `"type": "device-cert",
  "version": 1, "owner": index.owner`; an implied member present → ERROR(FORMAT).

Any other member of a compact form (`location`, `minor`, `crit`, extensions) is kept and covered by the master
signature of the rebuilt certificate.

## 3. Ordering

Indexes of one owner are ordered by **(sharing_cert.rotation, seq)**, lexicographically; `updated` plays no role.
Only the master raises the rotation, so a master-signed rotation that revokes a device supersedes every index that
device signed, whatever their `seq` (R-01). Within one rotation `seq` grows by 1 per publication (writers claim it with
a conditional write); a new rotation may restart it.

## 4. Verification (`verifyIndex(input, {expectedOwner?, retiredOwners?, lastSeen?, location?, now?})`)

`input` is the transported text or bytes (never an object parsed by a JSON library that resolved duplicates).
`now` is the reader's clock.

1. Bytes: more than 16 777 216 bytes → ERROR(FORMAT); strict UTF-8 decode → else ERROR(FORMAT). Text: more than
   16 777 216 UTF-16 code units → ERROR(FORMAT).
2. Canonical JSON object (README §4) → else ERROR(FORMAT).
3. `extensible = checkStructure(index, "index", 4, [version, seq, owner, updated, sharing_cert, revoked_devices,
   reads, device_cert, packs, signature], [public, move, invitations], 0)`.
4. `owner`: parseKey ed25519 → ERROR(FORMAT).
5. `seq`: not an integer ≥ 0 → ERROR(FORMAT).
6. `updated`: JSON date → else ERROR(FORMAT); `updated > now + 24 h` → ERROR(FORMAT) (retry later).
7. `revoked_devices`: not an array, or more than 256 entries → ERROR(FORMAT).
8. `sharing_cert`: not an object → ERROR(FORMAT); rebuild the full certificate (§2) and verify it (sharing-cert.md
   §2) with `retiredOwners` only (FORMAT, UNSUPPORTED_VERSION, INVALID_KEY, SIGNATURE, REVOKED as there).
9. The certificate has no `location` → ERROR(FORMAT). `certified = location`.
10. `device_cert`: not an object → ERROR(FORMAT); rebuild and verify it (device-cert.md §2), with no options.
11. The device is in the certificate's `revoked_devices` → ERROR(REVOKED).
12. `reads`: not an array, more than 32 entries, empty, an entry that is not a string matching the pattern, or a
    duplicate → ERROR(FORMAT).
13. `packs`: not an array, or more than 100 000 entries → ERROR(FORMAT). For each entry: not an object →
    ERROR(FORMAT); missing `file` or `hash`, or (index not extensible) another member → ERROR(FORMAT); `hash` not a
    string matching `^b2b256:([A-Za-z0-9_-]{43})$`, or `h` not a strict b64u of 32 bytes → ERROR(FORMAT); `file` not a
    string → ERROR(FORMAT); `file` ∉ {`packs/b2b256-<h>.bin`, `media/b2b256-<h>.bin`} → ERROR(FORMAT); `h` already
    seen → ERROR(FORMAT).
14. `public`, if present: not an object → ERROR(FORMAT); members and `hash` as in step 13; `file` not matching
    `^public/[A-Za-z0-9_-]{1,64}\.geojson$` → ERROR(FORMAT).
15. `invitations`, if present: not an array, or more than 256 entries → ERROR(FORMAT); empty → ERROR(FORMAT); an
    entry that is not a hash string as in step 13 → ERROR(FORMAT); not sorted and unique → ERROR(FORMAT). (Readers do
    not check the power-of-two padding.)
16. `move`, if present: not an object → ERROR(FORMAT); verify it (identity-move.md §2, no options); `move.to ≠
    owner` → ERROR(FORMAT).
17. `signature`: b64u 64 bytes → else ERROR(FORMAT); verify with the device key of step 10, domain `index`, message
    `canon(index \ {signature})` → else ERROR(SIGNATURE).
18. `owner` ∈ `retiredOwners` → ERROR(REVOKED).
19. `expectedOwner` given and ≠ `owner`: if `move` exists and `move.from = expectedOwner` →
    ERROR(IDENTITY_MOVED, from, to); else if `move` exists and `move.from` ∈ `retiredOwners` →
    ERROR(IDENTITY_MOVED, from, to, conflict = true); else ERROR(OWNER_MISMATCH).
20. `lastSeen` given (an index or an anchor of this owner): `checkNoRollback(index, lastSeen)` (§5).
21. `location` given (the address the reader actually fetched) and ≠ `certified` → ERROR(MOVED, location =
    certified): the index is fully verified but the owner moved storage; fetch it again at `certified`, and only there.
22. Accept. The index is **owner-bound** if `expectedOwner` was given (or the index was produced by the owner's own
    writer): only an owner-bound index can be used to open packs (V3-11). Record the address it was read from
    (`location`): the invitation checks require it.

## 5. `checkNoRollback(next, lastSeen)`

`lastSeen` is a verified index or an anchor (§7). For an index, `last = {version, owner, seq, sharing_cert = its full
certificate (§2), hash = "b2b256:" || b64u(BLAKE2b-256(UTF8(canon(index))))}`; the canonical text is exactly the
transported text.

1. `next.owner ≠ last.owner` → ERROR(OWNER_MISMATCH).
2. `next.version < last.version` → ERROR(ROLLBACK).
3. `checkSharingCertNotOlder(full certificate of next, last.sharing_cert)` (sharing-cert.md §3): lower rotation →
   ROLLBACK; same rotation, other certificate → ROLLBACK with fork; un-revocation → ROLLBACK.
4. `next` rotation > `last` rotation → accept (whatever `seq`).
5. `next.seq < last.seq` → ERROR(ROLLBACK).
6. `next.seq = last.seq`: hash of `next` ≠ `last.hash` → ERROR(ROLLBACK, fork = true) (report it; accept the next
   higher seq); else accept (re-delivery).
7. `next.seq − last.seq > 2^20` → ERROR(ROLLBACK) (keep `lastSeen`, report it; recovering needs a new rotation).
8. Accept.

Within an owner this is a total order on (rotation, seq) once forks are excluded (a property test checks it).

## 6. Invitation listing

`invitations` lists one **token** per open invitation (invitation-link.md §3), padded with dummy tokens so the index
never tells whether an invitation is open. A writer lists exactly the invitations that `listable` (invitation-record.md
§3) accepts under the index's own sharing certificate at the index's `updated` time `now`, then pads:

    padListing(tokens, padKey, now):
      real = tokens without duplicates
      size = 4; while size < |real|: size = 2 × size
      size > 256 → ERROR(FORMAT) (too many open invitations)
      out = set(real); i = 0
      while |out| < size: out.add(dummy(i)); i = i + 1      (a dummy equal to a member already present is skipped)
      return sorted(out)                                   (byte order of the ASCII strings)

    padKey   = BLAKE2b-256(key = vault data key, "TrianguLair-invitation-padding-key-v1")
    p        = BLAKE2b-64(key = padKey, "TrianguLair-invitation-padding-period-v1\n" || u32 i)
    period   = 86400 + (u32(p[0..4)) mod 518401)            seconds, 1 to 7 days
    phase    = u32(p[4..8)) mod period
    epoch    = floor((floor(now / 1000) + phase) / period)    now in ms; integer arithmetic
    dummy(i) = "b2b256:" || b64u(BLAKE2b-256(key = padKey, "TrianguLair-invitation-padding-v2\n" || u32 i || u32 epoch))

Every device of the owner holds the vault data key, so devices publishing at the same time write the same list; each
dummy changes at its own period and phase, like real tokens which live at most 7 days. The field is written in every
index (padding only when nothing is open); readers accept an index without it. What remains observable is listed in
THREATS.md (republication times, the bucket, a dummy that comes back). Vectors: `padding-*` (with each slot's `p`,
`period`, `phase`, `epoch`).

## 7. Index anchor

The compact form of `lastSeen` kept in the recovery vault (vault.md):

```json
{"hash":"b2b256:<BLAKE2b-256 of the canonical index>","owner":"ed25519:…","seq":42,
 "sharing_cert":<full sharing certificate>,"type":"index-anchor","version":4}
```

`version` is the index's major version. Validation when read from the vault (`verifyIndexAnchor`): exactly these six
members (else FORMAT), `type = "index-anchor"` (FORMAT), `version` integer ≥ 1 (FORMAT), `owner` an ed25519 key
(FORMAT), `seq` integer ≥ 0 (FORMAT), `hash` matching the hash pattern (FORMAT), `sharing_cert` an object verified as a
sharing certificate of `owner` (its errors; another owner is OWNER_MISMATCH). The anchor's `hash` and `seq` are not
otherwise authenticated (they come from the vault, encrypted under the vault data key).

## 8. Writing (`signIndex(signer, content)`)

1. The sharing certificate verifies and has a `location` (else FORMAT); the signer's device certificate verifies for
   the certificate's owner, matches the signer's keys (FORMAT) and is not revoked by the certificate (REVOKED).
2. Body: `version` 4, `seq`, `owner`, `updated` = now (ISO with milliseconds), compact `sharing_cert`,
   `revoked_devices`, `reads` (default `["4"]`), compact `device_cert`, `packs`, optional `public` and `move`, and
   `invitations = padListing(listable invitations, padKey(vault data key), now)` (§6). The index is written from the
   owner's state; an older writer never copies members it does not know.
3. Sign (domain `index`) and verify the result as a reader would (with `expectedOwner` and the certified `location`).
4. With `previous` (the index currently on the storage, or its anchor): `checkNoRollback(new, previous)`, and within the
   same rotation `seq = previous.seq + 1` (else ROLLBACK, V3-13).

Publication order on the storage: packs first, the index last (an index always points to complete files).

## 9. Public file

`public.file` is a plaintext GeoJSON file, content-addressed by `public.hash` like a pack. A reader shows it only after
checking `BLAKE2b-256(bytes)` against an owner-bound verified index (`verifyPublicFile`, else NOT_INDEXED).
