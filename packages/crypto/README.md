# @triangulair/crypto

TrianguLair's encrypted data format (phase-0 prototype, revised after the T-002 review). Pure functions,
`Uint8Array` in/out, libsodium (`libsodium-wrappers-sumo`, works in Node, web and React Native). License: MPL-2.0.

```ts
import { ready, identityFromPhrase, sealPack, verifyIndex, openPack } from '@triangulair/crypto';
await ready(); // required once before anything else
```

`npm test` (vitest) and `npm run typecheck` (tsc, strict).

## Encoding conventions

- Binary inside JSON: **base64url, no padding**, strictly decoded (non-canonical encodings rejected).
- Public keys in JSON: `"ed25519:<b64url>"` (master key = the *owner id*, and device keys) and `"x25519:<b64url>"`
  (sharing, device box, group and invitation keys). X25519 keys that are all-zero or of low order are rejected with
  `InvalidKeyError` (`INVALID_KEY`) wherever they are parsed or used as recipients.
- Dates: ISO-8601 UTC, `YYYY-MM-DDTHH:MM:SS[.mmm]Z`, which must be a real instant (no Feb 30). Written as
  `Date#toISOString()`. Binary structures use u32 unix seconds.
- **Canonical JSON** (`canonicalize`): object keys sorted by UTF-16 code units, recursively; no whitespace;
  strings escaped like `JSON.stringify`; numbers must be safe integers (no floats/NaN; `-0` → `0`);
  only plain objects, arrays, strings, integers, booleans, `null`. For this domain it is byte-identical
  to RFC 8785 (JCS).
- **Transported JSON MUST be canonical.** Every parser of transported text (signed documents, pack headers, payloads)
  requires `canonicalize(JSON.parse(s)) === s`. This rejects duplicate keys (parser differentials between
  implementations), whitespace and key-order variants. Already-parsed objects are accepted for in-process use.
- **Signatures** (Ed25519 detached) cover `UTF-8("TrianguLair-signature-v1\n" + domain + "\n") ‖ message`, where
  message is `canonicalJSON(doc without "signature")` for JSON documents, or the signed bytes of a binary structure.
  Domains: `index | sharing-cert | device-cert | identity-move | identity-move-to | invitation | invitation-response`.
- **Versioning**: every structure has a version (binary: byte after the magic; JSON: `"version"`). This library reads
  exactly the current version of each structure; any other throws `UnsupportedVersionError` (`code: "UNSUPPORTED_VERSION"`,
  `found`, `supported`). Unknown JSON fields are rejected (`FormatError`).
- Errors all extend `TLCryptoError` with a `code`: `FORMAT`, `UNSUPPORTED_VERSION`, `INVALID_KEY`, `DECRYPT`,
  `NO_MATCHING_KEY`, `NOT_INDEXED`, `SIGNATURE`, `OWNER_MISMATCH`, `REVOKED`, `IDENTITY_MOVED`, `EXPIRED`, `ROLLBACK`
  (`fork: true` for "same seq, different content"), `INVALID_PHRASE`, `INVALID_CODE`, `NOT_READY`.
  **Codes are for local handling only**; never reflect them to a remote party (e.g. `DECRYPT` vs `NO_MATCHING_KEY`
  tells whether a wrap was addressed to you). Messages never echo rejected numeric values.

| Structure | Version constant | Version |
|---|---|---|
| Signed index | `INDEX_VERSION` | 2 |
| Pack envelope and header | `PACK_VERSION` | 2 |
| Sharing certificate | `SHARING_CERT_VERSION` | 2 |
| Device certificate | `DEVICE_CERT_VERSION` | 1 |
| Identity move | `IDENTITY_MOVE_VERSION` | 1 |
| Sealed sharing key | `SHARING_KEY_VERSION` | 1 |
| Group-key payload | `GROUP_KEY_VERSION` | 2 |
| Invitation link and return link | `INVITATION_VERSION` | 2 |
| Transfer blob | `TRANSFER_VERSION` | 2 |
| Key export | `KEY_EXPORT_VERSION` | 2 |
| Primary identity | `PRIMARY_IDENTITY_VERSION` | 1 |

## Keys (spec: "Loss and theft", "Adding a device")

Three levels, so that the theft of an ordinary device does not cost the identity:

```
12 BIP39 words ──(checksum, 128-bit entropy)──► entropy
root       = BLAKE2b-256(key = entropy, msg = "TrianguLair/root/v1")      (wiped after use, never stored)
master     = Ed25519 from crypto_kdf(root, id = 1, ctx = "TLmaster")     signs certificates only
vault key  = crypto_kdf(root, id = 2, ctx = "TLvault_")                  recovery-vault copy of the sharing key
sharing    = random X25519 (generateX25519KeyPair)                       NOT derived from the phrase
device     = random Ed25519 (signs indexes) + random X25519 (box), generated on each device, never copied
```

- `identityFromPhrase(phrase) → Identity { owner, master, vaultKey }`. The identity (master + vault key) exists only
  while the 12 words are typed, or on the optional **primary device**: `encodePrimaryIdentity(identity)` (69 bytes:
  `"TLPI" ‖ 1 ‖ master seed ‖ vault key`, to keep in Keychain/Keystore) / `decodePrimaryIdentity(bytes)`.
- **Device certificate** (master-signed): `issueDeviceCert(identity, devicePublicKeys(deviceKeys))` /
  `verifyDeviceCert(c, { expectedOwner?, retiredOwners? })`:
  `{"box":"x25519:…","device":"ed25519:…","owner":"ed25519:…","signature":"…","type":"device-cert","version":1}`.
- **Sharing certificate** (master-signed): `issueSharingCert(identity, sharingPk, { rotation, revokedDevices? })` /
  `verifySharingCert(c, { expectedOwner?, retiredOwners?, lastSeen? })`:
  `{"key":"x25519:…","owner":"ed25519:…","revoked_devices":["ed25519:…"],"rotation":3,"signature":"…","type":"sharing-cert","version":2}`.
  `revoked_devices` is sorted, unique and **permanent** (a later rotation must keep it). With `lastSeen`: lower rotation
  → `RollbackError`; same rotation, other content → `RollbackError` with `fork`; a later rotation that un-revokes a
  device → `RollbackError`.
- **Sealed sharing key** (`sealSharingKey(sharing, to)` / `openSharingKey(bytes, holder, { expectedOwner? })`), how the
  current sharing key reaches each device and the recovery vault:
  ```
  "TLSK" | version 1 | mode u8
    mode 1 (to a DeviceCert):   crypto_box_seal(payload, device box key)
    mode 2 (to an Identity):    nonce 24B ‖ XChaCha20-Poly1305(payload, AD = bytes[0..6) ‖ nonce, key = vault key)
  payload = {"cert":<sharing cert>,"secret":"<32B>","to":"<device id | owner id>","type":"sharing-key","version":1}
  ```
- **Adding a device**: the new device runs `generateDeviceKeys()` and shows `devicePublicKeys(keys)` (QR). The primary
  device (or the phrase) issues its device cert and `sealSharingKey(current, deviceCert)`. With "link + code", the
  transfer carries `encodeKeyExport(current)` (sharing key + cert only, never the master); the new device then needs a
  device cert from the primary device or the phrase before it can publish.
- **Declare a device lost** (phrase or primary device): new random sharing key, `issueSharingCert(identity, pk,
  { rotation: r + 1, revokedDevices: [...previous, lostDeviceId] })`, `sealSharingKey` to each remaining device cert and
  to the identity (vault), re-encrypt own content, publish an index embedding the new cert. A stolen ordinary device holds
  neither the phrase, nor the master key, nor the vault key: it can neither obtain the new sharing key nor certify one,
  and the index rules below stop it from publishing. Remote wipe: a device that finds its own id in the
  `revoked_devices` of a verified index of its owner erases its keys.
- **Identity change** (primary device stolen): `issueIdentityMove(oldIdentity, newIdentity)` →
  `{"from":"ed25519:old","issued":"…","signature":"<old master>","to":"ed25519:new","to_signature":"<new master>","type":"identity-move","version":1}`,
  published as the `move` field of the new identity's index. A reader calling `verifyIndex(…, { expectedOwner: old })`
  gets an `IdentityMovedError { from, to }` (never an automatic accept): show "Marie changed her identity", remove the
  "verified" mark, then follow `to` with `retiredOwners` including `from`. Everything later signed by a retired master is
  refused (`REVOKED`).

## Content pack (binary)

```
offset size  field
0      4     magic "TLPK"
4      1     envelope version = 2
5      4     N = header length (uint32 BE, ≤ 64 KiB)
9      N     header, canonical JSON UTF-8
9+N    …     XChaCha20-Poly1305-IETF ciphertext ‖ 16-byte tag
```

Header (no pack id, no recipient information):

```json
{"alg":"xchacha20poly1305-ietf","nonce":"<24B>","pad":"padme","type":"pack","version":2,
 "wrapAlg":"x25519-sealedbox","wraps":["<80B>", "..."]}
```

- Plaintext = `logical id (16 B) ‖ u32 payload length ‖ payload ‖ zero padding`. The **logical id is inside the
  encryption**: neither the storage nor a former friend can link successive versions of a pack.
- `pad: "padme"` (default): plaintext length = `max(256, Padmé(20 + payload length))` (`paddedLength`), at most ~12 %
  overhead; `pad: "none"`: no padding. Readers check the exact length and that the padding is zeros.
- Batch key: random 32 bytes per encryption. Nonce: random 24 bytes.
- **AEAD associated data** = `"TLPK" ‖ version ‖ canonicalJSON(header without "wraps")`.
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

- `sealPack(payload, recipientPks, { id?, padTo?, pad? })`
- `openPack(bytes, verifiedIndex, keys) → { id, payload, file }`: **the only way to decrypt**. `verifiedIndex` must be an
  object returned by `verifyIndex` or `signIndex` (checked at run time, and frozen); the content hash is looked up in it
  **before any key operation**, so a pack not listed in its owner's verified index is ignored (`NOT_INDEXED`). This is how
  "everything is signed with my key" applies to packs.
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
`rotateGroup` → `sealGroupKey` to remaining members → `reencryptPack` the affected packs.

## Signed index

Signed by a **device key** certified by the master; the master-signed sharing certificate and revoked-device list are
embedded, so they share the index's rollback protection (one freshness anchor per owner).

```json
{"device_cert":{"box":"x25519:…","device":"ed25519:…","signature":"<master>"},
 "owner":"ed25519:…",
 "packs":[{"file":"packs/b2b256-<43>.bin","hash":"b2b256:<43>"}],
 "public":"public/lists.geojson",
 "reads":["2"],
 "revoked_devices":["ed25519:…"],
 "seq":42,
 "sharing_cert":{"key":"x25519:…","rotation":3,"signature":"<master>"},
 "signature":"<device>",
 "updated":"2026-10-13T15:10:00.000Z",
 "version":2}
```

Optional `move` (identity move, see Keys). The compact `sharing_cert` is verified as the full certificate
`{owner, key, rotation, revoked_devices, …}`: the top-level `owner` and `revoked_devices` are covered by the master
signature. The compact `device_cert` is verified as `{owner, device, box, …}`.

- `signIndex({ keys, cert }, { seq, sharingCert, packs, reads?, public?, move?, now? })` (round-trip verified).
- `verifyIndex(json, { expectedOwner?, retiredOwners?, lastSeen?, now? })` checks, in addition to the structure and
  signatures:
  - the signing device is certified by the owner's master and **not** in `revoked_devices` (`REVOKED`);
  - `updated` is at most **24 h** in the future (`FormatError`, retry later); it is otherwise informational;
  - `packs[].hash` = `b2b256:` + 32 bytes, `packs[].file` = `packs|media/b2b256-<same hash>.bin`, no duplicates;
    `public` = `public/<name>.geojson` (no absolute URLs, no traversal);
  - `reads`: 1 to 32 unique version strings (`"2"`, `"2.1"`);
  - with `lastSeen`, `checkNoRollback(next, lastSeen)`: **`seq` is the only ordering** (lower → `RollbackError`, same seq
    with other content → `RollbackError` with `fork: true`: report it and accept the next higher seq); the embedded
    sharing cert must not go back (lower rotation, un-revoked device).
- `sharingCertOf(index)`: the full, verified sharing certificate (to wrap content to a friend, or as `lastSeen`).
- `serialize(doc)` = canonical JSON, the only accepted transport form. Persist the last accepted index per owner (also in
  the recovery vault) so that a restore does not fall back to trust on first use.
- Allocate `seq` with a conditional write (`If-Match`) on the index file. The storage ETag is a cache hint only.

## Invitation (spec: "Invitation link and return link")

**Link** (`createInvitation(identity, { now?, ttlMs?, location? }) → { invitation, fragment }`), compact binary, put in
the URL **fragment** (`https://triangulair.app/i#<fragment>`), never sent to a server:

```
0 0x49 "I" | 1 version=2 | 2 id 16B | 18 owner master pk 32B | 50 created u32 s | 54 expires u32 s |
58 invitation X25519 secret 32B | 90 L u16 | 92 location (https URL, ≤ 512 B) | 92+L Ed25519 signature 64B
signature (owner master, domain "invitation") over bytes[0..58) ‖ invitation PUBLIC key ‖ bytes[90..92+L)
```

156 + L bytes: about 264 base64url characters with a typical share address, under 300 with the URL prefix. `ttlMs` is
an integer between 60 s and 7 days; the link is round-trip checked. `location` must be `https://`, without credentials
or fragment. `parseInvitationLink(link, { now? })` checks the signature, validity and expiry (`ExpiredError`).

**Return link** (`createInvitationResponse(received, inviteeIdentity, inviteeSharingCert, { now?, location? })`):

```
0x52 "R" | version=2 | crypto_box_seal(inner, invitation public key)
inner = invitation id 16 | responder master pk 32 | created u32 s | sharing pk 32 | rotation u32 |
        n u16 | n × 32 revoked device keys | sharing-cert signature 64 | L u16 | location L | signature 64
signature (responder master, domain "invitation-response") over inner[0..end-64) ‖ inviter master pk ‖ invitation pk
```

270 bytes (360 base64url characters) without location. The response is bound to the inviter and the invitation key,
its `created` must fall inside the invitation's validity, and it carries the responder's own read address if they share.

**Owner side**:

- `collectInvitationAnswers(invitation, allResponses, { now? }) → { answers, rejected, multiple, accepted }`:
  **one answer per invitation**. Pass every answer received; one responder → `accepted`; several → `multiple: true`,
  `accepted: null`, all returned: the user chooses, with a warning. (`openInvitationResponse` opens a single answer.)
- `retireInvitationKey(packs, ownIndex, invitation.keyPair, recipientsFor)`: on acceptance **or expiry**,
  **re-encrypts** (new batch keys, not a rewrap) every pack that the invitation key can open, for
  `recipientsFor(logicalId)` (which must not contain the invitation key). Returns `{ oldFile, bytes }[]`: publish the new
  files in a new index and delete the old ones. Track open invitations in the recovery vault so another device can sweep
  them at expiry.

**Safety code**: `safetyCode(ownerA, ownerB)` → 12 groups of 5 digits, the same on both sides:
`BLAKE2b-512("TrianguLair-safety-v1" ‖ min(pkA, pkB) ‖ max(pkA, pkB))` over the two master keys, group *i* =
`u40(h[5i..5i+5]) mod 100000` (about 199 bits). QR form: `safetyQrPayload(mine, theirs)` = `"tlsafe1:" + b64url(h[0..32])`,
checked with `matchSafetyQr(scanned, mine, theirs)`. Face to face, exchange `owner + sharing cert + location` by QR in
both directions instead of an invitation.

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
`{"cert":<sharing cert>,"secret":"<32B>","type":"key-export","version":2}` / `decodeKeyExport(bytes, { expectedOwner? })`.

See [THREATS.md](./THREATS.md) for known limitations.
