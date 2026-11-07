# Sync: threat notes

Complements `packages/crypto/THREATS.md` (the format) and the spec's threat model. What the sync layer adds.

## Compression before encryption

Payloads are DEFLATE-compressed (fflate, pure JavaScript) before being sealed. The storage, its host and anyone
who polls the files see the **padded size of the compressed content** (Padmé: at most ~12 % overhead), so the size
now depends on how repetitive the content is, not only on its length.

- **Chosen-plaintext compression attacks (CRIME/BREACH)** need an attacker who can inject text into the same
  compressed stream as a secret and observe the size, many times. Here the attacker would have to get text into
  my own packs: OSM names and categories (anyone can edit OSM, and my app copies names), imported files, or a
  friend's tag that I adopt. Each attempt needs me to republish (a sync), and the size is padded and shared with
  up to 200 places of the same pack. Recovering a comment this way is impractical; we accept it.
- **What size still tells**: roughly how many places each recipient set has (number and size of packs), and that
  a pack changed. That was already true without compression (the spec accepts it: "the storage still sees file
  sizes and update dates").
- **Decompression bombs**: decompression is streamed and stops at 64 MiB per payload (4 MiB per step), so a
  hostile pack (only my own devices or a friend who holds a valid signing device can list one) cannot exhaust
  memory. Parsing limits (features, positions, tags, string lengths) are checked before anything is projected.
- Trade-off: without compression, 10,000 places are ~3.5 MB of places packs and ~3.8 MB of document instead of
  ~0.23 MB and ~0.66 MB; a friend's first read would be ~15× larger on mobile networks.

## What the storage learns from the layout

- `packs/` vs `media/`: places packs (what friends read) vs my own document and manifest (and photos later). Until
  photos exist, the host can tell which file is my document; its size bounds the size of my whole collection,
  private places included. Packs are grouped by recipient set, so the host also sees how many distinct recipient
  sets I use (one per restricted friend or list), not who is in them.
- Republication timing: every sync that changed something writes a new index (the spec accepts update dates);
  the invitation padding also changes the index from time to time (crypto THREATS).
- Replacing one pack also rewrites another one (blur), so a single-place edit does not point at one file; it is
  a weak defense (it costs one pack upload) against matching successive indexes.

## The manifest

Recipient-set fingerprints (hash of sorted public keys) are written only in a pack sealed to my own key. They are
never in a pack a friend can open: a friend who knows other people's public keys could otherwise test which
friends share a pack with them. Wraps stay anonymous (crypto).

## Own devices

- My document is sealed to my **sharing key**, which every device holds and which a declaration of loss replaces
  (`rotate`: everything is re-sealed for the new key, old files deleted). A stolen device keeps what it had; it
  cannot open what is published after the rotation.
- Own-document updates are trusted because the pack is listed in **my signed index** (only my non-revoked devices
  can sign one that verifies) and opens with my key; sealed boxes alone would not authenticate the sender.
- The vault (`vault.bin`) is authenticated by the vault data key only; contact switches in its free-form part are
  as trustworthy as the vault itself (a stolen device could change them until the declaration; they are not
  security fields of the format: they decide who gets wraps, which the owner sees in the app).

## Friends' cache

- Content is projected only after the index verifies and every needed pack opens; a failure keeps the last valid
  content (no partial update from a tampered storage). A rollback or fork of a friend's index is refused against
  the anchor kept in my vault.
- Removing a friend, or a friend removing my access, erases their content and the place records their data
  created; deliberate copies (screenshots, a modified app) are out of reach, as the spec says.
- Coarse ETags on a friend's server can delay an update until the next full read (10 minutes while the app is open).

## Concurrency

- Compare-and-swap is best effort on some servers; the read-back check and the recomputation of the remote
  snapshot from what is actually listed make a lost publication reappear at the next pass. A reader may briefly
  see two indexes with the same `seq` (fork), which it reports and then moves past.
- Superseded files are deleted right after a successful publication. A friend reading at that moment may get a 404
  for a pack of the previous index: it keeps its cache and reads again at the next pass.
