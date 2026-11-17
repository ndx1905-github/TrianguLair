# Review of adding a device, the device list and declaring a device lost (T-206 / T-207, PR #86)

Reviewer: an independent reviewer who did not write this code. Branch reviewed: `t-206-devices` at `8306802`
(`git diff origin/main...HEAD`: 64 files, about 5,200 lines). Reviewed against docs/SPEC.md (Adding a device,
Loss and theft, Recovery kit, Threat model, Error cases), packages/crypto README/THREATS, docs/format/*.md,
packages/sync README and the earlier reviews in docs/reviews/.

Reproductions (no change to `src/`):

- `packages/sync/test/review-devices.test.ts`: 3 `it.fails` (F-01, F-02)
- `apps/mobile/src/devices/review.test.ts`: 6 `it.fails` (F-01, F-03, F-04, F-05 ×2, F-07)

Each `it.fails` states the **desired** behaviour and fails today on its assertion, not on an error (checked by
running every one as a plain `it`). When a finding is fixed its test starts passing, `it.fails` then reports it,
and it must become `it`.

Test runs on the branch with the review tests: sync `vitest` 75 passed, 3 expected fail, 1 skipped; sync `tsc`
clean; app `vitest` 258 passed, 6 expected fail; app `tsc --noEmit` clean. The earlier sync review's tests
(`fixes.test.ts`, R-01 to R-14) still pass. The only change to them, in R-14, moves the clock to `Date.now()` and
does not weaken them.

## Verdict: **merge after fixes**

The crypto structures are used correctly, and the frozen package is not bypassed. Transfer code, key export,
TLSK modes 1 and 2, device certificates, identity move and sharing certificates with permanent revocations all
check out. The 6-word code cannot be brute-forced. Friends follow an identity move correctly. The R-10 rule
(a vault sealed with an earlier vault data key is never merged once a device was revoked) still keeps a thief's
old-key vault out after the declaration.

Two high findings break the declaration of loss itself, because the vault's new free-form parts are
trusted for security decisions:

1. A stolen device can make every device of mine switch its storage settings to a write endpoint it chooses
   (F-01).
2. A stolen device can hide itself from "Declare a device lost", or keep the new key away from my other
   devices (F-02).

Fix both before merging. Fix the medium findings before release.

| Severity | Count | Findings |
|---|---|---|
| High | 2 | F-01, F-02 |
| Medium | 5 | F-03, F-05, F-06, F-07, F-08 |
| Low | 4 | F-04, F-09, F-10, F-11 |
| Info | – | Notes section |

---

## High

### F-01 Storage settings in the vault: a stolen device can redirect all my devices' writes, and its value survives the declaration *(test ×2)*

`packages/sync/src/devices.ts:104-109, 207-211` (latest `at` wins, no bound, no signer);
`apps/mobile/src/sync/controller.ts:367-394` (`afterOwn` adopts the vault value);
`apps/mobile/src/devices/sessions.ts:349-362, 416-418, 524-525, 580` (new devices take it too).

`triangulair_values.storage` holds the full storage settings: write URL or S3 endpoint and bucket, credentials,
and read address. It is merged per key by the largest `at`, and nothing else is checked. After each pass,
`afterOwn` hands any vault value with the same `readUrl` to `onStorageValue` → `StorageProvider.updateCurrent`.
That happens with no user action and no test of the new settings, as long as this device has not changed its
own settings since it last wrote them. Only the read address is compared. The **write side**
(`url`/`endpoint`/`bucket`) can be anything.

A stolen device before its declaration holds the vault data key and the storage credentials, so it can:

1. Write a vault whose `storage` value keeps my read address but names its own WebDAV/S3 endpoint, a proxy in
   front of my storage, stamped `at = 2^53-1`.
2. Wait. Every device of mine, and every device added later by link, QR or the 12 words, takes these settings at
   its next pass. From then on the proxy sees, and can drop or rewrite, everything my devices write and read
   back: index, vault, packs, `keys/<device>.bin`. That includes the content check after publication, because
   the check goes through the same adapter.
3. Then the declaration made from such a device publishes its new certificate to the proxy. If the proxy drops
   it, the real storage never shows the revocation. Friends keep wrapping to the old key, which the thief holds,
   and the stolen phone is never wiped.

The value is also **sticky**. The declaration carries it into the new vault (spec: "what it wrote is carried over"),
and it beats any later legitimate change. `setValue` stamps `cur.at + 1 = 2^53`, which is not a safe integer.
`valuesPart` then drops the user's new entry, so the next merge brings back the thief's. Changing the password
as the guide says therefore does not stick. The device even switches back to the planted value at its next pass,
since `written[storage]` now equals its own config.

`devices.ts:14-23` says "Nothing in this part is a security decision on its own". For `storage`, it is one.

Fix:

- Never take a different write endpoint from the vault automatically. Accept only new credentials for the same
  `kind` + `url`/`endpoint`/`bucket`/`prefix`. Anything else becomes a prompt that shows the endpoint, and the
  settings are tested before use.
- Sign value entries with the writing device's certificate, as invitation records are signed. Ignore entries
  signed by a device that the current sharing certificate revokes, and drop them at the declaration.
- Clamp `at` to `now + small skew` on merge, and reject `at > now + skew` when reading. Never stamp
  `cur.at + 1` past `MAX_SAFE_INTEGER`.
- For a new device (`readVaultValues`), show the write endpoint before using it.

### F-02 The device list in the vault decides who can be declared lost and who gets the new key, and a stolen device can rewrite it *(test ×2)*

`packages/sync/src/devices.ts:104-117` (`later` by `at`, `removed` sticky by `min`);
`apps/mobile/src/app/devices/lost.tsx:79`;
`packages/sync/src/engine.ts:270, 292-306`;
`apps/mobile/src/sync/controller.ts:396-403`.

The entries are said to be "display only", but they are not:

- `lost.tsx:79` offers only devices with `removed === undefined`. A stolen device sets `removed` on its own entry,
  and that removal is sticky (`Math.min`). It also sets `primary`/`name` with a far-future `at`. It then
  **disappears from "Declare a device lost"**, so the user cannot revoke it from the UI at all. No other screen
  revokes a device id.
- `rotateKey` and `deliverKeys` deliver to `book.devices()`, which keeps only entries whose certificate verifies.
  A thief replaces another device's entry with `{cert: {broken: true}, at: 2^53-1}`. That entry wins every merge
  (`later`), and `devicesOf` then drops the device. The declaration does **not deliver the new key to my
  remaining devices**. They end up on `NeedsKeyError` and must be re-added, and the thief gains time.
- `journalBase` records the "changes since the theft" only when `devices().length > 1`. Hiding the other
  entries turns the journal off (F-09).
- The `primary` badge is how the user tells which device holds the master key (F-06), and the thief controls it.

Fix:

- Make `removed` derive from the current sharing certificate (`revoked_devices`) only, and list every device
  whose certificate verifies and is not revoked.
- Merge entries per device id. An entry whose certificate does not verify never replaces one that does. Clamp
  `at`, and never let `later` pick a malformed entry.
- In `lost.tsx`, also offer any device that signed one of my indexes (`device_cert` in the journal or anchor)
  and is not revoked, so a device missing from the list can still be declared.

---

## Medium

### F-03 Link + code: the comparison does not protect the keys, and a refused request leads nowhere *(test)*

`apps/mobile/src/devices/sessions.ts:151-168, 386-428`; `apps/mobile/src/app/devices/add.tsx:52-57`.

The blob is `encryptForTransfer(encodeKeyExport(sharing))`, so it holds the sharing key pair **and the vault data
key**. Whoever has the link and the 6 words can therefore read all my places, my friends' content shared with me,
and the whole vault, including the storage write credentials (F-01). All of this comes before any request is
written and whether or not the old device approves.

The 12-digit number only gates the **device certificate**. What it protects is persistence: a listed device gets
every future key through `deliverKeys`, and can sign indexes and invitations. That part works.

- The number is the hash of the new device's key. The old device shows the request's number, and the new device
  shows its own. Its 39.9 bits cannot be ground within the window.
- The comparison is one-way: it shows the old device which key it certifies. It does not show the new device
  whose blob it opened.
- It can be skipped: "Add this device" is one tap after the master-key prompt. Nothing has to be typed.

Who can write a request: anyone with the sharing secret, so an interceptor of link + code, or a stolen device not
declared yet (it can list `transfer/`). The storage host cannot (the slot key needs the sharing secret).

The gap is what happens after a mismatch or a refusal. The mismatch proves that someone else holds the current
sharing key and vault data key, yet `refuse()` only deletes the files. That attacker is not a listed device, so
"Declare a device lost" cannot target it, and there is no "change my sharing key now" action.

Fix:

- On refuse, on a mismatch, or when a request arrives after the new device already got its approval, say that the
  transfer leaked. Offer a key change at once: rotation with `newKey`, cancelling invitations, plus the
  credentials guide.
- Ask the user to type the last 4 digits rather than tap "they match".
- Better, within the frozen formats: put only a slot secret in the TLTX payload, and deliver the sharing key
  sealed to the new device (TLSK mode 1) inside the approval, as the QR path does. The spec wording, "transfer
  pack", allows either.

### F-05 Restore with the 12 words: no freshness check, and no copy at all for existing identities *(test ×2)*

`apps/mobile/src/devices/sessions.ts:551-598`; `apps/mobile/src/sync/controller.ts:336-349`;
`apps/mobile/src/identity/IdentityProvider.tsx:106`.

- `restoreWithPhrase` accepts whatever TLSK mode 2 file `keys/<owner>.bin` holds. It never compares the file with
  the sharing certificate in my current index.
  - A host, or a stolen device whose storage access has not been changed yet, can put back a copy from before the
    declaration. Versioned S3 buckets and Nextcloud versions keep them.
  - The restored device then runs with the old key. The thief knows that key. `OwnSync.pull` stops on
    `NeedsKeyError`, because nobody delivers `keys/<new device>.bin`.
  - The same happens when the recovery kit still names a previous storage: its `keys/<owner>.bin` is never updated
    or deleted.
  - Fix: read the index at the certified address. Refuse, or warn and offer a rotation from the phrase, when its
    `sharing_cert` rotation or key differs from the restored one.
- `keys/<owner>.bin` is written only from the `recovery-copy` secret. Identities created before this version have
  none, and a primary device does not make one, even though it holds the master key (`primary-identity`). For
  every existing user, "restore with the 12 words" answers "not found" until some rotation happens.
  - Fix: when `recovery-copy` is missing on a primary device, seal one from `primary-identity` before publishing.
    Otherwise, ask for the 12 words once (kit screen).

The copy itself is sound. Its key comes from the 128-bit phrase, so an offline attack is out of reach. The file
reveals the owner id, which every certificate already shows, and the times of rotations.

### F-06 "Declare a device lost" accepts the primary device as an ordinary key change

`apps/mobile/src/app/devices/lost.tsx:79-90`.

The list offers the primary device like any other. A plain rotation is useless against a thief who holds the
master key: they can certify a new device key and issue the next rotation, and revocations being permanent does
not stop that. The spec requires the identity change in that case. The `primary` mark that should warn the user
is display-only and thief-writable (F-02).

Fix: when the chosen device is, or may be, the primary device, send the user to `/devices/identity`. Decide
"may be" from what the thief cannot forge, for example: no device of mine holds `primary-identity`, and this
device is not primary. Say so on the screen.

### F-07 "Lock after N days without sync" is bypassed by setting the clock back *(test)*

`apps/mobile/src/identity/lock.ts:121-125`; `apps/mobile/src/sync/SyncProvider.tsx:240-242`.

`staleSyncAction` uses `Date.now()` and returns `none` whenever `now - max(lastSuccess, since) < N days`. That
includes negative values. A thief who keeps the phone offline and sets the date back never sees the lock or the
wipe. This option exists precisely for a phone that cannot read its revocation, and changing the date needs no
root.

Fix:

- Keep a high-water mark of the time seen (persisted at each launch and foreground). Treat `now` earlier than the
  last success or the high-water mark as stale, which locks.
- Where available, also count elapsed real time (a monotonic uptime delta since the last success, or a server
  `Date` header from the last pass).

### F-08 Identity move: the thief still has the old master key and the storage access when the move is published

`apps/mobile/src/app/devices/identity.tsx:38-56`; `apps/mobile/src/sync/controller.ts:532-569`.

- The move is published at the new identity's first pass, using the storage credentials the thief also holds.
  Until the credentials change, the thief can do any of these, and friends who read its version first follow the
  thief (the reader marks only a **second** successor as `conflict`):
  - re-upload an index of the old identity (the old index was just deleted, `controller.ts:559`);
  - publish its own move signed by the old master;
  - publish a redirect to an address it controls, under a higher rotation of the old identity.

  This part of the race is inherent, but the flow makes it worse.
  - The only advice is a bullet ("Declare a device lost explains how").
  - After the move, the device list holds only this device (`DEVICES_KEY` deleted), so "Declare a device lost"
    shows "no other device".
  - The credentials guide (`lost.tsx:116`) appears only after a declaration, so after a move it is unreachable.

  Fix: show the credentials guide (`credentialGuide`) **before** publishing the move. Ask the user to change the
  storage access first, then publish. Also show the guide on the kit screen that follows.
- `prepareIdentityMove` deletes the old index and files and sets `moving = true` before `adoptMovedIdentity`
  stores the new identity. If that step fails, this device has neither, until a restart. `BOOK_KEY` already holds
  a vault for the new owner while the identity record is still the old one. Fix: write the new identity first, as
  a pending record, and delete the old index last. Or make the step resumable.
- The stolen primary device is never wiped (no revocation reaches the old identity), and the user's other devices
  are cut off silently. That is acceptable per the spec, but say it on the screen.

---

## Low

### F-04 QR: "Cancel" after approval leaves a certified device listed, and it gets the key *(test)*

`apps/mobile/src/devices/sessions.ts:272-297, 315-319`.

`QrSender.approve` issues the certificate and calls `register` (vault and publication) before the new device has
fetched anything. At that publication, `deliverKeys` already writes `keys/<device>.bin`, which is readable at the
public read address. `cancel()` then deletes only the `.qr` file and shows "cancelled". The device stays listed
and certified, and it gets every future key.

This only matters when the offer was not the user's own. The offer can be **pasted**, so a code sent in a message
qualifies. In that case the DH channel protects nothing: the key reaches the offerer through `keys/`.

Fix: register only once the new device has deleted the `.qr` file, or do not offer "Cancel" after approval. Offer
"Remove this device" instead, which is a rotation. Also consider refusing pasted offers, or asking for an extra
confirmation.

### F-09 "Changes since the theft" misses changes and misattributes them

`apps/mobile/src/sync/controller.ts:396-418`; `apps/mobile/src/devices/journal.ts`.

- Changes are attributed to the device that signed the index they were imported from (`importedFrom`). When
  another device of mine merged the thief's edits and republished first, they are attributed to that device and
  filtered out by `changesSince(…, [lost])`.
- Changes are recorded only when the vault lists more than one device (see F-02), and only for saves. Changes to
  contact `share`/`follow` policies in the vault, tags and lists are not covered.
- `revertChange` does not put back `name`, although `changedFields` reports it.
- The journal is per device and local.

Fix:

- Show all changes since the date, with the signer as a hint. Do not filter by device by default.
- Journal the vault's contact policies too. They are what decides who reads my places.

### F-10 "Remove a device" and the credentials guidance

`apps/mobile/src/app/devices/lost.tsx:97, 116-143`.

"Remove" rotates without cancelling invitations and shows no credentials guide. The removed device read the
invitation secrets and the storage credentials in the vault. Suited to a device given away; say it on the screen.

After a declaration, the guide is shown once, on the result screen. Nothing reminds the user later that the
access was not changed. The F-01 fix would also let the app notice when the credentials it uses are older than
the declaration.

### F-11 A declaration interrupted between the certificate and the publication

`apps/mobile/src/identity/IdentityProvider.tsx:258-278` stores the new key before `sync.declareLost`
(`controller.ts:481-498`) runs. If the publication fails:

- the lost device is not marked removed and its `keys/<id>.bin` is not deleted, until a retry;
- the screen does not list the invitations it cancelled;
- a retry makes rotation r+2.

Nothing leaks: the new certificate still cancels invitations and revokes the device at the next publication.
Make the step resumable (a pending declaration in the state store).

---

## Notes (checked, sound or informational)

- **6-word code**: 6 BIP39 words (66 bits) uniformly drawn (`randombytes_uniform`), Argon2id at libsodium
  INTERACTIVE (2 ops, 64 MiB), the format's minimum. The blob is readable by anyone who knows the slot (the
  storage host, the link holder), so it can be attacked offline: 2^65 Argon2id evaluations on average is out of
  reach, and online guessing adds nothing. The 15-minute expiry is authenticated but enforced only by honest
  clients. "Single use" means deleting the blob, which a hostile or versioning storage may keep. Both are
  harmless given 66 bits, but they are not cryptographic guarantees. Expiry is checked against the new
  device's clock.
- **Hostile storage and transfer files**: blob, request and approval are deleted by both sides. `trackSlot`
  deletes expired slots at the next publication even if the screen was closed (`controller.ts:351-363`). A
  blob put before `trackSlot` (app killed in between) stays forever (`sessions.ts:161-163`). Request and
  approval are AEAD-sealed with a slot key derived from the sharing secret, so the host learns no device name.
- **QR channel**: X25519 ephemerals, a hash-bound key over both public keys and the slot, and the package sealed
  to the device key. Sound. The checks on the new device side are complete: certificate owner, device and box
  keys, location equal to the reply's.
- **12-digit number**: `deviceFingerprint` covers the device id only (the box key is bound by the certificate the
  new device checks). Each group is `u32 mod 10000` (negligible bias), about 39.9 bits in total. See F-03 for what
  it does and does not protect.
- **Storage credentials in the vault**: readable by every device of mine and by whoever holds a link + code
  (F-03). Not readable by friends or the host (the vault is sealed with the vault data key, padded). After a
  declaration the new vault data key keeps the thief out of new values, but the credentials themselves stay
  valid until changed (guide).
- **Declaration completeness**:
  - Covered: new sharing key and vault data key; the device revoked permanently; all invitations cancelled
    (`cancelAllInvitations`, plus the certificate rule); the key delivered to remaining listed devices (F-02
    aside); `keys/<lost>.bin` deleted; `keys/<owner>.bin` refreshed; everything re-encrypted at the next
    publication; R-10 keeps out old-key vaults.
  - Old storages: their `keys/<owner>.bin` and `keys/<device>.bin` are left (F-05). The guide covers their
    access.
  - Link-only list keys do not exist yet in the code (no list-link implementation). When they do, the
    declaration must renew them.
    *After the merge with PR #85 (link-only lists): the app's `declareLost` draws a new key for every live
    link-only list on a declaration (not on "Remove a device") and the result screen lists them
    (`apps/mobile/src/devices/flow.test.ts`); see packages/sync THREATS.*
- **Identity move for friends**:
  - `followMove` reads the new identity at the **same certified address**.
  - It verifies with `expectedOwner = to`, `from` retired, and `index.move.from === from`.
  - It keeps the policies, clears `verified`, retires the old owner for good, and keeps my display name.
  - Every index carries the move (R-11).
  - A conflicting second successor is not followed.
  - Correct.
- **Revert**: a revert is a new local edit from the snapshot taken before the import, so it syncs like any
  other. A place that was purged is not revertible. Only the latest change per place is revertible. Sound apart
  from F-09.
- **Earlier findings**: R-01 (older-rotation index not imported), R-05 (reading stops on revocation) and R-10
  (previous vault data key not merged after a revocation) still hold. Their tests pass.
