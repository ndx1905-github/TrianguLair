# Transfer blob (`TLTX`, version 2) and transfer code

"Link + code" way of adding a device: the old device encrypts a key export (key-export.md) under a key derived from a
6-word code with Argon2id, drops the blob on the storage for at most 15 minutes, and the new device decrypts it with
the code typed by the user. Vectors: `vectors/transfer.json`. Code: `src/transfer.ts`.

## 1. Layout

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `"TLTX"` |
| 4 | 1 | version = 2 |
| 5 | 1 | purpose = 1 (key export) |
| 6 | 4 | Argon2id opslimit (u32) |
| 10 | 4 | Argon2id memlimit in bytes (u32) |
| 14 | 4 | expires, u32 seconds |
| 18 | 16 | salt (random) |
| 34 | 24 | nonce (random) |
| 58 | … | XChaCha20-Poly1305(payload, AD = bytes[0..58), key) |

    key = Argon2id13(out = 32, password = UTF8(normalized code), salt, opslimit, memlimit)   (README §2)

Parameters: `2 ≤ opslimit ≤ 10` and `64 MiB ≤ memlimit ≤ 256 MiB` (67 108 864 to 268 435 456), checked by both sides;
the default is libsodium INTERACTIVE (2, 64 MiB). Lifetime: 1 s to 15 minutes (default 15). The whole header,
expiry and parameters included, is authenticated. Single use = deleting the blob from the storage (app rule).

## 2. Transfer code

6 words drawn uniformly from the BIP39 English list (66 bits). Normalization (`normalizeTransferCode`): NFKD,
lowercase, trim, split on runs of whitespace or `-`, drop empty parts; there MUST be 6 parts; each part MUST have at
least 3 letters, is looked up by its first 4 letters (unique in the list; a 3-letter word maps to itself), and MUST be
a prefix of the word found; else ERROR(INVALID_CODE). The result is the 6 full words joined by single spaces: this is the
Argon2 password.

## 3. Decryption (`decryptTransfer(blob, code, {now?})`)

1. Not bytes or fewer than 74 bytes (58 + 16) → ERROR(FORMAT); magic ≠ `"TLTX"` → ERROR(FORMAT); version byte 0 →
   ERROR(FORMAT), ≠ 2 → ERROR(UNSUPPORTED_VERSION); purpose ≠ 1 → ERROR(FORMAT).
2. opslimit or memlimit out of range → ERROR(FORMAT) (before any key derivation: the parameters are
   attacker-controlled).
3. `now ≥ expires × 1000` → ERROR(EXPIRED) (before the slow derivation).
4. Normalize the code → else ERROR(INVALID_CODE); derive the key.
5. Decrypt with AD = `bytes[0..58)` → else ERROR(DECRYPT) (wrong code or tampered).
