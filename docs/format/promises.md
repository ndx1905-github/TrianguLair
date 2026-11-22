# Spec promises and what enforces them

Each security-relevant promise of `docs/SPEC.md`, the function and check of `packages/crypto` that enforces it (with
the error it raises), the **app rules** it relies on (which the format cannot enforce), and the vectors that exercise
it. "App" means the application layer that is not written yet (T-204 onwards); every app rule listed here is a
requirement on it. Section names are those of SPEC.md.

## Architecture: principle, storage, encrypted sharing, organization on the storage

| # | Promise | Enforced by | Relies on (app) | Vectors |
|---|---|---|---|---|
| A1 | "Everything is encrypted before leaving the phone" | `sealPack` (XChaCha20-Poly1305 per pack, pack.md), `sealVault` (vault.md), `sealSharingKey` (TLSK), `encryptForTransfer` | publishing only those outputs; the public list is plaintext by the user's choice | `pack/pack-kat`, `vault/vault-ok` |
| A2 | "One person, one key": a master key certifies a replaceable sharing key | `verifySharingCert` (master signature, SIGNATURE), `verifyDeviceCert`; `identityFromPhrase` | keeping the master only on the primary device or in the phrase | `sharing-cert/*`, `identity/*` |
| A3 | "Friends read at the source … decrypt only what is opened to them" | one wrap per recipient key; `openPack` → NO_MATCHING_KEY | — | `pack/pack-no-key` |
| A4 | "Friends read only at that certified address, never at an address that a link or a device chooses on its own" | `sharing_cert.location` under the master signature (`verifyIndex` step 8, SIGNATURE if changed); `verifyIndex(…, {location})` → MOVED; `checkInvitationIndex` requires the read address = certified (FORMAT) | fetching only at the certified address, re-fetching after MOVED and passing the address actually fetched (THREATS N-3) | `signed-index/index-moved-option`, `index-cert-tampered-location`, `invitation-link/accept-rewritten-address*` |
| A5 | "Connecting a storage for the first time and changing it need the master key" | `location` is part of the master-signed certificate; a new address is a new rotation | storage wizard asks for the 12 words or uses the primary device | `signed-index/index-storage-move-*` |
| A6 | "Wraps do not carry the recipient's name" | header has no recipient field (pack.md §1); sealed boxes are anonymous; dummy wraps and shuffling (`makeWraps`) | — | `pack/pack-kat` (wraps [Bob, dummy, Carol, dummy]) |
| A7 | "Everything is signed with my key: my friends' apps verify that the content comes from me and has not been modified by the storage" | `verifyIndex` (device signature, device and sharing certs by the master); `openPack` checks the file hash against an owner-bound verified index before any decryption (NOT_INDEXED); the AEAD binds the owner key (DECRYPT, R-05) | opening packs only through `openPack` with an index verified with `expectedOwner` | `pack/pack-not-listed`, `pack-index-not-owner-bound`, `pack-relisted`, `signed-index/index-tampered-seq` |
| A8 | "Removing someone: … the affected pack keys are renewed" | `reencryptPack` (new batch key and nonce) | erasing the friend's cache is the friend's app; copies already made stay | — |
| A9 | "Public list: published in plaintext … verified like the packs" | `index.public` hash; `verifyPublicFile` (NOT_INDEXED) | checking the file before showing it; uMap does not check | `signed-index/index-ok` (`public`), `index-public-traversal` |
| A10 | Packs content-addressed and never modified; logical id inside the encryption | `packEntry` file names checked by `verifyIndex` step 13; id in the frame (pack.md §3) | deleting old files | `signed-index/index-file-mismatch`, `pack/pack-kat` (`id_hex`) |
| A11 | "The storage's ETag is only a cache hint: integrity always comes from the content hash" | `findIndexed` (BLAKE2b-256 of the bytes) | — | `pack/pack-not-listed` |
| A12 | The app adds padding to limit what file sizes reveal | Padmé (pack.md §3, vault.md §1); wrap count padded to a power of two | batching replacements (diffs of indexes, THREATS N-1) | `pack/padme-*`, `vault/vault-bad-padding-length` |
| A13 | Index layout `index.json`, `index.v<N>.json` during a transition | — (file names) | storage layer (T-202) | — |

## Invitation link and return link

| # | Promise | Enforced by | Relies on (app) | Vectors |
|---|---|---|---|---|
| I1 | The link is short (about 150 characters) and carries only key, address, secret, rotation, expiry | link v5 layout (invitation-link.md §1); 750-character bound | the `https://example.org/i#` prefix | `invitation-link/link-ok` |
| I2 | "My device publishes an index that lists the invitation … this listing … is what proves the link comes from me" | `checkInvitationIndex` step 7 (NOT_LISTED); only a non-revoked device's index verifies (`verifyIndex` step 11, REVOKED) | publishing the listing index **before** sending the link | `invitation-link/accept-ok`, `accept-not-listed`, `accept-revoked-device-index` |
| I3 | Every field of the link is covered by the listed hash: "a forged link … is therefore refused, not redirected" | token v2 (invitation-link.md §3) | — | `accept-tampered-expiry`, `accept-tampered-seed`, `accept-rewritten-address-followed` |
| I4 | "The device that creates an invitation also signs its record … my other devices list only invitations really created by one of my devices that is not declared lost; an invitation lasts at most 7 days" | `checkOwnerInvitation` (SIGNATURE, FORMAT); `listable` → `"invalid"`, `"revoked"` | passing every vault record to `signIndex` | `invitation-record/status-*`, `vault/vault-invitation-*` |
| I5 | "Inviting a friend or answering an invitation never requires the 12 words" | `createInvitation`, `createInvitationResponse` take a device signer | — | — |
| I6 | "Inviting requires a storage" | `createInvitation` refuses a certificate without `location` (FORMAT) | storage wizard first | — |
| I7 | "Their app … reads my index only at the address certified by my master key, checks that it is mine and that it lists the invitation" | `parseInvitationLink`; `verifyIndex` with `expectedOwner` and `location` (OWNER_MISMATCH, MOVED); `checkInvitationIndex` | reading only at `received.location`; not showing anything before acceptance | `accept-other-owner`, `accept-rewritten-address` |
| I8 | "One answer per invitation": several answers → none accepted automatically | `collectInvitationAnswers` (`multiple`, `accepted = null`) | showing all answers with a warning; keeping the record (vault) until expiry + 7 days, also after acceptance | `return-link/collect-two` |
| I9 | A later answer from someone else warns that the first may be an impostor | `collectInvitationAnswers(…, {acceptedOwner})` → `late` | calling it again for every new answer until the end of the grace period | `return-link/collect-late` |
| I10 | Late answers: accepted for 7 days after expiry if created before; "an answer opened after expiry is flagged and never accepted automatically" | `openInvitationResponse`: window check (FORMAT), grace period (EXPIRED), `openedAfterExpiry` | asking the user for any answer with `openedAfterExpiry`, even the only one | `return-link/response-after-expiry`, `response-after-grace`, `response-created-*` |
| I11 | "Re-encryption on acceptance or expiry … not merely re-wrapped" | `retireInvitationKey` (new batch keys; refuses an incomplete file list, FORMAT) | running the sweep at acceptance and at expiry (from the vault records); re-keying keys carried inside content (THREATS N-4) | (unit tests: `test/invitation.test.ts`, `review-3.test.ts`) |
| I12 | Safety code: 12 groups of 5 digits, or a QR code | `safetyCode`, `safetyQrPayload`, `matchSafetyQr` | the "unverified" badge; removing the mark when an identity changes | `safety-code/*` |
| I13 | The list of open invitations is padded with dummies derived from the vault data key, changing every 1 to 7 days; present even when nothing is open | `padListing` (signed-index.md §6); `signIndex` always writes the field (`vaultDataKey` required) | — (readers do not check padding) | `signed-index/padding-*` |
| I14 | "The listing is kept until expiry, also after acceptance … and dropped at expiry" | `listable` → `"expired"` at expiry | passing the record to every `signIndex` until expiry | `invitation-record/status-listed`, `status-expired` |
| I15 | A bad record "is skipped and reported, and never prevents publishing the index"; a genuine one not listable yet is kept | `listable` never throws; `onSkip` reasons; `"not-yet"` (R5-02) | deleting only `"invalid"`, `"revoked"`, `"expired"` records | `invitation-record/status-not-yet-*` |
| I16 | "Any key change cancels open invitations … whatever copy of the vault a device merges later" | `listable` → `"superseded"` (rotation lower than the certificate's); reader side `checkInvitationIndex` step 6 (NOT_LISTED) | telling the user which links to resend; wrapping only to `"listed"` invitations (`invitationStatus`) | `invitation-record/status-superseded`, `invitation-link/accept-later-rotation*` |
| I17 | Freshness: the link's rotation is a floor; an older index is refused; a later one means cancelled | `checkInvitationIndex` steps 5–6 (ROLLBACK, NOT_LISTED) | — | `accept-link-rotation-ahead`, `accept-later-rotation` |
| I18 | "A device declared lost can therefore no longer pass as me to a new contact" | the three rules above + `verifyIndex` REVOKED / ROLLBACK | revoking storage credentials of every storage that held an index (declaration step 4); otherwise the TOFU residual remains | `accept-stolen-device-after-declaration`, `accept-stolen-device-tofu` (**residual**) |
| I19 | For a return link, "my app reads the responder's index at their certified address, refuses an index older than the certificate in the answer, and refuses the answer if its device is revoked there" | `checkInvitationIndex` answer path (FORMAT without address, ROLLBACK, REVOKED); `openInvitationResponse` (REVOKED by the carried certificate) | reading at `answer.location` only; showing "cannot be checked" for an answer without address | `return-link/answer-index-*`, `response-revoked-device` |
| I20 | "If the person is already a contact, a link never resets what the app already knows" | `lastSeen` in `verifyIndex` and `checkInvitationIndex` (ROLLBACK) | passing `lastSeen` for every known contact | `invitation-link/accept-rollback-lastseen` |
| I21 | "Direct recipient: … never through a recipient group" | `retireInvitationKey` refuses a group-key pack opened by an invitation key (FORMAT) | never adding an invitation key to a group (not checked when sealing) | (unit tests) |
| I22 | Face-to-face QR exchange replaces the two links and marks the contact verified | **not specified** (R-13) | to be specified before any app relies on it | — |

## Asymmetric relationships, format versions

| # | Promise | Enforced by | Relies on (app) | Vectors |
|---|---|---|---|---|
| V1 | Two version levels; a reader refuses a major it does not know | `checkStructure` step 1, `checkByteVersion` (UNSUPPORTED_VERSION) | "Update the app to see Léa's places" | `*-version-*` in every file |
| V2 | "Ignore the unknown" only with a higher minor; the signature or encryption covers the whole document | `checkStructure` step 6; signatures over `canon(doc \ {signature})`; pack AD over the header | — | `sharing-cert/cert-minor-extension`, `cert-unknown-field`, `signed-index/index-minor-extension`, `pack/pack-minor-extension` |
| V3 | Content documents keep unknown fields; documents derived from the owner's state are rewritten from it | `mergeVaults` keeps them (V4-07); `signIndex` writes from state | an older device never copying index members | `vault/merge-newer-minor` |
| V4 | "Except what affects security": `crit` | `checkStructure` step 4 (UNSUPPORTED_VERSION, `critical`) | — | `*-unknown-crit` |
| V5 | "Everyone announces what they can read" | `index.reads` validated (signed-index.md §4 step 12) | choosing each pack's version from the recipients' `reads` | `signed-index/index-reads-*` |
| V6 | "Identified algorithms in each pack" | header `alg`, `wrapAlg` checked (FORMAT for unknown values) | — | `pack/pack-header-alg`, `pack-header-wrapalg` |
| V7 | "Public specification of the format, versioned, with test vectors" | this directory | cross-reading tests between app versions (T-204+) | `vectors/` |

## First launch: recovery kit, adding a device, loss and theft

| # | Promise | Enforced by | Relies on (app) | Vectors |
|---|---|---|---|---|
| K1 | The phrase "recreates the key" | `identityFromPhrase` (deterministic; INVALID_PHRASE) | — | `identity/phrase-*` |
| K2 | Vault data encrypted with a random vault data key, sent to each device with the sharing key, renewed at a declaration | `TLSK` payload `vault_key`; `generateVaultDataKey`; `TLVD` AEAD bound to the owner | renewing the key and re-sealing at every declaration | `sharing-key/tlsk-device`, `vault/vault-wrong-key`, `vault-other-owner` |
| K3 | The vault keeps the current sharing key and vault data key under a key derived from the phrase, which no device keeps | `TLSK` mode 2 with the phrase-derived vault key | not persisting the identity on ordinary devices | `sharing-key/tlsk-vault`, `tlsk-vault-other-identity` |
| K4 | Vault records have a fixed format, padded | `openVault` validation (vault.md §3), Padmé | — | `vault/*` |
| K5 | Last index seen per contact, so a restore does not fall back to trust on first use | `contactRecord` / anchors (`verifyIndexAnchor`); `checkNoRollback` accepts an anchor | restoring `lastSeen` from the vault for every contact | `signed-index/index-lastseen-anchor`, `index-fork-anchor` |
| K6 | Merge: newest anchor, union of answers and retired identities; > 16 answers keeps verifiable ones first; older versions keep newer fields | `mergeVaults` (vault.md §4) | merging `app` data | `vault/merge`, `merge-newer-minor` |
| K7 | "A vault field that a future version gives a security meaning must … be signed by the device that wrote it … or it needs a new major version" | — (rule for future versions) | — | `vault/vault-huge-minor` (what a thief can write today) |
| D1 | "Each device has its own device key … never copied"; "the master key is not transferred" | key export and TLSK carry no master key; device certificates | — | `key-export/ke-ok` |
| D2 | QR code way of adding a device | **not specified** | to be specified | — |
| D3 | "Link + code": 15 minutes, once, slow derivation | `decryptTransfer` (EXPIRED, Argon2id bounds, AD over the header) | deleting the blob after use; sending the code over another channel | `transfer/*` |
| D4 | Changing storage needs the master key and cancels open invitations | new rotation; `"superseded"` | listing invitees to re-invite | `invitation-record/status-superseded` |
| L1 | "Sharing key: generated at random … certified … its certificate also carries the read address … and the list of devices declared lost" | `issueSharingCert` / `verifySharingCert` | — | `sharing-cert/cert-rotation-1` |
| L2 | A stolen device "can neither compute the new sharing key nor certify a key of its own" | sharing key random; certificates need the master; TLSK mode 2 needs the phrase | the declaration issuing a new key | `sharing-key/tlsk-rollback` (an old key pushed back is refused with `lastSeen`) |
| L3 | "My friends refuse what it publishes" | `verifyIndex` step 11 (REVOKED) and ordering by rotation first (ROLLBACK for its older-rotation indexes) | friends syncing to see the revocation | `signed-index/index-revoked-signer`, `index-stolen-device-after-revocation`, `index-higher-rotation-lower-seq` |
| L4 | Step 1: every open invitation cancelled; the cancellation follows from the new certificate itself | `cancelAllInvitations`; `listable` → `"superseded"` | sealing the vault with the new key; starting from the last good copy | `invitation-record/status-superseded` |
| L5 | Step 2: re-encrypt own content without the cancelled keys | `retireInvitationKey` with several key pairs; `reencryptPack` | running it on every file | (unit tests) |
| L6 | Step 3: friends accept the key change automatically thanks to the master signature | `checkNoRollback` accepts a higher rotation that keeps every revocation | — | `signed-index/index-higher-rotation-lower-seq`; refused: `index-unrevoke`, `index-cert-fork` |
| L7 | Steps 4 and 5 (storage credentials of every storage that held a redirect; diff since the theft) | — | app (V4-08) | — |
| L8 | Remote wipe: the stolen phone reads the revocation and erases itself | data only: its id in a verified index's `revoked_devices` | the app checking at every sync | — |
| L9 | Primary device theft: an identity move, "a later certificate signed by the old master key is refused" | `verifyIdentityMove`; `verifyIndex` IDENTITY_MOVED (with `conflict`); `retiredOwners` → REVOKED everywhere | keeping `move` in every index of the new identity (R-11); persisting retired owners (vault) | `identity-move/*`, `signed-index/index-move-*`, `index-retired-owner`, `sharing-cert/cert-retired-owner` |

## Data model (signed index)

| # | Promise | Enforced by | Relies on (app) | Vectors |
|---|---|---|---|---|
| X1 | Order by rotation then `seq`; a higher rotation supersedes "whatever their seq, provided it revokes at least the same devices" | `checkNoRollback` (signed-index.md §5), `checkSharingCertNotOlder` | persisting `lastSeen` per owner | `index-higher-rotation-lower-seq`, `index-unrevoke`, `index-lower-rotation` |
| X2 | Within a rotation: lower `seq` refused, same `seq` with other content reported as a fork, a jump over 2^20 refused | `checkNoRollback` steps 5–7 | reporting forks; accepting the next higher seq | `index-rollback`, `index-fork`, `index-seq-step-*` |
| X3 | `updated` informational; more than 24 h in the future refused | `verifyIndex` step 6 (FORMAT) | retrying later | `index-updated-*` |
| X4 | Signed by a device whose certificate is signed by the master; a revoked device can no longer publish | `verifyIndex` steps 10, 11, 17 | — | `index-foreign-device-cert`, `index-revoked-signer`, `index-signed-by-master` |
| X5 | `revoked_devices` covered by the master signature and permanent | rebuilt full certificate (signed-index.md §2); no un-revocation | — | `index-revoked-list-tampered`, `index-unrevoke` |
| X6 | `location` certified; a redirect is followed only to the certified address; rotation is u32; `seq` up to 2^53 | `verifyIndex` steps 8–9, 21; `checkStructure`; `u32` | following MOVED | `index-storage-move-redirect`, `sharing-cert/cert-rotation-2-32` |
| X7 | `hash` is BLAKE2b-256, algorithm prefixed | hash pattern and file name checks | — | `index-hash-short` |
| X8 | `invitations` written in every index, sorted and padded; a reader accepts an index without it | `signIndex`; `verifyIndex` step 15 | — | `index-no-invitations`, `index-invitations-*` |
| X9 | "Each pack is bound to its owner … nobody can re-publish my content under their name" | pack AD (pack.md §2) | — | `pack/pack-relisted`, `pack-other-owner-ad`, `group-key/group-key-other-owner-ad` |

## Error cases, privacy and threat model

| # | Promise | Enforced by | Relies on (app) | Vectors |
|---|---|---|---|---|
| E1 | Tampered content (invalid signature) rejected, last valid version kept | SIGNATURE / DECRYPT / NOT_INDEXED | keeping the last valid version | `*-tampered*` |
| E2 | Unsupported format version: content ignored | UNSUPPORTED_VERSION | message | `*-version-*` |
| E3 | Invalid invitation link (expired, cancelled, forged) | EXPIRED, NOT_LISTED, FORMAT | "This link no longer works" | `invitation-link/*` |
| E4 | A friend changes storage: followed only to the certified address | MOVED | following it once | `index-storage-move-*` |
| E5 | Interrupted write: an index always points to complete packs | — | packs first, index last | — |
| P1 | "All content read from a friend is verified (signature) before display" | `openPack` / `openGroupKey` / `verifyPublicFile` require an owner-bound verified index | never decrypting outside these functions; bundling a single copy of the package (the verified-index registry is per copy) | `pack/pack-index-not-owner-bound` |
| P2 | Key verification by QR or safety code | `safetyCode`, `matchSafetyQr` | the comparison itself | `safety-code/*` |
| T1 | Storage host: "read, modify or delete files" → encryption, signatures, anonymous wraps, padding | all of the above | restoring from local copies | — |
| T2 | Impersonator: one answer per invitation, late-answer warning, flagged answers after expiry, safety code | I8–I12 | the user verifying | — |
| T3 | Phone thief: random sharing key, master absent, certified address, invitations only while listed, signed records, all cancelled at the declaration, answers checked against the revocation | L1–L6, I2–I4, I16–I19 | app lock, credentials change; residuals in THREATS.md (stale index at an old address or an expired domain: only the safety code helps) | `accept-stolen-device-tofu` |
| T4 | Access to my messaging: 7-day invitation key, single answer, re-encryption, transfer code on another channel and 15 minutes | I8–I11, D3 | the user sending the code separately | — |

App rules collected (none is checked by the format): run the invitation expiry sweep; read only at the certified
address and re-fetch after MOVED; keep `move` in every index after an identity change; refuse private destinations in
the HTTP layer (DNS rebinding); persist `lastSeen` (also in the vault); bundle a single copy of `@triangulair/crypto`;
publish the listing index before sending an invitation link; never grant an answer flagged `openedAfterExpiry` without
asking; wrap content only to `"listed"` invitations and never to an invitation key through a group; delete only
`"invalid"`, `"revoked"` and `"expired"` records; revoke the credentials of every storage that held an index at a
declaration; cap download sizes (pack ciphertexts have no format-level bound).
