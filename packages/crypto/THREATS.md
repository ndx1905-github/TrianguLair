# Known limitations (phase 0)

Prototype; not audited. Listed so later phases can decide what to fix.

## Identity & keys
- **Phrase = everything.** The root seed derives the master key and every sharing key. A leaked phrase
  compromises past and future sharing keys; rotating the sharing key does not help — a new identity is needed.
  (Upside: the phrase restores everything.)
- No BIP39 passphrase and no key stretching on the phrase: 128 bits of entropy is the security level.
- No revocation of the *master* key and no recovery-contact scheme.
- Secrets live in JS memory (`Uint8Array`); `memzero` is best-effort, the GC may keep copies. Secure storage
  (Keychain/Keystore) is the app's job.
- A limited device holding only a sharing key cannot be cut off other than by rotating the sharing key and
  re-encrypting everything wrapped to it.

## Packs
- **No forward secrecy.** Whoever obtains a sharing (or group) secret key can open every pack ever wrapped to
  it that they can download.
- **Revocation is not retroactive.** `reencryptPack` protects future versions only; the revoked friend keeps
  whatever they already downloaded/decrypted, and anyone who held a batch key can still read old copies.
- **`rewrapPack` is not revocation**: removing a wrap does not change the batch key.
- **No sender authentication inside a pack.** Sealed boxes are anonymous and any recipient knows the batch key,
  so a recipient could forge a pack (or a new wrap). Authenticity relies on the owner's **signed index**
  (`etag` = BLAKE2b-128 hash of the pack file). Clients MUST check `packEtag(bytes)` against a verified index.
  128-bit hash: fine against second preimages, but collisions are ~2^64 (only the owner, who signs, could exploit).
- Wraps are not covered by the AEAD AD: an attacker can strip/replace wraps (denial of service only).
- **Metadata leaks**: pack size (≈ payload size), padded wrap count (power of two), pack id, file names,
  update times and the access pattern to the storage are visible. The pack id is stable across re-encryption.
- Trial decryption cost is wraps × candidate keys (X25519 each); a malicious pack with 4096 wraps is a mild DoS.
- Dummy wraps are indistinguishable from real ones only because they are real sealed boxes; do not replace
  them with random bytes.

## Signed index
- Rollback protection only works if the client **persists the last seen index** per owner; a fresh client
  can be served any old (validly signed) index (no freshness without a trusted time source).
- `updated` comes from the owner's clock; a wrong clock (far future) would make later indexes look like a
  rollback. No max-skew check yet.
- The owner key itself is trusted on first use (TOFU) or via the invitation link; there is no key transparency
  and no safety-number comparison helper yet.

## Invitations
- The link is a **bearer secret**: anyone who sees it (chat history, screenshot, clipboard, link previewers
  that read fragments) can read content wrapped to the invitation key and can send a response first.
  Owners should compare a safety code out of band before trusting the returned key (not implemented).
- Expiry is enforced by honest clients using their own clock; content already wrapped to the invitation key
  remains decryptable by a link holder after expiry until the owner re-encrypts (`reencryptPack`, not just
  `rewrapPack`) — dropping the invitation wrap via `rewrapPack` only stops future batch keys.
- The invitation response is sealed to the invitation key, so any link holder can also read it (it contains
  only public keys and a signature).

## Transfer code
- 60-bit code + Argon2id INTERACTIVE: offline brute force of a captured blob costs ~2^59 Argon2 evaluations
  (fine), but the blob and the code must still travel over different channels and the code is short-lived by
  convention only (no expiry inside the format).
- Argon2 parameters come from the blob; they are bounded (≤ 10 passes, ≤ 1 GiB) but 1 GiB can still be too
  much for a phone — the app should impose lower limits.

## General
- Canonical JSON forbids floats; any future signed field with decimals must be encoded as a string.
- libsodium-wrappers-sumo is a large WASM/asm.js bundle; React Native performance of Argon2 is untested.
- No constant-time guarantees beyond what libsodium provides; JS string handling of secrets (base64) is not
  constant-time.
