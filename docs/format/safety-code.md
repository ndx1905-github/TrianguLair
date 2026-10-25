# Safety code

Compares two identities out of band (phone call, face to face). It depends only on the two **master** public keys, so
it changes when either identity moves. Vectors: `vectors/safety-code.json`. Code: `src/safety.ts`.

    lo, hi = the two master public keys (32 bytes each) ordered by unsigned lexicographic byte comparison
    h      = BLAKE2b-512("TrianguLair-safety-v1" || lo || hi)                 (no "\n" in this context string)
    group i (i = 0 … 11) = (u40 big-endian of h[5i .. 5i + 5)) mod 100000, written with 5 digits (leading zeros)
    QR payload = "tlsafe1:" || b64u(h[0 .. 32))

Both sides compute the same 12 groups whatever the argument order (about 199 bits). Inputs are owner ids
(`"ed25519:…"`) or 32-byte keys; a malformed owner id is ERROR(FORMAT). A scanned QR payload matches when it is
byte-for-byte equal to the expected one. Marking a contact "verified" is a local declaration, never published (it is
kept in the vault's contact record).
