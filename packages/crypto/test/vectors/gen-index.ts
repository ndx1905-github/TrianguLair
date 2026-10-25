import { canonicalize, indexAnchor, issueIdentityMove, issueSharingCert, generateX25519KeyPair, serialize, signIndex, toB64Url } from '../../src/index';
import { concat, readU32be, u32be, utf8 } from '../../src/encoding';
import { listingPadKey } from '../../src/invitation-listing';
import { S } from '../../src/sodium';
import { FileBuilder, type VectorFile } from './builder';
import { compactCert, DAY, HOUR, iso, makeIndex, NOW, plain, plus, secs, signDoc, T0 } from './fixtures';
import { hex, type JsonObj } from './ops';
import type { Shared } from './shared';

export function indexVectors(sh: Shared): VectorFile {
  const { w } = sh;
  const { alice, bob, aliceNew, aliceOther } = w;
  const b = new FileBuilder('signed-index', 'signed-index.md', 'Signed index: verification, ordering (rollback, fork), redirects, identity moves, the invitation listing and its padding.');
  const i1 = b.fixture('i1', serialize(sh.i1));
  const i2 = b.fixture('i2', serialize(sh.i2));
  const rot1 = b.fixture('rot1', serialize(sh.iRot1));
  const now = iso(NOW);
  const opts = { expectedOwner: alice.id.owner, location: alice.location as string, now };
  const v = (name: string, d: string, text: JsonObj | string, want: string, options: JsonObj = opts, details?: JsonObj) => b.add(name, d, 'verify_index', { text, options }, want, details);
  const base = plain(sh.i1);
  const re = (over: JsonObj, from: JsonObj = base, sk: Uint8Array = alice.d1.sign.secretKey) => signDoc('index', { ...from, ...over }, sk);
  const { signature: _sig, ...unsigned } = base;

  // Positive.
  v('index-ok', 'Alice, seq 1, rotation 0: two packs (packs/, media/), public file, invitations listing (1 real token + 3 dummies).', i1, 'ok', opts, { signed_message: canonicalize(unsigned) });
  v('index-ok-no-options', 'Only the clock: verified for nobody in particular (cannot open packs).', i1, 'ok', { now });
  b.add('index-ok-bytes', 'The same index given as UTF-8 bytes.', 'verify_index', { bytes_hex: hex(utf8(serialize(sh.i1))), options: opts }, 'ok');
  v('index-next-seq', 'seq 2 after seq 1.', i2, 'ok', { ...opts, lastSeen: i1 });
  v('index-redelivery', 'The index already held.', i1, 'ok', { ...opts, lastSeen: i1 });
  v('index-higher-rotation-lower-seq', 'Rotation 1, seq 1 after rotation 0, seq 2: the rotation orders first.', rot1, 'ok', { ...opts, lastSeen: i2 });
  const anchor = canonicalize(indexAnchor(sh.i1));
  b.add('anchor-of-i1', 'Compact freshness anchor of index-ok.', 'index_anchor', { text: i1, options: opts }, 'ok');
  v('index-lastseen-anchor', 'lastSeen given as the anchor of seq 1.', i2, 'ok', { ...opts, lastSeenAnchor: anchor });
  v('index-anchor-redelivery', 'The anchored index itself (same hash).', i1, 'ok', { ...opts, lastSeenAnchor: anchor });
  v('index-minor-extension', 'minor 1: unknown top-level field and unknown field in a pack entry are ignored (and signed).', re({
    minor: 1,
    x_top: { a: 1 },
    packs: (base['packs'] as JsonObj[]).map((p) => ({ ...p, x_size: 10 })),
  }), 'ok');
  v('index-crit-known', 'crit lists a known optional field.', re({ crit: ['public'] }), 'ok');
  const { invitations: _inv, ...noInv } = base;
  v('index-no-invitations', 'Without the "invitations" field (readers accept it; writers always write it).', re({}, noInv), 'ok');
  v('index-updated-23h-ahead', 'updated 23 h after the reader\'s clock.', re({ updated: iso(plus(NOW, 23 * HOUR)) }), 'ok');
  v('index-reads-minor', 'reads ["4", "4.1"].', re({ reads: ['4', '4.1'] }), 'ok');

  // Structure.
  v('index-tampered-seq', 'seq changed after signing.', serialize(sh.i1).replace('"seq":1', '"seq":5'), 'SIGNATURE');
  v('index-signed-by-master', 'Signed by the master key instead of the certified device.', re({}, base, alice.id.master.secretKey), 'SIGNATURE');
  v('index-version-5', 'Major 5.', re({ version: 5 }), 'UNSUPPORTED_VERSION');
  v('index-version-3', 'Major 3.', re({ version: 3 }), 'UNSUPPORTED_VERSION');
  v('index-unknown-crit', 'crit names an unknown field.', re({ minor: 1, x_new: true, crit: ['x_new'] }), 'UNSUPPORTED_VERSION');
  v('index-unknown-field', 'Unknown top-level field without minor.', re({ x_top: 1 }), 'FORMAT');
  v('index-unknown-entry-field', 'Unknown field in a pack entry without minor.', re({ packs: (base['packs'] as JsonObj[]).map((p) => ({ ...p, x_size: 10 })) }), 'FORMAT');
  v('index-whitespace', 'A newline at the end.', serialize(sh.i1) + '\n', 'FORMAT');
  v('index-bom', 'Leading BOM.', '﻿' + serialize(sh.i1), 'FORMAT');
  v('index-duplicate-key', 'Duplicate "seq" key.', serialize(sh.i1).replace('"seq":1', '"seq":1,"seq":1'), 'FORMAT');
  const bad = concat(utf8(serialize(sh.i1).slice(0, 20)), Uint8Array.of(0xc3, 0x28), utf8(serialize(sh.i1).slice(20)));
  b.add('index-invalid-utf8', 'Bytes with an invalid UTF-8 sequence.', 'verify_index', { bytes_hex: hex(bad), options: opts }, 'FORMAT');
  b.add('index-bom-bytes', 'UTF-8 BOM bytes EF BB BF before the text.', 'verify_index', { bytes_hex: hex(concat(Uint8Array.of(0xef, 0xbb, 0xbf), utf8(serialize(sh.i1)))), options: opts }, 'FORMAT');
  v('index-updated-25h-ahead', 'updated 25 h after the reader\'s clock.', re({ updated: iso(plus(NOW, 25 * HOUR)) }), 'FORMAT');
  v('index-updated-bad-date', 'updated is not a real instant.', re({ updated: '2026-13-01T00:00:00.000Z' }), 'FORMAT');
  v('index-seq-negative', 'seq -1.', re({ seq: -1 }), 'FORMAT');
  v('index-seq-string', 'seq as a string.', re({ seq: '1' }), 'FORMAT');
  const packs = base['packs'] as JsonObj[];
  const p0 = packs[0] as JsonObj;
  v('index-file-mismatch', 'packs[].file does not match its hash.', re({ packs: [{ ...p0, file: (packs[1] as JsonObj)['file'] as string }] }), 'FORMAT');
  v('index-file-dir', 'packs[].file in another directory.', re({ packs: [{ ...p0, file: (p0['file'] as string).replace('packs/', 'other/') }] }), 'FORMAT');
  v('index-duplicate-pack', 'The same hash listed twice (packs/ and media/).', re({ packs: [p0, { ...p0, file: (p0['file'] as string).replace('packs/', 'media/') }] }), 'FORMAT');
  v('index-pack-as-string', 'A pack entry given as a JSON string (V3-05).', re({ packs: [canonicalize(p0)] }), 'FORMAT');
  v('index-hash-short', 'Hash of 31 bytes.', re({ packs: [{ file: 'packs/b2b256-' + toB64Url(new Uint8Array(31)) + '.bin', hash: 'b2b256:' + toB64Url(new Uint8Array(31)) }] }), 'FORMAT');
  v('index-public-traversal', 'public.file with a path traversal.', re({ public: { ...(base['public'] as JsonObj), file: 'public/../index.geojson' } }), 'FORMAT');
  v('index-reads-empty', 'reads empty.', re({ reads: [] }), 'FORMAT');
  v('index-reads-bad', 'reads ["4.0.1"].', re({ reads: ['4.0.1'] }), 'FORMAT');
  v('index-reads-duplicate', 'reads ["4", "4"].', re({ reads: ['4', '4'] }), 'FORMAT');
  const toks = base['invitations'] as string[];
  v('index-invitations-unsorted', 'invitations not sorted.', re({ invitations: [...toks].reverse() }), 'FORMAT');
  v('index-invitations-empty', 'invitations empty (omit the field instead).', re({ invitations: [] }), 'FORMAT');
  v('index-invitations-bad-token', 'A token that is not "b2b256:" + 32 bytes.', re({ invitations: ['b2b256:x'] }), 'FORMAT');
  const many = Array.from({ length: 257 }, (_, i) => 'b2b256:' + toB64Url(S().crypto_generichash(32, u32be(i), null))).sort();
  v('index-invitations-257', '257 entries (max 256).', re({ invitations: many }), 'FORMAT');
  v('index-invitations-3', '3 entries: readers do not require the writer\'s power-of-two padding.', re({ invitations: toks.slice(0, 3) }), 'ok');
  v('index-implied-field', 'The compact sharing_cert carries "owner" (implied by the index).', re({ sharing_cert: { ...(base['sharing_cert'] as JsonObj), owner: alice.id.owner } }), 'FORMAT');
  v('index-cert-tampered-location', 'sharing_cert.location changed (master signature).', re({ sharing_cert: { ...(base['sharing_cert'] as JsonObj), location: 'https://evil.example.net/' } }), 'SIGNATURE');
  v('index-revoked-list-tampered', 'Top-level revoked_devices changed (covered by the master signature of sharing_cert).', re({ revoked_devices: [alice.d2.id] }), 'SIGNATURE');
  const noLoc = issueSharingCert(alice.id, alice.sharing.publicKey, { rotation: 0 });
  v('index-cert-no-location', 'A sharing certificate without read address cannot be in an index.', re({ sharing_cert: compactCert(noLoc) }), 'FORMAT');
  v('index-foreign-device-cert', 'device_cert is Bob\'s device (master signature over owner = Alice fails).', makeIndex({ keys: bob.d1, dc: bob.dc1, cert: alice.cert0, seq: 1, now: T0, vdk: alice.vdk }), 'SIGNATURE');

  // Trust.
  v('index-expected-owner', 'expectedOwner = Bob.', i1, 'OWNER_MISMATCH', { ...opts, expectedOwner: bob.id.owner });
  v('index-retired-owner', 'Alice is retired.', i1, 'REVOKED', { ...opts, retiredOwners: [alice.id.owner] });
  const d2rot1 = makeIndex({ keys: alice.d2, dc: alice.dc2, cert: w.aliceCert1, seq: 2, now: plus(T0, (5 * HOUR) / 6), vdk: alice.vdk });
  v('index-revoked-signer', 'Signed by d2 under the certificate that revokes d2.', d2rot1, 'REVOKED');
  const d2rot0 = b.fixture('d2rot0', makeIndex({ keys: alice.d2, dc: alice.dc2, cert: alice.cert0, seq: 3, now: plus(T0, (5 * HOUR) / 6), vdk: alice.vdk }));
  v('index-stolen-device-tofu', 'RESIDUAL: d2 (later revoked) signs under the old certificate; a reader without anchor accepts it.', d2rot0, 'ok');
  v('index-stolen-device-after-revocation', 'The same index for a reader who saw rotation 1.', d2rot0, 'ROLLBACK', { ...opts, lastSeen: rot1 });

  // Ordering.
  v('index-rollback', 'seq 1 after seq 2.', i1, 'ROLLBACK', { ...opts, lastSeen: i2 });
  const forkText = makeIndex({ keys: alice.d1, dc: alice.dc1, cert: alice.cert0, seq: 2, now: plus(T0, HOUR / 2), vdk: alice.vdk });
  v('index-fork', 'Another index with seq 2.', forkText, 'ROLLBACK', { ...opts, lastSeen: i2 });
  v('index-fork-anchor', 'Fork detected through an anchor (hash of the canonical index).', forkText, 'ROLLBACK', { ...opts, lastSeenAnchor: canonicalize(indexAnchor(sh.i2)) });
  v('index-seq-step-max', 'seq jumps by exactly 2^20.', makeIndex({ keys: alice.d1, dc: alice.dc1, cert: alice.cert0, seq: 1 + 2 ** 20, now: T0, vdk: alice.vdk }), 'ok', { ...opts, lastSeen: i1 });
  v('index-seq-step-too-far', 'seq jumps by 2^20 + 1.', makeIndex({ keys: alice.d1, dc: alice.dc1, cert: alice.cert0, seq: 2 + 2 ** 20, now: T0, vdk: alice.vdk }), 'ROLLBACK', { ...opts, lastSeen: i1 });
  v('index-lower-rotation', 'Rotation 0 after rotation 1.', i2, 'ROLLBACK', { ...opts, lastSeen: rot1 });
  const forkCert = issueSharingCert(alice.id, generateX25519KeyPair().publicKey, { rotation: 1, location: alice.location as string, revokedDevices: [alice.d2.id] });
  v('index-cert-fork', 'Another master-signed certificate for rotation 1.', makeIndex({ keys: alice.d1, dc: alice.dc1, cert: forkCert, seq: 2, now: T0, vdk: alice.vdk }), 'ROLLBACK', { ...opts, lastSeen: rot1 });
  const unrevoke = issueSharingCert(alice.id, w.aliceSharing1.publicKey, { rotation: 3, location: alice.location as string });
  v('index-unrevoke', 'Rotation 3 that un-revokes d2.', makeIndex({ keys: alice.d1, dc: alice.dc1, cert: unrevoke, seq: 1, now: T0, vdk: alice.vdk }), 'ROLLBACK', { ...opts, lastSeen: rot1 });
  v('index-lastseen-other-owner', 'lastSeen is Bob\'s index.', i1, 'OWNER_MISMATCH', { ...opts, lastSeen: serialize(sh.bobIndex) });

  // Read address.
  v('index-moved-option', 'Read at another address than the certified one: MOVED to the certified address.', i1, 'MOVED', { ...opts, location: 'https://elsewhere.example.net/a/' });
  const moved = b.fixture('rot2', serialize(signIndex(alice.s1, { seq: 1, sharingCert: w.aliceCert2, packs: [], vaultDataKey: alice.vdk, now: plus(T0, (5 * HOUR) / 6) })));
  v('index-storage-move-redirect', 'Rotation 2 (storage move) read at the old address: redirect.', moved, 'MOVED', { ...opts, lastSeen: rot1 });
  v('index-storage-move-new-address', 'Rotation 2 read at the new address.', moved, 'ok', { ...opts, location: w.aliceNewLocation, lastSeen: rot1 });

  // Identity moves.
  const move = issueIdentityMove(alice.id, aliceNew.id, { now: T0 });
  const newIdx = b.fixture('alice_new', serialize(signIndex(aliceNew.s1, { seq: 1, sharingCert: aliceNew.cert0, packs: [], move, vaultDataKey: aliceNew.vdk, now: T0 })));
  const nopts = { location: aliceNew.location as string, now };
  v('index-move-new-owner', 'Alice-new\'s index with the move.', newIdx, 'ok', { ...nopts, expectedOwner: aliceNew.id.owner });
  v('index-move-detected', 'A reader expecting Alice finds the move: IDENTITY_MOVED (never accepted automatically).', newIdx, 'IDENTITY_MOVED', { ...nopts, expectedOwner: alice.id.owner });
  v('index-move-followed', 'Following the move: expectedOwner = new, retiredOwners = [old].', newIdx, 'ok', { ...nopts, expectedOwner: aliceNew.id.owner, retiredOwners: [alice.id.owner] });
  const otherMove = issueIdentityMove(alice.id, aliceOther.id, { now: T0 });
  const otherIdx = serialize(signIndex(aliceOther.s1, { seq: 1, sharingCert: aliceOther.cert0, packs: [], move: otherMove, vaultDataKey: aliceOther.vdk, now: T0 }));
  v('index-move-conflict', 'A second, different successor of the retired identity: IDENTITY_MOVED with conflict.', otherIdx, 'IDENTITY_MOVED', { location: aliceOther.location as string, now, expectedOwner: aliceNew.id.owner, retiredOwners: [alice.id.owner] });
  v('index-move-wrong-target', 'A move to Alice-new embedded in Bob\'s index.', signDoc('index', { ...plain(sh.bobIndex), move: plain(move) }, bob.d1.sign.secretKey), 'FORMAT', { now });

  // Listing padding.
  const padKey = listingPadKey(alice.vdk);
  const slots = (at: Date): JsonObj[] =>
    [0, 1, 2, 3].map((i) => {
      const p = S().crypto_generichash(8, concat(utf8('TrianguLair-invitation-padding-period-v1\n'), u32be(i)), padKey);
      const period = 86400 + (readU32be(p, 0) % 518401);
      const phase = readU32be(p, 4) % period;
      const epoch = Math.floor((secs(at) + phase) / period);
      const dummy = 'b2b256:' + toB64Url(S().crypto_generichash(32, concat(utf8('TrianguLair-invitation-padding-v2\n'), u32be(i), u32be(epoch)), padKey));
      return { slot: i, p_hex: hex(p), period, phase, epoch, dummy };
    });
  const pad = (name: string, d: string, tokens: string[], at: Date) => b.add(name, d, 'listing_padding', { vault_key_hex: hex(alice.vdk), tokens, now: iso(at) }, 'ok', { slots: slots(at) });
  pad('padding-none-open', 'No open invitation: 4 dummies.', [], T0);
  pad('padding-one-open', 'inv1\'s token and 3 dummies (as in index-ok).', [sh.received.token], T0);
  pad('padding-three-days-later', 'No invitation, 3 days later: dummies whose epoch changed differ.', [], plus(T0, 3 * DAY));
  const five = Array.from({ length: 5 }, (_, i) => 'b2b256:' + toB64Url(S().crypto_generichash(32, utf8(`token ${i}`), null)));
  pad('padding-five-open', '5 real tokens: bucket of 8.', five, T0);
  return b.file;
}
