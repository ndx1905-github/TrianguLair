# Group key (payload `group-key`, version 2)

A recipient group is an X25519 key pair. Content packs wrap their batch key to the group's public key like to any
recipient; the group's secret key is distributed to members in an ordinary pack of payload type 2 (pack.md §3),
wrapped to each member. Removing a member: a new generation (new key pair), sealed to the remaining members, and
re-encryption of the packs wrapped to the old group key. Vectors: `vectors/group-key.json`. Code: `src/group.ts`.

## 1. Payload

Canonical JSON, inside a pack of type 2:

```json
{"generation":1,"group":"<b64u 16>","owner":"ed25519:…","secretKey":"<b64u 32>","type":"group-key","version":2}
```

| Member | Value |
|---|---|
| `type`, `version` | `"group-key"`, 2 (`minor`, `crit` optional) |
| `owner` | owner id of the index that lists the pack (also bound by the pack's AD) |
| `group` | stable group id, b64u of 16 random bytes; readers key groups by (owner, group) |
| `generation` | integer ≥ 1, +1 at each rotation |
| `secretKey` | b64u of the 32-byte X25519 secret; the public key is `X25519(secretKey, 9)` |

An invitation key is never a group member (it is a direct recipient of the content it may read): retiring an
invitation refuses a group-key pack it can open (return-link.md §6).

## 2. Opening (`openGroupKey(bytes, index, keys)`)

1. `openPack` steps 1–7 (pack.md §5), with all their errors.
2. The payload type is not 2 → ERROR(FORMAT).
3. Payload: strict UTF-8, canonical JSON object → else ERROR(FORMAT).
4. `checkStructure(payload, "group-key", 2, [type, version, owner, group, generation, secretKey], [], 0)`.
5. `type ≠ "group-key"` → ERROR(FORMAT).
6. `owner` not a string → ERROR(FORMAT); `owner ≠ index.owner` → ERROR(OWNER_MISMATCH).
7. `group` not a string, or not b64u of 16 bytes → ERROR(FORMAT).
8. `generation` not an integer ≥ 0 → ERROR(FORMAT); `generation < 1` → ERROR(FORMAT).
9. `secretKey` not b64u of 32 bytes → ERROR(FORMAT).

Because the pack must be listed in the owner's verified index and its AD binds the owner key, a former member
cannot forge "generation n + 1".
