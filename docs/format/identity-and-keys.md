# Identity and keys

Vectors: `vectors/identity.json`, `vectors/sharing-key.json`, `vectors/encoding.json` (keys, read addresses).
Code: `src/identity.ts`, `src/sharing-key.ts`, `src/encoding.ts`, `src/location.ts`.

## 1. Key hierarchy

```
12 BIP39 words ──(checksum, 128-bit entropy)──► entropy (16 bytes)
root        = BLAKE2b-256(key = entropy, "TrianguLair/root/v1")          never stored
master seed = crypto_kdf(32, id = 1, ctx = "TLmaster", key = root)
master      = Ed25519 key pair from master seed                           signs certificates and identity moves only
vault key   = crypto_kdf(32, id = 2, ctx = "TLvault_", key = root)        opens the phrase copy of the sharing key (TLSK mode 2)
sharing     = random X25519 key pair                                      NOT derived from the phrase; certified (sharing-cert.md)
vault data  = random 32 bytes                                             encrypts the vault records (vault.md); held by every device
device      = random Ed25519 (signs indexes, invitation records, answers) + random X25519 (box), per device, never copied
```

`crypto_kdf` is defined in README §2. The **owner id** is `"ed25519:" || b64u(master public key)`.

### Recovery phrase → identity (`identityFromPhrase`)

1. Normalize: Unicode NFKD, trim leading and trailing whitespace, lowercase, split on runs of whitespace, join with
   single spaces (ECMAScript `String.prototype.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ")`).
2. Not exactly 12 words, or not a valid BIP39 English mnemonic (unknown word, checksum) → ERROR(INVALID_PHRASE).
   A valid 24-word phrase is refused too.
3. entropy = the 16 bytes encoded by the words (BIP39; no PBKDF2 seed, no passphrase).
4. Derive root, master seed, master key pair and vault key as above.

There is no key stretching: the 128-bit entropy is the security level. The vectors give every intermediate value
(`identity.json`, `details`: `entropy_hex`, `root_hex`, `master_seed_hex`, `master_public_hex`, `vault_key_hex`).

## 2. Primary identity `TLPI`

The optional primary device keeps the master key in the system's secure storage (never on the storage):

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `"TLPI"` |
| 4 | 1 | version = 1 |
| 5 | 32 | master seed |
| 37 | 32 | vault key |

69 bytes exactly. Decoding: magic (4 bytes, truncated → FORMAT) ≠ `"TLPI"` → ERROR(FORMAT); version byte 0 →
ERROR(FORMAT), ≠ 1 → ERROR(UNSUPPORTED_VERSION); seed and vault key (truncated → FORMAT); any trailing byte →
ERROR(FORMAT). The master key pair is rederived from the seed.

## 3. Device keys

Each device generates an Ed25519 key pair (its **device id** is `"ed25519:" || b64u(pk)`) and an X25519 box key
pair. It shows `{device, box}` to the primary device (or to the phrase holder), which issues its device certificate
(device-cert.md). Device keys never leave the device.

## 4. X25519 public key validation (`assertX25519PublicKey`)

Applied wherever an X25519 public key is parsed (`"x25519:…"` strings, compact certificates in return links) or used as
a pack recipient:

1. Not 32 bytes → ERROR(INVALID_KEY) (inside `parseKey`, a wrong length is ERROR(FORMAT) first).
2. Bit 255 set (`pk[31] & 0x80`) → ERROR(INVALID_KEY).
3. probe = BLAKE2b-256("TrianguLair/x25519-probe") (a fixed scalar, clamped by X25519). shared = X25519(probe, pk).
   If the scalar multiplication fails or shared is all-zero → ERROR(INVALID_KEY). This rejects 0, 1, the other
   small-order points and their encodings ≥ p (p + 0, p + 1).

**Note F-1 (found while writing this specification; not changed, the format is frozen).** Encodings in
`[p + 2, 2^255 − 1]` (17 values: non-canonical spellings of u = 2 … 18) pass these checks, so such a key has two
string forms. Honest writers never produce them (`crypto_scalarmult_base` outputs reduced values), and every
signature covers the exact string, so no verifier can be confused; at worst an owner can certify a key under an
unusual spelling. A second implementation MUST accept them too to agree with the vectors
(`encoding/key-x25519-p-plus-2`). A future version should reject `u ≥ p`.

## 5. Read address (`checkLocation`)

The master-certified read address of an owner's index (sharing-cert.md), also carried by invitation links. It is
fetched by readers, so it MUST pass, in order (any failure is ERROR(FORMAT)):

1. It is a string of at most 512 bytes in UTF-8, and starts with `https://`.
2. It contains none of: whitespace (the ECMAScript `\s` class: U+0009–U+000D, U+0020, U+00A0, U+1680, U+2000–U+200A,
   U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF), U+0000–U+001F, U+007F, `#`, `\`.
3. It parses as a WHATWG URL (the URL Standard, as implemented by `new URL()`) and **its serialization (`href`) is
   exactly the input**: so the host is lowercase ASCII (IDNs in punycode), IPv4 hosts are dotted decimal, IPv6 hosts
   are compressed lowercase, the default port 443 is absent, the path is not empty (`https://example.org/`), contains
   no dot segments and no character the URL Standard would percent-encode. Its scheme is `https`, with no user name
   or password, and a non-empty host. (Query strings are allowed; the fragment was excluded by step 2.)
4. The host is not local. Remove one trailing `.`; then refused are: `localhost` and `*.localhost`, `*.local`,
   `*.internal`; an IPv4 literal `a.b.c.d` with `a = 0`, `10`, `127`, `≥ 224`, or `100.64/10`, `169.254/16`,
   `172.16/12`, `192.168/16`; an IPv6 literal (in brackets) in `::/96` (unspecified, loopback, IPv4-compatible),
   `fe80::/10`, `fc00::/7`, `ff00::/8`, `64:ff9b:1::/48`, or whose embedded IPv4 address is local by the IPv4 rule:
   `::ffff:0:0/96` (hextets 7–8), `64:ff9b::/96` (hextets 7–8), `2002::/16` (hextets 2–3). An IPv6 literal that does
   not parse is refused.

The HTTP layer MUST additionally refuse public names that resolve to private addresses (DNS rebinding); that is not a
format check. Vectors: `encoding.json`, `loc-*`.

**Without a URL Standard parser** (gap G-1 of the reference reader). Step 3 is defined by the URL Standard's parser
and serializer. An implementation that has none can accept exactly the inputs that are already their own
serialization by checking, after steps 1–2: only ASCII; `https://` then an authority without `@`, then a path starting
with `/`, then an optional `?query`; the host is either `[` + the URL Standard IPv6 serialization (lowercase hex
without leading zeros, the first longest run of two or more zero pieces compressed to `::`, no dotted IPv4) + `]`, or,
when its last label is a number (decimal digits, or `0x` and hex digits), exactly four dotted decimal octets without
leading zeros, or else a domain of ASCII characters other than uppercase letters and the forbidden domain code points
(C0 controls, space, `# % / : < > ? @ [ \ ] ^ |`, U+007F), each `xn--` label valid punycode; an optional port of
decimal digits without leading zeros, at most 65535, not 443, not empty; path characters outside the path
percent-encode set (C0, space, `" # < > ? \` { }`) and no segment that is `.`, `..` or their `%2e` spellings
(any case); query characters outside the special-query percent-encode set (C0, space, `" # < > '`). This is what
`reference-reader/tlreader.py` does; it agrees with the reference library on every vector, but it is an
approximation, not an equivalent (its check of `xn--` labels is Python's punycode codec, not the full IDNA
validation of the URL Standard). Prefer a URL Standard implementation where one exists.

## 6. Sealed sharing key `TLSK`

How the current sharing key and vault data key reach each device (mode 1), and the phrase-protected copy kept in the
recovery vault (mode 2).

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `"TLSK"` |
| 4 | 1 | version = 2 |
| 5 | 1 | mode: 1 = sealed to a device, 2 = phrase copy |
| 6 | … | mode 1: `crypto_box_seal(payload, device box public key)` |
| 6 | 24 | mode 2: nonce |
| 30 | … | mode 2: `XChaCha20-Poly1305(payload, AD = bytes[0..30), key = vault key)` |

Mode 1's header bytes are not authenticated (the sealed box has no AD); the payload's own `type`, `version` and `to`
bind it. Mode 2's AD is the first 30 bytes (magic, version, mode, nonce).

Payload, canonical JSON (`version` 2, no optional fields, minor 0):

```json
{"cert":<full sharing certificate>,"secret":"<b64u 32-byte X25519 secret>","to":"<device id | owner id>",
 "type":"sharing-key","vault_key":"<b64u 32-byte vault data key>","version":2}
```

`to` is the recipient device's id (mode 1) or the owner id (mode 2). The certificate is a nested object (it is not
re-parsed from a string).

**Writing** (`sealSharingKey(sharing, to)`): the certificate verifies, the secret's public key is the certified key,
the vault data key is 32 bytes. Mode 1: `to` is a device certificate verified for the certificate's owner, and a
device that this certificate revokes is refused (ERROR(REVOKED), R-07). Mode 2: `to` is the identity of the same owner
(else ERROR(OWNER_MISMATCH)); the nonce is random.

**Reading** (`openSharingKey(bytes, holder, {expectedOwner?, lastSeen?})`), where the holder is a device (its id and
box key pair) or an identity (owner id and vault key):

1. Magic (truncated → FORMAT) ≠ `"TLSK"` → ERROR(FORMAT). Version byte: 0 → ERROR(FORMAT), ≠ 2 →
   ERROR(UNSUPPORTED_VERSION). Mode byte (truncated → FORMAT).
2. Mode 1 and a device holder: open the sealed box `bytes[6..]` with the device box key pair; failure →
   ERROR(DECRYPT). Mode 2 and an identity holder: nonce = `bytes[6..30)` (truncated → FORMAT); decrypt `bytes[30..]`
   with AD `bytes[0..30)` and the vault key; failure → ERROR(DECRYPT). Any other combination → ERROR(FORMAT).
3. Payload: strict UTF-8 and canonical JSON (README §4) → else ERROR(FORMAT).
4. `checkStructure(payload, "sharing-key", 2, [type, version, to, secret, vault_key, cert], [], 0)`.
5. `type ≠ "sharing-key"` → ERROR(FORMAT).
6. `to` ≠ the holder's device id (mode 1) or owner id (mode 2) → ERROR(FORMAT).
7. Verify `cert` as a sharing certificate (sharing-cert.md) with the caller's `expectedOwner` and `lastSeen` (mode 2:
   `expectedOwner` is the identity's owner id): errors as there. Pass `lastSeen` whenever the device already holds a
   certificate: anyone can seal to a device's public box key, so without it an older, compromised key could be
   pushed back (R-08).
8. `secret`: b64u of 32 bytes → else ERROR(FORMAT). `X25519(secret, 9)` ≠ the certified key → ERROR(FORMAT).
9. `vault_key`: b64u of 32 bytes → else ERROR(FORMAT).

Result: the sharing key pair, the verified certificate, the vault data key.
