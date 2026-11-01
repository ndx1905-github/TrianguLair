# Identity move (`identity-move`, version 1)

After the theft of the primary device (which holds the master key), the owner creates a new identity and publishes a
move: the **old** master signs that the identity now lives under the **new** master key, and the new master
countersigns, so nobody can move "to" a key they do not hold. It is published as the `move` member of every index of
the new identity. Vectors: `vectors/identity-move.json`, `vectors/signed-index.json` (`index-move-*`).
Code: `src/identity.ts`, `src/signed-index.ts`.

## 1. Shape

```json
{"from":"ed25519:<old owner>","issued":"2026-10-20T12:00:00.000Z","signature":"<old master>",
 "to":"ed25519:<new owner>","to_signature":"<new master>","type":"identity-move","version":1}
```

Signed bytes:
- `to_signature`: new master, domain `identity-move-to`, message `canon(move \ {to_signature, signature})`;
- `signature`: old master, domain `identity-move`, message `canon(move \ {signature})` (it covers `to_signature`).

The writer computes `to_signature` first, then `signature`.

## 2. Verification (`verifyIdentityMove(input, {expectedFrom?})`)

1. Transported text: canonical JSON object → else ERROR(FORMAT).
2. `checkStructure(move, "identity-move", 1, [type, version, from, to, issued, to_signature, signature], [], 0)`.
3. `type ≠ "identity-move"` → ERROR(FORMAT).
4. `from`, `to`: parseKey ed25519 → ERROR(FORMAT). Equal keys → ERROR(FORMAT).
5. `issued`: JSON date (README §3) → else ERROR(FORMAT). It is informational.
6. `to_signature`: b64u 64 bytes → else ERROR(FORMAT); verify with `to` → else ERROR(SIGNATURE).
7. `signature`: b64u 64 bytes → else ERROR(FORMAT); verify with `from` → else ERROR(SIGNATURE).
8. `expectedFrom` given and ≠ `from` → ERROR(OWNER_MISMATCH).

## 3. Use by readers

In `verifyIndex` (signed-index.md §4): a valid `move` MUST lead to the index's owner (`move.to = owner`, else
ERROR(FORMAT)). A reader that expects the old identity gets ERROR(IDENTITY_MOVED, from, to): nothing is accepted
automatically. The app shows "X changed their identity", removes the "verified" mark, then verifies again with
`expectedOwner = to` and `retiredOwners ∋ from`; from then on everything signed by the old master is ERROR(REVOKED).
A valid move from an identity the reader already retired to **another** successor is ERROR(IDENTITY_MOVED,
conflict = true): two moves exist, the old master is compromised.

App rule (R-11, not enforceable by the format): the new identity keeps `move` in every index; the library cannot know
that an index of the new identity should carry it.
