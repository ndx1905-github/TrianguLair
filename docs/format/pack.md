# Pack (envelope `TLPK`, version 4)

A pack is a content-addressed file encrypted once under a random **batch key**, which is wrapped (sealed box) to each
recipient's X25519 key. It opens only through the owner's verified signed index, which lists its hash and supplies the
owner key bound into the AEAD. Vectors: `vectors/pack.json`, `vectors/group-key.json`. Code: `src/pack.ts`.

## 1. Envelope

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `"TLPK"` |
| 4 | 1 | envelope version = 4 |
| 5 | 4 | N = header length (u32) |
| 9 | N | header: canonical JSON, UTF-8 |
| 9 + N | … | ciphertext = XChaCha20-Poly1305(plaintext) `\|\|` 16-byte tag |

Header (canonical JSON; minor 0; optional `minor` and `crit`, README §6):

```json
{"alg":"xchacha20poly1305-ietf","nonce":"<b64u 24>","pad":"padme","type":"pack","version":4,
 "wrapAlg":"x25519-sealedbox","wraps":["<b64u 80>","…"]}
```

| Member | Value |
|---|---|
| `type` | `"pack"` |
| `version` | 4 |
| `alg` | `"xchacha20poly1305-ietf"` |
| `wrapAlg` | `"x25519-sealedbox"` |
| `nonce` | b64u of the 24-byte AEAD nonce (random) |
| `pad` | `"padme"` or `"none"` |
| `wraps` | 1 to 256 strings, each b64u of an 80-byte sealed box of the 32-byte batch key: `epk 32 \|\| tag 16 \|\| encrypted key 32` |

There is **no** pack id, owner, recipient key, hash or hint in the header. Writers shuffle the wraps and pad the list
with dummy wraps, real sealed boxes of 32 random bytes to throwaway key pairs (indistinguishable from real ones), up to
the next power of two ≥ max(recipients, 2) by default (or a chosen count; at most 256).

## 2. Associated data

    AD = "TLPK" || 0x04 || owner master public key (32 bytes) || UTF8(canon(header \ {"wraps"}))

Every header member except `wraps` is authenticated, unknown extension members of a newer minor included. The owner
key is not written in the file: the reader takes it from the verified index the pack is listed in, so a pack
re-listed in another owner's index does not open (DECRYPT, R-05). Wraps are outside the AD (as JWE per-recipient
keys): changing one can only make it fail to open, and the file hash in the signed index covers the whole file.

## 3. Plaintext frame

    plaintext = id (16 bytes) || type (u8) || L = payload length (u32) || payload (L bytes) || zero padding

- `id`: the logical pack id, random, stable across re-encryptions of the same logical pack; only visible after
  decryption.
- `type`: 1 = content, 2 = group-key (group-key.md), 3 = media. Any other value is invalid.
- Length: with `pad = "padme"` the plaintext is exactly `padme(21 + L)` bytes; with `"none"`, exactly `21 + L`.
  Padding bytes are zero.

Padmé, integers only (every implementation MUST agree):

    padme(n), 0 ≤ n ≤ 2^32 − 1 (else ERROR(FORMAT)):
      n ≤ 256 → 256
      e = floor(log2 n); s = floor(log2 e) + 1; step = 2^(e − s)
      return ceil(n / step) × step

Vectors: `padme-*` (0, 21, 256, 257, 300, 1000, 1021, 4096, 4097, 65537, 10^6, 2^31, 2^32 − 1, and 2^32 refused).

## 4. Writing (`sealPack(owner, payload, recipients, {id?, padTo?, pad?, type?})`)

Batch key and nonce: fresh random. Each recipient key is validated (identity-and-keys.md §4); the wrap target count
is checked (≤ 256) before any work. The file name is `packs/b2b256-<h>.bin` (or `media/…` for photos), `h =
b64u(BLAKE2b-256(file bytes))`: files are never modified, a new version is a new file.

- `rewrapPack`: same batch key and ciphertext, new wrap list. Only to **add** recipients: not a revocation.
- `reencryptPack`: new batch key and nonce, same logical id and type, new file. This is revocation.

## 5. Opening (`openPack(bytes, index, keys)`)

`index` MUST be a verified, owner-bound index of the owner (signed-index.md §4 step 22); `keys` are the reader's X25519
key pairs (sharing key, group keys, invitation keys…).

1. `index` is not owner-bound → ERROR(NOT_INDEXED).
2. `h = "b2b256:" || b64u(BLAKE2b-256(bytes))`. No entry of `index.packs` has this hash → ERROR(NOT_INDEXED). This
   happens before any public-key operation.
3. Decode the envelope:
   1. fewer than 9 bytes → ERROR(FORMAT); magic ≠ `"TLPK"` → ERROR(FORMAT); version byte 0 → ERROR(FORMAT), ≠ 4 →
      ERROR(UNSUPPORTED_VERSION);
   2. N > 65 536 or 9 + N > length → ERROR(FORMAT);
   3. header: strict UTF-8, canonical JSON object → else ERROR(FORMAT);
   4. `checkStructure(header, "pack header", 4, [type, version, alg, wrapAlg, nonce, pad, wraps], [], 0)`;
   5. `type ≠ "pack"`, `alg`, `wrapAlg` other than above, `pad` ∉ {`padme`, `none`} → ERROR(FORMAT), in that order;
   6. `nonce` not a string, or not b64u of 24 bytes → ERROR(FORMAT);
   7. `wraps` not an array of 1 to 256 entries → ERROR(FORMAT); an entry not b64u of 80 bytes → ERROR(FORMAT);
   8. ciphertext = `bytes[9 + N ..]`.
4. AD as in §2, with the owner key of `index.owner`.
5. For each wrap in header order, for each key in the given order: open the sealed box with the key pair; on failure
   continue. On success (`unwrapped = true`), decrypt the ciphertext with that batch key, the nonce and the AD; on
   success go to step 6, on failure continue with the next key/wrap.
6. If nothing decrypted: `unwrapped` → ERROR(DECRYPT) (tampered, or listed in another owner's index), else
   ERROR(NO_MATCHING_KEY).
7. Unframe: plaintext shorter than 21 bytes → ERROR(FORMAT); type byte ∉ {1, 2, 3} → ERROR(FORMAT); L > length − 21
   → ERROR(FORMAT); length ≠ `padme(21 + L)` (pad `padme`) or `21 + L` (pad `none`) → ERROR(FORMAT); a non-zero
   padding byte → ERROR(FORMAT).
8. Result: `id = b64u(plaintext[0..16))`, the type, the payload, and the index entry's `file`.

Cost: at most wraps × keys X25519 operations, and only for files listed in a verified index. A reader MUST NOT treat
`DECRYPT` and `NO_MATCHING_KEY` differently in anything visible to others.

`readPackHeader(bytes)` performs step 3 alone (no index, no decryption).
