# TrianguLair encrypted format, version 4 (frozen)

This directory is the standalone specification of the data format written and read by `packages/crypto`, frozen
on main at commit `5b10faf` (index 4.0, pack 4, link 5, return link 4, vault 3) after five reviews
(`docs/reviews/`). It is written for implementers and auditors: everything a second implementation needs to read and
write every structure byte for byte, and every check a reader performs, **in the order the reference library
performs it** (the order decides which error a malformed input raises, and the vectors record that error).

The reference implementation is `packages/crypto` (TypeScript, libsodium). When this text and the code disagree,
that is a bug in one of them: report it. The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

| File | Structures |
|---|---|
| [identity-and-keys.md](identity-and-keys.md) | recovery phrase → master key, owner id and vault key; primary identity `TLPI`; device keys; X25519 key validation; sealed sharing key `TLSK` |
| [sharing-cert.md](sharing-cert.md) | sharing certificate (`sharing-cert` v3), `checkSharingCertNotOlder` |
| [device-cert.md](device-cert.md) | device certificate (`device-cert` v1) |
| [identity-move.md](identity-move.md) | identity move (`identity-move` v1) |
| [signed-index.md](signed-index.md) | signed index (4.0), compact certificates, `verifyIndex`, `checkNoRollback`, index anchor, invitation listing and its padding, public file |
| [pack.md](pack.md) | pack envelope (`TLPK` 4), header, AEAD associated data, plaintext frame, Padmé, wraps, `openPack` |
| [group-key.md](group-key.md) | group-key payload (`group-key` v2) |
| [invitation-link.md](invitation-link.md) | invitation link (version 5), seed derivations, listing token, acceptance (`checkInvitationIndex`, link path) |
| [return-link.md](return-link.md) | return link (response version 4), compact certificates, `openInvitationResponse`, `collectInvitationAnswers`, `checkInvitationIndex` (answer path), `retireInvitationKey` |
| [invitation-record.md](invitation-record.md) | invitation record and its device signature (`invitation-record`), listing decision (`listable`, skip reasons) |
| [vault.md](vault.md) | recovery vault envelope (`TLVD` 3) and records, `mergeVaults`, `cancelAllInvitations` |
| [transfer-blob.md](transfer-blob.md) | transfer blob (`TLTX` 2), transfer code |
| [key-export.md](key-export.md) | key-export payload (`key-export` v3) |
| [safety-code.md](safety-code.md) | safety code and its QR payload |
| [promises.md](promises.md) | each security promise mapped to the function and check that enforces it, and the app rules it relies on |
| [vectors/](vectors/) | known-answer vectors (positive and negative) for every structure |
| [reference-reader/](reference-reader/) | a second, minimal, independent reader in Python, run against the vectors |

Not specified here (not part of format v4): the content payloads inside packs (Automerge documents, GeoJSON; app
specification; the photo payload of `media` files and its size caps, 2,048 px and 1.5 MiB for a photo, 512 px and
128 KiB for a thumbnail, are in `packages/sync/README.md` "Personal photos"), the face-to-face QR contact exchange (R-13), the QR device-transfer key exchange ("Adding a device",
way 1), link-only list keys (T-212), and the storage layout beyond the file names given in signed-index.md.

## 1. Notation

- `a || b`: concatenation. `x[i..j)`: bytes `i` (included) to `j` (excluded).
- `u8`, `u16`, `u32`: unsigned integers, **big-endian**. `LE64`: 64-bit little-endian (only inside `crypto_kdf`).
- `UTF8(s)`: the UTF-8 encoding of a string. Literal strings are ASCII; `\n` is the byte 0x0A.
- `b64u(x)`: base64url without padding (section 3). `hex`: lowercase hexadecimal (vectors only).
- `BLAKE2b-n(m)`: BLAKE2b (RFC 7693) with **digest length parameter** n/8 bytes, no key. `BLAKE2b-n(key = k, m)`:
  keyed BLAKE2b. BLAKE2b-128 or BLAKE2b-64 is **not** a truncation of BLAKE2b-256: the digest length is a parameter
  of the hash (libsodium `crypto_generichash(n/8, m, k)`, Python `hashlib.blake2b(m, digest_size=n/8, key=k)`).
- `canon(doc)`: canonical JSON text of a document (section 4). `doc \ {f, g}`: the object without the keys f, g.
- `ERROR(CODE)`: the check fails with that error code (section 7). Steps are performed in order; the first failing
  step decides the error.

## 2. Primitives and parameters

All primitives are those of libsodium; a second implementation MUST match libsodium's behaviour where noted.

| Primitive | Definition | Used by |
|---|---|---|
| Ed25519 | RFC 8032 (pure Ed25519), libsodium `crypto_sign_detached` / `crypto_sign_verify_detached`. A key pair is derived from a 32-byte seed (`crypto_sign_seed_keypair`). Verification MUST reject: `S ≥ L`; a public key that is non-canonical or of small order; an `R` of small order (libsodium ≥ 1.0.16 semantics, cofactorless equation). | every signature (section 5) |
| X25519 | RFC 7748. A 32-byte secret is clamped by the scalar multiplication itself; public key = `X25519(secret, 9)` (`crypto_scalarmult_base`). Public keys are validated (identity-and-keys.md §4). | sealed boxes, sharing, group, device box and invitation keys |
| Sealed box | libsodium `crypto_box_seal`: `epk (32) \|\| crypto_box_easy(m, nonce = BLAKE2b-192(epk \|\| pk), pk, esk)` with a fresh ephemeral X25519 key pair; `crypto_box` = X25519 + HSalsa20 + XSalsa20-Poly1305. Overhead 48 bytes: `epk 32 \|\| tag 16 \|\| ciphertext`. Anonymous: no sender key, no recipient id. | pack wraps, `TLSK` mode 1, return links |
| XChaCha20-Poly1305 | IETF construction with a 24-byte nonce (libsodium `crypto_aead_xchacha20poly1305_ietf_*`): ciphertext `\|\|` 16-byte tag, with associated data. Keys are 32 bytes. | packs, `TLSK` mode 2, `TLVD`, `TLTX` |
| BLAKE2b | RFC 7693, digest lengths 8, 16, 24, 32 and 64 bytes, optionally keyed. | hashes, tokens, derivations, padding, safety code |
| crypto_kdf | libsodium `crypto_kdf_derive_from_key(len, id, ctx, key)` = `BLAKE2b(digest = len, key = key, message = empty, salt = LE64(id) \|\| 0^8, personal = ctx (8 ASCII bytes) \|\| 0^8)`. | phrase derivations |
| Argon2id | v1.3, libsodium `crypto_pwhash(32, password, salt 16, opslimit, memlimit, ARGON2ID13)`: `t = opslimit`, `m = memlimit / 1024` KiB, parallelism 1. | transfer blob |
| BIP39 | 12 words of the English list, 128-bit entropy + 4-bit checksum. | recovery phrase, transfer-code word list |

Randomness: every key, nonce, salt, seed, batch key and padding wrap is drawn from the CSPRNG (libsodium
`randombytes_buf`). No randomness is ever derived from a counter or a clock.

## 3. Encodings

**base64url.** RFC 4648 §5 alphabet (`A–Z a–z 0–9 - _`), **no padding**. Decoding is strict: any other character
(including `=`, `+`, `/`, whitespace) is `FORMAT`, and the decoded bytes re-encoded MUST give back exactly the input
(non-zero unused bits in the last character are `FORMAT`: one value, one spelling). Lengths are checked after
decoding where a field has a fixed length.

**Public keys in JSON**: `"ed25519:" || b64u(32 bytes)` (master keys, device signing keys) and
`"x25519:" || b64u(32 bytes)` (sharing, device box, group and invitation keys). Parsing (`parseKey`): the prefix
MUST match the expected kind, else `FORMAT`; the rest MUST decode to exactly 32 bytes, else `FORMAT`; an X25519 key is
then validated (identity-and-keys.md §4), else `INVALID_KEY`. Ed25519 keys are not point-validated when parsed (a
bad key simply verifies nothing). The **owner id** is the `ed25519:` string of the master public key.

**Hashes**: `"b2b256:" || b64u(BLAKE2b-256(bytes))`, always 43 base64url characters after the prefix. Checked with
the pattern `^b2b256:([A-Za-z0-9_-]{43})$` and a strict decode to 32 bytes.

**Dates in JSON**: `YYYY-MM-DDTHH:MM:SS[.mmm]Z` (pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$`), UTC
only, and it MUST denote a real instant: formatting the parsed instant as `YYYY-MM-DDTHH:MM:SS.mmmZ` gives back the
input, or the input with `.000` inserted before `Z` (no 30 February, no hour 24, no second 60). Years `0000` to
`9999` of the proleptic Gregorian calendar are valid (do not rely on a date library limited to years ≥ 1). Writers
use the form with milliseconds. **Dates in binary structures**: u32 seconds since the Unix epoch (they overflow in 2106).
The reader's clock `now` is in milliseconds; a u32 date `t` is compared as `t × 1000`.

**Read address** (`location`): see identity-and-keys.md §5 (`checkLocation`).

## 4. Canonical JSON

Every JSON structure is transported, signed and authenticated in exactly one spelling, `canon(doc)`, a subset of
RFC 8785 (JCS):

1. Values: objects, arrays, strings, `true`, `false`, `null`, and integers in `[-(2^53 − 1), 2^53 − 1]`. Floats, NaN,
   infinities, exponents and `-0` are not values of this format (`-0` is written `0`, but `-0` in an input is `FORMAT`
   since it is not the canonical spelling).
2. Objects: members sorted by key, comparing keys as sequences of **UTF-16 code units** (this differs from code-point
   order for characters above U+FFFF against U+E000–U+FFFF: `"😀"` sorts before `"�"`), recursively; no
   duplicate keys.
3. No whitespace outside strings. Separators `,` and `:`.
4. Strings: `"` … `"`, escaping exactly as ECMAScript `JSON.stringify` (well-formed variant, ES2019):
   `\"`, `\\`, `\b`, `\t`, `\n`, `\f`, `\r` for those characters, `\u00XX` with **lowercase** hex for the other
   characters below U+0020, a **lone surrogate** (U+D800–U+DFFF not part of a pair) as `\udXXX` with lowercase hex,
   and **every other character raw** (UTF-8 in the transported bytes: non-ASCII, U+007F, U+2028 and U+2029 are not
   escaped; `/` is not escaped).
5. Integers: shortest decimal form, `-` for negatives, no leading zeros, no `+`.

**Reading transported JSON** (text or bytes taken from a storage, a link, a decrypted payload): decode the bytes as
UTF-8 strictly (invalid sequences are `FORMAT`; a leading U+FEFF is **kept**, so a BOM makes the text non-canonical),
parse as JSON (`FORMAT` if invalid), check every number is an integer in range, then **re-serialize canonically and
compare with the input text: any difference is `FORMAT`**. This one rule rejects duplicate keys (a parser that keeps
one of them produces a shorter text), whitespace, key order, escape variants and number spellings, so two
implementations can never disagree on what a signed document says. The top level MUST be an object (`FORMAT`).

Lone surrogates: the reference library accepts `\udXXX` escapes of lone surrogates (they round-trip through
`JSON.parse` / `JSON.stringify`). JCS requires I-JSON input, which forbids them, so this is outside JCS; no field of
the format carries free text that could contain one except the vault `app` data. A second implementation MUST
reproduce rule 4 to read such a document (vector `encoding/json-lone-surrogate`).

## 5. Signatures

Every Ed25519 signature is computed over

    UTF8("TrianguLair-signature-v1\n" || domain || "\n") || message

- For a JSON document, `message = UTF8(canon(doc \ {"signature"}))`: the canonical form of the **whole** document
  without its `signature` member, unknown extension fields included. The signature is stored as `b64u(64 bytes)`
  in the member `signature`; a value that does not decode to exactly 64 bytes is `FORMAT`, a signature that does not
  verify is `SIGNATURE`.
- For the identity move's countersignature, `message = UTF8(canon(doc \ {"to_signature", "signature"}))`.
- For a binary structure, `message` is the signed bytes given in its section.

| Domain | Signed by | Message | Spec |
|---|---|---|---|
| `index` | publishing device (Ed25519 device key) | index JSON | signed-index.md |
| `sharing-cert` | master key | full sharing certificate JSON | sharing-cert.md |
| `device-cert` | master key | full device certificate JSON | device-cert.md |
| `identity-move` | old master key | identity move JSON (with `to_signature`) | identity-move.md |
| `identity-move-to` | new master key | identity move JSON without `to_signature` | identity-move.md |
| `invitation` | — | **retired** (the signed link of format 4); MUST NOT be used for anything else | — |
| `invitation-record` | creating device | binary record bytes (no version byte: any change MUST use a new domain, e.g. `invitation-record-v2`) | invitation-record.md |
| `invitation-response` | responding device | binary response body ‖ inviter master pk ‖ invitation pk | return-link.md |

The prefix and the `\n` terminator make the domains prefix-free (`invitation` vs `invitation-record`). Vectors:
`signatures.json` (one per domain, domain confusion, a malleated `S + L`).

## 6. Versioning (`minor`, `crit`)

**Binary structures** carry one major version byte right after the magic. Reading: `0` is `FORMAT`; any value other
than the version this reader reads is `UNSUPPORTED_VERSION`. Binary structures have no minor version and no
extension mechanism (a certificate with extension fields cannot travel in a return link).

**JSON structures** (index, certificates, identity move, pack header, `TLSK` payload, key export, group-key payload,
vault records) carry `version` (the major) and optionally `minor` and `crit`. Every JSON verifier runs
`checkStructure(doc, name, major, required, optional, supportedMinor)` first (after any `type` check noted in the
structure's own section, which always comes later):

    checkStructure:
    1. v = doc.version. Not an integer ≥ 1 → ERROR(FORMAT). v ≠ major → ERROR(UNSUPPORTED_VERSION).
    2. If "minor" is present: not an integer ≥ 1 → ERROR(FORMAT) (minor 0 is written by omitting the field).
       minor = doc.minor, else minor = 0.
    3. known = required ∪ optional ∪ {"version", "minor", "crit"}.
    4. If "crit" is present: not an array of 1 to 32 strings → ERROR(FORMAT); not sorted (UTF-16 order) and unique
       → ERROR(FORMAT); for each name f in crit: f ∈ {"version", "minor", "crit", "signature", "type"} or f absent
       from doc → ERROR(FORMAT); f ∉ known → ERROR(UNSUPPORTED_VERSION, critical = f).
    5. Each name in required absent from doc → ERROR(FORMAT).
    6. extensible = (minor > supportedMinor). If not extensible: any member of doc not in known → ERROR(FORMAT).
       If extensible, unknown members are accepted and ignored (they stay covered by the signature or the AEAD).
    7. Return extensible.

`supportedMinor` is 0 for every structure of format v4 (`INDEX_MINOR = 0`: `invitations` is part of index 4.0).
Nested objects without their own `version` (index `packs[]` entries and `public`, vault contacts and invitation
records) accept unknown members exactly when their enclosing document is extensible. The compact certificates inside
an index are verified as full certificates and follow the certificate's own `minor`.

Writers: a document **derived from the owner's state** (the index) is always written from that state: an older writer
drops the fields it does not know and writes its own minor. **Content documents** (vault records) keep unknown fields
and the highest minor when merged (vault.md). A field that must be neither dropped nor copied needs a new major
version; during a major transition the new index is published as `index.v<N>.json` next to `index.json`.

## 7. Errors

| Code | Class | Meaning |
|---|---|---|
| `FORMAT` | FormatError | malformed input: magic, length, encoding, non-canonical JSON, missing or unknown field, bad value, size bound |
| `UNSUPPORTED_VERSION` | UnsupportedVersionError | a major version this reader does not read, or an unknown `crit` field (`critical` names it) |
| `INVALID_KEY` | InvalidKeyError | an X25519 public key that is all-zero, of low order, or has bit 255 set |
| `DECRYPT` | DecryptionError | an AEAD or sealed box does not open (wrong key, tampered, other owner in the AD) |
| `NO_MATCHING_KEY` | DecryptionError | no wrap of a pack opens with any key the reader holds |
| `NOT_INDEXED` | DecryptionError | the file is not listed in the verified, owner-bound index it is opened against |
| `SIGNATURE` | SignatureError | a signature does not verify |
| `OWNER_MISMATCH` | SignatureError | signed by another owner than expected |
| `REVOKED` | SignatureError | signed by a revoked device, or by a master key whose identity moved away (a retired owner) |
| `NOT_LISTED` | SignatureError | an invitation link the owner's index does not list (or a later rotation cancelled) |
| `IDENTITY_MOVED` | IdentityMovedError | the expected owner moved to a new identity (`from`, `to`, `conflict`) |
| `MOVED` | StorageMovedError | the index is valid but certifies another read address (`location`) |
| `EXPIRED` | ExpiredError | an invitation, answer window or transfer blob has expired |
| `ROLLBACK` | RollbackError | older than already seen; `fork = true` for "same rotation (and seq), other content" |
| `INVALID_PHRASE`, `INVALID_CODE` | TLCryptoError | a recovery phrase or a transfer code that is not valid |

Error codes are for **local** handling only. A reader MUST NOT reflect them to a remote party (for example
`DECRYPT` vs `NO_MATCHING_KEY` tells whether a wrap was addressed to the reader). A reader MUST NOT throw anything
but these errors on any input (fuzzed in `packages/crypto/test/fuzz.test.ts`).

## 8. Size limits

Every limit is checked before the work it bounds.

| Limit | Value | Where |
|---|---|---|
| Signed index | 16 MiB (16 777 216; bytes for a byte input, UTF-16 code units for a text input) | before parsing |
| Index `packs` | 100 000 entries | signed-index.md |
| `revoked_devices` | 256 | certificates, index, return link |
| `reads` | 1 to 32 entries | index |
| `invitations` (index) | 1 to 256 entries (writers: a power of two ≥ 4) | index |
| `crit` | 1 to 32 names | every JSON structure |
| Read address | 512 UTF-8 bytes | `checkLocation` |
| Pack header | 65 536 bytes | pack.md |
| Pack wraps | 1 to 256 | pack.md |
| Pack plaintext | u32 | pack.md (no bound on ciphertext size: the HTTP layer caps downloads) |
| Invitation link fragment | 750 characters (58 + 504 bytes) | before decoding |
| Return link | 9 600 bytes | before decoding |
| Invitation lifetime | 60 s to 7 days (`expires − created ≤ 604 800 s`) | link, record |
| Link expiry ahead of the reader | 7 days + 5 minutes | link |
| Answer grace period | 7 days after expiry | return link |
| Index `updated` ahead of the reader | 24 hours | index |
| `seq` step within a rotation | 2^20 | `checkNoRollback` |
| Vault contacts / invitations / answers / retired owners | 10 000 / 256 / 16 per invitation / 256 | vault.md |
| Vault answer string | 13 000 characters | vault.md |
| Argon2id | opslimit 2 to 10, memlimit 64 MiB to 256 MiB | transfer-blob.md |
| Transfer blob lifetime | 1 s to 15 minutes | transfer-blob.md |

## 9. Registry of constants

Magics and versions:

| Structure | Magic / type | Version | Spec |
|---|---|---|---|
| Primary identity | `"TLPI"` | 1 | identity-and-keys.md |
| Sealed sharing key | `"TLSK"`, payload `"sharing-key"` | 2 / 2 | identity-and-keys.md |
| Sharing certificate | `"sharing-cert"` | 3 | sharing-cert.md |
| Device certificate | `"device-cert"` | 1 | device-cert.md |
| Identity move | `"identity-move"` | 1 | identity-move.md |
| Signed index | (no type) | 4 (minor 0) | signed-index.md |
| Index anchor | `"index-anchor"` | = the index's version | signed-index.md |
| Pack | `"TLPK"`, header `"pack"` | 4 / 4 | pack.md |
| Group-key payload | `"group-key"` | 2 | group-key.md |
| Invitation link | `0x49` ("I") | 5 | invitation-link.md |
| Return link | `0x52` ("R") | 4 | return-link.md |
| Vault | `"TLVD"`, records `"vault-records"` | 3 / 3 | vault.md |
| Transfer blob | `"TLTX"`, purpose 1 | 2 | transfer-blob.md |
| Key export | `"key-export"` | 3 | key-export.md |

Hash and KDF contexts (all distinct, none a prefix of another followed by attacker-chosen data):
`TrianguLair/root/v1` (BLAKE2b key = entropy), KDF contexts `TLmaster` and `TLvault_`, `TrianguLair/x25519-probe`,
`TrianguLair-invitation-key-v1\n`, `TrianguLair-invitation-id-v1\n`, `TrianguLair-invitation-listing-v2\n`,
`TrianguLair-invitation-padding-key-v1`, `TrianguLair-invitation-padding-period-v1\n`,
`TrianguLair-invitation-padding-v2\n`, `TrianguLair-safety-v1`, and the signature prefix
`TrianguLair-signature-v1\n`.

## 10. Known-answer vectors

`vectors/*.json` hold 473 vectors in 17 files, generated deterministically by
`packages/crypto/test/vectors/generate.ts` from seeded randomness (libsodium's random source is replaced, in the
test process only, by a stream seeded per file; see `test/vectors/seeded.ts`). Fixed clocks: fixtures are created at
`T0 = 2026-10-20T12:00:00.000Z` and most readers run at `NOW = 2026-10-20T13:00:00.000Z`.

    {
      "structure": "pack", "spec": "pack.md", "description": "…", "generator": "…",
      "fixtures": { "<name>": <any JSON value> },
      "vectors": [
        { "name": "pack-kat", "description": "…", "op": "open_pack",
          "input": { … },                     // values {"$ref": "<name>"} stand for fixtures[name]
          "expect": {"ok": { … }}             // or {"error": "<CODE>", …details}
          "details": { … } }                  // optional intermediate values (derivations, signed bytes…)
      ]
    }

Binary values are lowercase hex in fields ending with `_hex`; JSON documents are given as their exact text. An
error result carries `fork` for `ROLLBACK`, `location` for `MOVED`, `from`, `to` and `conflict` for
`IDENTITY_MOVED` (`conflict` always present), and `critical` for an `UNSUPPORTED_VERSION` caused by `crit`; `fork`
is present (`true` or `false`) on every `ROLLBACK`. The operations are implemented in
`packages/crypto/test/vectors/ops.ts`; their inputs and `ok` results are (dates in `ok` results are JSON dates with
milliseconds; keys are their `ed25519:` / `x25519:` strings; certificates in results are canonical JSON text):

| op | Input | Runs | `ok` result |
|---|---|---|---|
| `canonical_json` | `text` | §4 parse rule | `canonical` (= the text) |
| `parse_key` | `kind`, `value` | §3 | `hex` of the 32 bytes |
| `check_location` | `location` | identity-and-keys.md §5 | `{}` |
| `signature` | `domain`, `public_key_hex`, `message_hex`, `signature_hex` | §5 | `{}` |
| `identity_from_phrase` | `phrase` | identity-and-keys.md §1 | `owner`, `master_seed_hex`, `vault_key_hex` |
| `decode_primary_identity` | `bytes_hex` | identity-and-keys.md §2 | `owner`, `vault_key_hex` |
| `open_sharing_key` | `bytes_hex`, `holder` {`device`, `box_public_hex`, `box_secret_hex`} or {`phrase`}, `options` {`expectedOwner`, `lastSeen` (cert text)} | identity-and-keys.md §6 | `cert`, `secret_hex`, `public_hex`, `vault_key_hex` |
| `verify_sharing_cert` | `text`, `options` {`expectedOwner`, `retiredOwners`, `lastSeen` (cert text)} | sharing-cert.md §2 | `owner`, `key`, `rotation`, `revoked_devices`, `location` (if any) |
| `verify_device_cert` | `text`, `options` {`expectedOwner`, `retiredOwners`} | device-cert.md §2 | `owner`, `device`, `box` |
| `verify_identity_move` | `text`, `options` {`expectedFrom`} | identity-move.md §2 | `from`, `to`, `issued` |
| `verify_index` | `text` or `bytes_hex`, `options` {`now`, `expectedOwner`, `retiredOwners`, `lastSeen` (index text, verified with `now` only), `lastSeenAnchor` (anchor JSON text, trusted), `location`} | signed-index.md §4 | `owner`, `seq`, `rotation`, `location` (certified), `device`, `revoked_devices`, `packs` (hashes), `invitations` (`[]` if absent), and if present `public` (hash), `move_from`, `minor` |
| `index_anchor` | as `verify_index` | signed-index.md §7 | `anchor` (canonical text) |
| `listing_padding` | `vault_key_hex`, `tokens`, `now` | signed-index.md §6 | `pad_key_hex`, `list` |
| `invitation_token` | `owner_public_hex`, `invitation_public_hex`, `rotation`, `expires` (s), `location` | invitation-link.md §3 | `token` |
| `padded_length` | `n` | pack.md §3 | `length` |
| `read_pack_header` | `bytes_hex` | pack.md §5 step 3 | `nonce`, `pad`, `wraps` (count) |
| `open_pack` | `bytes_hex`, `index` {`text`, `options` as `verify_index`}, `keys` [{`public_hex`, `secret_hex`}] | pack.md §5 | `id`, `type` (`content`, `group-key`, `media`), `file`, `payload_hex` |
| `open_group_key` | as `open_pack` | group-key.md §2 | `owner`, `group`, `generation`, `secret_hex`, `public_hex` |
| `parse_invitation_link` | `link`, `now` | invitation-link.md §4 | `id`, `owner`, `location`, `rotation`, `expires`, `invitation_public_hex`, `invitation_secret_hex`, `token` |
| `accept_invitation` | `link`, `index` (text), `now`, `read_from` (default: the link's address), `lastSeen` (index text) | invitation-link.md §4–5, with `verifyIndex(index, {expectedOwner: link owner, location: read_from, lastSeen, now})` between | `owner`, `token`, `rotation`, `seq` (of the index) |
| `open_invitation_response` | `bytes_hex`, `invitation` {`record` (vault record text), `owner`}, `now` | return-link.md §4 | `owner`, `device`, `created`, `rotation`, `openedAfterExpiry`, `location` (if any) |
| `collect_answers` | `responses_hex`, `invitation`, `now`, `acceptedOwner` | return-link.md §5 | `answers`, `rejected`, `multiple`, `accepted`, `late` (owner ids) |
| `check_answer_index` | `bytes_hex`, `invitation`, `index` (text), `now` | return-link.md §4, then `verifyIndex` at the answer's address, then §6 | `owner`, `device` |
| `invitation_status` | `record`, `owner`, `sharing_cert` (text), `now` | invitation-record.md §3 (a record that fails `recordInvitation` is `invalid`) | `status` |
| `open_vault` | `bytes_hex`, `owner`, `vault_key_hex` | vault.md §3 | `records` (canonical text) |
| `merge_vaults` | `a_hex`, `b_hex`, `owner`, `vault_key_hex` | vault.md §3, §4 | `records` (canonical text) |
| `decrypt_transfer` | `blob_hex`, `code`, `now` | transfer-blob.md §3 | `payload_hex` |
| `normalize_transfer_code` | `code` | transfer-blob.md §2 | `code` |
| `decode_key_export` | `bytes_hex`, `options` {`expectedOwner`, `lastSeen`} | key-export.md §2 | as `open_sharing_key` |
| `safety_code` | `a`, `b` | safety-code.md | `groups`, `qr` |

`packages/crypto/test/vectors.test.ts` checks that the library returns every `expect`, and that regenerating the
files gives them back byte for byte (so writers are covered too). `npm run vectors` in `packages/crypto` rewrites
them after an intended change. `reference-reader/` runs an independent Python implementation of every op of this table (the public
structures, and the private ones a restore reads: phrase, `TLPI`, `TLSK`, key export, transfer blob, invitation
records, return links, vault) against the same files: all 473 vectors agree.

## 11. Fuzzing

`packages/crypto/test/fuzz.test.ts` (fast-check) feeds random and mutated inputs (byte flips, insertions, deletions,
truncations, JSON-significant characters, structural JSON mutations **re-signed or re-sealed with the right key** so
that the deep checks run) to every parser: canonical JSON, `checkLocation`, `decodePrimaryIdentity`,
`verifySharingCert`, `verifyDeviceCert`, `verifyIdentityMove`, `verifyIndex` (text and bytes), `readPackHeader`, pack
decryption and `openPack`, `openGroupKey`, `parseInvitationLink` with the acceptance checks, `openInvitationResponse`
(outer and inner bytes), `openSharingKey` (both modes), `decryptTransfer`, `decodeKeyExport`, `openVault` (envelopes,
and hostile records sealed with the vault data key, which `verifyIndexAnchor` and the record checks parse). Each
property requires that only a `TLCryptoError` escapes, that no call takes more than 5 s, and that altered
authenticated data is never accepted (an accepted mutated pack opens to the original content; an accepted `TLSK` or
key export carries the genuine certificate and secret). Property tests also check that `checkNoRollback` is the total
order of (rotation, seq), that `signIndex` → `serialize` → `verifyIndex` round-trips, and that canonical JSON
round-trips. CI runs a fixed seed with bounded runs (about 5 s); `npm run fuzz:long` runs 20 000 cases per property,
`FUZZ_SEED=random` changes the seed, and `FUZZ_STATS=<file>` records the outcome distribution of each property.

## 12. Changes made while writing this specification

No wire-format change. Ambiguities found while writing the second reader from this text are listed in
[reference-reader/README.md](reference-reader/README.md#gaps-found-in-the-documentation) together with the fix made
here.
