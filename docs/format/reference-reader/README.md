# Reference reader (Python)

A second, minimal implementation of the **reading** side of format v4, written from the documents of `docs/format/`
(not by translating `packages/crypto`), to find ambiguities in the specification and to check the vectors with
another language, JSON parser and libsodium binding.

- `tlreader.py`: canonical JSON, base64url, keys and X25519 validation, read addresses, signatures and domains,
  `checkStructure`, sharing and device certificates, identity moves, the signed index (`verifyIndex`,
  `checkNoRollback`, anchors), the invitation-listing padding, packs (`openPack`, Padmé, header), group keys, invitation
  links (parsing, derivations, token, acceptance), the safety code; and the owner's private structures, the ones a
  restore with the recovery kit reads: the recovery phrase (BIP39, root, `crypto_kdf` derivations, owner id), the
  primary identity `TLPI`, the sealed sharing key `TLSK` (both modes), the key export, the transfer blob `TLTX` and
  transfer code (Argon2id), invitation records (`recordInvitation`, `checkOwnerInvitation`, `listable`), return links
  (`openInvitationResponse`, `collectInvitationAnswers`, the answer path of `checkInvitationIndex`), index anchors and
  the recovery vault `TLVD` (`openVault`, `mergeVaults` with the more-than-16-answers rule). It writes nothing.
- `run_vectors.py`: runs every vector of `../vectors/*.json` whose op it implements and compares the result with the
  vector's `expect` exactly (error code and details included).
- `bip39-english.txt`: the BIP-0039 English word list (2048 words), checked against the SHA-256 of the published
  `english.txt` (`2f5eed53…24dbda`) when the reader loads.

```sh
pip install pynacl            # (or: pip install --break-system-packages pynacl)
python3 run_vectors.py        # exit status 0 when every supported vector matches
# or, from packages/crypto: npm run reader
```

Dependencies: Python ≥ 3.10, PyNaCl (libsodium) for Ed25519, X25519, sealed boxes, XChaCha20-Poly1305 and Argon2id;
the standard library's `hashlib` (BLAKE2b with key, salt and personalization for `crypto_kdf`; SHA-256 for the BIP39
checksum), `unicodedata` and `json`. Current result: **all 473 vectors pass, 0 fail, 0 skipped**: every op of README
§10 is implemented, so every vector file is checked by this second implementation.

Independence, honestly stated: this reader was written by the same agent that wrote the specification, after it had
read the TypeScript code. It was written against the documents, and the gaps below are the places where the documents
did not suffice; but it is not a substitute for an implementation by someone who never saw the code. The second half (the private
structures) was written the same way, by an agent that had used the app's restore code but wrote these functions from
`identity-and-keys.md`, `key-export.md`, `transfer-blob.md`, `invitation-record.md`, `return-link.md` and `vault.md`;
only the vector harness (`ops.ts`, the glue that README §10 documents) was looked at for the inputs of each op. An external
auditor is encouraged to write their own reader from `docs/format/` and run it against the vectors.

## Gaps found in the documentation

Each gap was fixed in the specification; the vectors did not change.

| # | Gap | Effect while writing the reader | Fix |
|---|---|---|---|
| G-1 | The read-address check was defined only as "its URL Standard serialization equals the input", which needs a URL Standard parser; Python has none. | A conservative re-implementation had to be designed. | identity-and-keys.md §5 now gives a checkable description for implementations without such a parser, with its limits. |
| G-2 | The IPv6 host serialization was described as "compressed lowercase" only. | The first version of the reader compressed the zero run with one `:` too few (`2001:db8:1` instead of `2001:db8::1`) and refused a valid address (vector `encoding/loc-public-ipv6`). | The exact rule (first longest run of two or more zero pieces, `::`) is now stated in §5. |
| G-3 | The `ok` results of the vector ops were not documented (README §10 pointed to `ops.ts`). | The reader's result summaries had to match fields that only the TypeScript harness defined. | README §10 now lists every op's inputs and `ok` result. |
| G-4 | Whether `fork` and `conflict` appear in every `ROLLBACK` / `IDENTITY_MOVED` result was not stated. | Exact comparison of error results depends on it. | README §10 says so. |
| G-5 | The valid range of years in JSON dates was not stated; Python's `datetime` cannot represent year 0. | A date library would refuse `0000-…` dates the reference library accepts. | README §3: years 0000 to 9999, proleptic Gregorian; the reader computes dates without `datetime`. |
| G-6 | The order of `answers` returned by `collectInvitationAnswers` was not stated (the vectors compare the list exactly). | An implementation sorting the responders (or keeping the latest position of a replaced answer) disagrees with `collect-two`. | return-link.md §5: in the order of each responder's first valid answer; a replacement by a higher rotation keeps that place (checked in `src/invitation.ts`, the one place the code was read for this half). |
| G-7 | No vector exercised `mergeVaults` beyond 16 answers (R5-03), the rule that keeps genuine answers ahead of junk written with the vault data key. | The Python merge of that case was untested. | New vector `vault/merge-more-than-16-answers` (2 genuine answers, 17 junk; no other vector changed). |

Points of the second half (the private structures) that the documents covered precisely enough to get right the
first time: the BIP39 decoding and the `crypto_kdf` mapping onto BLAKE2b salt and personalization; the order of the
`TLSK`, key-export, `TLTX`, vault and return-link checks (the exact error of every negative vector); the AD of each
envelope (`TLSK` mode 2's first 30 bytes, the vault's owner key, the transfer header); the compact certificates of a
return link; `listable`'s order; the merge rules. The one mistake made while writing them was the reader's own: the
phrase normalization split on each whitespace character instead of runs (`identity/phrase-normalized` caught it).

Points that the documents covered precisely enough to get right the first time (every one is exercised by vectors):
the UTF-16 key order and the escaping rules of canonical JSON, including lone surrogates; the canonical-comparison
parse rule (duplicate keys, BOM, number spellings); the order of every check in `verifyIndex`, `checkStructure`,
`openPack` and the invitation acceptance (the vectors compare the exact error); the compact certificates of the index;
`checkNoRollback` and anchors; the pack AD and frame; Padmé; the token, the seed derivations and the listing padding;
the signature prefix and domains; the safety code.

## Format notes found while writing the specification (no change made: format frozen)

- **F-1**: X25519 public keys in `[p + 2, 2^255 − 1]` (non-canonical encodings of u = 2 … 18) are accepted, although
  the package documentation says non-canonical encodings are rejected (only bit 255 and small-order points are
  checked). Low impact (identity-and-keys.md §4); vector `encoding/key-x25519-p-plus-2` pins the current behaviour.
- **F-2**: lone surrogates escaped as `\udXXX` are accepted by canonical JSON (README §4): outside JCS / I-JSON, and a
  second implementation must reproduce `JSON.stringify`'s escaping to agree. Vector `encoding/json-lone-surrogate`.
- **F-3**: the 16 MiB index bound is counted in UTF-16 code units for a text input and in bytes for a byte input
  (README §8); a text of up to 16 Mi code units can be up to 48 MiB of UTF-8. Readers should pass bytes.
