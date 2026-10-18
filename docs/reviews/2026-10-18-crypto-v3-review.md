# Third review of the crypto package: format v3 before freezing (PR #52)

- **Date:** 2026-10-18
- **Reviewer:** independent agent. I did not write T-001, T-002, the first or the second round of fixes.
- **Scope:** branch `t-001-crypto-fixes-2` at `7acc6f6` (PR #52): all of `packages/crypto/src`, `README.md`, `THREATS.md`
  and `test/`, the two previous reviews, and the `docs/SPEC.md` sections "Invitation link and return link", "Asymmetric
  relationships", "Encrypted sharing", "Organization on the storage", "Format versions", "Recovery kit", "Adding a
  device", "Loss and theft", "Data model" and "Threat model". **The spec is the source of truth.**
- **Method:** line-by-line reading, attacks written against the library, and a pass over every v3 structure as if
  freezing it (T-201). Findings marked *(test)* are reproduced in `packages/crypto/test/review-3.test.ts` as
  `it.fails(...)` tests that state the **desired** behaviour. I checked each one with `it` to make sure it fails at the
  intended assertion and not earlier. `src/` was not modified.
- **Build:** `npm install --workspaces=false` reports 0 vulnerabilities. `npm test` gives 13 files, with 155 tests
  passing and 11 expected failures (the new reproductions). `npm run typecheck` is clean.

## Verdict: **merge after fixes. Not ready to freeze.**

This round fixes what it set out to fix:

- Indexes are now ordered by `(rotation, seq)`. A stolen device can no longer block its own revocation, and I could not
  break the new ordering in `checkNoRollback`.
- Packs are bound to their owner through the AEAD associated data.
- The public file is covered by a hash.
- The BOM, `lastSeen` and revoked-device gaps are closed.

The rewrite also introduced one **high** issue, and it sits in the theft scenario that the v3 design exists for.

- **V3-01.** Invitations and return links are now signed by device keys. Device certificates never expire, and the link
  itself chooses where the invitee reads the "freshness" index. So a revoked phone can, at any time after "Declare a
  device lost", pass as the owner to any new contact, in both directions.
  - It can serve them content in the owner's name.
  - It receives their return links.
  - Through a forged return link, it gets inviters to wrap their places to the old sharing key, which the thief holds.
  - The safety code does not help, because the master key is genuine.
  - THREATS.md claims that `checkInvitationIndex` covers this case. It does not.

Three medium findings concern parts of the format and protocol that are not settled:

- **V3-02.** Answers that are opened after expiry are discarded, together with the late-answer warning.
- **V3-03.** The code's strict versioning contradicts the spec's "minor versions / ignore the unknown".
- **V3-10.** The spec's new vault data key has no format.

All of these must be settled before T-201 freezes v3. None of them takes a redesign.

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | none |
| High | 1 | V3-01 |
| Medium | 3 | V3-02, V3-03, V3-10 |
| Low | 10 | V3-04 to V3-09, V3-11 to V3-13, V3-16 |
| Note | 6 | N-1 to N-6 |

---

## High

### V3-01: A revoked device keeps the owner's identity toward new contacts, because the link chooses its own freshness anchor *(test)*

**Where:**

- `src/invitation.ts:194-229`: `createInvitation` takes any device signer and any valid sharing cert.
- `src/invitation.ts:240-281`: `parseInvitationLink` has no way to learn about a revocation.
- `src/invitation.ts:391-398`: `checkInvitationIndex` checks the index read at `source.location`, and that location
  comes from the link or response being checked.
- `src/certs.ts:62-85`: device certs have no expiry.
- Spec, "Invitation link and return link", bullet **Freshness** (SPEC.md:80); "Loss and theft" (SPEC.md:549: "can
  neither compute the new sharing key nor certify a key of its own"). THREATS.md:18-20.

**Problem.** For a new contact, the only freshness anchors are the link's `min_rotation` and the index found at the
link's `location`. A thief holding a revoked phone controls both:

1. Weeks after "Declare a device lost", the thief calls `createInvitation(phoneSigner, rotation0Cert, { location:
   "https://thief.example/…" })`. The rotation-0 cert is public in every old index, and the phone's device cert is
   still master-signed and never expires.
2. The new friend parses the link and reads the index at the thief's host. That index is signed by the phone at rotation
   0. `verifyIndex(…, { expectedOwner })` and `checkInvitationIndex` both pass. The real storage holds rotation 1,
   which revokes the phone, but the invitee is never sent there.
3. The friend now follows "Marie" at the thief's host. The thief publishes content in Marie's name, and the friend's
   return link, sealed to the invitation key the thief made, never reaches Marie.
4. **Mirror (worse):** with Bob's revoked phone, the thief answers an invitation from Alice. He uses Bob's rotation-0
   cert and his own `location`. Alice's `checkInvitationIndex(answer, index)` passes. Alice's app then wraps "everything
   I share with friends" to Bob's **old** sharing key, which the thief extracted. Alice's places leak, although Bob did
   everything the spec asks.
5. The safety code matches in both directions, because it is computed over the genuine master keys.

The theft scenario is where this matters most. The stolen phone usually still has the owner's messaging apps, which
are the channel invitations travel through. Before R-03, links were master-signed and a revoked device could not mint
any. The T-002 fix moved invitation signing to device keys without giving readers a way to see the revocation.
THREATS.md:19-20 states that "`checkInvitationIndex` refuses a link whose device is revoked in the index it leads
to". It does, but the link decides which index it leads to.

**Fix (format change, before T-201):**

- **Bind the read address to a master signature.** Add `location` to the sharing certificate. Rotations already
  require the master, and moving the read address is rare enough to deserve one too. Carry the cert's location in the
  link and the response instead of a free `location`, and have the invitee and inviter read **only** from it. A link
  minted by a revoked device then points at the real storage, where the newer rotation revokes that device. The stale
  index on the old storage is then the only remaining risk, and that is the storage host's rollback, which is already
  documented as TOFU.
- Alternatively, or in addition, give device certs an `issued` date and have readers refuse links whose `created` is
  later than a revocation they can see. That alone does not help a reader with no state, so the location binding is
  the actual fix.
- In `checkInvitationIndex`, also verify `index` against `lastSeen` when the owner is already a contact. State in the
  README that a link must never reset an existing contact's anchor to TOFU.
- Correct THREATS.md:18-20 and the spec's Freshness bullet, which currently over-claim.

---

## Medium

### V3-02: Answers opened after expiry are discarded, and so is the late-answer warning *(test)*

**Where:** `src/invitation.ts:336` (`openInvitationResponse` calls `assertInvitationActive(invitation, now)` against the
**owner's current clock**), `src/invitation.ts:437-438` (`collectInvitationAnswers` rethrows `ExpiredError` for the whole
batch). Spec SPEC.md:76 and threat-model row "Impersonator" (SPEC.md:840: "until the real friend's answer arrives and
triggers the warning"). THREATS.md:90-94.

**Problem.**

- The R-04 fix keeps the invitation record only until expiry. Take a typical sequence:
  - The interceptor answers in minute 1, and the answer is accepted.
  - The real friend opens the link on day 6.
  - The owner opens the app on day 8.

  The friend's answer, which the friend signed **inside** the validity window, is never opened. The second-responder
  warning, the whole point of R-04, never fires.
- The same rule breaks the honest single-answer case. A legitimate answer created on day 6 and processed on day 8
  cannot be accepted at all. Developers will be tempted to bypass expiry to work around it.

**Fix:**

- Separate "the invitation key reads content" (which ends at retirement) from "the owner can open answers" (keep the
  key pair in the vault for, say, 30 days after expiry).
- Give `openInvitationResponse` and `collectInvitationAnswers` an `{ afterExpiry: true }` mode that returns answers
  whose signed `created` falls inside the window, flagged `late: true`. Such answers can always trigger the warning.
  Whether they can still be *accepted* is a product decision: `created` is claimed by the responder, so a link holder
  can backdate it.
- Update THREATS.md:92 and the spec's threat-model row.

### V3-03: Versioning contradicts the spec ("minor versions", "ignore the unknown") *(test)*

**Where:** `src/encoding.ts:179-184` (`checkVersion` requires the exact integer), `src/encoding.ts:193-197` (`checkKeys`
rejects unknown fields), `src/signed-index.ts:181-182`, `READS_RE` at `src/signed-index.ts:67` (accepts `"3.1"`).
Spec, "Format versions" (SPEC.md:138-141): "Two version levels in the index: minor for compatible additions (new
fields) … an app silently ignores the fields and item types it does not know … during a major version, the app writes in
both the old and new format".

**Problem.** Every signed structure rejects unknown fields, and every version is a single exact integer. Any
"compatible addition" in 3.1 therefore makes every 3.0 reader refuse the owner's **index**, the one file that carries
`reads`. The spec's negotiation mechanism, which says to read `reads` and then pick a pack version, cannot work across
an index change. The spec also requires writing old and new formats side by side during a major transition, but the
storage layout has one fixed index file and no per-version name. Once v3 is frozen, none of this can be fixed without
breaking every deployed reader.

Strict rejection is the right default for *security-relevant* fields. Ignoring unknown fields is safe here because they
sit under the signature (the canonical form covers them).

**Fix (decide before T-201):**

- Either amend the spec: "unknown fields are refused; there are no minor versions; a new index version is published
  under a new file name (`index.v4.json`) next to the old one during the transition".
- Or implement minor versions:
  - `version` stays the major version, and an optional signed `minor` integer is added.
  - Unknown top-level fields are allowed only when `minor` is greater than the reader's, kept verbatim, and still
    covered by the signature.
  - Unknown fields inside certificates and pack headers stay refused.
- Either way, define where a v4 index lives so that v3 readers keep working during the "write both formats" year.

### V3-10: The spec's vault data key has no format, and the vault records the protocol depends on are undefined

**Where:** SPEC.md:521 (new text: a random vault data key "sent to each device like the sharing key … renewed when a
device is declared lost; the vault itself also keeps the current sharing key and vault data key, encrypted with a key
derived from the recovery phrase"). `src/sharing-key.ts:53-66` (the `TLSK` payload carries only `cert`, `secret` and
`to`). THREATS.md:37-41.

**Problem.** The spec now makes the vault data key part of what travels to each device and part of the phrase-protected
vault copy. That is exactly the `TLSK` sealed-sharing-key structure, which is about to be frozen without it. Adding the
key later means a `TLSK` v2 and two distribution paths. Several security rules in this package also depend on records
that only exist in the vault, and none of those records has a format:

- `lastSeen` per contact (R-01, F-07);
- open invitations kept until expiry (R-04, V3-02);
- the retired owners of identity moves (R-11);
- the "verified" marks.

**Fix:** before T-201, either add `vault_key` to the `TLSK` payload (version 2) or define a separate sealed structure,
and specify the vault record format (an encrypted CRDT document is fine) with the fields listed above. Rotate the vault
data key in the README's "Declare a device lost" sequence.

---

## Low

### V3-04: The invitation link's `created` is not bounded by the reader's clock *(test)*

**Where:** `src/invitation.ts:263` checks only `expires - created`, and `src/invitation.ts:279` checks only `now < expires`.
THREATS.md:100-101 accepts this "because only the owner's device can sign it".

A link with `created` set ten years ahead stays "active" for ten years. With device-signed links this is no longer
harmless: a thief can pre-mint, during the theft window, links that outlive any rotation, and a buggy device clock makes
an invitation that never expires (and so is never retired). **Fix:** refuse `created > now + 5 min` in
`parseInvitationLink`, and in `createInvitation` refuse a `now` that is not close to the real time.

### V3-05: Index pack entries given as JSON strings are accepted *(test)*

**Where:** `src/signed-index.ts:210`: `parseJsonObject(p as JsonObject, …)` parses a **string** entry as JSON text.

`"packs":["{\"file\":…,\"hash\":…}"]` verifies, and the frozen index then has string entries. Other implementations
will refuse it, which is a cross-implementation differential, and app code reading `index.packs[i].file` gets
`undefined`. **Fix:** require each entry to be a plain object (`typeof p === 'object' && p !== null &&
!Array.isArray(p)`) before `checkKeys`.

### V3-06: The rotation is a u53 in certificates but a u32 in links *(test)*

**Where:** `src/certs.ts:131` and `src/certs.ts:171` (safe integer) versus `src/invitation.ts:174` (`checkSigner` refuses
rotations above 2^32 - 1).

After a cert with a rotation of 2^32 or more, which a buggy client or a holder of the master key can issue, the owner can
no longer invite or answer. **Fix:** bound `rotation` to u32 in the sharing-cert format (and `seq` to u53, as now), and
write the bounds in the spec.

### V3-07: An invitation record with a malformed expiry never expires *(test)*

**Where:** `src/invitation.ts:231-237`: `now >= Date.parse("garbage")` is `false`.

`OwnerInvitation` records come back from the vault. A corrupted or truncated `expires` makes the invitation, and every
answer to it, valid forever, and the expiry sweep never runs. **Fix:** fail closed: treat a non-finite date as expired,
or throw `FormatError`.

### V3-08: `retireInvitationKey` silently skips packs it was not given *(test)*

**Where:** `src/invitation.ts:465-497`.

The helper re-encrypts only the `packs` array the caller passes. If the app passes one page of a listing, or forgets
`media/` files, the rest stay readable to the link holder, and the helper still reports success. **Fix:** require one
byte array per index entry (or a `fetch(file)` callback), throw if any index entry was not examined, and return the list
of entries that were checked.

### V3-09: `checkLocation` misses some IPv6 spellings of local addresses *(test)*

**Where:** `src/invitation.ts:109-113`.

`https://[::7f00:1]/` (IPv4-compatible) and `https://[64:ff9b::c0a8:101]/` (NAT64 well-known prefix) pass. **Fix:**
for IPv6 literals, extract the embedded IPv4 address for `::/96` and `64:ff9b::/96` and apply the IPv4 rules. Keep
the documented rule that the HTTP layer must refuse private resolved addresses (DNS rebinding).

### V3-11: Any verified index unlocks `openPack`, including one verified without `expectedOwner` or `lastSeen`

**Where:** `src/verified.ts:9-16`, `src/pack.ts:327-345`, `src/signed-index.ts:175` (all trust options are optional).

The run-time registry proves that an index came from `verifyIndex`, but not that it was verified *for this contact*,
against *their* `lastSeen`. An app that fetches Bob's address and calls `verifyIndex(json)` gets a capability that
opens Mallory's packs and a stale index of Bob's. The pack is attributed by URL, not by `index.owner`. **Fix:** make
`expectedOwner` required, with an explicit `{ firstContact: true }` for TOFU, and record in the registry whether
`lastSeen` was checked, so that `openPack` can require it outside the first-contact flow.

### V3-12: Already-parsed objects bypass the canonical-input rule

**Where:** `src/encoding.ts:158-176` (objects are accepted as is), used by every `verify*` function.

`verifyIndex(await res.json())` is the natural call, and it skips the F-05 duplicate-key and canonical checks: JS keeps
the last duplicate, while another reader may keep the first. **Fix:** the transport entry points should take bytes or
strings only (`verifyIndexBytes`). Keep object input behind an explicitly named in-process function.

### V3-13: Nothing stops an honest device from publishing an index readers will refuse, and a jammed `seq` needs the phrase

**Where:** `src/signed-index.ts:115-136` (`signIndex` has no notion of the previous index), `src/signed-index.ts:277`.

- A device that allocates `seq` from a stale local counter, or that jumps by more than 2^20, publishes an index every
  reader refuses. Readers only "report" this locally, so the owner never learns of it.
- If such an index lands on the storage, honest devices that continue from it are refused too, by every reader that
  missed it, for the rest of the rotation.
- Recovery takes a new rotation, which needs the master key, so the phrase or the primary device. THREATS.md:21-23
  documents this. The library could prevent most of it cheaply.

**Fix:** `signIndex(signer, content, { previous })`: run `checkNoRollback(new, previous)` and require
`seq === previous.seq + 1` unless the rotation increases. In the README publish flow, detect a storage index whose `seq`
jumped and prompt for a rotation.

### V3-16: Pack payloads carry no type, so group-key and content packs are told apart by sniffing JSON

**Where:** `src/group.ts:93-102` (`isGroupKeyPayload`), `src/pack.ts:210-219` (frame = id ‖ length ‖ payload).

The content payload format (Automerge, GeoJSON, media) is not specified. The only thing that keeps a content payload
from being read as a group secret, or the reverse, is a JSON `type` field inside the payload. Retirement safety (R-02)
depends on that sniffing. **Fix:** add a one-byte payload type inside the encrypted frame (`1 = content`,
`2 = group-key`, `3 = media`, …) before freezing, and check it in `openPack` and `openGroupKey`. It costs one byte and
gives domain separation inside the AEAD.

---

## Notes

- **N-1: Metadata in the public index.** The index is world-readable at the read address, and it reveals:
  - which device published each version (`device_cert`);
  - how many devices exist and how many have been revoked (a theft history);
  - the rotation count, `seq` (an activity count) and the number of packs.

  Diffing two consecutive indexes shows which file replaced which, so SPEC.md:109 ("neither the storage nor a former
  friend can link successive versions of a pack") over-claims whenever one pack changes per publication.
  THREATS.md:61-63 admits part of this. Align the spec's wording. Optionally batch pack replacements so that diffs are
  less precise.
- **N-2: There are no format-level size bounds** for index bytes (up to 100,000 entries, each JSON-parsed), pack
  ciphertext, return links, or the invitation string. `parseInvitationLink` decodes base64 before any length check.
  Specify maxima, for example an index of at most 16 MiB and a link string of at most 1,100 characters checked before
  decoding.
- **N-3: Two master holders can fork a rotation.** Suppose two devices declare a loss concurrently, both with the 12
  words typed. They produce two different certs at rotation r+1. Readers then report a fork for every index at r+1 until
  an r+2 cert exists. Document "issue r+2" as the recovery.
- **N-4: Key material inside payloads survives retirement.** R-02 generalizes: any key carried *inside* content opened
  to the invitation key, such as per-photo keys or link-only list keys, still works after `retireInvitationKey`. The
  spec should state that every key reachable from invitation-wrapped content is re-keyed on retirement.
- **N-5: Delivery of the late answer is assumed.** An attacker with access to the owner's messaging (a threat-model row)
  can drop the real friend's return link, so the late-answer warning never fires. The "Impersonator" row assumes that
  the answer is delivered.
- **N-6: Things I checked and found sound:**
  - the `(rotation, seq)` ordering, including the un-revocation check, seq restart on a new rotation, readers with stale
    state being served an old-rotation index, and seq jams before revocation;
  - the domain separation of every signature;
  - the owner-bound pack AD and the hash check before any X25519 operation in `openPack`, `rewrapPack`,
    `reencryptPack`, `openGroupKey` and `retireInvitationKey`;
  - the integer Padmé implementation and the padding check;
  - the binding of link and response signatures (inviter pk, invitation pk, id, location);
  - the device-cert reconstruction in links and responses;
  - the `TLSK` `to` binding and vault AD;
  - the transfer header AD, its bounds and the expiry check before the KDF;
  - the safety-code order independence;
  - canonicalization edge cases (BOM, duplicates, `__proto__`, lone surrogates).

---

## Status of previous findings

| ID | Status | Evidence / residual |
|---|---|---|
| F-01 | **Fixed by design, residual** | The three-level keys hold up. A stolen ordinary device cannot certify keys or obtain the new sharing key. However, V3-01 lets it keep the identity toward new contacts. |
| F-02 | **Partially fixed** | Retirement re-encrypts and refuses group secrets, and multiple answers are refused. Residuals: answers after expiry (V3-02), coverage of the pack list (V3-08), and the expiry sweep, which still depends on the app (documented). |
| F-03 | Fixed | `assertX25519PublicKey` is applied everywhere, and bit 255 is now refused. |
| F-04 | Fixed | `updated` is informational, with 24 h of skew allowed. |
| F-05 | Fixed, residual | The BOM gap is closed. Object input still bypasses the rule (V3-12). |
| F-06 | Fixed | The hash is checked first, and packs are owner-bound. See V3-11 for verification options. |
| F-07 | Fixed, residual | The certs are in the index. New contacts depend on the link (V3-01). |
| F-08 | Fixed | Padmé, with integer vectors. |
| F-09 | Fixed | Unchanged since the second review. |
| F-10 | Fixed | `MAX_WRAPS` is 256, checked before any work. See N-2 for the other size bounds. |
| F-11 | Fixed | Content-addressed names. See V3-05 for string entries. |
| F-12 | Fixed | Binding and the validity window. See V3-09 for location residuals. |
| F-13 | Fixed, residual | See V3-04 (created in the future) and V3-07 (malformed expiry). |
| F-14 | Mostly fixed | `rewrapPack` still decrypts the whole payload (it is wiped afterwards). Secrets in strings are documented. |
| F-15 | Fixed | |
| N-1…N-3 (T-002) | Sound | |
| N-4 (T-002) | Fixed | The owner is in the pack AD (R-05). |
| N-5 (T-002) | Documented | `seq` is allocated with `If-Match`, and forks are reported. There is no `prev` hash (acceptable). |
| N-6 (T-002) | **Open** | KAT vectors are missing for signed bytes, packs, transfer blobs, `TLSK` and links (THREATS.md:123-125). |
| R-01 | **Fixed** | `checkNoRollback` compares the rotation first, then `seq` with a 2^20 step bound. My attacks on revocation, stale readers and seq restarts failed. Residual: honest or buggy jams need the master (V3-13, documented). |
| R-02 | Fixed | `retireInvitationKey` refuses group-key packs. This is enforced only at retirement (documented). See N-4 and V3-16. |
| R-03 | **Fixed, but introduces V3-01** | Links and responses are device-signed and carry the device cert. The read address is not master-bound. |
| R-04 | **Partially fixed** | `late` works before expiry. After expiry, everything is discarded (V3-02). |
| R-05 | Fixed | The owner public key is in the AD (`src/pack.ts:121-123`). |
| R-06 | Fixed | `public: {file, hash}` and `verifyPublicFile`. |
| R-07 | Fixed | `sealSharingKey` refuses revoked devices. |
| R-08 | Fixed | `SharingCertOptions.lastSeen` is typed and documented. |
| R-09 | Fixed | `ignoreBOM: true`. |
| R-10 | Fixed, residual | Canonical URL and private-IP checks are in place. IPv6-embedded forms remain (V3-09). |
| R-11 | Fixed / documented | `IdentityMovedError.conflict` exists. The permanence of `move` is an app rule (documented). |
| R-12 | Fixed in form, defeated by V3-01 | `min_rotation` is in the link, but the link chooses where it is checked. |
| R-13 | Partially fixed | The short-code wording and SPEC.md:723 are fixed. The vault data key has no format (V3-10). The face-to-face QR format is still undefined (documented). |
| N-1 (2nd) | Fixed | Bit 255 is refused. |
| N-2 (2nd) | Fixed | Integer Padmé with vectors. |
| N-3 to N-6 (2nd) | Documented / sound | N-4 (2nd) is now V3-04. |

---

## Before an external human audit

1. **Fix V3-01** (read address bound by the master, carried in links and responses), **V3-02**, **V3-03** and **V3-10**,
   and update the spec accordingly. These are the open format decisions.
2. **A written format specification**, separate from the README. It should cover the byte layouts, JSON shapes, size
   bounds, the versioning and extension rules, and verification algorithms written as pseudocode, including
   `checkNoRollback` and the invitation checks.
3. **Known-answer vectors** for every structure: exact signed bytes per domain, a pack with a fixed key and nonce,
   `TLSK` in both modes, a transfer blob, an invitation link and a return link. Add deterministic-randomness test hooks
   to produce them. Negative vectors are needed too: non-canonical input, BOM, wrong versions, revoked signers.
4. **Fuzz and property tests** on every parser (`verifyIndex`, `readPackHeader`, `parseInvitationLink`,
   `openInvitationResponse`, `openSharingKey`, `decryptTransfer`, `decodeKeyExport`). Only `TLCryptoError` may escape.
5. **The missing protocol pieces specified**: the face-to-face QR contact format, the QR device-transfer key exchange
   ("Adding a device", way 1), the recovery-vault records (`lastSeen`, invitations, retired owners), and the payload
   type byte (V3-16).
6. **A threat-model document for the auditors** that maps each spec promise ("Loss and theft" steps 1-5, "one answer
   per invitation", re-encryption on acceptance) to the code paths and the app-level rules it relies on, such as the
   expiry sweep, `move` permanence and the HTTP-layer private-address filter.
