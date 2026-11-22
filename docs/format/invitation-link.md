# Invitation link (version 5)

A short, **unsigned** link carrying only what cannot be fetched: the owner's master key, the read address, a 16-byte
secret seed, the rotation and the expiry. What binds it to the owner is that the owner's current signed index, read
at the master-certified address, **lists** its token. Vectors: `vectors/invitation-link.json`.
Code: `src/invitation.ts`, `src/invitation-listing.ts`.

## 1. Layout

`https://example.org/i#<fragment>`, fragment = b64u of (big-endian):

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | magic `0x49` ("I") |
| 1 | 1 | version = 5 |
| 2 | 32 | owner master public key (Ed25519) |
| 34 | 16 | seed |
| 50 | 4 | rotation of the owner's sharing certificate when inviting (u32) |
| 54 | 4 | expires, u32 seconds |
| 58 | 1 … 504 | read address **without** its `https://` prefix, UTF-8 (the rest of the bytes) |

58 + (address length − 8) bytes: 146 characters with the URL prefix and a 40-character address. The fragment is
never sent to a server. The address is the certified one when inviting (the owner keeps it in the invitation record).

## 2. Derivations from the seed

    invitation secret key = BLAKE2b-256("TrianguLair-invitation-key-v1\n" || seed)    (an X25519 scalar, clamped on use)
    invitation public key = X25519(secret key, 9)
    invitation id         = b64u(BLAKE2b-128("TrianguLair-invitation-id-v1\n" || seed))   (digest length 16)

Content shared with an invitee before acceptance is wrapped directly to the invitation public key; return links are
sealed to it.

## 3. Listing token (version 2)

    token = "b2b256:" || b64u(BLAKE2b-256("TrianguLair-invitation-listing-v2\n" || owner master pk (32)
              || invitation public key (32) || u32 rotation || u32 expires || u16 L || address (L bytes)))

where `address` is the **full** read address written in the link, `https://` included, in UTF-8. Every field of the
link is bound: a link whose expiry, rotation, seed, key or address was changed has another token and is
`NOT_LISTED` (V4-04). The owner computes the token from its invitation record (invitation-record.md) and lists it in
every index published until expiry, under the record's rotation only (signed-index.md §6).

## 4. Parsing (`parseInvitationLink(linkOrFragment, {now?})`)

1. Not a string → ERROR(FORMAT). The fragment is everything after the first `#` if there is one, else the whole
   string.
2. More than 750 characters → ERROR(FORMAT) (checked before decoding).
3. Strict b64u decode → else ERROR(FORMAT).
4. Byte 0 (absent → FORMAT) ≠ `0x49` → ERROR(FORMAT). Byte 1 (absent → FORMAT): 0 → ERROR(FORMAT), ≠ 5 →
   ERROR(UNSUPPORTED_VERSION).
5. Owner key 32, seed 16, rotation u32, expires u32 (truncated → ERROR(FORMAT)). The owner key is not validated here.
6. The remaining length is 0 or more than 504 → ERROR(FORMAT). `location = "https://" || UTF-8 decode (strict →
   else ERROR(FORMAT))`.
7. `checkLocation(location)` → else ERROR(FORMAT).
8. `expires × 1000 > now + 7 days + 5 minutes` → ERROR(FORMAT) (V3-04).
9. Derive id and key pair (§2) and the token (§3).
10. `now ≥ expires × 1000` → ERROR(EXPIRED).

The result (owner, location, rotation, expires, id, key pair, token) is **not authenticated**: anyone can write a link
naming any master key. Nothing may be shown as coming from the owner, and no answer may be made, before step 5 below
accepts it.

## 5. Acceptance (`checkInvitationIndex(received, index, {lastSeen?, now?})`, link path)

The invitee reads the owner's index **only** at `received.location`, verifies it with
`verifyIndex(text, {expectedOwner: received.owner, location: <address fetched>, lastSeen?, now})` (signed-index.md §4),
and, on ERROR(MOVED), fetches again at the certified address it names (and only there), then:

1. The index is not owner-bound → ERROR(FORMAT).
2. (Return links only: no read address → ERROR(FORMAT); see return-link.md.)
3. The address the index was read from is unknown, or ≠ `index.sharing_cert.location` → ERROR(FORMAT): the index
   must have been verified with the address actually fetched, which must be its certified address.
4. `index.owner ≠ received.owner` → ERROR(OWNER_MISMATCH).
5. `index rotation < received.rotation` → ERROR(ROLLBACK): the index is older than the invitation (the rotation in the
   link is a freshness floor).
6. `index rotation ≠ received.rotation` → ERROR(NOT_LISTED): a later rotation (a declaration of loss, a storage
   move, a new key) cancelled the invitation (R5-01), even if a faulty writer still lists it.
7. `received.token` ∉ `index.invitations` (absent field = empty list) → ERROR(NOT_LISTED).
8. `now ≥ expires × 1000` → ERROR(EXPIRED).
9. `lastSeen` given (the owner is already a contact) → `checkNoRollback(index, lastSeen)`. A link MUST NOT reset an
   existing contact's anchor to trust on first use.
10. Accept: the invitation is confirmed; the index becomes the first `lastSeen` for this owner.

The vectors' `accept_invitation` op runs §4, then `verifyIndex` at `read_from` (default: the link's address), then §5.

Residual (THREATS.md): an index signed under the **old** certificate by a device that was later revoked, put back at
the certified address by someone with write access to it, is accepted by a new contact without an anchor
(`accept-stolen-device-tofu`); the declaration's step 4 (revoking storage credentials) closes it.
