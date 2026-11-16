# Review of shared lists (T-211, T-212, PR #85)

Independent security and correctness review of `git diff origin/main...origin/t-211-shared-lists` (head `f6cab4f`):
link-only lists (per-list X25519 key in `linkKey`, lists packs sealed with the frozen `sealPack`, links
`https://triangulair.app/l#…`), lists shared with friends ("some lists" and "pick who"), the public lists file and
the uMap link, following lists by link (vault records, tombstones, "new link" rotation) and the app screens.

Read: packages/sync README and THREATS (new sections), packages/crypto README and THREATS, docs/format/*.md,
docs/reviews/2026-11-07-sync-review.md, docs/SPEC.md (Creating a sharing list, Following a list, Viewing without
the app, Encrypted sharing, Privacy, Threat model).

Runs (all on the PR head, with the review tests added):

- `packages/sync`: `npm test` 78 passed, 1 skipped, plus the 4 expected failures below; `npm run typecheck` clean.
- `apps/mobile`: `vitest run` 248 passed (29 files); `npm run typecheck` (app and e2e) clean.

Reproductions: `packages/sync/test/review-lists.test.ts`. Each `it.fails` states the **desired** behaviour and
fails today. Once a finding is fixed its test passes unexpectedly, so change it to `it`.

## Verdict: **merge after fixes**

The crypto is used correctly. The list key is only ever a direct recipient of a freshly sealed lists pack
(`sealPack`, so a new batch key every time; `rewrapPack` is never used for lists). Every pack a link holder opens
goes through `verifyIndex` (expected owner, certified address, at most one signed redirect, then an anchor) and
`openPack` against that index, with the file/path check from R-03. A link holder can only open their list's pack,
which holds public comments and no private place. "New link" and deletion really do cut access to future content.

Fix M-01 and M-02 before merging. M-01 sends list names and memberships to a friend who was explicitly
restricted. M-02 is a spec privacy requirement that only half applies. The Low findings can follow.

| Severity | Count | Findings |
| --- | --- | --- |
| High | 0 | |
| Medium | 2 | M-01 *(test)*, M-02 |
| Low | 7 | L-01 *(test)*, L-02 *(test)*, L-03 *(test)*, L-04, L-05, L-06, L-07 |
| Info | 7 | notes at the end |

## Medium

### M-01 A friend restricted to "some lists" still receives lists she was picked for earlier: names and memberships of places she cannot read *(test)*

`packages/sync/src/contacts.ts:53` (`listsSeenBy`) returns `share.lists ∪ policy.lists` for a restricted contact.
`policy.lists` holds the "pick who" choices made in a list's share sheet while the contact saw everything.
`setPolicy` keeps it across a change of `share` (`contacts.ts:236`: `patch.lists ?? cur.lists`), and the contact
screen changes the scope through `setPolicy(owner, { share: policyOf(scope) })` (`apps/mobile/src/contacts/service.ts:573`).

Here is how it happens. Erin sees everything and is picked for "Secret dinners". Anna later restricts her to
"some lists: Trip". `computeAudiences` correctly sends Erin only the places of Trip. But `desiredListPacks`
(`list-packs.ts:69-89`) still seals the definition of "Secret dinners" to her: its name, its description and
`items`, which lists every non-private place id of the list. Those are places she can no longer read, and an
`osm:` id is enough to find the exact place on OpenStreetMap. Her reader drops the ids from the items
(`reader.ts:622`), but they are in the decrypted payload, and `friendLists()` still shows the list name. The
share sheet also lists her as a viewer (`listViewers`), so the author cannot tell anything is wrong. This breaks
THREATS "Membership never names a place they cannot read".

Fix:
- `listsSeenBy` returns only `share.lists` when `share` is restricted, and uses `policy.lists` only when `share === true`.
- `setPolicy` drops `lists` whenever `share` changes, so a stale pick cannot come back later (for example after true → false → true).
- Defence in depth in `desiredListPacks`: for each viewer group, keep only the items that every member of the group can read. Use the audiences from `computeAudiences`, which `build()` already computes, so membership can never name an unreadable place.

### M-02 The "looks like a home" warning only shows when a list goes public, not when a place is added to a list that is already public

Spec, Privacy: "Warning when a place looks like a home (residential address) **before adding it to a public
list**". The PR shows `PublicWarning` only when a list turns public: `ListEditor.tsx:104`
(`goingPublic = draft.visibility === 'public' && existing?.visibility !== 'public'`) and the share sheet.
Places that enter an existing public list are published in plaintext on the next pass with no warning:

- added from the place card (`apps/mobile/src/components/ListsSection.tsx:44`, `s.addToList`);
- added in the editor of a list that is already public (`goingPublic` is false);
- matched automatically by a public *filter* list. Spec: "any new place that meets them enters it automatically",
  so saving a friend's address with the same tag publishes it.

Fix: run `homeLikePlaces` on the places being added in the place card and in the editor whenever the target list
is public, and ask for confirmation. For filter lists, keep home-like places out of the public file until the
author confirms them, for example with an explicit "include" exception, and show the pending ones in the share
sheet. `buildPublicLists` is the last place where this can be enforced.

## Low

### L-01 Going public and back to link-only brings a dead link back to life *(test)*

`apps/mobile/src/sync/controller.ts:542` (`setListVisibility`) changes only `visibility` and keeps `linkKey`.
Public → link therefore seals the pack to the **old** key again (`list-packs.ts:92-103`). Everyone whose
followed list showed "This link no longer works" silently gets it back, and the share sheet shows the old link as
if it were current. The README says switching to public "does the same" as taking the link away.

Fix: clear `linkKey` when a list leaves `link` (`updateList(id, { visibility, linkKey: null })`), so going back
needs "Create the link", which draws a new key. Alternatively, draw a new key on the way back.

### L-02 Unfollowed lists keep their secret key in the vault forever; the followed-lists record has no bound *(test)*

`contacts.ts:285` (`unfollowList`) writes `{ link: cur.link, at, removed: true }`. The merge only needs the id
and `at` to keep the entry removed, yet the link, which holds the list's X25519 secret, the author's key and
their address, stays in every copy of the vault. Anyone who opens the vault (recovery phrase, a stolen unlocked
device) learns every list I ever followed and can still read the ones whose link was never renewed. Nothing
prunes removed entries or limits the number of followed lists, so the vault only grows (see L-07).

Fix: store `{ at, removed: true }` without `link` (`laterEntry` already handles that shape). Drop removed entries
after a delay, for example 180 days like the tombstones. Cap the number of followed lists.

### L-03 Forwardable lists carry exact save and edit times, and personal tag names

`featureFor(item, 'public')` (`features.ts`), used for link packs (`list-packs.ts:100`) and the public file,
keeps `created`/`updated` to the millisecond plus every tag name. A link is meant to be forwarded, and the
public file is world-readable and copied into uMap. The times show when the author was at each place (habits,
which the Privacy section lists as sensitive), and tag names can be personal ("Mum's", "ex"). The preview screen
shows neither. This is not a regression, because the public file already had them, but link-only lists now
spread them further. *(test, stated for link packs)*

Fix: leave `created`/`updated` out of `'public'` features (or round them to the month). Consider sending tag
colors and icons without names, or only the tags the author marks as public.

### L-04 A list tombstone is lost after a sharing-key rotation

`own.ts:750-756` keeps a listed tombstone of a purged list only when `fp` is known, and `fp` exists only for
packs sealed under the current rotation (`i.rot === this.rot`). After `rotate()`, the tombstones of lists already
purged from the trash are dropped. The list key is gone with the list, so they cannot be sealed again, and
holders see "This link no longer works" instead of "This list no longer exists" for the rest of the 180 days.

Fix: keep a listed tombstone (`i.tomb`, not expired, list not live) whatever its `rot`, and carry its
fingerprint over to the new manifest.

### L-05 `followList` saves the list before the first read succeeds

`engine.ts:228-234` writes the vault entry, then reads. If the read fails (offline, host down), the app shows
"unreachable" (`follow.tsx:82-86`), but the list is already followed on all my devices and appears later without
any confirmation.

Fix: read first, then record the entry. Or keep the entry and tell the user "Followed, will update when
reachable".

### L-06 The author name in a followed list is whatever the author typed

The `author` field of a link pack or public file is self-declared. For a non-contact it is shown as "by <name>"
(`follow.tsx:113`, `followed/[id].tsx:39`, `sharing.ts` `groupByAuthor`), so a list can claim to be "by Marie",
the name of one of my friends. The owner key in the link is the only real identity.

Fix: when the owner is not a contact, show the name as declared ("signs as Marie") next to the short key, and
never merge it with the name of a contact who has a different key.

### L-07 Bounds for followed lists are the friends' bounds, and apply before consent

`followed.ts:212` (preview) and `:249` (read) use `friendReadBytes` (32 MiB) per list. `readAll` (`:325`) opens a
second `passBytes` budget (128 MiB) on top of the friends', and there is no limit on the number of followed
lists. Because a list pack cannot be found without opening it, a follower downloads every `packs/` file of the
author. A hostile link, opened by a single tap and before "Follow", can make the phone download 32 MiB, and every
followed list can do the same on each pass while its index changes. Following is much cheaper to trigger than
befriending.

Fix:
- give previews and followed lists a smaller per-list budget (list packs are at most 500 places, about 100 KB);
- share one pass budget with friends;
- cap the number of followed lists (L-02);
- longer term, add a hint so a follower can skip other packs (README open question 9, HTTP Range on headers).

## Info

1. `followed.ts:404-406` vs `:428`: `features` keeps the last pack processed (concurrent order), while `items`
   picks the pack with the smallest hash. If one place appears in two packs, the stored hash and the projected
   feature can come from different packs. The author's own writer never does this, so only a malicious author can
   confuse their own list. Take both from the same pack.
2. The new direct dependency `libsodium-wrappers-sumo` in packages/sync is used only for
   `crypto_scalarmult_base(secret)` (`lists.ts:199`). The derivation is correct: it gives the same public key as
   `crypto_box_keypair`, with clamping inside libsodium, and any 32 bytes are a valid secret. Still, exporting a
   `x25519PublicKeyOf(secret)` from @triangulair/crypto avoids a second sodium instance and `ready` promise
   (Metro keeps hierarchical lookup, so a `packages/sync/node_modules` copy could be bundled twice) and keeps
   all key handling in the audited package.
3. Android app links: `pathPrefix "/l"` (`app.json:37`) also catches `/lists`, `/legal`, `/login` and so on. The
   same holds for `/i` and `/r`. Prefer `"path": "/l"` (or `pathPattern`).
4. README/THREATS say "the `triangulair.app` site must not read `location.hash`". If the Expo web export is served
   from that origin, its `/l` route reads the hash by design (`l.tsx:19`) and then removes it, which the e2e test
   checks at `lists-sharing.spec.ts:195`. Say "must never send it anywhere" to match the code.
5. A storage host that kept an old index and old pack files can replay them to someone holding an old link who
   has no anchor yet, because indexes do not expire. This only reveals the old version and does not break "new
   link" for later content. Worth a sentence in THREATS.
6. A public list followed by link that its author switches to link-only shows "This list no longer exists"
   (`fetchPublic`). That is acceptable wording, but it differs from the link-only case.
7. `newListLink` while offline (`controller.ts`) shows the new link right away, before it is published. Anyone
   who opens it before the next publication sees "This link no longer works".

## What I checked and found sound

- **What a link holder reads**: only packs sealed to the list key (`fetchLinkOnly` passes only `listKeyPair`,
  never my keys). Link packs hold one definition plus `featureFor(…, 'public')`: comments only when public, no
  private save (`list-packs.ts:57`). There are no other lists, no friends' lists packs, and no contact
  information (wraps are anonymous). They also learn my master key, read address, pack count and sizes, as
  THREATS documents.
- **List key as a recipient**: it appears only in `desiredListPacks` link and tombstone audiences. It is never a
  group member, never wrapped in any other pack, and is not reachable from friends' content.
- **"New link" and deletion**: a new key changes the audience, so `sealPack` re-seals with a new batch key and
  a new file. The old entry is dropped from the index and its file deleted (with garbage retry). Followers only
  iterate listed packs, so old files that were not deleted are not opened either. Tombstones work while the list
  is in the trash and after it is purged on another device (L-04 aside).
- **Link parsing**: strict version and kind; exactly 32 bytes of key; list id regex; fatal UTF-8; the address
  must pass `checkLocation` (canonical https) and is limited to 512 bytes; fragment limited to 1024 base64url
  characters. A forged address is refused by `verifyIndex` (signature over owner and certified location). One
  signed redirect is followed, then the anchor refuses rollback or fork, both for the stored location and per
  followed list. There is no downgrade path: a `public` link reads only the public file, checked against the
  index hash and the `owner` field.
- **Fragment handling**: in memory only (`pending.ts`), never in a query or route parameter. Followed-list routes
  use the hashed id. It is stripped from the web address bar and history (`l.tsx:21`, e2e test). Sync logs carry
  ids, not links, and error messages never include the fragment.
- **Friends**: a friend who sees everything learns no list name until picked (M-01 aside). Lists packs are
  sealed per viewer set, and the reader keeps definitions apart from places.
- **Public file**: only `visibility === 'public'` lists; no private saves, no closed places, no non-public
  comments; the `owner` field is checked against the verified index on the reader side (L-03 aside).
- **Followed lists in the cache**: owner `list:<hash>`, never mixed with a friend's cache. They are removed on
  unfollow, when the list is gone, and when unfollowed on another device. The payload is parsed strictly (R-13
  rules) and every download is bounded (R-06).
- **Previous sync review**: the R-01…R-14 tests (`review.test.ts`, `fixes.test.ts`) still pass. The new reader
  applies R-03 (served-path check), R-05 (nothing is read after a wipe), R-06 (bounds) and R-13 (strict strings
  and dates), and `own.ts` parses lists packs inside the existing per-pack `try` (R-12).

## Status after the fixes (branch `t-211-fixes`)

| Finding | Status | Where |
| --- | --- | --- |
| M-01 | Fixed: picks only while `share === true`, dropped on any change of scope; friends' lists packs keep only places every viewer can read | `contacts.ts`, `list-packs.ts` |
| M-02 | Fixed: warning in the place card and in the editor of a public list; a public filter list holds home-like places out of the public file until confirmed (`include`), listed in the share sheet | `home.ts`, `public-lists.ts`, app |
| L-01 | Fixed: leaving link-only clears `linkKey` | data `updateList` |
| L-02 | Fixed: removed entries keep `{ at, removed }` only, pruned after 180 days; at most 200 followed lists | `contacts.ts` |
| L-03 | Fixed: dates rounded to the UTC day, tag names only on opt-in (vault, all devices) | `features.ts`, share sheet |
| L-04 | Fixed: tombstones kept across a rotation | `own.ts` |
| L-05 | Fixed: recorded only after a successful first read | `engine.ts`, follow screen |
| L-06 | Fixed: author shown by key short code, contact name or quoted declared name with "not in your contacts" | app `authorLabel` |
| L-07 | Fixed: `listPackBytes`, `listReadBytes`, `listPreviewBytes`; one pass budget; preview only on demand | `limits.ts`, `followed.ts`, follow screen |
| Info 1 | Fixed (feature and hash from the same pack) | `followed.ts` |
| Info 2 | Documented (crypto package frozen) | THREATS |
| Info 3 | Fixed (`path` instead of `pathPrefix`) | `app.json` |
| Info 4 | Fixed (wording) | README, THREATS, `lists.ts` |
| Info 5, 6 | Documented | THREATS |
| Info 7 | Fixed (an unpublished new link is taken back) | controller |
