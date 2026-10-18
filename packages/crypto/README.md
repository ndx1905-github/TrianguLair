# @triangulair/crypto

TrianguLair's encrypted data format (phase-0 prototype, revised after the T-002 review, the second review of its
fixes, `docs/reviews/2026-10-13-crypto-fixes-review.md`, and the third review of format v3,
`docs/reviews/2026-10-18-crypto-v3-review.md`). Pure functions,
`Uint8Array` in/out, libsodium (`libsodium-wrappers-sumo`, works in Node, web and React Native). License: MPL-2.0.

```ts
import { ready, identityFromPhrase, sealPack, verifyIndex, openPack } from '@triangulair/crypto';
await ready(); // required once before anything else
```

`npm test` (vitest) and `npm run typecheck` (tsc, strict).

## Encoding conventions

- Binary inside JSON: **base64url, no padding**, strictly decoded (non-canonical encodings rejected).
- Public keys in JSON: `"ed25519:<b64url>"` (master key = the *owner id*, and device keys) and `"x25519:<b64url>"`
  (sharing, device box, group and invitation keys). X25519 keys that are all-zero, of low order, or non-canonical (bit
  255 set) are rejected with `InvalidKeyError` (`INVALID_KEY`) wherever they are parsed or used as recipients.
- Dates: ISO-8601 UTC, `YYYY-MM-DDTHH:MM:SS[.mmm]Z`, which must be a real instant (no Feb 30). Written as
  `Date#toISOString()`. Binary structures use u32 unix seconds.
- **Canonical JSON** (`canonicalize`): object keys sorted by UTF-16 code units, recursively; no whitespace;
  strings escaped like `JSON.stringify`; numbers must be safe integers (no floats/NaN; `-0` → `0`);
  only plain objects, arrays, strings, integers, booleans, `null`. For this domain it is byte-identical
  to RFC 8785 (JCS).
- **Transported JSON MUST be canonical.** Every parser of transported text (signed documents, pack headers, payloads)
  requires `canonicalize(JSON.parse(s)) === s`. This rejects duplicate keys (parser differentials between
  implementations), whitespace and key-order variants. UTF-8 input is decoded strictly and a leading BOM is kept (so it
  is rejected). `verifyIndex`, the entry point for JSON read from a storage, takes **text or bytes only** (V3-12): a
  parsed object (`await res.json()`) has already lost duplicate keys and is refused, except an object that `verifyIndex`
  or `signIndex` itself returned. Certificates, identity moves and payloads travel inside the index, inside binary
  structures or inside encryption; their verifiers still accept objects for in-process use.
- **Signatures** (Ed25519 detached) cover `UTF-8("TrianguLair-signature-v1\n" + domain + "\n") ‖ message`, where
  message is `canonicalJSON(doc without "signature")` for JSON documents, or the signed bytes of a binary structure.
  Domains: `index | sharing-cert | device-cert | identity-move | identity-move-to | invitation | invitation-response`.
- **Versioning** (spec "Format versions", V3-03). Binary structures carry a single **major** version (the byte after
  the magic). JSON structures (index, certificates, identity move, pack header, sealed-key and key-export payloads,
  group-key payload, vault records) carry:
  - `version`: the **major** version, read only if it is exactly the one this library knows (else
    `UnsupportedVersionError`, `code: "UNSUPPORTED_VERSION"`, `found`, `supported`);
  - `minor` (optional integer ≥ 1, absent = 0): compatible additions. When `minor` is **higher** than the one this
    library reads (0 for every structure today), unknown fields are **accepted and ignored**; they stay covered by the
    signature (computed over the canonical form of the whole document, unknown fields included) or by the AEAD
    associated data (pack header). Otherwise an unknown field is a `FormatError`. Nested objects of the index (compact
    certificates follow their own rule; `packs[]`, `public`) follow the index's rule;
  - `crit` (optional, non-empty, sorted, unique list of field names, like JWS/JWE `crit`): fields that **affect
    security**. Each must be present, and a reader that does not know one of them refuses the whole document with
    `UnsupportedVersionError` (`critical` names the field). A security extension that must never be dropped needs a
    major version: an older device rewriting the index writes its own minor and drops fields it does not know.
  A new **major** index version is published under its own file name next to the old one during the transition
  (`index.json` holds the oldest major still written, `index.v<N>.json` each newer one; readers try the highest major
  they read first).
- Errors all extend `TLCryptoError` with a `code`: `FORMAT`, `UNSUPPORTED_VERSION`, `INVALID_KEY`, `DECRYPT`,
  `NO_MATCHING_KEY`, `NOT_INDEXED`, `SIGNATURE`, `OWNER_MISMATCH`, `REVOKED`, `IDENTITY_MOVED` (`conflict: true` for
  a second, different move of an identity already left behind), `MOVED` (`StorageMovedError { location }`: the owner's
  certified read address is elsewhere), `EXPIRED`, `ROLLBACK` (`fork: true` for "same
  rotation and seq, different content"), `INVALID_PHRASE`, `INVALID_CODE`, `NOT_READY`.
  **Codes are for local handling only**; never reflect them to a remote party (e.g. `DECRYPT` vs `NO_MATCHING_KEY`
  tells whether a wrap was addressed to you). Messages never echo rejected numeric values.

| Structure | Version constant | Version | Changed by the third review |
|---|---|---|---|
| Signed index | `INDEX_VERSION` (`INDEX_MINOR` = 0) | 4 | `sharing_cert.location`, `minor`/`crit` |
| Pack envelope and header | `PACK_VERSION` | 4 | payload type byte, AD over every header field |
| Sharing certificate | `SHARING_CERT_VERSION` | 3 | `location`, `rotation` is a u32 |
| Device certificate | `DEVICE_CERT_VERSION` | 1 | (`minor`/`crit` rule only) |
| Identity move | `IDENTITY_MOVE_VERSION` | 1 | (`minor`/`crit` rule only) |
| Sealed sharing key | `SHARING_KEY_VERSION` | 2 | `vault_key` in the payload |
| Group-key payload | `GROUP_KEY_VERSION` | 2 | (`minor`/`crit` rule only) |
| Invitation link and return link | `INVITATION_VERSION` | 4 | carry the compact sharing certificate (read address) |
| Transfer blob | `TRANSFER_VERSION` | 2 | |
| Key export | `KEY_EXPORT_VERSION` | 3 | `vault_key` |
| Vault records and envelope | `VAULT_VERSION` | 1 | new |
| Primary identity | `PRIMARY_IDENTITY_VERSION` | 1 | |

## Keys (spec: "Loss and theft", "Adding a device")

Three levels, so that the theft of an ordinary device does not cost the identity:

```
12 BIP39 words ──(checksum, 128-bit entropy)──► entropy
root       = BLAKE2b-256(key = entropy, msg = "TrianguLair/root/v1")      (wiped after use, never stored)
master     = Ed25519 from crypto_kdf(root, id = 1, ctx = "TLmaster")     signs certificates only
vault key  = crypto_kdf(root, id = 2, ctx = "TLvault_")                  phrase copy of the sharing key + vault data key
sharing    = random X25519 (generateX25519KeyPair)                       NOT derived from the phrase
vault data = random 32 bytes (generateVaultDataKey)                      encrypts the vault records; every device holds it
device     = random Ed25519 (signs indexes) + random X25519 (box), generated on each device, never copied
```

- `identityFromPhrase(phrase) → Identity { owner, master, vaultKey }`. The identity (master + vault key) exists only
  while the 12 words are typed, or on the optional **primary device**: `encodePrimaryIdentity(identity)` (69 bytes:
  `"TLPI" ‖ 1 ‖ master seed ‖ vault key`, to keep in Keychain/Keystore) / `decodePrimaryIdentity(bytes)`.
- **Device certificate** (master-signed): `issueDeviceCert(identity, devicePublicKeys(deviceKeys))` /
  `verifyDeviceCert(c, { expectedOwner?, retiredOwners? })`:
  `{"box":"x25519:…","device":"ed25519:…","owner":"ed25519:…","signature":"…","type":"device-cert","version":1}`.
- **Sharing certificate** (master-signed): `issueSharingCert(identity, sharingPk, { rotation, location?, revokedDevices? })`
  / `verifySharingCert(c, { expectedOwner?, retiredOwners?, lastSeen? })`:
  `{"key":"x25519:…","location":"https://…","owner":"ed25519:…","revoked_devices":["ed25519:…"],"rotation":3,"signature":"…","type":"sharing-cert","version":3}`.
  - `location` is the owner's **read address**, certified by the master (V3-01): friends read the owner's index only
    there, and invitations and return links carry this certificate instead of a free address. It is absent only for an
    owner who publishes nothing. **Changing storage therefore needs the master key** (phrase or primary device): issue
    rotation `r + 1` (the same sharing key may be kept) with the new address.
  - `rotation` is a u32 (0 … 2^32 − 1) and increases at every change of key, address or revoked devices.
  - `revoked_devices` is sorted, unique and **permanent** (a later rotation must keep it).
  - With `lastSeen`: lower rotation → `RollbackError`; same rotation, any other content (key, address, revocations,
    extension fields) → `RollbackError` with `fork`; a later rotation that un-revokes a device → `RollbackError`.
- **Sealed sharing key** (`sealSharingKey({ keyPair, cert, vaultDataKey }, to)` / `openSharingKey(bytes, holder,
  { expectedOwner?, lastSeen? })`), how the current sharing key **and vault data key** reach each device, and the
  phrase-protected copy in the recovery vault (V3-10). `sealSharingKey` refuses a device that the certificate itself
  revokes (`REVOKED`). Anyone can seal to a device's public box key, so pass `lastSeen` (the sharing cert the device
  already holds) whenever there is one: an older rotation is then refused (`ROLLBACK`).
  ```
  "TLSK" | version 2 | mode u8
    mode 1 (to a DeviceCert):   crypto_box_seal(payload, device box key)
    mode 2 (to an Identity):    nonce 24B ‖ XChaCha20-Poly1305(payload, AD = bytes[0..6) ‖ nonce, key = vault key)
  payload = {"cert":<sharing cert>,"secret":"<32B>","to":"<device id | owner id>","type":"sharing-key",
             "vault_key":"<32B vault data key>","version":2}
  ```
- **Adding a device**: the new device runs `generateDeviceKeys()` and shows `devicePublicKeys(keys)` (QR). The primary
  device (or the phrase) issues its device cert and `sealSharingKey(current, deviceCert)`. With "link + code", the
  transfer carries `encodeKeyExport(current)` (sharing key, cert and vault data key, never the master); the new device then needs a
  device cert from the primary device or the phrase before it can publish. `decodeKeyExport(bytes, { expectedOwner?,
  lastSeen? })` takes the same `lastSeen` rule.
- **Declare a device lost** (phrase or primary device): new random sharing key and **new vault data key**
  (`generateVaultDataKey()`), `issueSharingCert(identity, pk, { rotation: r + 1, location, revokedDevices: [...previous,
  lostDeviceId] })`, `sealSharingKey` to each remaining device cert and to the identity (vault), `sealVault` the records
  with the new vault data key, re-encrypt own content, publish an index embedding the new cert. A stolen ordinary device
  holds neither the phrase, nor the master key, nor the phrase-derived vault key, nor the new vault data key: it can
  neither obtain the new keys nor certify one, and it can no longer pass as the owner to a **new** contact either
  (`checkInvitationIndex` reads the revocation at the certified address).
  Indexes are ordered by `(rotation, seq)`, so the new rotation supersedes every index the stolen device signed, whatever
  its `seq`, for every reader that sees it; afterwards the device's indexes are refused (`REVOKED` with the new cert,
  `ROLLBACK` with the old one). Remote wipe: a device that finds its own id in the
  `revoked_devices` of a verified index of its owner erases its keys.
- **Change storage** (phrase or primary device): `issueSharingCert(identity, samePk, { rotation: r + 1, location: newAddress,
  revokedDevices })`, publish the new index at the new address **and** leave the same newest index at the old address
  for a few months (the signed redirect of the spec). A reader that verifies it with `location: oldAddress` gets
  `StorageMovedError { location: newAddress }` after full verification and reads only there from then on. Never leave
  a stale index at an old address: replace it with the newest one, or delete it.
- **Identity change** (primary device stolen): `issueIdentityMove(oldIdentity, newIdentity)` →
  `{"from":"ed25519:old","issued":"…","signature":"<old master>","to":"ed25519:new","to_signature":"<new master>","type":"identity-move","version":1}`,
  published as the `move` field of the new identity's index. A reader calling `verifyIndex(…, { expectedOwner: old })`
  gets an `IdentityMovedError { from, to }` (never an automatic accept): show "Marie changed her identity", remove the
  "verified" mark, then follow `to` with `retiredOwners` including `from`. Everything later signed by a retired master is
  refused (`REVOKED`). If an index carries a valid move from a retired identity to *another* successor than the one
  followed, the error has `conflict: true`: two moves exist, the old master is compromised; warn and require a
  safety-code comparison. The new identity keeps `move` in every index (friends who were offline need it). Packs are
  bound to their owner, so after a move the content is re-sealed under the new owner id (`openPack` with the old index,
  `sealPack(newOwner, …)`).

## Content pack (binary)

```
offset size  field
0      4     magic "TLPK"
4      1     envelope version = 4
5      4     N = header length (uint32 BE, ≤ 64 KiB)
9      N     header, canonical JSON UTF-8
9+N    …     XChaCha20-Poly1305-IETF ciphertext ‖ 16-byte tag
```

Header (no pack id, no recipient information):

```json
{"alg":"xchacha20poly1305-ietf","nonce":"<24B>","pad":"padme","type":"pack","version":4,
 "wrapAlg":"x25519-sealedbox","wraps":["<80B>", "..."]}
```

- Plaintext = `logical id (16 B) ‖ payload type (1 B) ‖ u32 payload length ‖ payload ‖ zero padding`. The **logical id
  is inside the encryption**: neither the storage nor a former friend can link successive versions of a pack.
- **Payload type** (V3-16), inside the AEAD: `1` = content, `2` = group-key, `3` = media. `sealPack(…, { type:
  "content" | "media" })` (default content), `sealGroupKey` writes `2`; `openPack` returns `type`, `openGroupKey`
  refuses anything but `2`, and `retireInvitationKey` recognises group secrets by it (no payload sniffing).
- `pad: "padme"` (default): plaintext length = `max(256, Padmé(21 + payload length))` (`paddedLength`), at most ~12 %
  overhead; `pad: "none"`: no padding. Readers check the exact length and that the padding is zeros. Padmé, with integer
  operations only: for `n ≤ 256` the result is 256; otherwise `e = floor(log2 n)`, `s = floor(log2 e) + 1`,
  `step = 2^(e − s)`, result `= ceil(n / step) × step` (vectors in `test/review-fixes.test.ts`).
- Batch key: random 32 bytes per encryption. Nonce: random 24 bytes.
- **AEAD associated data** = `"TLPK" ‖ version ‖ owner master public key (32 B) ‖ canonicalJSON(header without
  "wraps")`, every other header field included (extension fields of a newer minor too). The owner is not written in the file; the reader takes it from the verified index the pack is listed in, so
  a pack re-listed in someone else's index fails to open (`DECRYPT`): no re-attribution, no resurrection under another
  name.
- `wraps` are outside the AD; a modified wrap can only fail to open. Each wrap = `crypto_box_seal(batchKey, recipientPk)`
  = 32 B ephemeral pk ‖ 16 B MAC ‖ 32 B key. At most `MAX_WRAPS` = 256 (checked before any work).
- **Files are content-addressed**: `packEntry(bytes) → { file: "packs/b2b256-<b64url hash>.bin", hash: "b2b256:<b64url
  BLAKE2b-256>" }` (`"media/…"` for photos). A new version is a new file; files are never modified.

### Wrap anonymity (design choice)

**No hint at all.** Sealed boxes use a fresh ephemeral key and carry no recipient identifier, so the header contains no
recipient public key, hash or stable tag, and two wraps to the same person in two packs are unlinkable. Readers try every
wrap with every candidate key (sharing key, group keys, invitation key). The wrap list is **shuffled** and **padded** with
dummy wraps (real sealed boxes of random bytes to throwaway keys) to the next power of two ≥ 2 (`padTo` to override,
`padTo: 0` disables).

### Operations

- `sealPack(ownerId, payload, recipientPks, { id?, padTo?, pad? })`: `ownerId` is the owner of the index that will list
  the pack.
- `openPack(bytes, verifiedIndex, keys) → { id, type, payload, file }`: **the only way to decrypt**. `verifiedIndex` must
  be an object returned by `verifyIndex` **with `expectedOwner`** or by `signIndex` (checked at run time, and frozen;
  V3-11: an index verified for nobody in particular opens nothing); the content hash is looked up in it
  **before any key operation**, so a pack not listed in its owner's verified index is ignored (`NOT_INDEXED`). This is how
  "everything is signed with my key" applies to packs. The registry of verified indexes is per copy of the package (a
  module-level `WeakSet`): an index verified by one bundled copy is `NOT_INDEXED` for another copy. Bundle one copy.
- `rewrapPack(bytes, ownIndex, keys, recipientPks)`: same batch key and ciphertext, new wraps. Only to **add** recipients;
  it is **not** a revocation.
- `reencryptPack(bytes, ownIndex, keys, remainingPks)`: **revocation**: new batch key and nonce, same logical id, new file.
- `readPackHeader(bytes)`, `packHash(bytes)`, `packEntry(bytes, dir?)`, `paddedLength(n)`.

## Groups

A group is an X25519 key pair. Content wraps to the group public key like to anyone else. The group secret is distributed
in an ordinary pack: `sealGroupKey(group, ownerId, memberPks)` / `openGroupKey(bytes, verifiedIndex, keys)`, payload
`{"generation":n,"group":"<16B>","owner":"ed25519:…","secretKey":"<32B>","type":"group-key","version":2}`.
`openGroupKey` accepts it only if listed in the verified index **and** `owner` equals that index's owner, so a former
member cannot forge "generation n + 1". Key groups by `(owner, id)`; `generation ≥ 1`. Removing a member:
`rotateGroup` → `sealGroupKey` to remaining members → `reencryptPack` the affected packs. **An invitation key is never a
group member**: it is a direct recipient of the content it may read (`retireInvitationKey` refuses a group-key pack).

## Signed index

Signed by a **device key** certified by the master; the master-signed sharing certificate and revoked-device list are
embedded, so they share the index's rollback protection (one freshness anchor per owner).

```json
{"device_cert":{"box":"x25519:…","device":"ed25519:…","signature":"<master>"},
 "owner":"ed25519:…",
 "packs":[{"file":"packs/b2b256-<43>.bin","hash":"b2b256:<43>"}],
 "public":{"file":"public/lists.geojson","hash":"b2b256:<43>"},
 "reads":["4"],
 "revoked_devices":["ed25519:…"],
 "seq":42,
 "sharing_cert":{"key":"x25519:…","location":"https://…","rotation":3,"signature":"<master>"},
 "signature":"<device>",
 "updated":"2026-10-13T15:10:00.000Z",
 "version":4}
```

Optional `move` (identity move, see Keys), `minor` and `crit` (Versioning). The compact `sharing_cert` is the full
certificate minus `type`, `version`, `owner` and `revoked_devices`, and is verified as the full certificate: the
top-level `owner` and `revoked_devices` are covered by the master signature, and so is `location` (required in an
index). The compact `device_cert` is verified as `{owner, device, box, …}`. At most 16 MiB (`MAX_INDEX_BYTES`), checked
before parsing.

- `signIndex({ keys, cert }, { seq, sharingCert, packs, reads?, public?, move?, previous?, now? })` (round-trip
  verified). With `previous` (the index currently on the storage, or its anchor) it refuses to publish an index that
  readers would refuse: no rollback, and `seq = previous.seq + 1` within the same rotation (V3-13). The publish flow:
  read the storage index, verify it, sign with `previous`, write with `If-Match`. If the storage index jumped (a stale
  or buggy device), prompt for a new rotation.
- `verifyIndex(textOrBytes, { expectedOwner?, retiredOwners?, lastSeen?, location?, now? })` checks, in addition to
  the structure and signatures:
  - the signing device is certified by the owner's master and **not** in `revoked_devices` (`REVOKED`);
  - `updated` is at most **24 h** in the future (`FormatError`, retry later); it is otherwise informational;
  - `packs[].hash` = `b2b256:` + 32 bytes, `packs[].file` = `packs|media/b2b256-<same hash>.bin`, no duplicates;
    `public` = `{file: "public/<name>.geojson", hash}` (no absolute URLs, no traversal), built with
    `publicEntry(bytes, name)`; readers check the plaintext file with `verifyPublicFile(bytes, verifiedIndex)`
    (`NOT_INDEXED` if it does not match) before showing it;
  - `reads`: 1 to 32 unique version strings (`"4"`, `"4.1"`);
  - with `location` (the address the index was read from): after full verification, if the certified address is
    another one, `StorageMovedError { location }` (follow it; never read elsewhere). `checkInvitationIndex` requires
    this option;
  - with `lastSeen`, `checkNoRollback(next, lastSeen)`: indexes are ordered by **`(sharing_cert.rotation, seq)`**.
    The embedded sharing cert is compared first: lower rotation → `RollbackError`; same rotation, other cert → fork; a
    higher rotation that un-revokes a device → `RollbackError`; any other **higher rotation is accepted whatever its
    `seq`** (only the master raises the rotation, so a device cannot outrank its own revocation, and a new rotation may
    restart `seq`). Within one rotation: lower seq → `RollbackError`; same seq with other content → `RollbackError` with
    `fork: true` (report it and accept the next higher seq); a seq more than `MAX_SEQ_STEP` (2^20) above the last seen
    one → `RollbackError` (keep `lastSeen`, report it).
- `sharingCertOf(index)`: the full, verified sharing certificate (to wrap content to a friend, or as `lastSeen`).
- `indexAnchor(index)` → `{"hash":"b2b256:…","owner":…,"seq":…,"sharing_cert":<full cert>,"type":"index-anchor",
  "version":4}`: the compact form of `lastSeen` kept in the recovery vault (`lastSeen` and `previous` accept an index or
  an anchor; a same-`seq` fork is detected by the hash of the canonical index).
- `serialize(doc)` = canonical JSON, the only accepted transport form. Persist the last accepted index (or its anchor)
  per owner, also in the recovery vault, so that a restore does not fall back to trust on first use.
- Allocate `seq` with a conditional write (`If-Match`) on the index file, as last seq + 1. The storage ETag is a cache
  hint only. If an index cannot be superseded within its rotation (a jammed `seq`), issue a new rotation.

## Invitation (spec: "Invitation link and return link")

Invitations and return links are signed by a **device key** and carry its master-signed device certificate, so an
ordinary device invites and answers without the master key (the 12 words are needed only to add or remove a device,
change the sharing key or change storage). They also carry the signer's current **sharing certificate**, whose master
signature covers the read address (V3-01): a link cannot choose where its reader goes, so a device declared lost cannot
send a new contact to a host it controls.

**Compact certificates** inside links:

```
sharing cert = key 32B | rotation u32 | n u16 | n × 32B revoked device keys | L u16 | location L (0 = none) | master sig 64B
device cert  = device pk 32B | box pk 32B | master sig 64B
```

They are rebuilt as version-3 / version-1 certificates and verified like any other. A certificate with extension fields
(`minor`, `crit`, …) cannot travel in a link (binary structures have no minor version).

**Link** (`createInvitation({ keys, cert }, currentSharingCert, { now?, ttlMs? }) → { invitation, fragment }`), compact
binary, put in the URL **fragment** (`https://triangulair.app/i#<fragment>`), never sent to a server:

```
0 0x49 "I" | 1 version=4 | 2 id 16B | 18 owner master pk 32B | 50 created u32 s | 54 expires u32 s |
58 compact sharing cert (location REQUIRED) | compact device cert 128B | invitation X25519 secret 32B |
Ed25519 signature 64B (device key, domain "invitation") over every byte before the secret ‖ invitation PUBLIC key
```

386 + 32 × (revoked devices) + L bytes: about 570 base64url characters with a typical share address and no revoked
device, about 600 with the URL prefix (a QR code of version 17 at level L, 20 at level M); each revoked device adds 43
characters. `createInvitation` refuses a certificate without `location` (connect a storage first) and a signer that the
certificate revokes. `ttlMs` is an integer between 60 s and 7 days; the link is round-trip checked.
`parseInvitationLink(link, { now? })` checks the length (at most 12,288 characters) before decoding, both certificates
against the owner, the device signature, that the device is not revoked by the carried certificate, the validity, a
`created` at most 5 minutes after the reader's clock (V3-04) and expiry (`ExpiredError`). It returns `{ id, owner,
device, cert, location, keyPair, created, expires }`.

**Read address** (`location`, in sharing certificates): `https://`, canonical WHATWG form (`new URL(l).href === l`, so
no backslash or other parser-dependent spelling), no credentials, no fragment, at most 512 bytes, and no local-network
host (`localhost`, `*.local`, `*.internal`, loopback, private, link-local, CGNAT or multicast IP literals, including IPv4
addresses embedded in IPv6: `::/96`, `::ffff:0:0/96`, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4 `2002::/16`;
V3-09): the app fetches it. `checkLocation(l)`.

**Freshness for a new contact.** Read the owner's index **only** at `received.location`, verify it with `verifyIndex(text,
{ expectedOwner: received.owner, location: received.location, lastSeen? })` (follow `StorageMovedError` to the newer
certified address), then call `checkInvitationIndex(received, index, { lastSeen? })`:

- the index was verified with the address it was read from, which is its own certified address;
- same owner; the index's certificate is not older than the one in the link (same rotation → the very same certificate;
  a later rotation keeps every revocation) (`ROLLBACK`);
- the device that signed the link is not revoked in that index (`REVOKED`);
- if the owner is already a contact, pass `lastSeen`: **a link must never reset an existing contact's anchor to trust
  on first use**.

Then keep that index (or `indexAnchor(index)`) as the first `lastSeen` for this owner.

**Return link** (`createInvitationResponse(received, { keys, cert }, ownSharingCert, { now? })`):

```
0x52 "R" | version=4 | crypto_box_seal(inner, invitation public key)
inner = invitation id 16 | responder master pk 32 | created u32 s | compact sharing cert | compact device cert 128 | signature 64
signature (responder device key, domain "invitation-response") over inner[0..end-64) ‖ inviter master pk ‖ invitation pk
```

398 + 32 × (revoked devices) + L bytes (531 base64url characters without location). The response is bound to the
inviter and the invitation key, its `created` must fall inside the invitation's validity, its device must not be revoked
by the carried sharing cert, and its read address (if the responder publishes) is the one certified in that cert
(`answer.location`). The owner reads the responder's index there and applies `checkInvitationIndex(answer, index)`
exactly like the invitee. An answer whose certificate has no address cannot be freshness-checked
(`checkInvitationIndex` throws `FORMAT`); see THREATS.md.

**Owner side**:

- `collectInvitationAnswers(invitation, allResponses, { now?, acceptedOwner? }) → { answers, rejected, multiple,
  accepted, late }`: **one answer per invitation**. Pass every answer received; one responder → `accepted`; several →
  `multiple: true`, `accepted: null`, all returned: the user chooses, with a warning. **Keep the invitation record
  (with its key pair) until expiry + 7 days (`INVITATION_ANSWER_GRACE_MS`), also after acceptance**, and keep
  collecting with `acceptedOwner`: any other responder is returned in `late` ("a second person answered this
  invitation; the first may have been an impostor": offer to revoke and to compare the safety code). Answers whose
  signed `created` falls before expiry are opened, accepted and reported in `late` during the grace period (V3-02);
  after it, `ExpiredError`. (`openInvitationResponse` opens a single answer.) A record with a malformed date fails
  closed: `isInvitationExpired` is `true` and opening answers throws `FORMAT` (V3-07).
- `retireInvitationKey(packs, ownIndex, invitation.keyPair, recipientsFor)`: on acceptance **or expiry**,
  **re-encrypts** (new batch keys, not a rewrap) every pack that the invitation key can open, for
  `recipientsFor(logicalId)` (which must not contain the invitation key). `packs` must hold the bytes of **every** file
  listed in `ownIndex.packs` (packs and media): a missing one is a `FormatError` (V3-08). Returns `{ oldFile, bytes }[]`:
  publish the new files in a new index and delete the old ones. It throws if the invitation key received a group secret
  (payload type group-key): the invitation key must be a direct recipient, never a group member. The invitation key
  stops reading content at retirement; the record stays for the grace period only to open answers.

## Recovery vault (spec: "Recovery kit")

The records that the security rules depend on, encrypted with the random **vault data key** (`SharingKey.vaultDataKey`),
which travels to each device in `TLSK` and is kept, with the sharing key, in the phrase-protected `TLSK` copy:

```
"TLVD" | version 1 | nonce 24B | XChaCha20-Poly1305(plaintext, AD = bytes[0..5) ‖ owner master pk 32B ‖ nonce, key = vault data key)
plaintext = u32 length ‖ canonical JSON records ‖ zero padding (Padmé, at least 256 bytes)
```

```json
{"app":{"…":"free-form app data: storage credentials, groups, settings"},
 "contacts":[{"anchor":<index-anchor>,"owner":"ed25519:…","sharing_cert":<their sharing cert>,"verified":true}],
 "invitations":[{"accepted":"ed25519:…","answers":["<b64url return link>"],"created":"…","expires":"…",
                 "id":"<16B>","secret":"<32B invitation secret key>"}],
 "owner":"ed25519:…",
 "retired_owners":["ed25519:…"],
 "type":"vault-records","version":1}
```

- `contacts` (sorted by `owner`): friends' keys (their sharing certificate, so also their certified read address), the
  **last index seen** as an anchor (rollback protection survives a restore), and the "verified" mark.
- `invitations` (sorted by `id`): open invitations until expiry + 7 days, with every answer received (at most 16) and
  the accepted responder, so any device can keep collecting (`late`) and run the expiry sweep.
- `retired_owners`: identities that moved away (`IdentityMovedError.from`), passed as `retiredOwners` everywhere.
- Helpers: `emptyVault(owner)`, `contactRecord(verifiedIndex, verified?)`, `invitationRecord(invitation, { answers?,
  accepted? })`, `invitationFromRecord(record, owner) → { invitation, answers, accepted? }`, `sealVault(records,
  vaultDataKey)` (sorts, de-duplicates and validates first), `openVault(bytes, owner, vaultDataKey)` (validates,
  verifies every certificate and anchor, returns frozen records), `mergeVaults(a, b)` for two devices that wrote
  concurrently (later anchor and certificate by rotation then seq, union of answers and retired owners, "verified" if
  either says so, `app` from `a`).

**Safety code**: `safetyCode(ownerA, ownerB)` → 12 groups of 5 digits, the same on both sides:
`BLAKE2b-512("TrianguLair-safety-v1" ‖ min(pkA, pkB) ‖ max(pkA, pkB))` over the two master keys, group *i* =
`u40(h[5i..5i+5]) mod 100000` (about 199 bits). QR form: `safetyQrPayload(mine, theirs)` = `"tlsafe1:" + b64url(h[0..32])`,
checked with `matchSafetyQr(scanned, mine, theirs)`. Face to face, exchange `owner + sharing cert + location` by QR in
both directions instead of an invitation (the QR contact format is not defined yet, see THREATS.md).

## Transfer code ("link + code")

`generateTransferCode()` → 6 words of the BIP39 English list (66 bits). `normalizeTransferCode` accepts any case, spaces
or hyphens, and each word by its first 4 letters. `encryptForTransfer(payload, code, { params?, ttlMs?, now? })` /
`decryptTransfer(blob, code, { now? })`:

```
0 "TLTX" | 4 version=2 | 5 purpose=1 (key-export) | 6 opslimit u32 | 10 memlimit u32 | 14 expires u32 s |
18 salt 16B | 34 nonce 24B | 58 ciphertext
key = Argon2id(crypto_pwhash, 32 B, code, salt, ops, mem) ; AEAD XChaCha20-Poly1305, AD = bytes[0..58)
```

Parameters: at least libsodium INTERACTIVE (2 passes, 64 MiB), at most 10 passes and 256 MiB (checked on both sides).
Expiry: 15 minutes by default (max), authenticated by the AD and checked before the key derivation. Single use =
deleting the blob from the storage. Payload: `encodeKeyExport({ keyPair, cert })` =
`{"cert":<sharing cert>,"secret":"<32B>","type":"key-export","version":2}` / `decodeKeyExport(bytes, { expectedOwner?,
lastSeen? })`.

See [THREATS.md](./THREATS.md) for known limitations.
