# Key export (`key-export`, version 3)

The payload of a transfer blob (transfer-blob.md): the owner's **current** sharing key, its certificate and the vault
data key. The master key never travels; the new device generates its own device keys and needs a device certificate
from the primary device or the phrase before it can publish. Vectors: `vectors/key-export.json`.
Code: `src/transfer.ts`.

## 1. Shape

Canonical JSON (UTF-8 bytes):

```json
{"cert":<full sharing certificate>,"secret":"<b64u 32>","type":"key-export","vault_key":"<b64u 32>","version":3}
```

`minor` and `crit` optional; no other member at minor 0.

## 2. Decoding (`decodeKeyExport(bytes, {expectedOwner?, retiredOwners?, lastSeen?})`)

1. Strict UTF-8, canonical JSON object → else ERROR(FORMAT).
2. `checkStructure(doc, "key-export", 3, [type, version, secret, vault_key, cert], [], 0)`.
3. `type ≠ "key-export"` → ERROR(FORMAT).
4. Verify `cert` (a nested object) as a sharing certificate with the options (sharing-cert.md §2). Pass `lastSeen`
   whenever the receiving device already holds a certificate (R-08).
5. `secret` b64u 32 bytes → else ERROR(FORMAT); `X25519(secret, 9)` ≠ the certified key → ERROR(FORMAT).
6. `vault_key` b64u 32 bytes → else ERROR(FORMAT).
