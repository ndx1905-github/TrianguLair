# Fifth review of the crypto package: the V4 fixes, final pass before the format v4 freeze (PR #52)

- **Date:** 2026-10-18
- **Reviewer:** independent agent. I did not write T-001, T-002, any round of fixes, or the earlier reviews.
- **Scope:** a focused review of `git diff 6d4e2da..5be049b` on `t-001-crypto-fixes-2`, which covers commits `b02ebd0`
  (crypto: V4-01..V4-08) and `5be049b` (spec). I read the fourth review first, then the diff. I also read the code
  around it in `packages/crypto/src` (`invitation-listing.ts`, `signed-index.ts`, `invitation.ts`, `vault.ts`,
  `sign.ts`, `encoding.ts#checkStructure`), the README and THREATS, the tests, and the changed `docs/SPEC.md` sections.
  **The spec is the source of truth.**
- **Method:** I attacked each V4 fix as the thief (before and after revocation, holding the old vault data key), as an
  honest device of the owner on another app version, as a link interceptor, and as someone polling the index. Findings
  marked *(test)* are reproduced in `packages/crypto/test/review-5.test.ts` as `it.fails(...)` tests that state the
  **desired** behaviour. I ran each one as a plain `it` and confirmed that it fails at the intended assertion, not
  earlier. I did not modify `src/`.
- **Build:** `npm install --workspaces=false` reports 0 vulnerabilities. `npm test`: 16 files, 204 passing and 3
  expected failures (the new reproductions). `npm run typecheck` is clean.

## Verdict: **ready to freeze format v4 (T-201)**

No finding needs a wire-format change. That holds as long as R5-01 is fixed with the listing rule proposed below
(option A); option B would need a format change. The team should make that choice before tagging, and the fix should
land before the external audit.

The V4 fixes hold up. I could not get a planted or extended invitation record listed:

- A record is now verified end to end: the device certificate is checked against the master, the
  `invitation-record` signature is checked over every listed field, and `seed` is re-derived to give `id` and the key.
- The lifetime is capped at 7 days at every entry point.
- A record can no longer stop an index from being published.
- The token binds the address.
- The padding is the same on every device.
- The spec now says what older devices do with the index and with the vault.

The one real gap is in V4-02: cancelling invitations at a declaration is a deletion, and `mergeVaults` is a union. Any
copy of the vault from before the declaration (the third device's local copy, or anything that copy merges) brings the
cancelled invitations back. The next index lists them again. That is R5-01. It can be fixed without touching any byte
format.

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | none |
| High | 0 | none |
| Medium | 1 | R5-01 |
| Low | 2 | R5-02, R5-03 |
| Note | 5 | N-1 to N-5 |

---

## Medium

### R5-01: A cancelled invitation comes back through `mergeVaults` and is listed again *(test)*

**Where:**

- `src/vault.ts:407-415` (`cancelAllInvitations` only empties the list).
- `src/vault.ts:351-363` (`mergeVaults` takes the union of invitations by id, with no tombstone).
- `src/signed-index.ts:241-253` (`listable` accepts any `inv.rotation <= cert.rotation`).
- README:138-140, SPEC:575 (step 1) and SPEC:539 ("two devices that write the vault at the same time merge their
  versions").

**Problem.** Marie has a phone (stolen), a tablet and a laptop. Before the theft, the tablet created invitation I (at
rotation 0). The seed of I is in the vault, which the phone has read, and in the laptop's local copy.

1. The tablet declares the phone lost, as the README describes: `cancelAllInvitations`, then `sealVault` with the new
   vault data key, then an index at rotation 1 that lists nothing.
2. The laptop receives the new `TLSK`, opens the new vault and merges its local copy into it (the documented multi-device
   rule). I is back.
3. The next time the laptop publishes, `signIndex` lists I. It passes every check: its signature and device
   certificate are valid, the tablet is not revoked, `rotation 0 <= 1`, and it has not expired.
4. The thief uses I's link two days after the declaration. `checkInvitationIndex` confirms it (test). Any device that
   wraps "friends" packs to open invitations also wraps them to I's key again, and the thief holds that key.

No action by the thief is needed. The thief can also help it happen: until step 4, he can write a vault sealed with the
**old** key, and any device that has not yet received the new `TLSK` will open it and merge it. This reopens the whole
of V4-02 for up to 7 days after the declaration.

**Fix.** Choose one before tagging T-201:

- **(A) No format change, recommended.** Make cancellation follow from the certificate rather than from a vault
  deletion. In `listable`, list only invitations with `inv.rotation === cert.rotation`, and return a new skip reason
  `'superseded'` for older ones (keep the record for late answers, but do not list it). A declaration always raises the
  rotation, so every invitation open at the declaration stops being listed, whatever any merge brings back.
  - Cost: a storage move (also `r + 1`) cancels open invitations too. Moving needs the master or the phrase and happens
    rarely, so the app can simply say "pending invitations were cancelled; send new ones".
  - The review-4 test "the token binds the read address: the owner recomputes it from the record after a storage move"
    then changes its expectation. `location` stays in the record and in the token, which is harmless.
  - Keep `cancelAllInvitations`: it still gives the key pairs to pass to `retireInvitationKey`.
  - Write the rule into SPEC "Invitation link" and "Loss and theft" step 1, and into the README.
- **(B) Format change, only if invitations must survive a storage move.** Add a vault field `invitations_from` (u32
  rotation). `cancelAllInvitations` sets it to the new rotation, `mergeVaults` keeps the maximum, and both `mergeVaults`
  and `listable` drop invitations below it. Older devices must not ignore this field, so it cannot come later as a
  minor. It would have to be in vault v3 now, which makes it a freeze blocker.

Either way, add the test from `review-5.test.ts` as a plain `it`.

---

## Low

### R5-02: `"invalid"` covers both planted records and legitimate ones that cannot be listed yet *(test)*

**Where:**

- `src/signed-index.ts:245` (`inv.rotation > cert.rotation` and `created > now + 5 min` both give `'invalid'`).
- `src/signed-index.ts:155-160` and README:280 (the guidance for `'invalid'` is "drop it from the vault and warn").
- SPEC:617 ("the record is dropped from the vault").

**Problem.** Here are two ordinary cases where a genuine invitation is reported as `'invalid'`:

- One of the owner's devices has a clock 10 minutes fast. A second device publishes the next index (test).
- One device already holds a newer certificate and invites. Another device publishes with the certificate it still
  has.

If the app follows the documented guidance, it deletes a valid invitation from the vault. That invitation then never
becomes listable, and its link fails with `NOT_LISTED`.

**Fix (API and documentation only).** Add a reason `'not-yet'` for "created in the future" and "newer rotation than
this certificate". The app keeps the record and lists it later. With R5-01 option A, "older rotation" becomes
`'superseded'`. Keep `'invalid'` for records that are malformed, have a bad signature or certificate, belong to another
owner, or last longer than 7 days.

### R5-03: `mergeVaults` sorts the union of answers and then cuts it to 16 *(test)*

**Where:** `src/vault.ts:359` (`[...new Set([...x.answers, ...i.answers])].sort().slice(0, MAX_ANSWERS)`). This
predates the diff, but it matters more now that V4-06 depends on seeing every answer.

**Problem.** The vault only checks that an answer is base64url of at most 13 000 characters. A device holding the vault
data key (for example the thief during the theft window) writes the same invitation record with 16 short junk answers
that sort first, such as `---A`. After the merge, the real answers are gone (test).

That removes the evidence behind "one answer per invitation": a second responder no longer triggers `multiple` or
`late`. After a declaration the invitation is cancelled anyway, so the effect is limited to the theft window and to
honest devices that run into the limit.

**Fix:** when the union is too long, keep the side's own answers first. Better, drop answers that do not open for this
invitation: the merging device holds the seed and can run `openInvitationResponse` on each one. Validate answers
against the invitation in `invitationFromRecord` too.

---

## Notes

- **N-1: Two uses of the vault data key.** The same 32 bytes are the XChaCha20-Poly1305 key of `TLVD` and the BLAKE2b key
  of `listingPadKey` (`src/invitation-listing.ts:121-124`, message `TrianguLair-invitation-padding-key-v1`). The two
  uses are separated by primitive and by a fixed context. There is no known interaction between keyed BLAKE2b and
  ChaCha20 under one key, and the padding outputs are public PRF values that reveal nothing about the key. This is
  acceptable and much better than the earlier reuse of the Ed25519 seed. Ideally both would derive from one root, but
  changing the vault encryption key derivation would change the vault format, and that is not worth doing. The domain
  strings are distinct from every other BLAKE2b domain in the package: token `listing-v2`, `padding-v2`,
  `padding-period-v1`, `key-v1` and `id-v1`.
- **N-2: Fields written by a stolen device survive the declaration.** `mergeVaults` keeps the maximum `minor` and
  unknown top-level, contact and record fields. `cancelAllInvitations` keeps everything except `invitations`.
  - So a thief can set `minor` to 2^53 − 1. That turns off "unknown field without a higher minor is an error" for this
    vault for good.
  - He can also plant fields that a future minor will give meaning to. Both survive the re-seal under the new key
    (current behaviour, plain test).
  - This is harmless today and fits the spec's "keep as is" rule for content documents. Add a spec rule: **a
    security-relevant vault field added in a future minor must not be trusted on the vault data key alone** (it needs a
    device signature, as invitation records have), or it needs a new major. At a declaration, the app should start from
    its last copy from before the theft (step 5 already asks for a diff).
  - Thief writes to `accepted`, `verified` and `retired_owners` are already documented in THREATS:89-95. Note that
    `CancelledInvitation.accepted` ("no new link needed for them") carries a value the thief can choose.
- **N-3: `invitations` is not quite "written in every index".** SPEC:753 says it is, but `signIndex` omits the field when
  `vaultDataKey` is not passed (`src/signed-index.ts:220-224`, plain test). Readers accept either form, so this is not
  a format issue. Either make `vaultDataKey` required, or soften the spec.
- **N-4: The record signature has no version byte.** The signed bytes (`src/invitation-listing.ts:86-99`) start directly
  with the owner key under the domain `invitation-record`. They are unambiguous: fixed-length fields, then the
  length-prefixed address last. A future change must use a new domain (for example `invitation-record-v2`). Write that
  in the format spec. Note also that `created` and `expires` are signed as seconds, so different ISO spellings of the
  same instant verify alike. That is harmless.
- **N-5: Checked and found sound:**
  - Signature domain separation: the prefix and `\n` terminator make `invitation`, `invitation-record` and
    `invitation-response` distinct.
  - The record signature covers owner, id, key, rotation, created, expires and address. `seed` is bound through
    `id` and the key, `device` through the verifying key, and `checkOwnerInvitation` checks that `device` equals
    `deviceCert.device`.
  - `listable` never throws (try/catch around everything), and rotation, `created` and the lifetime are checked after
    the signature.
  - A phone-signed record with any rotation is either `revoked` or `invalid`.
  - Token v2 binds the address. A rewritten address gives `NOT_LISTED`, and a stale index at a host the interceptor
    controls no longer gives trust on first use.
  - Links keep working after a storage move through the redirect, because the record keeps the old address. With R5-01
    option A this changes, by design.
  - Padding: the period is between 1 and 7 days (`86400 + x mod 518401`), and the leaks that remain (republication
    time, bucket, a dummy that comes back) are stated accurately in THREATS and SPEC.
  - `openedAfterExpiry` is computed from the opener's clock against the record's `expires`. It errs towards safety: an
    answer first seen before expiry and reopened later is flagged again.
  - `INDEX_MINOR = 0`, with `invitations` in 4.0, and SPEC:142 is split into content documents versus derived
    documents.
  - V4-08 is covered in SPEC step 4 and THREATS.

---

## Status of the V4 findings

| ID | Status | Evidence / residual |
|---|---|---|
| V4-01 | **Fixed** | Records carry a compact device certificate and an `invitation-record` signature, checked in `validate`, `invitationFromRecord` and `listable`. The lifetime is at most 7 days everywhere and `created <= now + 5 min`. `listable` skips and never throws, and reports to `onSkip`. A record in another device's name fails `SIGNATURE`, and a phone-signed record is `revoked` after the declaration. Residual: R5-02 (reason granularity). |
| V4-02 | **Partially fixed** | `cancelAllInvitations` and `retireInvitationKey` take several key pairs, and the spec and README sequences are updated. However, the cancellation is undone by `mergeVaults` with any copy from before the declaration (R5-01). |
| V4-03 | **Fixed** | `invitations` is in 4.0 (`INDEX_MINOR = 0`). SPEC:142 separates content documents (keep the unknown) from derived documents (re-derive and drop). A field that must be neither dropped nor copied needs a new major. |
| V4-04 | **Fixed** | Token v2 binds `u16 length ‖ address`, the record keeps `location`, and a rewritten address gives `NOT_LISTED`. The `readFrom` check is unchanged (still declared by the caller: N-3 of the fourth review, documented). |
| V4-05 | **Fixed (documented residual)** | Dummies come from the vault data key, so all devices write the same list. Each slot churns with a period of 1 to 7 days, the list has at least 4 entries, and the Ed25519 seed is no longer used. Remaining leaks (when the index is republished, the bucket, a dummy that comes back) are documented. N-1 covers the key's second use. |
| V4-06 | **Fixed** | `openedAfterExpiry` is set on each answer, documented in `collectInvitationAnswers`, and covered in SPEC (late answers and error cases) and THREATS. |
| V4-07 | **Fixed, note** | The highest `minor`, the union of `crit` and unknown fields are kept, and the result seals. Note N-2: a stolen device can use this to plant fields that survive the declaration. `crit` cannot be abused today: an unknown `crit` name makes `openVault` refuse the vault, so such a vault never reaches a merge, and a known `crit` name has to be present. |
| V4-08 | **Fixed (documentation)** | SPEC step 4 and THREATS cover old storages that still hold a redirect, and domains that expire and are re-registered. |

## Which findings need a wire-format change

**None, if R5-01 is fixed with option A** (a listing rule; no byte of the link, token, index or vault changes). R5-02
and R5-03 are API and merge behaviour. N-1 to N-4 are documentation, or would only matter for a future version.

**If the team prefers R5-01 option B**, the vault gains a mandatory field. That is a vault v3 change and must land
before T-201.

## Before the external audit (unchanged from the fourth review, plus)

1. R5-01 (option A), R5-02 and R5-03, each with its `it.fails` turned into a plain `it`.
2. The standalone format spec. It must include:
   - the `invitation-record` signed bytes and the rule "new domain for any change" (N-4);
   - the padding algorithm, which every implementation must write identically;
   - the listing rule from R5-01;
   - the pseudocode of `mergeVaults`, `cancelAllInvitations` and `listable` with its skip reasons.
3. Known-answer vectors for every structure, including the token, the padding dummies for a fixed key and time, and a
   signed invitation record. Negative vectors as listed in the fourth review.
4. Fuzzing of every parser, plus `openVault` with hostile records (planted answers, a huge `minor`, unknown fields).
5. A second minimal reader, at least for canonical JSON, signatures, the token and the padding.
