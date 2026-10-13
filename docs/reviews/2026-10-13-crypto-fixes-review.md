# Review of the T-002 fixes in the crypto package (packages/crypto, format v2)

- **Date:** 2026-10-13
- **Reviewer:** independent agent. I did not write T-001, T-002 or the fixes.
- **Scope:** branch `t-001-crypto-fixes` at `17dd10c`, diffed against `origin/t-002-crypto-review` (`packages/crypto`, `docs/SPEC.md`). I read all of `src/`, `README.md` and `THREATS.md` in full. The spec sections checked were "Invitation link and return link", "Organization on the storage", "Recovery kit", "Adding a device", "Loss and theft", "Data model" (signed index) and "Threat model". **The spec is the source of truth.**
- **Method:** line-by-line reading, plus experiments against the library. Each new finding marked *(test)* is reproduced in `packages/crypto/test/review-fixes.test.ts` as an `it.fails(...)` that states the **desired** behaviour. `src/` was not modified.
- **Build:** `npm install --workspaces=false` reports 0 vulnerabilities. `npm test` gives 12 files: 133 tests pass and 6 fail as expected (the new reproductions). `npm run typecheck` is clean.

## Verdict: **merge after fixes**

The rewrite is a real redesign, not a patch to make tests pass. It adds a three-level key hierarchy (master, random sharing key, per-device keys), certificates embedded in the index, content-addressed packs with the logical id inside the encryption, Padmé padding, canonical-input enforcement, compact invitations bound to the inviter, a full-strength safety code, and an index-gated `openPack`. Most first-review findings are genuinely fixed, and I could not break the primitives or the new binary encodings.

One new **high** finding defeats the main goal of F-01 and has to be fixed before the v2 index format is frozen:

- **R-01.** `seq` is the *only* ordering key. A stolen device that has not yet been revoked can publish `seq = 2^53-1` once.
- From then on, every friend who saw that index refuses the owner's revocation index forever. Those friends keep wrapping to the sharing key the thief holds.
- The only way out is an identity change.

Three medium findings concern the invitation and key-management design:

- **R-02.** Invitation retirement does not cover group secrets.
- **R-03.** Every invitation and every return link needs the master key, which contradicts the spec.
- **R-04.** "One answer per invitation" only holds if the answers arrive together.

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | none |
| High | 1 | R-01 |
| Medium | 3 | R-02, R-03, R-04 |
| Low | 9 | R-05 to R-13 |
| Note | 6 | N-1 to N-6 |

---

## Status of the first review's findings

| ID | Topic | Status | Evidence / residual |
|---|---|---|---|
| F-01 | Theft of a full device: future sharing keys derivable, certs hijackable | **Partially fixed** | Fixed by design. Sharing keys are random (`identity.ts:117`). Ordinary devices hold only device keys plus a sealed sharing key (`sharing-key.ts`). `rootSeed` is gone. Certificates and `revoked_devices` are master-signed, so a device cannot certify a key or revoke real devices. I verified this by trying to forge a sharing cert and a revocation list with a device key: both are rejected. **However**, R-01 lets the stolen device stop the revocation from ever reaching readers, and R-07 is an easy way to hand the new key to the thief. |
| F-02 | Intercepted invitation persists past acceptance/expiry; first answer wins | **Partially fixed** | `retireInvitationKey` re-encrypts the packs instead of re-wrapping them, and `collectInvitationAnswers` refuses multiple responders. Residual issues: group secrets (R-02), answers that arrive after acceptance (R-04), and an expiry sweep that still depends on the app running (documented). |
| F-03 | Low-order X25519 keys | **Verified fixed** | `assertX25519PublicKey` (`encoding.ts:268`) is applied in `parseKey`, in `formatKey` and per recipient in `makeWraps` (`pack.ts:134`). Any failure is an `InvalidKeyError`. |
| F-04 | Far-future `updated` locks readers out | **Verified fixed** for `updated`, which is now informational with a 24 h future skew (`signed-index.ts:172`). The same lock-out now happens through `seq` (R-01). |
| F-05 | Non-canonical signed JSON | **Fixed, with a residual** | `parseJsonObject` requires `canonicalize(JSON.parse(s)) === s` (`encoding.ts:157`). I tested duplicate keys, `A` escapes, `-0`, `1e2`, integers above 2^53, whitespace and key order: all are rejected. A UTF-8 BOM is still accepted on byte inputs (R-09). |
| F-06 | No sender authentication for packs or group-key packs | **Verified fixed** | `openPack` requires a registered, frozen, verified index and checks the hash before any X25519 operation (`pack.ts:303-321`). The group-key payload carries `owner` and is checked against the index (`group.ts:76`). Content packs are still not bound to an owner (R-05, which was N-4 in the first review). |
| F-07 | Cert freshness outside rollback protection | **Partially fixed** | The sharing cert, the revocations and the device cert are inside the index, so they inherit `seq` rollback protection. A reader with no prior state (a new friend) is still trust-on-first-use (R-12). |
| F-08 | No padding | **Verified fixed** | The plaintext is framed as `id ‖ len ‖ payload ‖ zeros` with Padmé and a 256 B minimum. `pad` is covered by the AD. Readers check the exact length and that the padding is zero (`pack.ts:191-213`). |
| F-09 | Transfer code params / expiry / purpose | **Verified fixed** | 6 BIP39 words give 66 bits. Argon2 parameters are floored at INTERACTIVE and capped at 10 passes and 256 MiB on both sides. `expires` and the purpose byte are covered by the AD, and expiry is checked before the KDF. Offline brute force costs about 2^65 Argon2id(2, 64 MiB) evaluations, which is infeasible. |
| F-10 | DoS bounds | **Verified fixed** | `MAX_WRAPS = 256`, checked before any key generation (`pack.ts:131`). The hash is checked before trial decryption. |
| F-11 | Arbitrary file / public strings | **Verified fixed** | A file name must equal `packs|media/b2b256-<hash>.bin` for its own hash, and duplicates are rejected. `public` is constrained by `PUBLIC_RE`. The public file still has no hash (R-06). |
| F-12 | Response binding / validation | **Verified fixed** | The response signature covers `inviter pk ‖ invitation pk` (`invitation.ts:233`). `created` is checked against the invitation window. The response carries an optional `location`. It is 270 B, or 360 base64url characters. `checkLocation` has gaps (R-10). |
| F-13 | Input-validation rough edges | **Verified fixed** | Integer ttl ≥ 60 s with a round-trip check. `nowMs` validates its input. `isoDate` round-trips, so Feb 30 is rejected. The key export binds the secret to the cert by public key. `generation ≥ 1`. |
| F-14 | Secret hygiene | **Mostly fixed** | Entropy, root, master seed, batch keys and plaintexts are wiped, and `rootSeed` is removed. `rewrapPack` still decrypts the whole payload, then wipes it. Strings that hold secrets (JSON payloads, base64) are documented in THREATS. |
| F-15 | Error leakage | **Verified fixed** | Numbers are no longer echoed, and the codes are documented as local-only. The remaining messages only echo lengths, versions or public keys. |
| Q1 | `seq` in the index | **Done**, but "sole ordering key" causes R-01. Recommendation: order by `(sharing_cert.rotation, seq)`. |
| Q2 | Content hash, not storage ETag | **Done** (`b2b256:` prefix, 256 bits). |
| Q3 | Logical id hidden, content-addressed files | **Done**. |
| Q4 | Compact invitation | **Done**: 156 + L bytes, about 264 characters with a typical address. The QR face-to-face exchange format is not defined (R-13). |
| Q5 | Safety number | **Implemented** (`safety.ts`). It is order-independent, the 12 × 5 digits give about 199 bits, and the QR form gives 256 bits. The per-group modulo bias of about 1e-7 is negligible. There is a known-answer vector. The spec made verification **optional**, a product decision that the spec records. Combined with R-04, the default grant goes to whoever answers first. |
| N-6 | KAT vectors | **Partial**: there are vectors for phrase → owner and for the safety code. Vectors are still missing for exact signed bytes per domain, a fixed pack, a fixed transfer blob, a sealed sharing key and an invitation link. |

---

## High

### R-01: `seq` as the only ordering key lets a stolen, not-yet-revoked device block its own revocation forever *(test)*

**Where:** `src/signed-index.ts:238-247` (`checkNoRollback`, with the `seq` comparison at line 241 running before any certificate comparison) and `src/encoding.ts:204` (`seq` ≤ 2^53-1). Spec, Data model: "`seq` … it alone orders indexes". README "Declare a device lost": "the index rules below stop it from publishing".

**Problem.** Any certified, unrevoked device can sign an index with any `seq`. Ordinary devices are the ones stolen in the spec's theft scenario. Suppose a thief publishes `seq = Number.MAX_SAFE_INTEGER` once, before the owner declares the device lost:

1. Every friend who syncs in that window persists the jammed index as `lastSeen`.
2. The owner's "Declare a device lost" index has a higher master-signed rotation and lists the device as revoked, but it carries a lower `seq`. Readers refuse it with `ROLLBACK`.
3. The owner cannot publish a higher `seq`, because 2^53 is not a safe integer.
4. Friends never learn the new sharing key, so they **keep wrapping their content to the old sharing key, which the thief holds**.
5. Loss-and-theft step 2 ("the thief no longer sees any update") and step 3 (friends adopt the new key) both fail. The only escape is an identity change, which the two-level key design was meant to avoid.

A variant needs no jamming in advance. A reader whose `lastSeen` predates the revocation can be served the revoked device's index, which carries the *old* certificate and a high `seq`. The reader accepts it and is then locked out in the same way.

A buggy honest device has the same effect.

This was reproduced in `review-fixes.test.ts` (R-01). After the jam, `verifyIndex(revocation, { lastSeen: jammed })` throws `ROLLBACK: seq 2 < last seen 9007199254740991`.

**Fix (format-level, before T-201):**

- Order indexes by **`(sharing_cert.rotation, seq)` lexicographically**:
  - A strictly higher master-signed rotation is accepted whatever its `seq`, as long as it does not un-revoke a device.
  - `seq` only orders indexes within one rotation.
  - Only the master can raise the rotation, so a device cannot outrank a revocation.
  - In `checkNoRollback`, compare rotations first and call `checkSharingCertNotOlder` before the `seq` test.
- Optionally, bound how far `seq` can jump within one rotation (for example, refuse `seq > lastSeen.seq + 2^20`), and reset or continue `seq` freely on a new rotation.
- Update the spec's Data model bullet ("it alone orders indexes") and README accordingly, and add the R-01 test as a plain `it`.

---

## Medium

### R-02: `retireInvitationKey` re-encrypts a group-key pack but keeps the same group secret *(test)*

**Where:** `src/invitation.ts:333-363` (it opens with `[invitationKeyPair]` only and re-seals the same payload) and `src/group.ts`. Spec: "Re-encryption on acceptance or expiry … someone who kept a copy of the link can no longer read anything new."

**Problem.** "Everything I share with friends" can naturally be implemented as a crypto group, which `group.ts` exists for. In that case the invitation key receives the group secret in a group-key pack. `retireInvitationKey` then does two things:

- It re-encrypts that group-key pack with the **same group secret** inside.
- It skips the content packs wrapped to the group public key, because the invitation key cannot open them directly.

The link holder keeps the group secret, so they read all current and **future** content wrapped to the group. The helper reports success. The README never says whether the invitation key may join a group.

**Fix:** in `retireInvitationKey`, parse each re-encrypted payload. If it is a `group-key` payload, throw, or return it in a `groupsToRotate` list. Rotating means `rotateGroup`, then `sealGroupKey` to the remaining members, then `reencryptPack` of every pack wrapped to the old group public key. Document in the README that the invitation key must be a direct recipient and never a group member, or provide `retireInvitationKey` with the group-rotation step built in.

### R-03: Creating an invitation and answering one both require the master key, contradicting the spec's key hierarchy

**Where:** `src/invitation.ts:122-146` (`createInvitation(identity: Identity)` signs with `identity.master.secretKey`) and `src/invitation.ts:211-236` (`createInvitationResponse(…, invitee: Identity, …)` signs with the invitee's master key). Spec, Loss and theft (line 543): the master key "is kept only on the primary device (optional) and is otherwise recreated from the 12 words when needed: adding or removing a device, changing the sharing key." Invitations are not in that list.

**Problem.** With the spec's default, where no primary device keeps the master, users must type the 12 words **every time they invite a friend or answer an invitation**. In practice this pushes everyone to keep the master on a primary device. That device then becomes a single point of identity compromise: theft means an identity move and re-verification with every friend. The two-level design no longer protects anything.

**Fix (decide and write into the spec):**

- **(a)** Sign invitations and responses with the **device key**, and carry the master-signed device cert. In the link this adds device pk 32 B, box pk 32 B and cert signature 64 B, about 170 more characters. Alternatively, add a `devices` list of device certs to the index and carry only the 32 B device id in the link. The verifier checks the device cert against the owner and checks that the device is not revoked in the index read at `location`.
- **(b)** Keep master signatures and amend the spec: inviting needs the primary device or the 12 words. Then state the consequence for the theft scenario.

### R-04: "One answer per invitation" only holds when the answers arrive together

**Where:** `src/invitation.ts:307-324` (it is stateless: a single responder gives `accepted`). Spec, line 76: "If several answers arrive … none is accepted automatically".

**Problem.**

- An interceptor reads the link at the same time as the friend and can answer first.
- When the owner's app processes the batch that contains only the interceptor's answer, `accepted` is that answer, and the default "friends" scope is granted.
- The real friend's answer arrives later. Re-running `collectInvitationAnswers` now returns `multiple: true, accepted: null`, but the grant already happened.
- After acceptance the app is expected to retire the invitation, so the later answer may never be looked at.
- The safety code is optional, so nothing else catches this.

**Fix:**

- Keep the invitation record, including its key pair, in the vault until **expiry**, even after acceptance.
- Add a parameter such as `collectInvitationAnswers(inv, responses, { acceptedOwner })` that returns `late: InvitationResponse[]` for any other responder. The UI shows "a second person answered this invitation; the first may have been an impostor", offers to revoke, and runs `reencryptPack`.
- Consider granting a reduced scope, or delaying the grant, until the user confirms the requester's name or compares the code.
- Update the threat-model row "Impersonator" accordingly.

---

## Low

### R-05: Content packs are not bound to their owner (re-attribution) *(test)*

**Where:** `src/pack.ts:106-108` (the AD has no owner), `src/pack.ts:318-321`.

Mallory is a recipient of Alice's pack, and so is Bob. Mallory lists Alice's pack bytes, current or **old**, in Mallory's own signed index. Bob opens it through Mallory's verified index, and the app attributes Alice's places and comments to Mallory. Mallory can also resurrect content that Alice deleted, under Mallory's name. Group-key packs are protected against this (`owner` is in the payload); content packs are not.

**Fix:** add `owner` to the protected header, inside the AD. Have `openPack` require `header.owner === index.owner`, or put the owner inside the encrypted frame and compare it after decryption. The header cost is 51 bytes.

### R-06: The public list file is not covered by the signature

**Where:** `src/signed-index.ts:58, 208`. `public` is a bare path with no hash.

The plaintext GeoJSON of public lists can be modified by the storage host, or by anyone with write access, and the app has nothing to check it against. The spec says all content read from a friend is verified (signature) before display.

**Fix:** use `public: { file, hash }` with the same content-addressed rule as the packs, or at least a `public_hash` field.

### R-07: `sealSharingKey` seals a new key to a device that its own certificate revokes *(test)*

**Where:** `src/sharing-key.ts:316-326`.

In "Declare a device lost", one stale device list in the app sends the new sharing key straight to the thief. The library accepts it silently.

**Fix:** if `sharing.cert.revoked_devices.includes(dc.device)`, throw `SignatureError('REVOKED')`.

### R-08: `lastSeen` for sealed sharing keys and key exports works at run time but is untyped and undocumented

**Where:** `src/sharing-key.ts:343` and `src/transfer.ts:162` (the `opts: TrustOptions` object is passed to `verifySharingCert`, which honours `lastSeen`).

Anyone can seal to a device's box key, which is public in the index. A thief holding the old sharing key and its valid certificate can push it back to a remaining device. If the app does not pass `lastSeen`, the device may adopt the old key and wrap its own new content to it.

I first wrote this up as a missing check, but a test showed that the check happens if `lastSeen` is passed. The type (`TrustOptions`) and the README (`{ expectedOwner? }`) hide it.

**Fix:** add `lastSeen?: SharingCert` to the option types of `openSharingKey` and `decodeKeyExport`, document it, and require it whenever the device already holds a key.

### R-09: A UTF-8 BOM bypasses the canonical-bytes rule *(test)*

**Where:** `src/encoding.ts:5`. `new TextDecoder('utf-8', { fatal: true })` strips a leading BOM by default (`ignoreBOM: false`).

A pack header with `EF BB BF` in front of the canonical JSON is accepted. This is the residual of F-05: two byte strings decode to the same header, which makes test vectors ambiguous and goes against "transported bytes MUST be canonical". The same applies to every `fromUtf8` input: sealed sharing keys, key exports and group payloads (all inside an AEAD).

**Fix:** use `{ fatal: true, ignoreBOM: true }` so that the BOM stays in the string and fails the canonical comparison.

### R-10: `checkLocation` allows parser differentials and LAN addresses *(test)*

**Where:** `src/invitation.ts:91-102`.

- `https://good.example\@evil.example/` is accepted. WHATWG parses the host as `good.example`, but other URL parsers (Swift `URL`, Kotlin, curl) may not.
- `https://localhost/` and `https://192.168.1.1/` are accepted. The response `location` comes from an **untrusted** requester, and the owner's app will fetch it, which allows LAN or SSRF probing from the owner's phone. This is the same concern as F-11, applied to the new field.

**Fix:**

- Require `new URL(l).href === l` (canonical form) and reject a backslash.
- Reject loopback, link-local and RFC 1918 IP literals and `localhost` in response locations, or at least require explicit confirmation before fetching them.

### R-11: No detection of conflicting identity moves

**Where:** `src/signed-index.ts:210-224` and `src/identity.ts:174-190`. THREATS: "readers keep the first move they see".

When the primary device is stolen, the owner (move A→B) and the thief (move A→T) hold the same old master, and both moves are valid. Suppose a reader followed A→T first and later sees B's index with move A→B. The reader gets a generic `OWNER_MISMATCH`, with nothing that says "two different successors of A exist: the old identity is compromised".

**Fix:**

- When an index carries a valid `move` whose `from` is in `retiredOwners` but whose `to` is not the expected owner, throw a distinct error (for example `IdentityMovedError` with `conflict: true`) so that the UI can warn and force safety-code verification.
- Require the new identity to keep `move` in every index until all friends have migrated, or permanently. Today the field is optional and can be dropped, which strands friends who were offline.

### R-12: New readers are still trust-on-first-use for index freshness

**Where:** the invitation link (`src/invitation.ts:39-51`) carries no freshness anchor.

A device that has been revoked, or the storage host, can serve a brand-new friend an old index whose old certificate does not list the device as revoked. The friend then wraps content to an old, compromised sharing key. THREATS documents this.

**Fix (cheap):** add `min_rotation` (u32) to the signed invitation link, and to the face-to-face QR. The invitee then refuses an index whose sharing-cert rotation is lower. Together with R-01's rotation-first ordering, this gives every new reader a freshness anchor signed by the owner.

### R-13: Spec and code inconsistencies

- SPEC.md:815 (Privacy, Security) says "comparing a **short code**". This contradicts the 12 × 5-digit code everywhere else, and the first review warned against short codes.
- SPEC.md:519: the recovery vault holds friends, groups and credentials "encrypted with the key". Ordinary devices do not hold `vaultKey` but must update the friend list. THREATS acknowledges this, but the spec has to name a vault key that ordinary devices can use without being able to read the vault copy of the sharing key. For example, use a separate vault data key distributed like the sharing key, and rotate it on theft.
- SPEC.md:76-81, "When meeting face to face, an exchange of QR codes replaces the two links … marked as verified automatically": the QR contact payload (owner, sharing cert, location) has no defined format or parser in the library. It needs a versioned, signed or at least canonical encoding before T-201, so that "verified automatically" refers to something concrete.
- SPEC.md:720, "A device listed in `revoked_devices` can no longer publish", and the README equivalent: this only holds after R-01 is fixed, and only for readers who saw the revocation (R-12).
- The README index example is consistent with the code, and the format tables, version constants and byte layouts match `src` (I checked the link size of 156 + L B and the response size of 270 B).

---

## Notes

- **N-1:** X25519 public keys with bit 255 set (non-canonical encodings of the same point) are accepted, so two `"x25519:…"` strings can denote one key. This is harmless for sealing, but at equal rotation it causes spurious "fork" errors. Consider rejecting `pk[31] & 0x80`.
- **N-2:** `paddedLength` uses `Math.log2`. It is correct for every length up to 2^32, but define Padmé with integer bit operations in the spec, and add vectors, so that the Swift and Kotlin implementations agree exactly.
- **N-3:** The verified-index registry is a module-level `WeakSet` (`verified.ts`). If two copies of the package are bundled, verified indexes from one copy are `NOT_INDEXED` in the other. This fails closed, but it is confusing; document it.
- **N-4:** The invitation link's `created` is not bounded against the reader's clock. Only the owner can sign a link, so this is informational. The u32 seconds field overflows in 2106.
- **N-5:** The response `location` and the responder's identity are readable by any link holder (sealed to the invitation key). THREATS already documents this.
- **N-6:** Things I checked and found sound:
  - The domains of the identity-move countersignature (the `to` key must consent).
  - Device-cert verification inside the index (owner from the index, revoked check).
  - The canonicalization edge cases (lone surrogates are escaped by `JSON.stringify`, and `__proto__` keys are rejected as unknown).
  - The binding between pack hash and file name.
  - The padding check.
  - The sealed sharing key's `to` binding and vault AD.
  - The transfer header AD and the bounds on its parameters.
  - The safety-code order independence.

---

## Recommended order

1. **R-01** (index ordering by rotation, then seq): a format and spec change, so it must happen before T-201.
2. **R-03** (who signs invitations), then **R-02** and **R-04** (invitation retirement and late answers). Update the spec's invitation section and threat-model rows.
3. **R-05**, **R-06** and **R-12**: format additions (owner in the pack AD, public hash, `min_rotation` in the link).
4. **R-07** to **R-11** and **R-13**: hygiene and spec wording. Then turn the `it.fails` tests in `test/review-fixes.test.ts` into plain tests and complete the KAT vectors.
