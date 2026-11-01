# Invitation record and its device signature

The owner's private record of an open invitation, kept in the recovery vault (vault.md) until expiry + 7 days so
that any of the owner's devices can list it, collect answers and retire it. The **creating device** signs it, with its
master-signed device certificate, so a stolen device (which holds the vault data key) cannot write a record in
another device's name or extend one. Vectors: `vectors/invitation-record.json`, `vectors/vault.json`.
Code: `src/invitation-listing.ts`, `src/vault.ts`, `src/signed-index.ts` (`listable`).

## 1. Vault form

A member of the vault records' `invitations` (sorted by `id`):

```json
{"accepted":"ed25519:…","answers":["<b64u return link>"],"created":"2026-10-20T12:00:00.000Z",
 "device_cert":{"box":"x25519:…","device":"ed25519:…","signature":"<master>"},
 "expires":"2026-10-27T12:00:00.000Z","id":"<b64u 16>","location":"https://…","rotation":0,
 "seed":"<b64u 16>","signature":"<b64u 64>"}
```

| Member | Value |
|---|---|
| `id` | invitation id, derived from `seed` (invitation-link.md §2) |
| `seed` | the link's 16-byte seed: the invitation key pair and id derive from it |
| `rotation` | u32, the sharing-certificate rotation when inviting (in the link and the token) |
| `location` | the read address written in the link (in the token) |
| `device_cert` | compact device certificate (device-cert.md §1) of the creating device |
| `created`, `expires` | JSON dates on whole seconds; `0 < expires − created ≤ 7 days` |
| `signature` | creating device, domain `invitation-record` (§2) |
| `answers` | every return link received, b64u, sorted, unique, at most 16, each at most 13 000 characters |
| `accepted` | optional owner id of the accepted responder |

## 2. Signed bytes

    message = owner master pk (32) || id (16) || invitation public key (32) || u32 rotation
              || u32 created (s) || u32 expires (s) || u16 L || location (L bytes, UTF-8)
    signature = Ed25519(creating device key, "TrianguLair-signature-v1\ninvitation-record\n" || message)

All fields have fixed lengths except the length-prefixed address, which comes last, so the encoding is unambiguous.
There is **no version byte**: any future change of the signed fields or their encoding MUST use a new domain
(for example `invitation-record-v2`). `seed` is bound through `id` and the key, `device` through the verifying key.
Dates are signed as seconds, so two spellings of the same instant verify alike.

## 3. Checks

**`checkOwnerInvitation(inv)`** (the record turned into an invitation: owner, id, seed, key pair, rotation, device,
device certificate, location, created, expires, signature):

1. `owner` parseKey ed25519 → ERROR(FORMAT).
2. `created`, `expires`: a date on a whole second, `0 ≤ t ≤ 2^32 − 1` seconds → else ERROR(FORMAT).
3. `expires ≤ created` → ERROR(FORMAT); `expires − created > 7 days` → ERROR(FORMAT).
4. `rotation` not an integer in `0 … 2^32 − 1` → ERROR(FORMAT).
5. `checkLocation(location)` → else ERROR(FORMAT).
6. The seed is not 16 bytes, or the derived id or public key differs from the record's → ERROR(FORMAT).
7. The device certificate verifies for `owner` (device-cert.md §2: its errors) and names `device` (else FORMAT).
8. `signature` b64u 64 bytes (else FORMAT) verifies over §2 with the device key → else ERROR(SIGNATURE).

It says nothing about revocation or expiry. Reading a vault record (`recordInvitation`) first checks `seed` (b64u of
16 bytes, FORMAT), the id derived from it (FORMAT), the compact device certificate (an object, FORMAT; implied members,
FORMAT; then verified for the vault's owner), the u32 `rotation` and the string members (FORMAT), then runs the
checks above.

**`listable(inv, cert, now)`**: what a writer does with a record when it publishes an index under the sharing
certificate `cert` at time `now` (`signIndex`, `invitationStatus`). It **never throws**: any error is `"invalid"`.
In this order:

1. `inv.owner ≠ cert.owner` → `"invalid"`.
2. `checkOwnerInvitation(inv)` fails → `"invalid"` (planted, corrupted, unsigned, lifetime over 7 days).
3. The creating device is in `cert.revoked_devices` → `"revoked"`.
4. `expires ≤ now` → `"expired"`.
5. `inv.rotation < cert.rotation` → `"superseded"`: any rotation cancels the invitations open before it (R5-01).
6. `inv.rotation > cert.rotation`, or `created > now + 5 minutes` → `"not-yet"` (R5-02): genuine but not listable
   yet (the publisher has not received the newer certificate, or the creating device's clock is ahead).
7. Listed: its token (invitation-link.md §3) with the record's rotation, expires and location.

`"expired"` comes before `"superseded"` and `"not-yet"`, so every genuine record ends as `"expired"` within 7 days.
Only `"invalid"`, `"revoked"` and `"expired"` (after the grace period) allow deleting the record; `"superseded"` and
`"not-yet"` records are kept. A record never prevents publishing an index. Content is wrapped only to invitations
whose status is `"listed"`.
