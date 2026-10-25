import { canonicalize, createGroup, packEntry, sealGroupKey, sealPack, serialize, signIndex, toB64Url } from '../../src/index';
import { concat, u32be, utf8 } from '../../src/encoding';
import { sealTyped } from '../../src/pack';
import { S } from '../../src/sodium';
import { FileBuilder, type VectorFile } from './builder';
import { flip, frame, iso, NOW, packBytes, T0 } from './fixtures';
import { hex, type JsonObj } from './ops';
import type { Shared } from './shared';

const HEADER = { alg: 'xchacha20poly1305-ietf', pad: 'padme', type: 'pack', version: 4, wrapAlg: 'x25519-sealedbox' };

export function packVectors(sh: Shared): VectorFile {
  const { w } = sh;
  const { alice, bob, carol, dave } = w;
  const s = S();
  const b = new FileBuilder('pack', 'pack.md', 'Pack envelope, header, AEAD associated data, plaintext frame, Padmé, wraps; opened through a verified index.');
  const ownerPk = alice.id.master.publicKey;
  const kp = (k: { publicKey: Uint8Array; secretKey: Uint8Array }) => ({ public_hex: hex(k.publicKey), secret_hex: hex(k.secretKey) });
  const dummy = () => toB64Url(s.crypto_box_seal(s.randombytes_buf(32), s.crypto_box_keypair().publicKey));

  // The KAT pack: every intermediate value is recorded.
  const id16 = s.randombytes_buf(16);
  const batchKey = s.randombytes_buf(32);
  const nonce = s.randombytes_buf(24);
  const payload = utf8('{"features":[{"id":"node/42","type":"Feature"}],"type":"FeatureCollection"}');
  const wraps = [toB64Url(s.crypto_box_seal(batchKey, bob.sharing.publicKey)), dummy(), toB64Url(s.crypto_box_seal(batchKey, carol.sharing.publicKey)), dummy()];
  const header = { ...HEADER, nonce: toB64Url(nonce) };
  const kfr = frame(id16, 1, payload, 'padme');
  const kat = packBytes({ ownerPk, header, wraps, frame: kfr, batchKey, nonce });

  /** A pack written from its parts with a fresh batch key and nonce, wrapped to Bob (plus `extraWraps`). */
  const craft = (o: { header?: JsonObj; frame?: (id: Uint8Array) => Uint8Array; wraps?: (bk: Uint8Array) => string[]; envelopeVersion?: number; owner?: Uint8Array } = {}) => {
    const bk = s.randombytes_buf(32);
    const n = s.randombytes_buf(24);
    const id = s.randombytes_buf(16);
    const h = { ...HEADER, nonce: toB64Url(n), ...(o.header ?? {}) };
    const fr = o.frame ? o.frame(id) : frame(id, 1, utf8('payload'), (h['pad'] as 'padme' | 'none') === 'none' ? 'none' : 'padme');
    const ws = o.wraps ? o.wraps(bk) : [toB64Url(s.crypto_box_seal(bk, bob.sharing.publicKey)), dummy()];
    const p = packBytes({ ownerPk: o.owner ?? ownerPk, header: h, wraps: ws, frame: fr, batchKey: bk, nonce: n });
    return o.envelopeVersion !== undefined ? concat(p.bytes.subarray(0, 4), Uint8Array.of(o.envelopeVersion), p.bytes.subarray(5)) : p.bytes;
  };
  /** Re-encodes a pack with a modified header text (ciphertext kept). */
  const reheader = (pack: Uint8Array, f: (h: JsonObj) => JsonObj | string) => {
    const n = new DataView(pack.buffer, pack.byteOffset).getUint32(5, false);
    const h = JSON.parse(new TextDecoder().decode(pack.subarray(9, 9 + n))) as JsonObj;
    const out = f(h);
    const hb = utf8(typeof out === 'string' ? out : canonicalize(out));
    return concat(pack.subarray(0, 5), u32be(hb.length), hb, pack.subarray(9 + n));
  };

  const packs: Record<string, Uint8Array> = {
    kat: kat.bytes,
    minor: craft({ header: { minor: 1, x_hint: 'h' } }),
    critKnown: craft({ header: { crit: ['pad'] } }),
    padNone: craft({ header: { pad: 'none' } }),
    empty: craft({ frame: (id) => frame(id, 1, new Uint8Array(0), 'padme') }),
    big: craft({ frame: (id) => frame(id, 3, new Uint8Array(1000).fill(0x61), 'padme') }),
    dummyReplaced: (() => {
      const h = JSON.parse(kat.headerText) as JsonObj;
      const ws = [...(h['wraps'] as string[])];
      ws[1] = dummy();
      return reheader(kat.bytes, (x) => ({ ...x, wraps: ws }));
    })(),
    tamperedCt: flip(kat.bytes, -1),
    tamperedNonce: reheader(kat.bytes, (h) => ({ ...h, nonce: toB64Url(s.randombytes_buf(24)) })),
    tamperedPad: reheader(kat.bytes, (h) => ({ ...h, pad: 'none' })),
    onlyDummy: craft({ wraps: () => [dummy()] }),
    forgedWrap: craft({ wraps: () => [toB64Url(s.crypto_box_seal(s.randombytes_buf(32), bob.sharing.publicKey))] }),
    env5: craft({ envelopeVersion: 5 }),
    env0: craft({ envelopeVersion: 0 }),
    magic: flip(kat.bytes, 0),
    hdrLenHuge: concat(kat.bytes.subarray(0, 5), u32be(0x7fffffff), kat.bytes.subarray(9)),
    hdrLen64k: concat(kat.bytes.subarray(0, 5), u32be(65537), kat.bytes.subarray(9), new Uint8Array(70000)),
    short: kat.bytes.subarray(0, 8),
    hdrVersion5: reheader(kat.bytes, (h) => ({ ...h, version: 5 })),
    hdrWhitespace: reheader(kat.bytes, (h) => canonicalize(h).replace(',', ' ,')),
    hdrUnknown: craft({ header: { x_hint: 'h' } }),
    hdrUnknownCrit: craft({ header: { minor: 1, x_new: 1, crit: ['x_new'] } }),
    hdrAlg: reheader(kat.bytes, (h) => ({ ...h, alg: 'aes256gcm' })),
    hdrWrapAlg: reheader(kat.bytes, (h) => ({ ...h, wrapAlg: 'x25519-hpke' })),
    hdrPad: reheader(kat.bytes, (h) => ({ ...h, pad: 'zero' })),
    hdrType: reheader(kat.bytes, (h) => ({ ...h, type: 'group-key' })),
    wrapsEmpty: reheader(kat.bytes, (h) => ({ ...h, wraps: [] })),
    wrapShort: reheader(kat.bytes, (h) => ({ ...h, wraps: [toB64Url(new Uint8Array(79))] })),
    wraps257: reheader(kat.bytes, (h) => ({ ...h, wraps: Array.from({ length: 257 }, dummy) })),
    nonceShort: reheader(kat.bytes, (h) => ({ ...h, nonce: toB64Url(new Uint8Array(23)) })),
    frNonZeroPad: craft({ frame: (id) => frame(id, 1, utf8('payload'), 'padme', { padByte: 1 }) }),
    frBadLength: craft({ frame: (id) => frame(id, 1, utf8('payload'), 'padme', { length: 300 }) }),
    frNoneTrailing: craft({ header: { pad: 'none' }, frame: (id) => frame(id, 1, utf8('payload'), 'none', { length: 29 }) }),
    frType4: craft({ frame: (id) => frame(id, 4, utf8('payload'), 'padme') }),
    frType0: craft({ frame: (id) => frame(id, 0, utf8('payload'), 'padme') }),
    frDeclaredTooLong: craft({ frame: (id) => frame(id, 1, utf8('payload'), 'padme', { declared: 300 }) }),
    frTooShort: craft({ header: { pad: 'none' }, frame: () => new Uint8Array(20) }),
    otherOwnerAd: craft({ owner: bob.id.master.publicKey }),
  };
  const notListed = sealPack(alice.id.owner, utf8('not listed'), [bob.sharing.publicKey]);
  const ipk = b.fixture('alice_packs', serialize(signIndex(alice.s1, { seq: 1, sharingCert: alice.cert0, packs: Object.values(packs).map((p) => packEntry(p)), vaultDataKey: alice.vdk, now: T0 })));
  const bobRelist = b.fixture('bob_relists', serialize(signIndex(bob.s1, { seq: 1, sharingCert: bob.cert0, packs: [packEntry(kat.bytes)], vaultDataKey: bob.vdk, now: T0 })));
  const now = iso(NOW);
  const aliceIdx = { text: ipk, options: { expectedOwner: alice.id.owner, location: alice.location as string, now } };
  const bobKey = [kp(bob.sharing)];
  const open = (name: string, d: string, bytes: Uint8Array, want: string, keys: JsonObj[] = bobKey, index: JsonObj = aliceIdx, details?: JsonObj) =>
    b.add(name, d, 'open_pack', { bytes_hex: hex(bytes), index, keys }, want, details);

  open('pack-kat', 'Fixed batch key, nonce, id and wraps [Bob, dummy, Carol, dummy]; opened by Bob.', kat.bytes, 'ok', bobKey, aliceIdx, {
    batch_key_hex: hex(batchKey),
    nonce_hex: hex(nonce),
    id_hex: hex(id16),
    payload_hex: hex(payload),
    plaintext_hex: hex(kfr),
    ad_hex: hex(kat.ad),
    header_text: kat.headerText,
    hash: packEntry(kat.bytes).hash,
  });
  open('pack-kat-carol', 'The same pack opened by Carol (third wrap).', kat.bytes, 'ok', [kp(carol.sharing)]);
  open('pack-kat-many-keys', 'Reader holding several keys tries each on each wrap.', kat.bytes, 'ok', [kp(dave.sharing), kp(alice.sharing), kp(bob.sharing)]);
  const i1 = b.fixture('i1', serialize(sh.i1));
  const i1Idx = { text: i1, options: { expectedOwner: alice.id.owner, location: alice.location as string, now } };
  open('pack-library-content', 'sealPack output (content, padme), listed in index i1.', sh.packA, 'ok', bobKey, i1Idx);
  open('pack-library-media', 'sealPack output (media, pad "none"), listed under media/ in index i1.', sh.mediaA, 'ok', bobKey, i1Idx);
  open('pack-minor-extension', 'Header minor 1 with an unknown field, covered by the AD.', packs['minor']!, 'ok');
  open('pack-crit-known', 'Header crit ["pad"].', packs['critKnown']!, 'ok');
  open('pack-pad-none', 'pad "none": plaintext = exactly 21 + payload bytes.', packs['padNone']!, 'ok');
  open('pack-empty-payload', 'Empty payload, padded to 256.', packs['empty']!, 'ok');
  open('pack-media-1000', 'Media payload of 1000 bytes (frame 1021 -> Padmé 1024).', packs['big']!, 'ok');
  open('pack-dummy-wrap-replaced', 'A dummy wrap replaced: wraps are outside the AD, the pack still opens (but it is a new file, listed under its new hash).', packs['dummyReplaced']!, 'ok');

  open('pack-not-listed', 'Not listed in the index: refused before any key operation.', notListed, 'NOT_INDEXED');
  open('pack-index-not-owner-bound', 'Index verified without expectedOwner.', kat.bytes, 'NOT_INDEXED', bobKey, { text: ipk, options: { now } });
  open('pack-relisted', 'Alice\'s pack listed in Bob\'s index: the AD binds Alice\'s key (R-05).', kat.bytes, 'DECRYPT', bobKey, { text: bobRelist, options: { expectedOwner: bob.id.owner, location: bob.location as string, now } });
  open('pack-other-owner-ad', 'Sealed for Bob as owner, listed in Alice\'s index.', packs['otherOwnerAd']!, 'DECRYPT');
  open('pack-no-key', 'None of the reader\'s keys opens a wrap.', kat.bytes, 'NO_MATCHING_KEY', [kp(dave.sharing)]);
  open('pack-only-dummy', 'Only a dummy wrap.', packs['onlyDummy']!, 'NO_MATCHING_KEY');
  open('pack-forged-wrap', 'A wrap to Bob of another key: unwraps, then the AEAD fails.', packs['forgedWrap']!, 'DECRYPT');
  open('pack-tampered-ciphertext', 'Last tag byte flipped (listed under its new hash).', packs['tamperedCt']!, 'DECRYPT');
  open('pack-tampered-nonce', 'Header nonce replaced.', packs['tamperedNonce']!, 'DECRYPT');
  open('pack-tampered-pad-field', 'Header pad changed to "none" (in the AD).', packs['tamperedPad']!, 'DECRYPT');
  open('pack-envelope-5', 'Envelope version 5.', packs['env5']!, 'UNSUPPORTED_VERSION');
  open('pack-envelope-0', 'Envelope version 0.', packs['env0']!, 'FORMAT');
  open('pack-bad-magic', 'Magic "ULPK".', packs['magic']!, 'FORMAT');
  open('pack-header-length-huge', 'N = 2^31 - 1.', packs['hdrLenHuge']!, 'FORMAT');
  open('pack-header-length-64k', 'N = 65537 (max 65536), with enough bytes.', packs['hdrLen64k']!, 'FORMAT');
  open('pack-too-short', '8 bytes.', packs['short']!, 'FORMAT');
  open('pack-header-version-5', 'Header version 5 inside envelope 4.', packs['hdrVersion5']!, 'UNSUPPORTED_VERSION');
  open('pack-header-whitespace', 'Non-canonical header.', packs['hdrWhitespace']!, 'FORMAT');
  open('pack-header-unknown-field', 'Unknown header field without minor.', packs['hdrUnknown']!, 'FORMAT');
  open('pack-header-unknown-crit', 'Unknown crit field.', packs['hdrUnknownCrit']!, 'UNSUPPORTED_VERSION');
  open('pack-header-alg', 'alg "aes256gcm".', packs['hdrAlg']!, 'FORMAT');
  open('pack-header-wrapalg', 'wrapAlg "x25519-hpke".', packs['hdrWrapAlg']!, 'FORMAT');
  open('pack-header-pad', 'pad "zero".', packs['hdrPad']!, 'FORMAT');
  open('pack-header-type', 'type "group-key" (the header type is always "pack").', packs['hdrType']!, 'FORMAT');
  open('pack-wraps-empty', 'No wrap.', packs['wrapsEmpty']!, 'FORMAT');
  open('pack-wrap-79', 'A wrap of 79 bytes.', packs['wrapShort']!, 'FORMAT');
  open('pack-wraps-257', '257 wraps (max 256).', packs['wraps257']!, 'FORMAT');
  open('pack-nonce-23', 'Nonce of 23 bytes.', packs['nonceShort']!, 'FORMAT');
  open('pack-frame-nonzero-padding', 'Valid AEAD, a non-zero padding byte.', packs['frNonZeroPad']!, 'FORMAT');
  open('pack-frame-bad-length', 'Valid AEAD, plaintext of 300 bytes (Padmé gives 256).', packs['frBadLength']!, 'FORMAT');
  open('pack-frame-none-trailing', 'pad "none", one byte after the payload.', packs['frNoneTrailing']!, 'FORMAT');
  open('pack-frame-type-4', 'Payload type 4.', packs['frType4']!, 'FORMAT');
  open('pack-frame-type-0', 'Payload type 0.', packs['frType0']!, 'FORMAT');
  open('pack-frame-declared-too-long', 'Declared payload length beyond the plaintext.', packs['frDeclaredTooLong']!, 'FORMAT');
  open('pack-frame-too-short', 'Plaintext of 20 bytes.', packs['frTooShort']!, 'FORMAT');
  b.add('header-kat', 'Public header of the KAT pack.', 'read_pack_header', { bytes_hex: hex(kat.bytes) }, 'ok');
  b.add('header-short', 'Truncated to 9 bytes plus half a header.', 'read_pack_header', { bytes_hex: hex(kat.bytes.subarray(0, 40)) }, 'FORMAT');

  for (const n of [0, 21, 256, 257, 300, 1000, 1021, 4096, 4097, 65537, 1_000_000, 2 ** 31, 4294967295]) {
    b.add(`padme-${n}`, `Padmé length for a frame of ${n} bytes.`, 'padded_length', { n }, 'ok');
  }
  b.add('padme-2-32', '2^32 is out of range.', 'padded_length', { n: 4294967296 }, 'FORMAT');
  return b.file;
}

export function groupKeyVectors(sh: Shared): VectorFile {
  const { w } = sh;
  const { alice, bob } = w;
  const b = new FileBuilder('group-key', 'group-key.md', 'Group-key pack (payload type 2) and its JSON payload.');
  const group = createGroup();
  const payload = (over: JsonObj = {}) =>
    utf8(canonicalize({ generation: group.generation, group: group.id, owner: alice.id.owner, secretKey: toB64Url(group.keyPair.secretKey), type: 'group-key', version: 2, ...over }));
  const seal = (over: JsonObj) => sealTyped(alice.id.owner, payload(over), [bob.sharing.publicKey], {}, 'group-key');
  const packs: Record<string, Uint8Array> = {
    gk: sealGroupKey(group, alice.id.owner, [bob.sharing.publicKey]),
    content: sealPack(alice.id.owner, payload(), [bob.sharing.publicKey]),
    ownerMismatch: seal({ owner: bob.id.owner }),
    gen0: seal({ generation: 0 }),
    id15: seal({ group: toB64Url(new Uint8Array(15)) }),
    v3: seal({ version: 3 }),
    extra: seal({ members: 3 }),
    minor: seal({ members: 3, minor: 1 }),
    forBob: sealGroupKey(group, bob.id.owner, [bob.sharing.publicKey]),
  };
  const idx = b.fixture('alice_groups', serialize(signIndex(alice.s1, { seq: 1, sharingCert: alice.cert0, packs: Object.values(packs).map((p) => packEntry(p)), vaultDataKey: alice.vdk, now: T0 })));
  const index = { text: idx, options: { expectedOwner: alice.id.owner, location: alice.location as string, now: iso(NOW) } };
  const keys = [{ public_hex: hex(bob.sharing.publicKey), secret_hex: hex(bob.sharing.secretKey) }];
  const g = (name: string, d: string, p: Uint8Array, want: string, details?: JsonObj) => b.add(name, d, 'open_group_key', { bytes_hex: hex(p), index, keys }, want, details);
  g('group-key-ok', 'Generation 1, wrapped to Bob.', packs['gk']!, 'ok', { payload_text: new TextDecoder().decode(payload()) });
  b.add('group-key-as-pack', 'The same pack through open_pack: payload type "group-key".', 'open_pack', { bytes_hex: hex(packs['gk']!), index, keys }, 'ok');
  g('group-key-minor', 'minor 1 with an unknown field.', packs['minor']!, 'ok');
  g('group-key-content-type', 'A content pack (type 1) carrying a group-key JSON.', packs['content']!, 'FORMAT');
  g('group-key-owner-mismatch', 'Payload owner = Bob in Alice\'s index (AD bound to Alice).', packs['ownerMismatch']!, 'OWNER_MISMATCH');
  g('group-key-generation-0', 'generation 0.', packs['gen0']!, 'FORMAT');
  g('group-key-id-15', 'Group id of 15 bytes.', packs['id15']!, 'FORMAT');
  g('group-key-version-3', 'Version 3.', packs['v3']!, 'UNSUPPORTED_VERSION');
  g('group-key-unknown-field', 'Unknown field without minor.', packs['extra']!, 'FORMAT');
  g('group-key-other-owner-ad', 'Sealed for Bob as owner, listed in Alice\'s index.', packs['forBob']!, 'DECRYPT');
  g('group-key-not-listed', 'Not in the index.', sealGroupKey(group, alice.id.owner, [bob.sharing.publicKey]), 'NOT_INDEXED');
  return b.file;
}
