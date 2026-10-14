# Known limitations

Prototype, revised after the independent review T-002 (`docs/reviews/2026-10-13-crypto-T-002.md`); not audited.
Listed so later phases can decide what to fix.

## Identity & keys
- **Phrase = identity.** The phrase derives the master key and the vault key. A leaked phrase lets an attacker certify
  sharing keys and devices and read the vault copy of the sharing key: only an identity change helps (new phrase, move
  signed by the old master; friends must re-verify).
- **Theft of an ordinary device** gives the thief that device's keys and the sharing key current at the time. It does not
  give the phrase, the master key or the vault key. After "Declare a device lost" (new random sharing key, master-signed
  certificate listing the device as revoked), the thief can neither obtain the new sharing key nor certify one, and its
  indexes are refused (`REVOKED`, or `ROLLBACK` for an index carrying the old certificate). Remaining:
  - what was wrapped to the old sharing key (by me and by friends) stays readable from copies the thief downloaded or
    can still download, until it is re-encrypted;
  - between the theft and the declaration, the stolen device can publish validly signed indexes (and change content);
  - a reader who never saw the new certificate (fresh install with no `lastSeen`) can be served an older index.
- **Theft of the primary device** (the one storing the master key): equivalent to a phrase leak. The owner and the thief
  can both sign an identity move; readers keep the first move they see (`IdentityMovedError` then `retiredOwners`) and
  drop the "verified" mark: users must compare the safety code again. Keeping the master on a primary device is optional
  for this reason.
- No BIP39 passphrase and no key stretching on the phrase: 128 bits of entropy is the security level.
- Device revocation relies on readers seeing a newer index: there is no expiry on certificates.
- The rest of the recovery vault (friends, storage credentials, settings) is not specified here. Its key must not be
  something a stolen ordinary device keeps, or a post-theft vault update would leak to the thief.
- Secrets live in JS memory (`Uint8Array`); `memzero` is applied to intermediates (entropy, root, master seed, batch keys,
  plaintexts) but is best-effort: the GC may keep copies, and secrets that pass through JSON strings (key export, sealed
  sharing key, group-key payload) or base64 cannot be wiped. Secure storage (Keychain/Keystore) is the app's job.

## Packs
- **No forward secrecy.** Whoever obtains a sharing (or group) secret key can open every pack ever wrapped to it that
  they can download.
- **Revocation is not retroactive.** `reencryptPack` protects future versions only; the revoked friend keeps whatever
  they already downloaded/decrypted, and anyone who held a batch key can still read old copies the storage keeps
  (version history: limit it, delete old files).
- **`rewrapPack` is not revocation**: removing a wrap does not change the batch key.
- **No sender authentication inside a pack.** Sealed boxes are anonymous and any recipient knows the batch key.
  Authenticity comes only from the owner's signed index: `openPack` requires a verified index and checks the content hash
  (BLAKE2b-256) before decrypting. An app that bypassed this (copying internals) would lose it.
- Wraps are not covered by the AEAD AD: an attacker can strip/replace wraps (denial of service only, and the index hash
  catches it).
- **Metadata leaks**: padded pack size (Padmé, ≤ 12 %, so sizes are bucketed, not hidden), padded wrap count (power of
  two), file count, update times and the access pattern to the storage. The logical pack id is no longer visible, and a
  new version is an unlinkable new file, but the storage still sees one file appear as another disappears.
- Trial decryption cost is wraps × candidate keys (X25519 each), at most 256 wraps, and only for packs listed in a
  verified index.
- Dummy wraps are indistinguishable from real ones only because they are real sealed boxes; do not replace them with
  random bytes.

## Signed index
- Rollback protection only works if the client **persists the last seen index** per owner (also in the recovery vault);
  a fresh client can be served any old (validly signed) index. No freshness without gossip or a trusted time source, and
  split views (different readers served different indexes) are undetectable.
- Two devices of the same owner racing on a storage without conditional writes (HTTPS-only mode) produce a legitimate
  same-`seq` fork; readers report it (`fork: true`) and should accept the next higher `seq` rather than fail hard.
- `updated` is informational; a device with a clock up to 24 h fast is accepted, more is refused until the clock is fixed.
- The owner key itself is trusted on first use or via the invitation link. Verification is a user action (safety code);
  there is no key transparency.

## Invitations
- The link is a **bearer secret** for its validity: anyone who sees it (chat history, screenshot, clipboard, link
  previewers that read fragments) can read content wrapped to the invitation key and can answer.
  Mitigations: one answer per invitation (several answers → none accepted automatically), safety code, and
  `retireInvitationKey` re-encryption on acceptance or expiry. These require the owner app to actually run the sweep at
  expiry (track open invitations in the recovery vault).
- Expiry inside the link is enforced by honest clients using their own clock.
- The invitation response is sealed to the invitation key, so any link holder can also read it (public keys, the
  responder's read address, a signature).
- The safety code is only as good as the comparison the users actually make; marking "verified" is a declaration.

## Transfer code
- 66-bit code + Argon2id (≥ INTERACTIVE): offline brute force of a captured blob costs ~2^65 Argon2 evaluations.
  The blob and the code must still travel over different channels.
- Expiry is authenticated but checked against the receiver's clock; single use depends on deleting the blob.
- 256 MiB of Argon2 memory can still be too much for low-end phones; the app may impose lower limits.

## General
- Canonical JSON forbids floats; any future signed field with decimals must be encoded as a string.
- Transported JSON must be byte-canonical; other implementations must produce exactly the same bytes (JCS subset).
- libsodium-wrappers-sumo is a large WASM/asm.js bundle; React Native performance of Argon2 is untested.
- No constant-time guarantees beyond what libsodium provides; JS string handling of secrets (base64) is not
  constant-time.
- Error codes are local information; reflecting them to a remote party would create oracles.
