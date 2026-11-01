# Known limitations

Prototype, revised after the independent review T-002 (`docs/reviews/2026-10-13-crypto-T-002.md`), the second
review of its fixes (`docs/reviews/2026-10-13-crypto-fixes-review.md`, R-01 to R-13) and the third review of format v3
(`docs/reviews/2026-10-18-crypto-v3-review.md`, V3-01 to V3-16, N-1 to N-6), then given a short invitation link
(link version 5), and revised after the fourth review (`docs/reviews/2026-10-18-crypto-v4-review.md`, V4-01 to V4-08,
N-1 to N-7: index 4.0 with `invitations`, token v2, vault v3) and the fifth review before the v4 freeze
(`docs/reviews/2026-10-18-crypto-v4-final-review.md`, R5-01 to R5-03, N-1 to N-5: no format change); not audited.
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
    create invitations and list them in those indexes, and answer invitations in the owner's name; readers who later
    see the revocation refuse its indexes, and the next index after the declaration lists no invitation at all:
    - each vault invitation record is signed by its creating device (domain `invitation-record`) and carries that
      device's master-signed certificate (vault v3, V4-01), so the thief, who holds the vault data key, cannot write a
      record in another device's name nor change its dates (a lifetime over 7 days is refused everywhere). Records it
      signs with the phone's own key are skipped by `signIndex` once the certificate revokes the phone (`"revoked"`);
      a malformed or forged record is skipped (`"invalid"`), never thrown on, so it cannot block the declaration's
      index. A genuine record that is not listable yet (a newer rotation, created up to 7 days "in the future") is
      `"not-yet"` (R5-02): kept, not deleted, and it ends as `"expired"` within 7 days, so a planted one costs a vault
      slot for at most a week;
    - the stolen device read the seed of **every** open invitation in the vault, including those other devices
      created, so the declaration cancels them all (`cancelAllInvitations`, V4-02) and re-encrypts what they opened
      without their keys (`retireInvitationKey` with all the cancelled key pairs). Before the declaration, the thief
      reads what is wrapped to those keys and can open answers sealed to them (the responders' public certificates and
      addresses); people invited who had not answered need a new link;
    - the cancellation is a **listing rule**, not only a deletion (R5-01): an invitation is listed only under the
      rotation it was created with, and a reader refuses a link whose rotation is older than the index's. A vault copy
      from before the declaration (a device that had not seen it yet, or a vault the thief seals with the old vault data
      key for a device that has not received the new one) can bring the records back through `mergeVaults`, but no index
      lists them again. The app must also wrap content only to invitations `invitationStatus` reports as `"listed"`.
      Cost: every rotation, a storage move included, cancels the open invitations, and the app asks the user to resend
      them;
  - **after** the declaration, the device can still mint links (they are unsigned: anyone can write one naming any
    master key) and answers (device certificates never expire). A link is honoured only if the owner's index read at
    the link's address is verified there as its master-certified address (an attacker's address only leads, by a
    master-signed redirect, to the real one) and **lists** the link's token; only a device the current master-signed
    certificate does not revoke can publish such an index, so the listing replaces the device signature of format 4.
    An answer carries the master-signed certificate with the responder's address; the inviter reads the revocation
    there. `checkInvitationIndex` refuses both. Residuals:
    - **write access to the storage** (the thief kept the storage credentials, before step 4 of the declaration, or
      the host itself): an index signed by the revoked device under the **old** certificate, listing a link it made,
      can be put back at the certified address. A new contact without an anchor accepts it (trust on first use), unless
      the link names a later rotation than that certificate (the link's rotation is a freshness floor, bound in the
      token: `ROLLBACK`). This is the same residual as with the signed link of format 4, whose carried certificate was
      the same floor; the declaration's step 4 (revoke the storage credentials) closes it;
    - an **old read address** that still serves a stale index after a storage move (the owner left it there instead
      of the newest index, or the host rolls it back) is trust on first use for a new contact who holds a link naming
      that address and the older rotation (if that stale index lists it). The spec requires leaving the newest index (the redirect) or nothing at an old address;
    - **every address an older certificate certified** (V4-08): the revoked device can still sign valid indexes of an
      older rotation, which certify the older address. Whoever can write at such an address can serve there a stale
      index listing the thief's earlier links. Step 4 of the declaration therefore revokes the credentials of the
      current storage **and** of every previous storage still holding a redirect (it must stay writable by the owner).
      A **custom domain** that expires and is re-registered by the thief gives a permanent impersonation channel toward
      new contacts holding an old link (and the mirror case: an inviter wrapping to the old sharing key, which the thief
      holds). Owners should keep old domains registered or use provider addresses; for a first contact the safety code
      is the only defence. A master-signed "superseded" statement at old addresses, or a not-after date on sharing
      certificates for first-contact use, would close it (not done);
    - an **answer whose certificate has no address** (the responder publishes nothing) cannot be freshness-checked:
      `checkInvitationIndex` throws `FORMAT` and the app must show the contact as "cannot be checked" until the safety
      code is compared (a thief can only use such a certificate if the victim never published one);
    - a contact who accepted a link **before** the declaration keeps following until the next sync shows the
      revocation (ordinary rollback protection then applies);
  - within the current rotation the device can push `seq` forward by up to `MAX_SEQ_STEP` (2^20) per step a reader
    accepts; recovering from that needs a new rotation, which "Declare a device lost" issues anyway. Honest devices are
    protected by `signIndex(…, { previous })` (V3-13: `seq = previous + 1`, no rollback), but a jam published by a buggy
    device that did not use it still needs a rotation (phrase or primary device);
  - a reader who never saw the new certificate and has no other anchor (restore without the vault's anchor) can be
    served an older index **at the certified address** only by the storage host (rollback, trust on first use).
- **Theft of the primary device** (the one storing the master key): equivalent to a phrase leak. The owner and the thief
  can both sign an identity move; readers keep the first move they see (`IdentityMovedError` then `retiredOwners`) and
  drop the "verified" mark: users must compare the safety code again. A second, different move of the same old identity
  is reported (`IdentityMovedError` with `conflict: true`), but nothing decides automatically which one is genuine.
  Keeping the master on a primary device is optional for this reason, and inviting no longer needs it (invitations
  are created and signed by devices, R-03).
- **`move` permanence is an app rule (R-11, left):** the library cannot know that an index of the new identity *should*
  carry `move` (it does not know the old identity), so it cannot refuse one that drops it. The app keeps `move` in every
  index of the new identity; a friend who was offline and sees an index without it gets `OWNER_MISMATCH`.
- No BIP39 passphrase and no key stretching on the phrase: 128 bits of entropy is the security level.
- Device revocation relies on readers seeing a newer index at the certified address: there is no expiry on
  certificates (an `issued` date on device certificates would not help a reader without state, V3-01).
- **Changing storage needs the master key** (V3-01): the read address is in the master-signed sharing certificate. Owners
  without a primary device type the 12 words to connect or move a storage. That is the price of a link that cannot
  choose its reader's address.
- **Recovery vault (V3-10):** the vault data key travels in `TLSK` v2 and the key export v3, and encrypts the `TLVD`
  records (contacts with anchors and certificates, open invitations with their answers, retired owners, free-form app
  data). Remaining:
  - every device holds the vault data key, so a stolen device can rewrite the records until the declaration (drop
    anchors, add answers, mark contacts verified, or make the whole vault unreadable). Records are authenticated by that
    key only, except invitation records, which are also signed by their creating device (V4-01). After the
    declaration a new vault data key is used; the app should compare the restored records with its local copy, show
    changes made since the date of the theft (spec "Loss and theft" step 5), and start from its last good copy if the
    storage copy does not open;
  - older vault files encrypted with the previous vault data key stay readable by the thief from the storage's version
    history: limit the history and delete old files;
  - `mergeVaults` is a simple union (later anchor wins, "verified" if either says so); un-marking "verified" on one
    device can be undone by a concurrent merge. Merging the free-form `app` part is the app's job. Unknown fields of a
    newer minor, its `minor` and `crit` are kept (V4-07), from the side the merge picks for a record present on both;
  - answers to an invitation are capped at 16. Above the cap, `mergeVaults` keeps the answers that open and verify for
    the invitation first, one per responder, the accepted one first (R5-03), so junk cannot evict a real second
    responder. A thief holding the seed can still sign valid answers from identities of its own; those take slots,
    but they are themselves other responders, so `multiple` / `late` still fire. `collectInvitationAnswers` counts
    answers that do not verify in `rejected`;
  - **fields written by a stolen device survive the declaration** (N-2 of the fifth review): merges keep the highest
    `minor` (the thief can set 2^53 − 1, which turns off "unknown field without a higher minor is an error" for this
    vault) and unknown fields, and `cancelAllInvitations` keeps everything but `invitations`. Harmless today, since no
    such field has a meaning; the spec requires that a security-relevant vault field added later be device-signed (as
    invitation records are) or come with a new major. `CancelledInvitation.accepted` and the `accepted`, `verified` and
    `retired_owners` values are likewise chosen by whoever last held the vault data key: at a declaration the app should
    start from its last copy from before the theft and show the differences (spec step 5);
  - the vault records are a canonical JSON document, not a CRDT: concurrent writers rely on `If-Match` and merge.
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
  new version is a new file, but the storage still sees one file appear as another disappears, and diffing two
  consecutive public indexes shows which entry replaced which when one pack changes per publication (N-1). Batching
  replacements makes diffs less precise.
- The payload type byte (V3-16) separates content, media and group-key payloads inside the AEAD. The content payload
  format itself (Yjs, GeoJSON) is specified by the app, not here.
- No format-level size bound on pack ciphertext (N-2): the HTTP layer must cap downloads (the index lists each hash, not
  each size).
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
- **The public index reveals metadata** (N-1): which device published (`device_cert`), how many devices were revoked (a
  theft history), the rotation count, `seq` (an activity count), the number of packs and the read address.
- **`lastSeen` is not enforced by `openPack` (V3-11, partly left):** an index must now be verified with `expectedOwner`
  (or made by `signIndex`) to open packs, so content is never attributed by URL. Whether it was also checked against
  the contact's anchor is recorded but not required: only the app knows whether this is a first contact. The app must
  pass `lastSeen` for every known contact.
- **Extension fields (V3-03, V4-03):** an older device that rewrites the index writes its own minor and drops fields it
  does not know (spec "Format versions": the index is derived from the owner's state, never copied; copying an unknown
  field blindly could keep listing invitations past expiry or across a declaration). `invitations` is part of index
  4.0, so no 4.x writer drops it, and `signIndex` writes it in every index (`vaultDataKey` is required), so an index
  never tells whether an invitation is open. A security-relevant extension that must neither be dropped nor copied needs a new
  major version, published under its own file name during the transition. `crit` only protects readers, not round
  trips through older writers.
- **`readFrom` is a caller declaration (N-3):** `verifyIndex(…, { location })` records the address the caller says it
  read from; the library cannot know where bytes came from, so "read only at the certified address, and re-fetch after
  `MOVED`" stays an app rule. Token v2 narrows the damage of getting it wrong: a link with a rewritten address is
  `NOT_LISTED` in the owner's genuine index (V4-04).
- **Two master holders can fork a rotation (N-3):** two devices that declare a loss concurrently (both with the 12
  words) issue two different certificates for rotation r + 1; readers report a fork until a certificate for r + 2
  exists. Recovery: issue r + 2.
- Object input (V3-12): `verifyIndex` takes text or bytes only; certificate, identity-move and payload verifiers still
  accept objects, for in-process use (they never travel as standalone JSON from an untrusted source).
- The plaintext public-list file is covered by its hash in the index (`verifyPublicFile`), but only for apps that check
  it; uMap and other external readers see the file as is.

## Invitations
- The link is a **bearer secret** for its validity: anyone who sees it (chat history, screenshot, clipboard, link
  previewers that read fragments) can read content wrapped to the invitation key and can answer.
  Mitigations: one answer per invitation (several answers → none accepted automatically), safety code, and
  `retireInvitationKey` re-encryption on acceptance or expiry. These require the owner app to actually run the sweep at
  expiry (track open invitations in the recovery vault).
- Expiry inside the link is enforced by honest clients using their own clock (it is bound in the listing token, so it
  cannot be extended, and the owner's next index after expiry no longer lists it).
- The invitation response is sealed to the invitation key, so any link holder can also read it (public keys, the
  responder's read address, a signature).
- **Late answers** (R-04, V3-02): an interceptor who answers first is accepted if no other answer has arrived yet. The
  owner keeps the invitation record until expiry + 7 days (`INVITATION_ANSWER_GRACE_MS`, in the vault) and collects
  with `acceptedOwner`, so a later answer from someone else shows up in `late` and the app warns, also when it is
  opened after expiry. An answer is opened during the grace period only if its signed `created` precedes expiry; that
  date is claimed by the responder, so any link holder can backdate an answer made after expiry within the grace period.
  When another answer exists it triggers the warning; when it is the **only** one (the real friend never answered) it
  would be `accepted`, so every answer opened at or after expiry carries `openedAfterExpiry: true` (V4-06) and the app
  must ask the user (and suggest the safety code) instead of granting. The effective window for a link holder is
  therefore 14 days, but the second week is never silent. After the grace period nothing is opened. The grant made
  in the meantime stands until the user reacts; granting a reduced scope until the code is compared is a product
  decision left to the app.
- **Delivery of the late answer is assumed (N-5):** an attacker with access to the owner's messaging can drop the real
  friend's return link, so the warning never fires. The safety code is the only defence against that.
- **Keys inside invitation-wrapped content (N-4):** `retireInvitationKey` re-encrypts packs, but a key carried *inside*
  their payload (a per-photo key, a link-only list key) keeps working for the link holder. The app must re-key every key
  reachable from content opened to the invitation when retiring it (spec "Invitation link and return link").
- The invitation key must be a direct recipient, never a group member; this is enforced only when retiring
  (`retireInvitationKey` throws on a group-key pack), not when sealing.
- **Short link, unsigned** (version 5): 146 characters with the URL prefix and a 40-character address (200 with an
  80-character one; QR version 7 to 10 at level L or M). It carries the owner's master key, the read address, a
  16-byte seed (128-bit secret: the invitation key pair and id derive from it), the rotation and the expiry. Its
  authenticity comes entirely from the owner's index: a parsed link is **unauthenticated** until `checkInvitationIndex`
  confirms it (`createInvitationResponse` refuses an unconfirmed one; the app must not show "Marie invites you" or
  any content before). Properties kept from format 4: the read address and revocations are master-certified (the link
  cannot point elsewhere: V3-01), a revoked device cannot vouch for a link (R-03, R-12 via the rotation floor), expiry
  is checked against the reader's clock (V3-04: at most 7 days + 5 minutes ahead), and the link is still a bearer
  secret (F-02 mitigations unchanged). Changed: tampering with the expiry, rotation, seed or address is no longer a
  signature error but a token mismatch (`NOT_LISTED`; token v2 binds the address, V4-04).
- **The link works only once listed.** The owner app must publish the index that lists a new invitation before sending
  it, and keep it listed until expiry (also after acceptance, so a second answer can still arrive: R-04). Any new
  rotation of the sharing certificate (declaration of loss, storage move, new sharing key) ends the listing of every
  invitation created before it (R5-01); the app tells the user which links to resend.
- **The record signature has no version byte** (N-4 of the fifth review): the `invitation-record` signed bytes are
  unambiguous today (fixed-length fields, then the length-prefixed address), but any future change must use a new
  signature domain. `created` and `expires` are signed as seconds, so two ISO spellings of the same instant verify
  alike (harmless). An owner
  without storage cannot invite (no index to vouch for the link); the app offers the storage wizard first, as the spec
  already required for sharing.
- **The listing reveals metadata** (V4-05): tokens are unlinkable hashes (only a link holder can recompute one),
  padded to a power of two (at least 4, also when nothing is open). The dummies are derived from the vault data key,
  so every device writes the same ones (a device change no longer separates real from dummy entries), and each dummy
  slot changes value at its own period of 1 to 7 days, so a token seen for more than 7 days is not necessarily a dummy
  and a disappearing token is not necessarily a real one. What remains observable to anyone who polls the index (the
  host, a former friend, anyone with the address):
  - **when** the index is republished, and so the time of each invitation (inviting needs a publication; N-2), and that
    the owner must be online with a working storage to invite;
  - the **bucket** (4, 8, 16, …) and when it changes;
  - real tokens take slots first: when an invitation ends inside a dummy's epoch, the dummy that comes back is one
    already seen, which marks it as padding (and so tells that one invitation ended);
  - a new set of dummies at a declaration of loss (new vault data key), which the rotation shows anyway.
  The Ed25519 signing seed is no longer used as a padding key (N-1). A separate signed file would not help: it would
  need the index's rollback protection, so the index would reference it.
- The return link is unchanged (about 530 characters plus the responder's address and 43 per revoked device). It is
  not shortened: it travels through messaging, and invitees without storage, the common case, need the full
  device-signed form.
- `checkLocation` rejects local-network IP literals (IPv4, IPv6, and IPv4 embedded in IPv6: mapped, NAT64, 6to4,
  V3-09) and names (`localhost`, `*.local`, `*.internal`), not public names that resolve to private addresses (DNS
  rebinding): the app's HTTP layer must also refuse private destinations.
- A link `created` more than 5 minutes after the reader's clock is refused (V3-04). `createInvitation` does not compare
  its `now` option with the real time (the option exists for tests; the app passes nothing). The u32 seconds fields
  overflow in 2106.
- Size bounds (N-2, N-5): link fragments of at most 750 characters (the longest read address exactly) and return links
  of at most 9,600 bytes are checked before decoding; an index is at most 16 MiB.
- `retireInvitationKey` requires the bytes of every file listed in the index (V3-08): with many photos it decrypts
  each media header's wraps once (one X25519 per wrap). The app may fetch files in pages but must pass them all.
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
- The standalone format specification is `docs/format/` (T-201), with 472 known-answer vectors (positive and negative)
  for every structure in `docs/format/vectors/`, generated from seeded randomness and checked by
  `test/vectors.test.ts` and by an independent Python reader (`docs/format/reference-reader/`); every parser is fuzzed
  (`test/fuzz.test.ts`). Format notes found while writing them (no change, the format is frozen): X25519 encodings
  `u ≥ p + 2` with bit 255 clear are accepted although non-canonical (F-1); lone-surrogate escapes are accepted by
  canonical JSON (F-2); the index size bound counts UTF-16 code units for text input (F-3).
