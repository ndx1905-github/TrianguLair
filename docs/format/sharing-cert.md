# Sharing certificate (`sharing-cert`, version 3)

The master key binds, in one signature, the owner's **current sharing key** (random X25519), the owner's **read
address** (`location`), and the **revoked devices**. A new **rotation** is issued whenever any of them changes
(a device declared lost or removed, a storage move, a new sharing key). Vectors: `vectors/sharing-cert.json`.
Code: `src/certs.ts`.

## 1. Shape

Canonical JSON, signed by the master key under the domain `sharing-cert` (README §5):

```json
{"key":"x25519:…","location":"https://storage.example.org/alice/","owner":"ed25519:…",
 "revoked_devices":["ed25519:…"],"rotation":3,"signature":"<b64u 64>","type":"sharing-cert","version":3}
```

| Field | Required | Value |
|---|---|---|
| `type` | yes | `"sharing-cert"` |
| `version` | yes | 3 (`minor`, `crit` optional: README §6) |
| `owner` | yes | owner id (master key) |
| `key` | yes | `"x25519:…"`, the sharing public key (validated: identity-and-keys.md §4) |
| `rotation` | yes | integer `0 … 2^32 − 1` |
| `revoked_devices` | yes | array of at most 256 device ids (`"ed25519:…"`), sorted (UTF-16 order), unique; permanent |
| `location` | no | read address (identity-and-keys.md §5); absent only for an owner who publishes nothing |
| `signature` | yes | master signature over `canon(cert \ {signature})` |

Rules for writers: `rotation` increases by at least 1 at every change of key, address or revoked devices; a later
rotation keeps every device revoked earlier; changing the address needs the master key (the phrase or the primary
device).

Two compact forms exist:
- **in an index** (`sharing_cert`): the full certificate minus `type`, `version`, `owner` and `revoked_devices`, which
  the index carries at top level or implies (signed-index.md §2). Any other member (`location`, `minor`, `crit`,
  extension fields) stays, so the master signature over the rebuilt full certificate still verifies;
- **in a return link**: a binary form without extension fields (return-link.md §2).

## 2. Verification (`verifySharingCert(input, {expectedOwner?, retiredOwners?, lastSeen?})`)

1. Transported text: canonical JSON object (README §4) → else ERROR(FORMAT). (An object built by the reader itself,
   such as the certificate rebuilt from an index or a return link, is taken as is.)
2. `checkStructure(cert, "sharing-cert", 3, [type, version, owner, key, rotation, revoked_devices, signature],
   [location], 0)`.
3. `type ≠ "sharing-cert"` → ERROR(FORMAT).
4. `owner`: parseKey ed25519 → ERROR(FORMAT).
5. `key`: parseKey x25519 → ERROR(FORMAT) or ERROR(INVALID_KEY).
6. `rotation`: not an integer in `0 … 2^32 − 1` → ERROR(FORMAT).
7. `location`, if present: not a string, or fails `checkLocation` → ERROR(FORMAT).
8. `revoked_devices`: not an array, or more than 256 entries → ERROR(FORMAT); each entry parseKey ed25519 →
   ERROR(FORMAT); not sorted and unique → ERROR(FORMAT).
9. `signature`: b64u of 64 bytes → else ERROR(FORMAT); Ed25519 verification with the `owner` key, domain
   `sharing-cert`, message `canon(cert \ {signature})` → else ERROR(SIGNATURE).
10. `owner` ∈ `retiredOwners` → ERROR(REVOKED).
11. `expectedOwner` given and ≠ `owner` → ERROR(OWNER_MISMATCH).
12. `lastSeen` given (a certificate already verified for this owner): `checkSharingCertNotOlder(cert, lastSeen)`.

## 3. `checkSharingCertNotOlder(next, last)` (both verified)

1. `next.owner ≠ last.owner` → ERROR(OWNER_MISMATCH).
2. `next.rotation < last.rotation` → ERROR(ROLLBACK).
3. `next.rotation = last.rotation`: if `canon(next) ≠ canon(last)` (key, address, revocations, signature, any
   extension field) → ERROR(ROLLBACK, fork = true); else accept (re-delivery).
4. Some device of `last.revoked_devices` is not in `next.revoked_devices` → ERROR(ROLLBACK) (no un-revocation).
5. Accept.

Ed25519 signatures are deterministic, so "the same certificate" and "the same signed content" coincide. Two holders
of the master key who declare a loss concurrently produce two certificates for one rotation: readers report a fork
until a certificate for the next rotation exists (THREATS.md, N-3).
