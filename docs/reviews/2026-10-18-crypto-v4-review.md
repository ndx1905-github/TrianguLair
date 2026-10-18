# Fourth review of the crypto package: format v4, short invitation link, vault v2 (PR #52)

- **Date:** 2026-10-18
- **Reviewer:** independent agent. I did not write T-001, T-002, any round of fixes, or the short-link change.
- **Scope:** branch `t-001-crypto-fixes-2` at `db2e0dc` (PR #52): all of `packages/crypto/src`, `README.md`,
  `THREATS.md` and `test/`, the three previous reviews, and the `docs/SPEC.md` sections "Invitation link and return
  link", "Asymmetric relationships", "Encrypted sharing", "Organization on the storage", "Format versions", "Recovery
  kit", "Adding a device", "Loss and theft", "Error cases", "Data model" and "Threat model". **The spec is the source of
  truth.** Focus on the commits after `455768b`: `3e97c51` (V3 fixes), `ccaa84b` (spec), `fe5c8e2` (short link, index
  4.1, vault v2), `db2e0dc` (spec).
- **Method:** line-by-line reading; attacks written against the library for each adversary named in the brief (thief
  before and after revocation, with and without storage credentials; storage host; link interceptor; older app
  version). Findings marked *(test)* are reproduced in `packages/crypto/test/review-4.test.ts` as `it.fails(...)` tests
  that state the **desired** behaviour. I ran each one as a plain `it` to check that it fails at the intended assertion
  and not earlier. `src/` was not modified.
- **Build:** `npm install --workspaces=false` reports 0 vulnerabilities. `npm test`: 15 files, 190 tests passing and 8
  expected failures (the new reproductions). `npm run typecheck` is clean.

## Verdict: **merge after fixes. Not ready to freeze (T-201).**

The V3 fixes hold up. The master-certified read address (V3-01) closes the "the link picks its own freshness anchor"
attack, and I could not reopen it through the short link: the address, owner key, rotation, seed and expiry of a link
cannot be changed without either a token mismatch or a master-signed redirect. The minor/crit rule (V3-03), the late-
answer grace (V3-02) and the vault format (V3-10) are implemented as described, and the Low items of the third review
are fixed. The short link itself is a sound idea: an unsigned bearer link bound by a listing in the owner's
rollback-protected index has the same freshness properties as the device-signed v4 link it replaces, and the residual
documented in THREATS (an old index replayed by someone with write access to the certified address) is accurately
described and indeed identical to the v4 one.

What is new is that the listing moved the security decision **from a signature to a vault record**, and vault records
are not authenticated against the device that wrote them:

- **V4-01 (high).** Every device holds the vault data key. During the theft window the thief writes invitation records
  whose self-declared `device` names another, honest device, and whose `expires` is arbitrary. After "Declare a device
  lost" the honest devices carry the records over to the new vault key and keep listing them. So the thief's links stay
  valid for new contacts, and any content the app wraps to "open invitations" goes to keys the thief holds, for as long
  as the thief chose. A planted record with an impossible rotation even makes `signIndex` throw, so the declaration's
  index cannot be published. This defeats spec "Loss and theft" step 1 and the README claim that `signIndex` "stops
  listing the invitations it created".
- **V4-02 (medium).** The seeds of **all** open invitations are in the vault, so the stolen device holds them. The
  declaration withdraws none of them, so the thief keeps reading what is wrapped to them for up to 7 days after the
  declaration. This contradicts step 2 ("the thief no longer sees any update").
- **V4-03 (medium).** The spec contradicts itself and the code on what an older writer does with unknown index
  fields. If the spec's "keeps them as is" were implemented, an older device would carry `invitations` forward verbatim
  through a declaration.

All three need decisions or small format changes in the vault record and index (vault v3, or `invitations` in
4.0), which is exactly what must be settled before T-201. None of them takes a redesign.

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | none |
| High | 1 | V4-01 |
| Medium | 2 | V4-02, V4-03 |
| Low | 5 | V4-04 to V4-08 |
| Note | 7 | N-1 to N-7 |

---

## High

### V4-01: Vault invitation records are unauthenticated, so a stolen device plants listings that survive its revocation *(test)*

**Where:**

- `src/signed-index.ts:212-226` (`listableTokens`): the only revocation filter is `cert.revoked_devices.includes(inv.device)`
  (line 222), where `inv.device` comes from the record. There is no bound on `expires - created`, and line 217
  **throws** for `inv.rotation > cert.rotation`.
- `src/vault.ts:186-205` (`validate`): `device` is only checked as an Ed25519 key (line 195), and `expires` only has
  to follow `created` (line 196).
- `src/vault.ts:139-156` (`invitationFromRecord`): copies `device`, `rotation`, `created` and `expires` from the
  record.
- README:130-137 ("`signIndex` stops listing the invitations it created"), THREATS:20-23 and 69-72, SPEC:571 (step 1,
  "The invitations that device created are no longer listed in the index, so their links stop working"), SPEC:81 and the
  threat-model row "Phone thief" ("its earlier ones are dropped at the declaration").

**Problem.** The listing replaces the device signature of link v4, and the decision "was this invitation made by a
revoked device?" now rests on the `device` field of a vault record. Every device holds the vault data key, and THREATS
says outright that a stolen device can rewrite the records until the declaration. The declaration re-seals the
records under the new vault data key, which makes whatever the thief wrote look authentic again.

1. In the theft window, the thief calls `createInvitation(phoneSigner, cert0)`, which gives `device = phone`. He then
   writes the record with `device = tablet`. Optionally he also sets `expires` years ahead, staggering several records
   so that one always falls within the 7 days that `parseInvitationLink` accepts.
2. Marie declares the phone lost from the tablet. The tablet opens the vault with the old key, re-seals it with the
   new key, and publishes rotation 1 with `invitations` taken from the records. The planted invitation is listed,
   because its `device` is not revoked.
3. A new contact opens the thief's link: the index at the certified address lists it, so `checkInvitationIndex` passes
   (test 1). The return link is sealed to an invitation key the thief derived, and the contact believes they are
   connected to Marie.
4. Spec item 1 ("a temporary invitation secret that lets the invitee immediately see what I share with my friends")
   means that every device re-sealing a "friends" pack must include the keys of open invitations from the vault. With
   a record that expires in 2030 (test 2: accepted by `sealVault` and listed by `signIndex`), the thief reads every new
   "friends" pack for years after the declaration.
5. Variant (test 3): a record with `rotation = 2^32 - 1` makes `signIndex` throw `FormatError` for any index that lists
   the vault's invitations, including the declaration's index. Revocation is blocked until someone finds and removes the
   record by hand.

Self-declared fields cannot be filtered after the fact. `device`, `rotation`, `created` and `expires` can all be set
in anticipation of the declaration. For example, `rotation = r + 1` passes both `inv.rotation <= cert.rotation` and
the invitee's rotation floor. Any rule of the form "skip records whose field X says…" therefore loses.

**Fix (vault v3, before T-201):**

- **Authenticate each record by its creating device.** Add a `sig` field: an Ed25519 signature by the creating
  device's key, under a new domain `invitation-record`, over `owner pk ‖ id ‖ invitation pk ‖ rotation ‖ created ‖
  expires`. Also add that device's compact cert. `listableTokens` and `invitationFromRecord` verify both against the
  owner's master, and the existing revoked-device filter then means what the README says. (The phone can still sign
  records with its own key, but those are dropped by the revocation filter.)
- **Bound the lifetime everywhere.** Require `expires - created <= INVITATION_MAX_TTL_MS + 5 min` in `validate`,
  `invitationFromRecord` and `listableTokens`. In `listableTokens`, also require `created <= now + 5 min`.
- **Skip, never throw, in `listableTokens`** for records that cannot be listed: wrong rotation, malformed dates.
  Return them, or report them through a callback, so that the app can drop them. A vault record must never be able to
  block publication of an index.
- Purging at the declaration (V4-02) is needed in any case, and it also removes records planted this way.

---

## Medium

### V4-02: The declaration does not withdraw the open invitations whose seeds the stolen device read *(test)*

**Where:** README:130-137 ("Declare a device lost": nothing about open invitations), `src/signed-index.ts:212-226`
(invitations created by a non-revoked device stay listed), SPEC:571-572 (steps 1-2), SPEC:531 (the vault keeps "the
invitation secret").

**Problem.** Vault v2 stores each invitation's `seed`, which gives the invitation key pair. The stolen device can
decrypt the vault, so it knows the seed of every invitation open at the time of the theft, including those created by
the tablet. After the declaration:

- These invitations stay listed until expiry (test 4), and their keys stay recipients of "friends" packs until
  acceptance or expiry.
- Step 2's re-encryption therefore re-wraps fresh content to keys the thief holds. For up to 7 days, the thief keeps
  reading updates, against "the thief no longer sees any update".
- The thief can also open the friends' return links (they are sealed to the invitation key), learning who Marie is
  inviting and their sharing certificates.

**Fix:** step 1 of the declaration withdraws **every** open invitation: drop it from the vault and from the listing.
Step 2 re-encrypts without their keys (`retireInvitationKey` on each). The app tells the user "your pending
invitations were cancelled; send new ones". Write this in the spec, the README sequence and THREATS. Optionally, offer a
library helper (`declarationRecords(records)`) that returns the records to keep.

### V4-03: The spec contradicts itself and the code on what an older writer does with unknown index fields

**Where:** SPEC:142 ("Ignore the unknown: … and **keeps them as is** when it rewrites its own content (the case of two
devices of the same user with different versions)") versus SPEC:748 ("An older app version that rewrites the index
**drops** this field"), README:50-51, THREATS:126-128 and 181-182, and `src/signed-index.ts:181-198` (`signIndex`
rebuilds the body from scratch; it has no way to carry fields over).

**Problem.**

- The source of truth says that an older device keeps unknown fields when rewriting. The code, README and data model
  say that it drops them. A second implementation that follows SPEC:142 would copy `invitations` verbatim, because a
  4.0 writer cannot re-evaluate a field it does not understand.
- That copy would keep listing tokens past their expiry. It would also keep listing them across a declaration made on
  that older device, re-listing the revoked device's links. Fields like this one, derived from state the writer
  cannot recompute, are exactly the ones that must never be copied blindly.
- The vault rules point the other way: `openVault` keeps unknown fields and `sealVault` accepts them, but
  `mergeVaults` drops `minor` (V4-07).

**Fix (decide before T-201):**

- **Fold `invitations` into 4.0.** Nothing is deployed, and `INDEX_MINOR = 1` exists only because the short link was
  added a commit after minor support. Then no v4 writer is an "older writer" for this field. Keep minors for after the
  freeze.
- **Amend SPEC:142**: for the signed index (and any document bound to the owner's current state), an older writer
  **drops** unknown fields and writes its own minor. "Keep as is" applies only to content documents (Automerge, the
  vault's `app` part and unknown record fields).
- State in the spec that a future field which an older writer must neither drop nor copy needs a new major version
  (the README already says so).

---

## Low

### V4-04: A rewritten read address is redirected, not refused, and the library cannot tell *(test)*

**Where:** `src/invitation-listing.ts:41-44` (the token covers owner pk, invitation pk, rotation and expiry, but **not
the address**), `src/invitation.ts:438-440` (`checkInvitationIndex` compares `readFrom` with the index's certified
address, never with `source.location`), SPEC:81 ("A forged link (another key, another address, a changed expiry) is
therefore refused").

**Problem.**

- An interceptor can replace the link's address with his own. The app reads it, he serves any copy of Marie's index,
  `verifyIndex` throws `MOVED` to the certified address, and the app reads there. The link is confirmed (test 5), so
  the spec's claim is false.
- No security property is lost **if the app re-fetches** at the redirect target. But the bytes the app already holds
  verify too, and re-verifying them with `location: certified` is accepted. That turns a stale index served at the
  thief's own host into a TOFU acceptance without any write access to the real storage (an app bug the library could
  prevent).
- The address is also the only link field that is not bound to the token.

**Fix:**

- Add the address to the token: `… ‖ u16 address length ‖ address`. Keep the invitation's address in the vault record
  (`location`), so that the owner can recompute the token after a storage move.
- In `checkInvitationIndex`, require either `readFrom === source.location`, or a redirect chain that the library
  recorded itself. `verifyIndex` can mark the result with the `MOVED` source it came from, so that `readFrom` is not
  only a caller declaration.

### V4-05: Listing padding does not hide which tokens are real *(test)*

**Where:** `src/invitation-listing.ts:46-65` (dummies `= BLAKE2b(key = padKey, i)`), `src/signed-index.ts:197` (`padKey =`
the publishing device's Ed25519 seed), SPEC:81 ("padded with dummy entries so that the public index does not show how
many invitations are open, only a rough bucket"), SPEC:112, README:352-356, THREATS:176-180.

**Problem.** The index is world-readable, so the storage host, any former friend or anyone holding the address can
poll it.

- **Across devices:** two consecutive indexes signed by two devices have disjoint dummies, so their intersection is
  exactly the set of real tokens (test 6: 1 of 4).
- **Across time, even with one device:** the dummies are stable forever, while real tokens live at most 7 days and
  never come back. Any token seen for more than 7 days, or seen to disappear and reappear, is a dummy. After a week of
  polling, the observer knows the exact number of open invitations and when each one was created.
- The field is absent when nothing is open, which shows that invitations exist at all.

THREATS admits the device-change leak and the diffing of additions, but the spec still promises a bucket. The
metadata in question is how many people the owner invites, and when.

**Fix:** either correct the spec ("the listing reveals when invitations are created and how many are open to anyone
who polls the index"), or make the padding effective:

- derive `padKey` from an owner-wide secret, for example a KDF of the vault data key with a dedicated context, so that
  every device produces the same dummies;
- give each dummy a pseudo-random lifetime of at most 7 days, keyed by `(padKey, slot, epoch)`, so that dummies churn
  like real tokens;
- always publish the field, with a fixed minimum of 4 entries.

Do not use the Ed25519 signing seed as a BLAKE2b key in any case (N-1).

### V4-06: A lone answer first opened after expiry is accepted silently *(test)*

**Where:** `src/invitation.ts:372-410` and `484-514`, THREATS:147-154 ("any link holder can backdate an answer … it is
still one more answer, which triggers the warning"), SPEC:77.

**Problem.** The answer's `created` is claimed by the responder. Anyone who kept the link (chat history, screenshot)
can sign an answer dated before expiry and deliver it during the grace period. If the real friend never answered,
nothing else is there to trigger the warning, so `collectInvitationAnswers` returns it as `accepted` (test 7). The
effective answer window is 14 days, not 7. THREATS's "it is still one more answer" holds only when another answer
exists.

**Fix:** mark answers opened when `now >= expires` with `openedAfterExpiry: true` (or put them in a separate list).
The app then requires an explicit choice, and preferably a safety-code comparison, before granting. Correct THREATS:152.

### V4-07: Vault records from a newer minor cannot be merged by an older device *(test)*

**Where:** `src/vault.ts:292-335` (`mergeVaults` builds `out` without `minor`/`crit`, but keeps unknown fields inside
records through `{ ...x }` and unmerged contacts), and `src/vault.ts:170-191` (`validate` then refuses those fields,
because the document no longer declares a higher minor).

**Problem.** As soon as a newer app adds a record field under vault minor 1, every older device fails in `sealVault`
after a merge (test 8). It can then no longer save the vault, its answers or its anchors. This is fail-closed, but it
contradicts "ignore the unknown", and it breaks the multi-device rule of SPEC:535.

**Fix:** `mergeVaults` keeps `max(a.minor, b.minor)` and `crit` (as a union, re-validated), and keeps unknown
top-level and record fields from the side the merge picks. Add a test with a minor-1 vault.

### V4-08: Revoking storage credentials (step 4) must cover every address that ever appeared in a certificate

**Where:** SPEC:574 (step 4: "revoking the Nextcloud app password, new S3 or SSH key"), SPEC:555 and the "A friend
changes storage" row (SPEC:608; the old storage keeps the newest index as a redirect "for a few months"), THREATS:31-39.

**Problem.** A device revoked at rotation `r + 1` can still sign valid rotation-`r` indexes, and the rotation-`r`
certificate certifies its own (older) address. Anyone who can write at an address certified by **any** older
certificate can serve, there, a stale index listing the thief's links. A new contact with a link naming that address
and rotation `r` accepts it (trust on first use). THREATS covers "kept the storage credentials" and "an old address
still serving a stale index". It misses two practical cases:

- the old storage, which must stay writable by the owner for the redirect, is not covered by step 4;
- a custom domain that later expires can be re-registered by the thief, which gives a permanent impersonation
  channel to new contacts (and the mirror case of V3-01: their places wrapped to the old sharing key, which the thief
  holds).

**Fix:** step 4 revokes the credentials of the current **and** every previous storage that still holds a redirect.
Document the domain-expiry residual: owners should keep old domains or use provider addresses, and the only defence
for a first contact is the safety code. Longer term, consider a master-signed "superseded" statement at old addresses,
or a not-after date on sharing certificates for first-contact use.

---

## Notes

- **N-1: Key reuse for padding.** `padListing` uses `signer.keys.sign.secretKey.subarray(0, 32)`, the Ed25519 seed, as a
  BLAKE2b key (`src/signed-index.ts:197`). BLAKE2b is a PRF and this is not exploitable today, but the same secret now
  feeds two primitives. Derive a dedicated key (see V4-05).
- **N-2: Inviting now writes the index.** Every invitation needs an index publication before the link is sent, so the
  storage host (and anyone polling) learns the exact time of each invitation from `seq` and `updated`. The owner also
  has to be online with a working storage to invite. Both are accepted in the spec, and should be listed in the
  threat-model row "Storage host".
- **N-3: `readFrom` is a caller declaration.** `verifyIndex(…, { location })` records the address the caller says it
  read from. The library cannot know where bytes came from, so the "read only at the certified address" rule remains
  an app rule. Say so in THREATS. V4-04's fix narrows it.
- **N-4: Stale README.** README:461 still documents key export version 2 without `vault_key`, while the table at
  README:76 and `src/transfer.ts:145-151` have version 3.
- **N-5: `MAX_LINK_CHARS = 1024`** (`src/invitation.ts:105`) is about five times the real maximum (about 200 characters
  plus a prefix). A tighter bound (for example 768 characters for the fragment) would match the 504-byte address limit
  exactly.
- **N-6: The return link is unchanged and sound.** It is device-signed, bound to the inviter and the invitation key,
  and carries the master-signed certificate with its address. Its freshness check (certificate not older, device not
  revoked at the certified address) has the same storage-write residual as the invitation. Its length (about 530 to 600
  characters) is acceptable, since it travels by messaging.
- **N-7: Things I checked and found sound:**
  - Token construction: fixed-length fields, a domain prefix, and binding of owner, invitation key, rotation and expiry.
  - Seed derivation: separate domains for the key and the id. A 128-bit seed gives 128-bit security for the
    invitation key.
  - Link parsing: length checked before decoding, the remaining bytes give the address length, `checkLocation`
    applies, and the expiry is bounded by the reader's clock.
  - Every link tampering (owner, seed, rotation, expiry) gives `NOT_LISTED` or `OWNER_MISMATCH`.
  - The rotation floor is bound in the token.
  - `createInvitationResponse` requires a confirmed invitation.
  - The grace period: `created` must fall inside `[created - 5 min, expires)` and the record is fail-closed.
  - `crit` handling (reserved names, presence, unknown names refused).
  - `minor` gating of `invitations`.
  - The `IndexAnchor` fork detection.
  - `signIndex({ previous })`.
  - Strict object entries for packs (V3-05).
  - The IPv6-embedded IPv4 rules.
  - The payload type byte inside the AEAD.
  - The vault AEAD (AD with magic, version, owner and nonce), with Padmé padding and a zero-padding check.
  - `TLSK` v2 and key export v3 carry and check `vault_key`.

---

## Status of previous findings

| ID | Status | Evidence / residual |
|---|---|---|
| F-01 | **Fixed by design, new residual** | The three key levels hold. A stolen device can no longer mint links honoured after the declaration, except through planted vault records (V4-01) and the open invitations it read (V4-02). |
| F-02 | **Partially fixed** | V3-02 is fixed. Residuals: open invitations are not withdrawn at the declaration (V4-02), silent acceptance after expiry (V4-06), and the expiry sweep is still an app duty (documented). |
| F-03 | Fixed | Unchanged. |
| F-04 | Fixed | Unchanged. |
| F-05 | Fixed | `verifyIndex` takes text or bytes only (V3-12). Other verifiers accept objects in-process (documented). |
| F-06 | Fixed | Hash first, owner-bound AD, and `openPack` requires an owner-bound index (V3-11). |
| F-07 | Fixed | The certificate is in the index, and the read address is certified (V3-01). |
| F-08 | Fixed | Padmé for packs and the vault. |
| F-09 | Fixed | Unchanged. |
| F-10 | Fixed | `MAX_WRAPS` is 256. Size bounds exist for the link, the return link and the index (N-2 of the third review). Pack ciphertext is unbounded (documented). |
| F-11 | Fixed | V3-05 is fixed too. |
| F-12 | Fixed | The link is now unsigned and bound by the token. See V4-04 for the address. |
| F-13 | Fixed | V3-04 (expiry bounded by the reader's clock) and V3-07 (fail-closed dates). |
| F-14 | Mostly fixed | Unchanged: secrets in JSON strings are documented. |
| F-15 | Fixed | Unchanged. |
| N-1…N-3 (T-002) | Sound | |
| N-4 (T-002) | Fixed | |
| N-5 (T-002) | Documented | |
| N-6 (T-002) | **Open** | No KAT vectors for signed bytes, packs, `TLSK`, transfer, vault, link, token or return link (THREATS:217-220). |
| R-01 | Fixed | `(rotation, seq)` ordering and `signIndex({ previous })`. |
| R-02 | Fixed | Payload type byte (V3-16). |
| R-03 | **Fixed differently** | Invitations need no master and no signature: the listing in a device-signed index. Answers are device-signed. Its new trust root is the vault record (V4-01). |
| R-04 | Fixed, residual | `late` works during the grace period. Residual: V4-06. |
| R-05 | Fixed | |
| R-06 | Fixed | |
| R-07 | Fixed | |
| R-08 | Fixed | |
| R-09 | Fixed | |
| R-10 | Fixed | V3-09 forms are refused. DNS rebinding is left to the HTTP layer (documented). |
| R-11 | Fixed / documented | |
| R-12 | Fixed | The rotation floor is bound in the token. TOFU remains for a reader without an anchor (documented, V4-08). |
| R-13 | Partially fixed | The vault format is defined (V3-10). The face-to-face QR format is still undefined (THREATS:196-199). |
| N-1…N-6 (2nd) | Sound / documented | |
| V3-01 | **Fixed** | The read address is in the master-signed certificate, `MOVED` redirects, `checkInvitationIndex` requires the certified address, and links and answers carry nothing that chooses it. Residuals: storage write access (documented), old addresses (V4-08). |
| V3-02 | **Fixed** | 7-day grace, `created` checked against the window, `late` reported. Residual: V4-06. |
| V3-03 | **Fixed in code, spec contradiction** | `minor`/`crit` are implemented on every JSON structure. SPEC:142 contradicts the code on rewriting (V4-03). Vault merge: V4-07. |
| V3-04 | Fixed | `expires <= now + 7 d + 5 min`. `createInvitation` trusts its `now` option (documented). |
| V3-05 | Fixed | |
| V3-06 | Fixed | The rotation is a u32 everywhere. |
| V3-07 | Fixed | `recordTime` and `isInvitationExpired` fail closed. |
| V3-08 | Fixed | Every index entry is required. |
| V3-09 | Fixed | Also 6to4 and local NAT64. |
| V3-10 | **Fixed, new issue** | `TLSK` v2, key export v3, `TLVD` v2 records. The invitation records are unauthenticated (V4-01) and the merge loses the minor (V4-07). |
| V3-11 | Partially fixed (documented) | An owner-bound index is required. `lastSeen` is recorded but not enforced. |
| V3-12 | Fixed for transport | |
| V3-13 | Fixed (opt-in) | `previous`. |
| V3-16 | Fixed | |
| N-1 (3rd) | Documented, extended | The listing adds invitation metadata (V4-05, N-2). |
| N-2 (3rd) | Mostly fixed | No bound on pack ciphertext (documented). |
| N-3 (3rd) | Documented | |
| N-4 (3rd) | Documented | In the spec and THREATS (app duty). |
| N-5 (3rd) | Documented | |

---

## Is v4 ready to freeze (T-201)?

**No.** Before freezing, settle these format items:

1. **Vault invitation record** (V4-01): add a device signature and a compact device cert, bound the lifetime, and add
   `location` if V4-04 is adopted. This is vault v3.
2. **Token** (V4-04): decide whether the read address is bound. It is a link and token change.
3. **Where `invitations` lives** (V4-03): in 4.0, or 4.1 with the spec amended. Also amend SPEC:142.
4. **Padding derivation** (V4-05): it changes what every implementation writes, even if the JSON shape stays the
   same.
5. **Declaration semantics** (V4-02) and the `openedAfterExpiry` flag (V4-06): protocol and API, written into the spec
   before a second implementation exists.

## Before an external human audit

1. **The fixes above**, with the spec, README and THREATS updated to match. The plain-`it` versions of
   `review-4.test.ts` should pass.
2. **A standalone format specification** (not the README), versioned. It must cover every structure byte by byte:
   - JSON shapes with required and optional fields, the `minor`/`crit` rules per structure, and size bounds;
   - the index and its compact certificates, the sharing and device certificates, the identity move, the pack envelope
     and header with the AD and the frame (payload types), the group-key payload, `TLSK` (both modes), the key export,
     the transfer blob, `TLPI`, `TLVD` and its records, the link v5, the token, the seed derivations, the padding
     dummies, and the return link with its compact certificates;
   - every signature domain and the exact signed bytes;
   - canonical JSON (the JCS subset);
   - the pseudocode of `verifyIndex`, `checkNoRollback`, `checkSharingCertNotOlder`, `checkInvitationIndex` (both
     paths), `listableTokens`, `collectInvitationAnswers` (with the grace period) and `mergeVaults`.
3. **Known-answer vectors** for each structure, from deterministic-randomness hooks (seeded `randombytes`):
   - signed bytes per domain;
   - a pack with a fixed key, nonce and wraps;
   - `TLSK` modes 1 and 2, a key export, a transfer blob (fixed salt and nonce), a vault envelope, `TLPI`;
   - a link with its derived key pair, id and token, and a padded listing;
   - a return link.

   Add **negative vectors**: non-canonical JSON, BOM, duplicate keys, wrong major, unknown `crit`, unknown field
   without a minor, a revoked signer, a rollback, a fork, an un-revocation, a tampered link field, an expired or
   far-future link, and a non-canonical X25519 key.
4. **Fuzzing and property tests** of every parser: `verifyIndex`, `verifyIndexAnchor`, `readPackHeader`, `openPack`,
   `parseInvitationLink`, `openInvitationResponse`, `openSharingKey`, `decryptTransfer`, `decodeKeyExport`,
   `openVault`, `decodePrimaryIdentity`, `checkLocation`. Only a `TLCryptoError` may escape, and nothing may run longer
   than the size bounds allow. Add property tests that `serialize` followed by verification round-trips, and that the
   ordering in `checkNoRollback` is a total order within an owner.
5. **Cross-implementation check**: a second, minimal reader (for example in Rust or Python) that reads the KAT vectors,
   at least for canonical JSON, signatures, pack opening and token computation. It is the cheapest way to find
   ambiguities in the spec.
6. **The open protocol pieces specified**: the face-to-face QR contact format (R-13); the device-transfer QR key
   exchange ("Adding a device", way 1); the declaration sequence as an ordered, testable procedure (new keys, purge of
   invitations, re-encryption, credential revocation of every storage, vault diff since the theft); the
   app-side rule for which keys "friends" packs are wrapped to (open invitations included).
7. **A threat-model mapping for auditors**: each spec promise ("Loss and theft" steps 1-5, "one answer per
   invitation", re-encryption on acceptance or expiry, "a revoked device cannot pass as me", padding claims) mapped to
   the code path that enforces it, and to the app rules it relies on: the expiry sweep, reading only at the certified
   address and re-fetching after `MOVED`, `move` permanence, the HTTP-layer private-address filter, persisting
   `lastSeen`, and bundling a single copy of the package.
8. **Dependency pinning and build reproducibility** for `libsodium-wrappers-sumo`, a recorded `npm audit`, and a note
   on what in JS memory can be wiped.
