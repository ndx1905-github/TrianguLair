# Return link (response version 4)

The invitee's answer: signed by the invitee's **device** (no master key needed), carrying their master-signed device
and sharing certificates (so their certified read address), bound to the inviter and to the invitation key, and sealed
to the invitation key. It travels through messaging. Vectors: `vectors/return-link.json`. Code: `src/invitation.ts`.

## 1. Layout

    response = 0x52 ("R") || version = 4 || crypto_box_seal(inner, invitation public key)
    inner    = invitation id (16) || responder master pk (32) || created (u32 s)
               || compact sharing certificate || compact device certificate (128) || signature (64)
    signature: responder DEVICE key, domain "invitation-response", over
               inner[0 .. len − 64) || inviter master pk (32) || invitation public key (32)

398 + 32 × (revoked devices) + L bytes before base64url; at most 9 600 bytes.

## 2. Compact certificates

Sharing certificate:

| Size | Field |
|---|---|
| 32 | sharing public key (X25519) |
| 4 | rotation (u32) |
| 2 | n = number of revoked devices (u16, ≤ 256) |
| 32 × n | revoked device keys, in the certificate's (sorted) order |
| 2 | L = location length in bytes (u16, ≤ 512; 0 = no location) |
| L | location, UTF-8 |
| 64 | master signature |

It is rebuilt as `{"key": "x25519:…", "location"?: …, "owner": <responder>, "revoked_devices": [...],
"rotation": r, "signature": "…", "type": "sharing-cert", "version": 3}` and verified (sharing-cert.md §2) with
`expectedOwner` = the responder. A certificate with any other member (`minor`, `crit`, extensions) cannot travel
in a return link.

Device certificate: `device pk (32) || box pk (32) || master signature (64)`, rebuilt as a version-1 device
certificate of the responder and verified (device-cert.md §2) with `expectedOwner` = the responder.

## 3. Writing (`createInvitationResponse(received, signer, sharingCert, {now?})`)

The invitation MUST have been confirmed (invitation-link.md §5) and not be expired; the responder's certificate
verifies; the signing device's certificate verifies for that owner, matches its keys, and is not revoked by the
certificate. `created` = now (seconds).

## 4. Opening (`openInvitationResponse(bytes, invitation, {now?})`, owner side)

`invitation` is the owner's record (id, owner, key pair, created, expires: invitation-record.md).

1. Not bytes, or fewer than 2 → ERROR(FORMAT); more than 9 600 → ERROR(FORMAT); byte 0 ≠ `0x52` → ERROR(FORMAT);
   byte 1: 0 → ERROR(FORMAT), ≠ 4 → ERROR(UNSUPPORTED_VERSION).
2. The record's `created` or `expires` is not a date → ERROR(FORMAT) (fail closed, V3-07).
3. `now ≥ expires + 7 days` (the grace period) → ERROR(EXPIRED).
4. Open the sealed box `bytes[2..]` with the invitation key pair → else ERROR(DECRYPT).
5. Read the inner bytes (any truncation → ERROR(FORMAT)): id 16; `b64u(id) ≠ invitation.id` → ERROR(FORMAT);
   responder pk 32; created u32;
6. compact sharing certificate: key 32 (validated: INVALID_KEY), rotation, n (> 256 → ERROR(FORMAT)), n keys, L
   (> 512 → ERROR(FORMAT)), location (if L > 0: strict UTF-8 → else FORMAT; `checkLocation` → else FORMAT), signature;
   rebuilt and verified as in §2 (FORMAT, INVALID_KEY, SIGNATURE, OWNER_MISMATCH);
7. compact device certificate: device 32, box 32 (INVALID_KEY), signature 64; verified as in §2;
8. signature 64; any byte after it → ERROR(FORMAT).
9. Verify the signature (domain `invitation-response`, §1) with the device key → else ERROR(SIGNATURE).
10. `created × 1000 < invitation.created − 5 minutes` or `created × 1000 ≥ invitation.expires` → ERROR(FORMAT).
11. The device is in the carried certificate's `revoked_devices` → ERROR(REVOKED).
12. Result: responder owner, device, sharing key and certificate, `created`, `location` (the certificate's, if any),
    and `openedAfterExpiry = (now ≥ expires)` (V4-06).

An answer opened during the grace period has a `created` claimed by the responder: anyone who kept the link can
produce one. It MUST NOT be granted silently, even when it is the only one.

## 5. Collecting answers (`collectInvitationAnswers(invitation, responses, {now?, acceptedOwner?})`)

1. The record's dates are not dates → ERROR(FORMAT) (an error of the record, not a rejected answer).
2. For each response, `openInvitationResponse`: ERROR(EXPIRED) is raised to the caller; any other error counts in
   `rejected`. Keep one answer per responder owner: the first, replaced by a later one only if its certificate
   rotation is higher.
   `answers` lists the kept answers in the order of each responder's first valid answer (a replacement keeps that
   place).
3. `multiple` = more than one responder. Without `acceptedOwner`: `accepted` = the single answer if exactly one
   responder, else none. With `acceptedOwner`: `accepted` = that responder's answer (or none), `late` = every other
   responder's answer (warn: the first may have been an impostor).

The owner keeps the record until expiry + 7 days, also after acceptance, and keeps collecting with `acceptedOwner`.

## 6. The responder's index (`checkInvitationIndex(answer, index)`, answer path), and retirement

The owner reads the responder's index at `answer.location` (the certified one), verifies it with `expectedOwner` =
responder and `location`, then:

1. The index is not owner-bound → ERROR(FORMAT).
2. The answer has no read address → ERROR(FORMAT): its device cannot be checked (show "cannot be checked" until the
   safety code is compared).
3. Read address unknown or ≠ the index's certified address → ERROR(FORMAT).
4. `index.owner ≠ answer.owner` → ERROR(OWNER_MISMATCH).
5. `checkSharingCertNotOlder(index certificate, answer certificate)` (same rotation → the very same certificate;
   later → every revocation kept; else ROLLBACK).
6. The answer's device is in the index's `revoked_devices` → ERROR(REVOKED).
7. `lastSeen` given → `checkNoRollback(index, lastSeen)`.

**Retirement** (`retireInvitationKey(packs, ownIndex, invitationKeyPairs, recipientsFor)`), on acceptance or expiry
of an invitation (or for every cancelled one at a declaration of loss): `packs` MUST contain the bytes of every file
listed in the owner's index (else FORMAT, V3-08); each pack any of the invitation keys opens is **re-encrypted** (new
batch key and nonce, same id and type, pad kept) for `recipientsFor(id)`, which MUST NOT contain an invitation key
(FORMAT); a group-key pack opened by an invitation key is refused (FORMAT: rotate the group instead). Packs no
invitation key opens are untouched.
