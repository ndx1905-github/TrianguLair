# Recovery vault (`TLVD`, version 3)

The owner's private state that the security rules depend on (contacts with their certificates and freshness anchors,
open invitations with their answers, retired identities) plus free-form app data, encrypted with the random **vault
data key** that every device of the owner holds (it travels in `TLSK` and in the key export) and that the phrase copy
of `TLSK` keeps. It is renewed at every declaration of loss. Vectors: `vectors/vault.json`. Code: `src/vault.ts`.

## 1. Envelope

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `"TLVD"` |
| 4 | 1 | version = 3 |
| 5 | 24 | nonce (random) |
| 29 | … | XChaCha20-Poly1305(plaintext, AD = bytes[0..5) `\|\|` owner master pk (32) `\|\|` nonce, key = vault data key) |

    plaintext = u32 J || records (J bytes, canonical JSON, UTF-8) || zero padding,  length = padme(4 + J)  (pack.md §3)

## 2. Records

```json
{"app":{…},
 "contacts":[{"anchor":<index anchor>,"owner":"ed25519:…","sharing_cert":<full sharing certificate>,"verified":true}],
 "invitations":[<invitation record>],
 "owner":"ed25519:…",
 "retired_owners":["ed25519:…"],
 "type":"vault-records","version":3}
```

| Member | Value |
|---|---|
| `type`, `version` | `"vault-records"`, 3 (`minor`, `crit` optional) |
| `owner` | the vault's owner id |
| `contacts` | at most 10 000, strictly sorted by `owner`: `owner`, the contact's current `sharing_cert` (its key and certified read address), the optional `anchor` of the last index accepted from them (signed-index.md §7), and the user's `verified` mark (boolean) |
| `invitations` | at most 256 records (invitation-record.md §1), strictly sorted by `id` |
| `retired_owners` | at most 256 owner ids that moved away (never trusted again), sorted, unique |
| `app` | optional object, free-form (storage credentials, groups, settings) |

Only invitation records are authenticated by more than the vault data key (their device signature). A
security-relevant member added by a future minor MUST be signed by the device that wrote it, with its device
certificate, or come with a new major version: every device holds the vault data key, a stolen one included, and
merges keep unknown members (N-2 of the fifth review).

## 3. Opening (`openVault(bytes, owner, vaultDataKey)`)

1. Not bytes or fewer than 45 bytes → ERROR(FORMAT); magic ≠ `"TLVD"` → ERROR(FORMAT); version byte 0 →
   ERROR(FORMAT), ≠ 3 → ERROR(UNSUPPORTED_VERSION).
2. AD = `bytes[0..5) || owner pk || bytes[5..29)`; decrypt `bytes[29..]` → else ERROR(DECRYPT) (another key, another
   owner, tampered).
3. Plaintext shorter than 4 → ERROR(FORMAT); `J > length − 4` or `length ≠ padme(4 + J)` → ERROR(FORMAT); a non-zero
   padding byte → ERROR(FORMAT).
4. Records: strict UTF-8, canonical JSON object → else ERROR(FORMAT).
5. `extensible = checkStructure(records, "vault-records", 3, [type, version, owner, contacts, invitations,
   retired_owners], [app], 0)`.
6. `type ≠ "vault-records"` → ERROR(FORMAT). `owner` not a string → ERROR(FORMAT); ≠ the expected owner →
   ERROR(OWNER_MISMATCH). `app` present and not an object → ERROR(FORMAT).
7. `contacts`: an array of at most 10 000 (FORMAT). Each: an object (FORMAT); members `owner`, `sharing_cert`,
   `verified` required, `anchor` optional, others only if extensible (FORMAT); `owner` an ed25519 key (FORMAT);
   `verified` a boolean (FORMAT); `sharing_cert` an object verified as a sharing certificate with `expectedOwner =
   owner` (its errors); `anchor`, if present, an object verified as an index anchor of `owner` (signed-index.md §7).
   Then the owners MUST be strictly increasing (FORMAT).
8. `invitations`: an array of at most 256 (FORMAT). Each: an object (FORMAT); the members of invitation-record.md
   §1 (`accepted` optional; others only if extensible: FORMAT); `id` b64u of 16 bytes (FORMAT); `created`, `expires`
   JSON dates (FORMAT); the record checks of invitation-record.md §3 (`recordInvitation`: FORMAT, INVALID_KEY,
   SIGNATURE, OWNER_MISMATCH); `accepted` an ed25519 key (FORMAT); `answers` an array of at most 16 (FORMAT), each a
   string of at most 13 000 characters that is strict b64u (FORMAT), sorted and unique (FORMAT). Then the ids MUST be
   strictly increasing (FORMAT).
9. `retired_owners`: an array of at most 256 (FORMAT), strings sorted and unique (FORMAT), each an ed25519 key
   (FORMAT).
10. Result: the records, with the certificates and anchors as verified.

Revocation is not checked here (the index writer does it, `listable`). Answers are not opened here (junk answers are
accepted, and counted as `rejected` when collected). `sealVault` sorts and de-duplicates the lists, runs the same
validation, then encrypts with a fresh nonce.

## 4. Merging (`mergeVaults(a, b)`), for two devices that wrote concurrently

1. `a.owner ≠ b.owner` → ERROR(OWNER_MISMATCH).
2. Contacts, by owner: present on one side → kept; on both → `a`'s record (its unknown members kept) with
   `sharing_cert` = `b`'s if its rotation is higher, else `a`'s; `verified` = either; `anchor` = the later one by
   (rotation, then seq; a tie keeps `a`'s).
3. Invitations, by id: one side → kept; both → `a`'s record with the merged answers (below) and `accepted` = `a`'s,
   else `b`'s.
4. `retired_owners` = the sorted union. Top level: unknown members of both, `a` winning; `minor` = the higher one (or
   absent); `crit` = the sorted union (or absent); `app` = `a`'s, else `b`'s.

Merged answers (R5-03): the sorted union if it has at most 16 entries. Otherwise each answer of the union is opened
"at the invitation's creation time" (the window check applies, the grace period does not): the verifiable ones are
kept one per responder (the highest certificate rotation, then the smallest string), ranked the accepted responder's
first, then those `a` holds, then `b`'s (ties by string); then the answers that do not verify, `a`'s first; the first
16 are kept, then sorted. So junk written with the vault data key alone never evicts a genuine answer.

The union can bring back records that a declaration removed (from an older copy); they are never listed again since
they were created under an older rotation (`"superseded"`).

## 5. Declaration of loss (`cancelAllInvitations(records)`)

Returns the records without any invitation, and for each cancelled invitation its id, key pair (from the seed),
`expires` and `accepted`. The caller seals the records with the **new** vault data key, re-encrypts every pack the
cancelled keys open (`retireInvitationKey` with all of them, return-link.md §6), and tells the user which invitees
had not answered. Everything else in the records is kept as is, including members a stolen device may have written:
start from the last copy from before the theft when possible (spec "Loss and theft" step 5).
