# Known limitations

Prototype, revised after the independent review T-002 (`docs/reviews/2026-10-13-crypto-T-002.md`) and the second
review of its fixes (`docs/reviews/2026-10-13-crypto-fixes-review.md`, R-01 to R-13); not audited.
Listed so later phases can decide what to fix.

## Identity & keys
- **Phrase = identity.** The phrase derives the master key and the vault key. A leaked phrase lets an attacker certify
  sharing keys and devices and read the vault copy of the sharing key: only an identity change helps (new phrase, move
  signed by the old master; friends must re-verify).
- **Theft of an ordinary device** gives the thief that device's keys and the sharing key current at the time. It does not
  give the phrase, the master key or the vault key. After "Declare a device lost" (new random sharing key, master-signed
  certificate listing the device as revoked), the thief can neither obtain the new sharing key nor certify one, and its
  indexes are refused (`REVOKED`, or `ROLLBACK` for an index carrying the old certificate). Indexes are ordered by
  `(rotation, seq)`, so the device cannot block its revocation by publishing a huge `seq` beforehand (R-01). Remaining:
  - what was wrapped to the old sharing key (by me and by friends) stays readable from copies the thief downloaded or
    can still download, until it is re-encrypted;
  - between the theft and the declaration, the stolen device can publish validly signed indexes (and change content),
    and create or answer invitations in the owner's name (they are device-signed); readers who later see the revocation
    refuse its indexes, and `checkInvitationIndex` refuses a link whose device is revoked in the index it leads to;
  - within the current rotation the device can push `seq` forward by up to `MAX_SEQ_STEP` (2^20) per step a reader
    accepts; recovering from that needs a new rotation, which "Declare a device lost" issues anyway (a buggy honest
    device that jams `seq` also needs a rotation, so the phrase or the primary device);
  - a reader who never saw the new certificate and has no other anchor (restore without the vault's `lastSeen`) can be
    served an older index. New friends get an owner-signed anchor: the link's `min_rotation` (R-12).
- **Theft of the primary device** (the one storing the master key): equivalent to a phrase leak. The owner and the thief
  can both sign an identity move; readers keep the first move they see (`IdentityMovedError` then `retiredOwners`) and
  drop the "verified" mark: users must compare the safety code again. A second, different move of the same old identity
  is reported (`IdentityMovedError` with `conflict: true`), but nothing decides automatically which one is genuine.
  Keeping the master on a primary device is optional for this reason, and inviting no longer needs it (device-signed
  links, R-03).
- **`move` permanence is an app rule (R-11, left):** the library cannot know that an index of the new identity *should*
  carry `move` (it does not know the old identity), so it cannot refuse one that drops it. The app keeps `move` in every
  index of the new identity; a friend who was offline and sees an index without it gets `OWNER_MISMATCH`.
- No BIP39 passphrase and no key stretching on the phrase: 128 bits of entropy is the security level.
- Device revocation relies on readers seeing a newer index: there is no expiry on certificates.
- The rest of the recovery vault (friends, storage credentials, settings) is not implemented here. The spec (Recovery
  kit) now names a random **vault data key**, distributed to devices like the sharing key and renewed when a device is
  declared lost, separate from the phrase-derived key of the vault copy of the sharing key (R-13). The library has no
  helper for it yet (`sealSharingKey`'s format could be reused); until then a post-theft vault update must not use a
  key the stolen device holds.
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
  Authenticity comes from the owner's signed index: `openPack` requires a verified index and checks the content hash
  (BLAKE2b-256) before decrypting. The owner id is bound into the AEAD associated data (pack version 3), so a recipient
  cannot re-list someone else's pack in their own index (R-05). An app that bypassed `openPack` (copying internals) would
  lose all this.
- After an identity move, packs bound to the old owner id do not open through the new identity's index: re-seal them.
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
- The plaintext public-list file is covered by its hash in the index (`verifyPublicFile`), but only for apps that check
  it; uMap and other external readers see the file as is.

## Invitations
- The link is a **bearer secret** for its validity: anyone who sees it (chat history, screenshot, clipboard, link
  previewers that read fragments) can read content wrapped to the invitation key and can answer.
  Mitigations: one answer per invitation (several answers → none accepted automatically), safety code, and
  `retireInvitationKey` re-encryption on acceptance or expiry. These require the owner app to actually run the sweep at
  expiry (track open invitations in the recovery vault).
- Expiry inside the link is enforced by honest clients using their own clock.
- The invitation response is sealed to the invitation key, so any link holder can also read it (public keys, the
  responder's read address, a signature).
- **Late answers** (R-04): an interceptor who answers first is accepted if no other answer has arrived yet. The owner
  keeps the invitation record until expiry and collects with `acceptedOwner`, so a later answer from someone else shows
  up in `late` and the app warns. Answers arriving after expiry are not opened (the record and its key are dropped at
  expiry), and the grant made in the meantime stands until the user reacts. Granting a reduced scope until the code is
  compared is a product decision left to the app.
- The invitation key must be a direct recipient, never a group member; this is enforced only when retiring
  (`retireInvitationKey` throws on a group-key pack), not when sealing.
- The link is about 450 characters (device cert inside, R-03): larger QR codes than the former ~300.
- `checkLocation` rejects local-network IP literals and names (`localhost`, `*.local`, `*.internal`), not public names
  that resolve to private addresses (DNS rebinding): the app's HTTP layer must also refuse private destinations.
- The link's `created` is not bounded against the reader's clock (only the owner's device can sign it); the u32
  seconds fields overflow in 2106.
- **Face-to-face QR exchange (R-13, left):** the spec's "exchange of QR codes replaces the two links … marked as
  verified automatically" has no defined payload or parser yet. It needs product decisions (one or two scans, what is
  shown) and should reuse the return-link body (device-signed, sharing cert, location); to be specified with T-201
  before any app relies on "verified automatically".
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
- The verified-index registry is a module-level `WeakSet`: two bundled copies of this package do not recognise each
  other's verified indexes (fails closed with `NOT_INDEXED`).
- Known-answer vectors exist for phrase → owner, the safety code and Padmé; vectors for exact signed bytes per domain, a
  fixed pack, transfer blob, sealed sharing key and invitation link are still to be written (they need deterministic
  randomness hooks).
