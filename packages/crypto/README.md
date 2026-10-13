# @triangulair/crypto

Phase-0 prototype of TrianguLair's encrypted data format. Pure functions, `Uint8Array` in/out,
libsodium (`libsodium-wrappers-sumo`, works in Node, web and React Native). License: MPL-2.0.

```ts
import { ready, identityFromPhrase, deriveSharingKeyPair, sealPack, openPack } from '@triangulair/crypto';
await ready(); // required once before anything else
```

`npm test` (vitest) and `npm run typecheck` (tsc, strict).

## Encoding conventions

- Binary inside JSON: **base64url, no padding**, strictly decoded (non-canonical encodings rejected).
- Public keys in JSON: `"ed25519:<b64url>"` (master key, the *owner id*) and `"x25519:<b64url>"` (sharing key).
- Dates: ISO-8601 UTC as produced by `Date#toISOString()` (`2026-10-13T12:00:00.000Z`).
- **Canonical JSON** (`canonicalize`): object keys sorted by UTF-16 code units, recursively; no whitespace;
  strings escaped like `JSON.stringify`; numbers must be safe integers (no floats/NaN; `-0` → `0`);
  only plain objects, arrays, strings, integers, booleans, `null`. For this domain it is byte-identical
  to RFC 8785 (JCS). Floats are forbidden on purpose: coordinates belong in the encrypted payload, not
  in signed structures.
- **Signatures** (Ed25519 detached, by the master key) cover
  `UTF-8("TrianguLair-signature-v1\n" + domain + "\n" + canonicalJSON(doc without "signature"))`,
  domain ∈ `index | sharing-cert | invitation | invitation-response`. Verifiers re-canonicalize, so key order /
  whitespace of the transported JSON does not matter.
- **Versioning**: every structure has a version (binary: byte after the magic; JSON: `"version"`).
  A version higher than supported throws `UnsupportedVersionError` (`code: "UNSUPPORTED_VERSION"`, `found`,
  `supported`). Unknown JSON fields are rejected (`FormatError`) in v1.
- Errors all extend `TLCryptoError` with a `code`: `FORMAT`, `UNSUPPORTED_VERSION`, `DECRYPT`, `NO_MATCHING_KEY`,
  `SIGNATURE`, `OWNER_MISMATCH`, `EXPIRED`, `ROLLBACK`, `INVALID_PHRASE`, `INVALID_CODE`, `NOT_READY`.

## Keys

```
12 BIP39 words ──(checksum, 128-bit entropy)──► entropy
root  = BLAKE2b-256(key = entropy, msg = "TrianguLair/root/v1")
master seed      = crypto_kdf(root, id = 1,        ctx = "TLmaster") → Ed25519   (signs only)
sharing seed (r) = crypto_kdf(root, id = rotation, ctx = "TLshare_") → X25519    (content)
```

The sharing key is bound to the identity by a **sharing certificate** (`issueSharingCert` / `verifySharingCert`):

```json
{"issued":"…Z","key":"x25519:…","owner":"ed25519:…","rotation":1,"signature":"…","type":"sharing-cert","version":1}
```

Rotation = derive the key for `rotation + 1` and issue a new certificate. `verifySharingCert(c, { lastSeen })`
rejects lower rotations and two different keys for the same rotation. Because sharing keys derive from the
root, the phrase restores all of them.

Devices: `encodeKeyExport({ identity })` (full device) or `encodeKeyExport({ sharing: { keyPair, cert } })`
(limited device: reads/wraps content, cannot sign).

## Content pack (binary)

```
offset size  field
0      4     magic "TLPK"
4      1     envelope version = 1
5      4     N = header length (uint32 BE)
9      N     header, canonical JSON UTF-8
9+N    …     XChaCha20-Poly1305-IETF ciphertext ‖ 16-byte tag
```

Header:

```json
{"alg":"xchacha20poly1305-ietf","id":"<16B>","nonce":"<24B>","type":"pack","version":1,
 "wrapAlg":"x25519-sealedbox","wraps":["<80B>", "..."]}
```

- Batch key: random 32 bytes per pack (per encryption). Nonce: random 24 bytes.
- **AEAD associated data** = `"TLPK" ‖ version ‖ canonicalJSON(header without "wraps")` — the *protected header*
  (JWE-style). Changing `id`, `nonce`, `alg`, version… fails decryption.
- `wraps` are outside the AD so the owner can re-wrap (add a friend, replace an invitation key) without
  re-encrypting: `rewrapPack`. A modified wrap can only fail to open. Integrity of the whole file relative to
  its owner comes from the signed index (`etag = packEtag(bytes)` = b64url BLAKE2b-128 of the file).
- Each wrap = `crypto_box_seal(batchKey, recipientX25519Pk)` = 32 B ephemeral pk ‖ 16 B MAC ‖ 32 B key.

### Wrap anonymity (design choice)

**No hint at all.** A wrap contains only a sealed box; sealed boxes use a fresh ephemeral key and carry no
recipient identifier, so the header contains no recipient public key, hash or stable tag, and two wraps to
the same person in two packs are unlinkable. Readers call `openPack(bytes, candidateKeys)`, which tries every
wrap with every key (sharing key, group keys, invitation key): cost = wraps × keys X25519 operations, fine for
the expected tens of recipients. In addition:

- the wrap list is **shuffled** (position does not reveal the owner/first recipient);
- it is **padded** with dummy wraps (real sealed boxes of random bytes to throwaway keys, indistinguishable)
  to the next power of two ≥ 2 by default (`padTo` to override, `padTo: 0` disables).

A short hint (e.g. 1 byte keyed per pack) was rejected for phase 0: it saves little at our sizes and is easy to
get wrong (cross-pack linkability).

### Operations

- `sealPack(payload, recipientPks, { id?, padTo? })`
- `openPack(bytes, keys) → { id, payload }`
- `rewrapPack(bytes, keys, recipientPks)` — same batch key/ciphertext, new wraps (**not** a revocation)
- `reencryptPack(bytes, keys, remainingPks)` — **revocation**: new batch key + nonce, same pack id
- `readPackHeader(bytes)`, `packEtag(bytes)`

## Groups

A group is an X25519 key pair. Content wraps to the group public key like to anyone else. The group secret is
distributed in an ordinary pack (`sealGroupKey(group, memberPks)` / `openGroupKey(bytes, keys)`) whose payload is
`{"generation":n,"group":"<16B>","secretKey":"<32B>","type":"group-key","version":1}`. Removing a member:
`rotateGroup` → `sealGroupKey` to remaining members → `reencryptPack` the affected packs to the new group key.

## Signed index

```json
{"owner":"ed25519:…","packs":[{"etag":"…","file":"packs/7c1e.bin"}],"public":"public/listes.geojson",
 "seq":42,"signature":"…","updated":"2026-10-13T12:00:00.000Z","version":1}
```

`version` is the format version; `seq` (added to the spec shape) is a publication counter.
`signIndex(identity, { seq, packs, public?, now? })`, `verifyIndex(json, { expectedOwner?, lastSeen? })`,
`checkNoRollback(next, lastSeen)` rejects: lower format version, lower `seq`, older `updated`, or same `seq` with
different content (fork). `serialize(doc)` = canonical JSON for storage.

## Invitation

- `createInvitation(identity, { now?, ttlMs? (≤ 7 days), location? }) → { invitation, fragment }`.
  Fragment = base64url(canonicalJSON(`{"invitation":<signed doc>,"secret":"<x25519 sk>","type":"invitation-link","version":1}`)),
  signed doc = `{created, expires, id, key:"x25519:…", location?, owner, signature, type:"invitation", version}`.
  Put it in the URL **fragment** (`https://…/invite#<fragment>`) so it is never sent to a server.
- The owner wraps content to `invitation.keyPair.publicKey`; the invitee `parseInvitationLink(link, { now })`
  (checks signature, secret/key match, validity ≤ 7 days, expiry → `ExpiredError`) and opens it.
- "Lien retour": `createInvitationResponse(received, inviteeIdentity, inviteeCert)` →
  `"TLIR" ‖ version ‖ crypto_box_seal(canonicalJSON(signed response), invitationPk)`; the response
  (`{cert, created, invitation, owner, signature, type:"invitation-response", version}`) is signed by the
  invitee's master key and embeds their sharing certificate.
- Owner: `openInvitationResponse(bytes, invitation, { now })` (rejects after expiry) → friend's sharing key, then
  `rewrapPack(pack, ownerKeys, [owner, friend])` drops the invitation wrap.

## Transfer code

`generateTransferCode()` → `XXXX-XXXX-XXXX` (12 Crockford base32 chars, 60 bits; input normalized: case,
separators, O→0, I/L→1). `encryptForTransfer(payload, code, params?)` / `decryptTransfer(blob, code)`:

```
0 "TLTX" | 4 version=1 | 5 opslimit u32 | 9 memlimit u32 | 13 salt 16B | 29 nonce 24B | 53 ciphertext
key = Argon2id(crypto_pwhash, 32 B, code, salt, ops, mem) ; AEAD XChaCha20-Poly1305, AD = bytes[0..53)
```

Defaults: libsodium INTERACTIVE (ops 2, 64 MiB). Imported params are bounded (ops ≤ 10, mem ≤ 1 GiB).
Typical payload: `encodeKeyExport(...)`.

See [THREATS.md](./THREATS.md) for known limitations.
