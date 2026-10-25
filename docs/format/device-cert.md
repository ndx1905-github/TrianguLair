# Device certificate (`device-cert`, version 1)

The master key authorizes a device's Ed25519 key to sign indexes, invitation records and answers, and names the
device's X25519 box key (to which the sharing key is sealed). Device certificates never expire: a device is revoked by
listing it in the sharing certificate's `revoked_devices`. Vectors: `vectors/device-cert.json`. Code: `src/certs.ts`.

## 1. Shape

```json
{"box":"x25519:…","device":"ed25519:…","owner":"ed25519:…","signature":"<b64u 64>","type":"device-cert","version":1}
```

| Field | Value |
|---|---|
| `type` | `"device-cert"` |
| `version` | 1 (`minor`, `crit` optional) |
| `owner` | owner id (master key) |
| `device` | device id, `"ed25519:…"` |
| `box` | `"x25519:…"` (validated) |
| `signature` | master signature, domain `device-cert`, over `canon(cert \ {signature})` |

Compact forms: in an index and in a vault invitation record, `{box, device, signature}` plus any extension member
(the full certificate minus `type`, `version`, `owner`, which are implied; an implied member present in the compact
form is ERROR(FORMAT)); in a return link, the 128 bytes `device pk 32 || box pk 32 || signature 64`
(return-link.md §2).

## 2. Verification (`verifyDeviceCert(input, {expectedOwner?, retiredOwners?})`)

1. Transported text: canonical JSON object → else ERROR(FORMAT).
2. `checkStructure(cert, "device-cert", 1, [type, version, owner, device, box, signature], [], 0)`.
3. `type ≠ "device-cert"` → ERROR(FORMAT).
4. `owner`: parseKey ed25519 → ERROR(FORMAT).
5. `device`: parseKey ed25519 → ERROR(FORMAT).
6. `box`: parseKey x25519 → ERROR(FORMAT) or ERROR(INVALID_KEY).
7. `signature`: b64u 64 bytes → else ERROR(FORMAT); verify with the `owner` key, domain `device-cert` → else
   ERROR(SIGNATURE).
8. `owner` ∈ `retiredOwners` → ERROR(REVOKED).
9. `expectedOwner` given and ≠ `owner` → ERROR(OWNER_MISMATCH).

A device certificate says nothing about revocation: every user of a device signature also checks that the device is
not in the relevant sharing certificate's `revoked_devices`.
