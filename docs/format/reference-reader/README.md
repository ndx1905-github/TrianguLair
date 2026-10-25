# Reference reader (Python)

A second, minimal implementation of the **reading** side of format v4, written from the documents of `docs/format/`
(not by translating `packages/crypto`), to find ambiguities in the specification and to check the vectors with
another language, JSON parser and libsodium binding.

- `tlreader.py`: canonical JSON, base64url, keys and X25519 validation, read addresses, signatures and domains,
  `checkStructure`, sharing and device certificates, identity moves, the signed index (`verifyIndex`,
  `checkNoRollback`, anchors), the invitation-listing padding, packs (`openPack`, Padmé, header), group keys, invitation
  links (parsing, derivations, token, acceptance) and the safety code. It writes nothing.
- `run_vectors.py`: runs every vector of `../vectors/*.json` whose op it implements and compares the result with the
  vector's `expect` exactly (error code and details included).

```sh
pip install pynacl            # (or: pip install --break-system-packages pynacl)
python3 run_vectors.py        # exit status 0 when every supported vector matches
# or, from packages/crypto: npm run reader
```

Dependencies: Python ≥ 3.10, PyNaCl (libsodium) for Ed25519, X25519, sealed boxes and XChaCha20-Poly1305; the
standard library's `hashlib.blake2b` and `json`. Current result: **334 vectors pass, 0 fail**; 138 are skipped
because their ops are not implemented here (phrase derivation, which needs the BIP39 word list; `TLSK`, return links,
invitation records, vault, transfer blob, key export).

Independence, honestly stated: this reader was written by the same agent that wrote the specification, after it had
read the TypeScript code. It was written against the documents, and the gaps below are the places where the documents
did not suffice; but it is not a substitute for an implementation by someone who never saw the code. An external
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
