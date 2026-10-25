import {
  canonicalize,
  encodeKeyExport,
  encodePrimaryIdentity,
  encryptForTransfer,
  formatKey,
  generateTransferCode,
  identityFromPhrase,
  sealSharingKey,
  serialize,
  toB64Url,
} from '../../src/index';
import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { concat, readU32be, u32be, utf8 } from '../../src/encoding';
import { S } from '../../src/sodium';
import { FileBuilder, type VectorFile } from './builder';
import { flip, NOW, plain, plus, sealedKeyToDevice, secs, T0, iso, type Person } from './fixtures';
import { hex, type JsonObj } from './ops';
import type { Shared } from './shared';

// ---------------------------------------------------------------------------------------------
export function encodingVectors(): VectorFile {
  const b = new FileBuilder('encoding', 'README.md', 'Canonical JSON (the JCS subset), public key strings, read addresses.');
  const ok = (name: string, text: string, d: string) => b.add(name, d, 'canonical_json', { text }, 'ok');
  const bad = (name: string, text: string, d: string) => b.add(name, d, 'canonical_json', { text }, 'FORMAT');
  ok('json-simple', '{"a":1,"b":[true,false,null],"c":"x"}', 'Already canonical.');
  ok('json-nested-sorted', '{"a":{"b":1,"c":{"d":[{"e":"f","g":0}]}},"z":-5}', 'Keys sorted at every depth.');
  ok('json-raw-non-ascii', '{"a":"é漢😀"}', 'Non-ASCII characters are written raw (UTF-8), not escaped.');
  ok('json-utf16-key-order', '{"😀":1,"�":2}', 'Keys sort by UTF-16 code units: U+1F600 (D83D DE00) sorts BEFORE U+FFFD, unlike code-point order.');
  ok('json-control-escapes', '{"a":"\\u0001\\b\\t\\n\\f\\r\\"\\\\\\u001f"}', 'Control characters: \\b \\t \\n \\f \\r short forms, others \\u00XX lowercase; quote and backslash escaped.');
  ok('json-del-and-u2028-raw', '{"a":"\u007f "}', 'U+007F and U+2028 are written raw.');
  ok('json-lone-surrogate', '{"a":"\\ud800"}', 'A lone surrogate is written as a lowercase \\udXXX escape and ACCEPTED (outside I-JSON/JCS; see README "Canonical JSON").');
  ok('json-max-safe-int', '{"a":9007199254740991,"b":-9007199254740991}', 'Largest safe integers.');
  ok('json-empty-object', '{}', 'Empty object.');
  bad('json-whitespace', '{"a": 1}', 'Insignificant whitespace.');
  bad('json-trailing-newline', '{"a":1}\n', 'Trailing newline.');
  bad('json-key-order', '{"b":1,"a":2}', 'Keys not sorted.');
  bad('json-duplicate-key', '{"a":1,"a":1}', 'Duplicate key (identical values): the canonical re-serialization is shorter.');
  bad('json-bom', '﻿{"a":1}', 'Leading U+FEFF (BOM) is kept by the strict decoder, so the text is not canonical.');
  bad('json-float', '{"a":1.5}', 'Floats are not allowed.');
  bad('json-float-integral', '{"a":1.0}', '1.0 is not the canonical spelling of 1.');
  bad('json-exponent', '{"a":1e3}', 'Exponent notation.');
  bad('json-negative-zero', '{"a":-0}', '-0 (canonical form is 0).');
  bad('json-unsafe-int', '{"a":9007199254740992}', '2^53 is not a safe integer.');
  bad('json-escaped-non-ascii', '{"a":"\\u00e9"}', 'Non-ASCII written as an escape.');
  bad('json-escaped-slash', '{"a":"\\/"}', 'Escaped solidus.');
  bad('json-uppercase-escape', '{"a":"\\u001F"}', 'Uppercase hex in a \\u escape.');
  bad('json-top-level-array', '[1]', 'Top level must be an object.');
  bad('json-invalid', '{"a":', 'Invalid JSON.');
  bad('json-nan', '{"a":NaN}', 'NaN is not JSON.');

  const owner = 'ed25519:' + toB64Url(new Uint8Array(32).fill(0x42));
  b.add('key-ed25519', 'Ed25519 key string.', 'parse_key', { kind: 'ed25519', value: owner }, 'ok');
  b.add('key-ed25519-zero', 'Ed25519 keys are NOT point-validated when parsed (a small-order key verifies nothing).', 'parse_key', { kind: 'ed25519', value: 'ed25519:' + toB64Url(new Uint8Array(32)) }, 'ok');
  const x = S().crypto_scalarmult_base(S().crypto_generichash(32, utf8('vector x25519'), null));
  b.add('key-x25519', 'X25519 key string.', 'parse_key', { kind: 'x25519', value: formatKey('x25519', x) }, 'ok');
  b.add('key-x25519-zero', 'All-zero X25519 key.', 'parse_key', { kind: 'x25519', value: 'x25519:' + toB64Url(new Uint8Array(32)) }, 'INVALID_KEY');
  const one = new Uint8Array(32);
  one[0] = 1;
  b.add('key-x25519-low-order', 'u = 1, a low-order point.', 'parse_key', { kind: 'x25519', value: 'x25519:' + toB64Url(one) }, 'INVALID_KEY');
  const high = x.slice();
  high[31] = (high[31] as number) | 0x80;
  b.add('key-x25519-bit255', 'A valid key with bit 255 set (non-canonical: two strings for one key).', 'parse_key', { kind: 'x25519', value: 'x25519:' + toB64Url(high) }, 'INVALID_KEY');
  // p + 2 (little-endian): a non-canonical encoding (>= p) of u = 2 with bit 255 clear.
  const p2 = new Uint8Array(32).fill(0xff);
  p2[0] = 0xed + 2;
  p2[31] = 0x7f;
  b.add('key-x25519-p-plus-2', 'FINDING (format note F-1): u = p + 2, a non-canonical encoding of u = 2 below 2^255, is ACCEPTED (only bit 255 and small order are checked).', 'parse_key', { kind: 'x25519', value: 'x25519:' + toB64Url(p2) }, 'ok');
  const p1 = p2.slice();
  p1[0] = 0xed + 1;
  b.add('key-x25519-p-plus-1', 'u = p + 1 (= 1 mod p) is of low order: refused.', 'parse_key', { kind: 'x25519', value: 'x25519:' + toB64Url(p1) }, 'INVALID_KEY');
  b.add('key-wrong-prefix', 'x25519 key where ed25519 is expected.', 'parse_key', { kind: 'ed25519', value: formatKey('x25519', x) }, 'FORMAT');
  b.add('key-31-bytes', 'Wrong length.', 'parse_key', { kind: 'ed25519', value: 'ed25519:' + toB64Url(new Uint8Array(31)) }, 'FORMAT');
  b.add('key-padding', 'base64 padding is refused.', 'parse_key', { kind: 'ed25519', value: owner + '=' }, 'FORMAT');
  b.add('key-standard-alphabet', '"+" and "/" (standard alphabet) are refused.', 'parse_key', { kind: 'ed25519', value: 'ed25519:' + '+'.repeat(43) }, 'FORMAT');
  const nonCanon = owner.slice(0, -1) + (owner.endsWith('I') ? 'J' : 'I');
  b.add('key-non-canonical-b64', 'Last character with non-zero unused bits (decodes to the same bytes as another string).', 'parse_key', { kind: 'ed25519', value: nonCanon }, 'FORMAT');

  const loc = (name: string, location: string, want: 'ok' | 'FORMAT', d: string) => b.add(name, d, 'check_location', { location }, want);
  loc('loc-ok', 'https://storage.example.org/alice/', 'ok', 'Typical read address.');
  loc('loc-port-query', 'https://example.org:8443/x?y=1', 'ok', 'Non-default port and query.');
  loc('loc-public-ipv4', 'https://100.63.255.255/', 'ok', 'Just below the CGNAT range 100.64/10.');
  loc('loc-public-ipv6', 'https://[2001:db8::1]/', 'ok', 'Compressed lowercase IPv6 literal on a non-local prefix.');
  loc('loc-punycode', 'https://xn--bcher-kva.example/', 'ok', 'IDN in its ASCII (punycode) form.');
  loc('loc-percent', 'https://example.org/a%20b/', 'ok', 'Percent-encoded path.');
  loc('loc-http', 'http://example.org/', 'FORMAT', 'Not https.');
  loc('loc-no-path', 'https://example.org', 'FORMAT', 'Not canonical: the WHATWG serialization adds "/".');
  loc('loc-default-port', 'https://example.org:443/', 'FORMAT', 'Not canonical: the default port is dropped.');
  loc('loc-uppercase-host', 'https://EXAMPLE.org/', 'FORMAT', 'Not canonical: the host is lowercased.');
  loc('loc-unicode-host', 'https://bücher.example/', 'FORMAT', 'Not canonical: the host is serialized as punycode.');
  loc('loc-space', 'https://example.org/a b', 'FORMAT', 'Whitespace.');
  loc('loc-backslash', 'https://example.org\\x/', 'FORMAT', 'Backslash.');
  loc('loc-credentials', 'https://user:pw@example.org/', 'FORMAT', 'Credentials.');
  loc('loc-fragment', 'https://example.org/#x', 'FORMAT', 'Fragment.');
  loc('loc-dot-segment', 'https://example.org/a/../b', 'FORMAT', 'Not canonical: dot segments are removed.');
  loc('loc-localhost', 'https://localhost/', 'FORMAT', 'localhost.');
  loc('loc-dot-local', 'https://printer.local/', 'FORMAT', '*.local.');
  loc('loc-dot-internal', 'https://db.corp.internal/', 'FORMAT', '*.internal.');
  loc('loc-private-v4', 'https://10.1.2.3/', 'FORMAT', 'Private IPv4.');
  loc('loc-cgnat', 'https://100.64.0.1/', 'FORMAT', 'CGNAT 100.64/10.');
  loc('loc-link-local', 'https://169.254.1.1/', 'FORMAT', 'Link-local IPv4.');
  loc('loc-ipv4-shorthand', 'https://127.1/', 'FORMAT', 'Not canonical (WHATWG serializes 127.0.0.1); local anyway.');
  loc('loc-v6-loopback', 'https://[::1]/', 'FORMAT', 'IPv6 loopback.');
  loc('loc-v6-mapped', 'https://[::ffff:7f00:1]/', 'FORMAT', 'IPv4-mapped loopback.');
  loc('loc-v6-nat64', 'https://[64:ff9b::a00:1]/', 'FORMAT', 'NAT64 of 10.0.0.1.');
  loc('loc-v6-6to4', 'https://[2002:c0a8:101::]/', 'FORMAT', '6to4 of 192.168.1.1.');
  loc('loc-v6-ula', 'https://[fd00::1]/', 'FORMAT', 'Unique-local IPv6.');
  loc('loc-v6-uncompressed', 'https://[2001:db8:0:0:0:0:0:1]/', 'FORMAT', 'Not canonical: WHATWG compresses the zeros.');
  loc('loc-513-bytes', 'https://example.org/' + 'a'.repeat(493), 'FORMAT', '513 bytes (max 512).');
  loc('loc-512-bytes', 'https://example.org/' + 'a'.repeat(492), 'ok', 'Exactly 512 bytes.');
  return b.file;
}

// ---------------------------------------------------------------------------------------------
const PREFIX = 'TrianguLair-signature-v1\n';
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

export function signatureVectors(sh: Shared): VectorFile {
  const { w } = sh;
  const b = new FileBuilder('signatures', 'README.md', 'Ed25519 signatures with their domain prefix: one vector per domain, and domain confusion.');
  const docBytes = (text: string) => {
    const { signature: _s, ...rest } = JSON.parse(text) as JsonObj;
    return utf8(canonicalize(rest));
  };
  const cases: { domain: string; msg: Uint8Array; pk: Uint8Array; sigB64: string; d: string }[] = [
    { domain: 'index', msg: docBytes(serialize(sh.i1)), pk: w.alice.d1.sign.publicKey, sigB64: sh.i1.signature, d: 'The index of index.json/i1, signed by Alice\'s device d1.' },
    { domain: 'sharing-cert', msg: docBytes(serialize(w.alice.cert0)), pk: w.alice.id.master.publicKey, sigB64: w.alice.cert0.signature, d: 'Alice\'s rotation-0 sharing certificate (master key).' },
    { domain: 'device-cert', msg: docBytes(serialize(w.alice.dc1)), pk: w.alice.id.master.publicKey, sigB64: w.alice.dc1.signature, d: 'Device certificate of d1 (master key).' },
  ];
  for (const c of cases) {
    const message = c.msg;
    b.add(`sig-${c.domain}`, c.d, 'signature', { domain: c.domain, public_key_hex: hex(c.pk), message_hex: hex(message), signature_hex: hex(Buffer.from(c.sigB64, 'base64url')) }, 'ok', {
      prefix: `${PREFIX}${c.domain}\n`,
      signed_bytes_hex: hex(concat(utf8(`${PREFIX}${c.domain}\n`), message)),
    });
  }
  // Binary domains: freshly signed messages (the record bytes are in invitation-record.json).
  const s = S();
  const k = w.alice.d1.sign;
  for (const domain of ['identity-move', 'identity-move-to', 'invitation', 'invitation-record', 'invitation-response']) {
    const message = utf8(`message for ${domain}`);
    const signature = s.crypto_sign_detached(concat(utf8(`${PREFIX}${domain}\n`), message), k.secretKey);
    b.add(`sig-${domain}`, `Domain "${domain}" over a fixed message (device key d1).`, 'signature', { domain, public_key_hex: hex(k.publicKey), message_hex: hex(message), signature_hex: hex(signature) }, 'ok', {
      prefix: `${PREFIX}${domain}\n`,
      signed_bytes_hex: hex(concat(utf8(`${PREFIX}${domain}\n`), message)),
    });
  }
  const first = b.file.vectors[0]!.input;
  b.add('sig-domain-confusion', 'The index signature verified under the "sharing-cert" domain.', 'signature', { ...first, domain: 'sharing-cert' }, 'SIGNATURE');
  b.add('sig-flipped-bit', 'One bit of the message flipped.', 'signature', { ...first, message_hex: hex(flip(Buffer.from(first['message_hex'] as string, 'hex'), 0)) }, 'SIGNATURE');
  const sg = new Uint8Array(Buffer.from(first['signature_hex'] as string, 'hex'));
  let sScalar = 0n;
  for (let i = 63; i >= 32; i--) sScalar = (sScalar << 8n) | BigInt(sg[i] as number);
  let t = sScalar + L;
  for (let i = 32; i < 64; i++) {
    sg[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  b.add('sig-non-canonical-s', 'S + L (malleated signature): refused, S must be < L.', 'signature', { ...first, signature_hex: hex(sg) }, 'SIGNATURE');
  b.add('sig-wrong-key', 'Verified with the master key instead of the device key.', 'signature', { ...first, public_key_hex: hex(w.alice.id.master.publicKey) }, 'SIGNATURE');
  return b.file;
}

// ---------------------------------------------------------------------------------------------
function derivation(phrase: string): JsonObj {
  const s = S();
  const norm = phrase.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
  const entropy = mnemonicToEntropy(norm, wordlist);
  const root = s.crypto_generichash(32, utf8('TrianguLair/root/v1'), entropy);
  const masterSeed = s.crypto_kdf_derive_from_key(32, 1, 'TLmaster', root);
  const vaultKey = s.crypto_kdf_derive_from_key(32, 2, 'TLvault_', root);
  const kp = s.crypto_sign_seed_keypair(masterSeed);
  return {
    normalized: norm,
    entropy_hex: hex(entropy),
    root_hex: hex(root),
    master_seed_hex: hex(masterSeed),
    master_public_hex: hex(kp.publicKey),
    vault_key_hex: hex(vaultKey),
  };
}

export function identityVectors(sh: Shared): VectorFile {
  const { alice } = sh.w;
  const b = new FileBuilder('identity', 'identity-and-keys.md', 'Recovery phrase -> master key, owner id and vault key; the primary-identity blob TLPI.');
  const zoo = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  b.add('phrase-abandon', 'BIP39 test phrase (entropy = 16 zero bytes).', 'identity_from_phrase', { phrase: zoo }, 'ok', derivation(zoo));
  b.add('phrase-alice', 'Alice\'s phrase (from the seeded generator).', 'identity_from_phrase', { phrase: alice.phrase }, 'ok', derivation(alice.phrase));
  const messy = `  ${alice.phrase.toUpperCase().split(' ').join('   ')}\t`;
  b.add('phrase-normalized', 'Case and whitespace are normalized (NFKD, trim, lowercase, single spaces): same identity as phrase-alice.', 'identity_from_phrase', { phrase: messy }, 'ok');
  b.add('phrase-bad-checksum', 'Last word changed: checksum mismatch.', 'identity_from_phrase', { phrase: zoo.replace(/about$/, 'abandon') }, 'INVALID_PHRASE');
  b.add('phrase-11-words', 'Eleven words.', 'identity_from_phrase', { phrase: zoo.split(' ').slice(1).join(' ') }, 'INVALID_PHRASE');
  b.add('phrase-24-words', 'A valid 24-word BIP39 phrase is refused (12 words only).', 'identity_from_phrase', { phrase: 'abandon '.repeat(23) + 'art' }, 'INVALID_PHRASE');
  b.add('phrase-unknown-word', 'A word outside the English list.', 'identity_from_phrase', { phrase: zoo.replace(/^abandon/, 'abandonx') }, 'INVALID_PHRASE');

  const tlpi = encodePrimaryIdentity(alice.id);
  b.add('tlpi-alice', '"TLPI" | 1 | master seed 32 | vault key 32 (69 bytes).', 'decode_primary_identity', { bytes_hex: hex(tlpi) }, 'ok');
  b.add('tlpi-bad-magic', 'Magic "TLPJ".', 'decode_primary_identity', { bytes_hex: hex(flip(tlpi, 3)) }, 'FORMAT');
  const v = (n: number) => {
    const x = tlpi.slice();
    x[4] = n;
    return hex(x);
  };
  b.add('tlpi-version-2', 'Unknown major version.', 'decode_primary_identity', { bytes_hex: v(2) }, 'UNSUPPORTED_VERSION');
  b.add('tlpi-version-0', 'Version 0 is malformed.', 'decode_primary_identity', { bytes_hex: v(0) }, 'FORMAT');
  b.add('tlpi-truncated', '68 bytes.', 'decode_primary_identity', { bytes_hex: hex(tlpi.subarray(0, 68)) }, 'FORMAT');
  b.add('tlpi-trailing', '70 bytes.', 'decode_primary_identity', { bytes_hex: hex(concat(tlpi, Uint8Array.of(0))) }, 'FORMAT');
  return b.file;
}

// ---------------------------------------------------------------------------------------------
export function sharingKeyVectors(sh: Shared): VectorFile {
  const { w } = sh;
  const { alice } = w;
  const b = new FileBuilder('sharing-key', 'identity-and-keys.md', 'TLSK: the sharing key and vault data key sealed to a device (mode 1) or to the phrase-derived vault key (mode 2).');
  const sk = { keyPair: alice.sharing, cert: alice.cert0, vaultDataKey: alice.vdk };
  const dev = (d: Person['d1']) => ({ device: d.id, box_public_hex: hex(d.box.publicKey), box_secret_hex: hex(d.box.secretKey) });
  const m1 = sealSharingKey(sk, alice.dc1);
  const m2 = sealSharingKey(sk, alice.id);
  const opts = { expectedOwner: alice.id.owner };
  b.add('tlsk-device', 'Mode 1, sealed to device d1.', 'open_sharing_key', { bytes_hex: hex(m1), holder: dev(alice.d1), options: opts }, 'ok');
  b.add('tlsk-vault', 'Mode 2, the phrase-protected copy (nonce 24 || XChaCha20-Poly1305, AD = bytes[0..6) || nonce).', 'open_sharing_key', { bytes_hex: hex(m2), holder: { phrase: alice.phrase } }, 'ok', {
    nonce_hex: hex(m2.subarray(6, 30)),
    ad_hex: hex(m2.subarray(0, 30)),
  });
  b.add('tlsk-device-same-cert-lastseen', 'lastSeen = the same certificate: accepted.', 'open_sharing_key', { bytes_hex: hex(m1), holder: dev(alice.d1), options: { ...opts, lastSeen: serialize(alice.cert0) } }, 'ok');
  b.add('tlsk-mode-mismatch', 'A mode-1 blob opened with the phrase.', 'open_sharing_key', { bytes_hex: hex(m1), holder: { phrase: alice.phrase } }, 'FORMAT');
  b.add('tlsk-other-device', 'Sealed to d1, opened by d2.', 'open_sharing_key', { bytes_hex: hex(m1), holder: dev(alice.d2) }, 'DECRYPT');
  b.add('tlsk-vault-tampered', 'Mode 2, last ciphertext byte flipped.', 'open_sharing_key', { bytes_hex: hex(flip(m2, -1)), holder: { phrase: alice.phrase } }, 'DECRYPT');
  b.add('tlsk-vault-header-tampered', 'Mode 2, the mode byte is in the AD: changing the version byte to 3 is refused first.', 'open_sharing_key', { bytes_hex: hex(flip(m2, 4)), holder: { phrase: alice.phrase } }, 'UNSUPPORTED_VERSION');
  b.add('tlsk-vault-other-identity', 'Mode 2 opened with Bob\'s phrase.', 'open_sharing_key', { bytes_hex: hex(m2), holder: { phrase: w.bob.phrase } }, 'DECRYPT');
  b.add('tlsk-bad-magic', 'Magic "TLSL".', 'open_sharing_key', { bytes_hex: hex(flip(m1, 3)), holder: dev(alice.d1) }, 'FORMAT');
  const payload = (over: JsonObj = {}): JsonObj => ({
    cert: plain(alice.cert0),
    secret: toB64Url(alice.sharing.secretKey),
    to: alice.d1.id,
    type: 'sharing-key',
    vault_key: toB64Url(alice.vdk),
    version: 2,
    ...over,
  });
  b.add('tlsk-crafted-ok', 'Mode 1 written from the documented payload.', 'open_sharing_key', { bytes_hex: hex(sealedKeyToDevice(payload(), alice.d1.box.publicKey)), holder: dev(alice.d1) }, 'ok');
  b.add('tlsk-to-other-device', 'Payload addressed to d2, sealed to d1.', 'open_sharing_key', { bytes_hex: hex(sealedKeyToDevice(payload({ to: alice.d2.id }), alice.d1.box.publicKey)), holder: dev(alice.d1) }, 'FORMAT');
  b.add('tlsk-secret-mismatch', 'The secret is not the certified key\'s.', 'open_sharing_key', { bytes_hex: hex(sealedKeyToDevice(payload({ secret: toB64Url(alice.vdk) }), alice.d1.box.publicKey)), holder: dev(alice.d1) }, 'FORMAT');
  b.add('tlsk-payload-version-3', 'Payload version 3.', 'open_sharing_key', { bytes_hex: hex(sealedKeyToDevice(payload({ version: 3 }), alice.d1.box.publicKey)), holder: dev(alice.d1) }, 'UNSUPPORTED_VERSION');
  b.add('tlsk-payload-unknown-field', 'Unknown payload field without a minor.', 'open_sharing_key', { bytes_hex: hex(sealedKeyToDevice(payload({ extra: 1 }), alice.d1.box.publicKey)), holder: dev(alice.d1) }, 'FORMAT');
  b.add('tlsk-payload-minor-unknown-field', 'Unknown payload field with minor 1: ignored.', 'open_sharing_key', { bytes_hex: hex(sealedKeyToDevice(payload({ extra: 1, minor: 1 }), alice.d1.box.publicKey)), holder: dev(alice.d1) }, 'ok');
  b.add('tlsk-envelope-version-3', 'Envelope version byte 3.', 'open_sharing_key', { bytes_hex: hex(sealedKeyToDevice(payload(), alice.d1.box.publicKey, 3)), holder: dev(alice.d1) }, 'UNSUPPORTED_VERSION');
  b.add('tlsk-rollback', 'lastSeen = rotation 1: a rotation-0 key pushed back is refused (R-08).', 'open_sharing_key', { bytes_hex: hex(m1), holder: dev(alice.d1), options: { lastSeen: serialize(w.aliceCert1) } }, 'ROLLBACK');
  b.add('tlsk-other-owner', 'expectedOwner = Bob.', 'open_sharing_key', { bytes_hex: hex(m1), holder: dev(alice.d1), options: { expectedOwner: w.bob.id.owner } }, 'OWNER_MISMATCH');
  return b.file;
}

// ---------------------------------------------------------------------------------------------
export function safetyVectors(sh: Shared): VectorFile {
  const { w } = sh;
  const b = new FileBuilder('safety-code', 'safety-code.md', 'Safety code (12 groups of 5 digits) and its QR payload.');
  const zoo = identityFromPhrase('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about').owner;
  const det = (a: string, c: string): JsonObj => {
    const pa = Buffer.from(a.slice(8), 'base64url');
    const pc = Buffer.from(c.slice(8), 'base64url');
    const [lo, hi] = Buffer.compare(pa, pc) <= 0 ? [pa, pc] : [pc, pa];
    return { hash_hex: hex(S().crypto_generichash(64, concat(utf8('TrianguLair-safety-v1'), lo, hi), null)) };
  };
  b.add('safety-abandon-alice', 'Test identity and Alice.', 'safety_code', { a: zoo, b: w.alice.id.owner }, 'ok', det(zoo, w.alice.id.owner));
  b.add('safety-alice-bob', 'Alice and Bob.', 'safety_code', { a: w.alice.id.owner, b: w.bob.id.owner }, 'ok', det(w.alice.id.owner, w.bob.id.owner));
  b.add('safety-bob-alice', 'Same pair, other order: identical output.', 'safety_code', { a: w.bob.id.owner, b: w.alice.id.owner }, 'ok');
  b.add('safety-same', 'An identity with itself (defined, though meaningless).', 'safety_code', { a: w.alice.id.owner, b: w.alice.id.owner }, 'ok');
  b.add('safety-bad-owner', 'Not an owner id.', 'safety_code', { a: 'x25519:' + w.alice.id.owner.slice(8), b: w.bob.id.owner }, 'FORMAT');
  return b.file;
}

// ---------------------------------------------------------------------------------------------
export function transferVectors(sh: Shared): VectorFile {
  const { alice } = sh.w;
  const b = new FileBuilder('transfer', 'transfer-blob.md', 'TLTX transfer blob ("link + code") and the transfer code.');
  const s = S();
  const code = generateTransferCode();
  const payload = encodeKeyExport({ keyPair: alice.sharing, cert: alice.cert0, vaultDataKey: alice.vdk });
  const blob = encryptForTransfer(payload, code, { now: T0 });
  const ops = readU32be(blob, 6);
  const mem = readU32be(blob, 10);
  const key = s.crypto_pwhash(32, utf8(code), blob.subarray(18, 34), ops, mem, s.crypto_pwhash_ALG_ARGON2ID13);
  const at = { now: iso(plus(T0, 60_000)) };
  b.add('tltx-ok', 'Key-export payload, INTERACTIVE parameters, expires 15 minutes after T0.', 'decrypt_transfer', { blob_hex: hex(blob), code, ...at }, 'ok', {
    code,
    opslimit: ops,
    memlimit: mem,
    expires: readU32be(blob, 14),
    salt_hex: hex(blob.subarray(18, 34)),
    nonce_hex: hex(blob.subarray(34, 58)),
    key_hex: hex(key),
  });
  const short = code
    .split(' ')
    .map((x) => x.slice(0, 4).toUpperCase())
    .join('-');
  b.add('tltx-code-abbreviated', 'The code typed as 4-letter prefixes, uppercase, hyphens.', 'decrypt_transfer', { blob_hex: hex(blob), code: short, ...at }, 'ok');
  const other = code.split(' ').reverse().join(' ');
  b.add('tltx-wrong-code', 'Another valid code.', 'decrypt_transfer', { blob_hex: hex(blob), code: other === code ? 'abandon ability able about above absent' : other, ...at }, 'DECRYPT');
  b.add('tltx-expired', 'now = expires.', 'decrypt_transfer', { blob_hex: hex(blob), code, now: iso(new Date(readU32be(blob, 14) * 1000)) }, 'EXPIRED');
  const set = (off: number, v: number) => {
    const x = blob.slice();
    x.set(u32be(v), off);
    return hex(x);
  };
  b.add('tltx-expiry-extended', 'Expiry moved one hour later (authenticated by the AD).', 'decrypt_transfer', { blob_hex: set(14, readU32be(blob, 14) + 3600), code, ...at }, 'DECRYPT');
  b.add('tltx-ops-too-low', 'opslimit 1 (< INTERACTIVE = 2), refused before any key derivation.', 'decrypt_transfer', { blob_hex: set(6, 1), code, ...at }, 'FORMAT');
  b.add('tltx-ops-too-high', 'opslimit 11 (> 10).', 'decrypt_transfer', { blob_hex: set(6, 11), code, ...at }, 'FORMAT');
  b.add('tltx-mem-too-low', 'memlimit 32 MiB (< 64 MiB).', 'decrypt_transfer', { blob_hex: set(10, 32 * 1024 * 1024), code, ...at }, 'FORMAT');
  b.add('tltx-mem-too-high', 'memlimit 256 MiB + 1.', 'decrypt_transfer', { blob_hex: set(10, 256 * 1024 * 1024 + 1), code, ...at }, 'FORMAT');
  const byte = (off: number, v: number) => {
    const x = blob.slice();
    x[off] = v;
    return hex(x);
  };
  b.add('tltx-purpose-2', 'Unknown purpose.', 'decrypt_transfer', { blob_hex: byte(5, 2), code, ...at }, 'FORMAT');
  b.add('tltx-version-1', 'Old major version.', 'decrypt_transfer', { blob_hex: byte(4, 1), code, ...at }, 'UNSUPPORTED_VERSION');
  b.add('tltx-bad-magic', 'Magic "TLTY".', 'decrypt_transfer', { blob_hex: byte(3, 0x59), code, ...at }, 'FORMAT');
  b.add('tltx-too-short', '73 bytes (header 58 + tag 16 - 1).', 'decrypt_transfer', { blob_hex: hex(blob.subarray(0, 73)), code, ...at }, 'FORMAT');
  b.add('tltx-bad-code', 'Not a code: refused before the key derivation.', 'decrypt_transfer', { blob_hex: hex(blob), code: 'abandon ability', ...at }, 'INVALID_CODE');

  const norm = (c: string, want: 'ok' | 'INVALID_CODE', d: string) => b.add(`code-${b.file.vectors.length}`, d, 'normalize_transfer_code', { code: c }, want);
  norm('aban abil able abou abov abse', 'ok', '4-letter prefixes.');
  norm('Abandon-Ability  ABLE about above absent', 'ok', 'Mixed separators and case.');
  norm('act add age aim air all', 'ok', '3-letter words.');
  norm('abandon ability able about above', 'INVALID_CODE', 'Five words.');
  norm('abandonx ability able about above absent', 'INVALID_CODE', 'Prefix matches but the word does not.');
  norm('aba ability able about above absent', 'INVALID_CODE', 'A 3-letter prefix of a longer word.');
  return b.file;
}

// ---------------------------------------------------------------------------------------------
export function keyExportVectors(sh: Shared): VectorFile {
  const { w } = sh;
  const { alice } = w;
  const b = new FileBuilder('key-export', 'key-export.md', 'Key-export payload (inside a transfer blob): current sharing key, certificate and vault data key.');
  const ke = encodeKeyExport({ keyPair: alice.sharing, cert: alice.cert0, vaultDataKey: alice.vdk });
  const text = new TextDecoder().decode(ke);
  const body = JSON.parse(text) as JsonObj;
  const re = (over: JsonObj) => hex(utf8(canonicalize({ ...body, ...over })));
  b.add('ke-ok', 'Alice\'s rotation-0 key export.', 'decode_key_export', { bytes_hex: hex(ke), options: { expectedOwner: alice.id.owner } }, 'ok', { text });
  b.add('ke-other-owner', 'expectedOwner = Bob.', 'decode_key_export', { bytes_hex: hex(ke), options: { expectedOwner: w.bob.id.owner } }, 'OWNER_MISMATCH');
  b.add('ke-rollback', 'lastSeen = rotation 1.', 'decode_key_export', { bytes_hex: hex(ke), options: { lastSeen: serialize(w.aliceCert1) } }, 'ROLLBACK');
  b.add('ke-version-2', 'Version 2.', 'decode_key_export', { bytes_hex: re({ version: 2 }) }, 'UNSUPPORTED_VERSION');
  b.add('ke-secret-mismatch', 'Secret of another key.', 'decode_key_export', { bytes_hex: re({ secret: toB64Url(w.bob.sharing.secretKey) }) }, 'FORMAT');
  const { vault_key: _vk, ...noVault } = body;
  b.add('ke-missing-vault-key', 'vault_key missing (version 2 shape).', 'decode_key_export', { bytes_hex: hex(utf8(canonicalize(noVault))) }, 'FORMAT');
  b.add('ke-unknown-field', 'Unknown field without minor.', 'decode_key_export', { bytes_hex: re({ master: 'x' }) }, 'FORMAT');
  b.add('ke-wrong-type', 'type = "sharing-key".', 'decode_key_export', { bytes_hex: re({ type: 'sharing-key' }) }, 'FORMAT');
  b.add('ke-non-canonical', 'A space after the first colon.', 'decode_key_export', { bytes_hex: hex(utf8(text.replace(':', ': '))) }, 'FORMAT');
  b.add('ke-invalid-utf8', 'A 0xff byte.', 'decode_key_export', { bytes_hex: hex(concat(ke.subarray(0, 10), Uint8Array.of(0xff), ke.subarray(10))) }, 'FORMAT');
  b.add('ke-tampered-cert', 'Certificate rotation changed (master signature).', 'decode_key_export', { bytes_hex: re({ cert: { ...plain(alice.cert0), rotation: 5 } }) }, 'SIGNATURE');
  void secs;
  void NOW;
  return b.file;
}
