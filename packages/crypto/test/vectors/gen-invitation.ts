import {
  canonicalize,
  contactRecord,
  createInvitation,
  createInvitationResponse,
  emptyVault,
  invitationRecord,
  issueSharingCert,
  sealVault,
  serialize,
  signIndex,
  toB64Url,
  verifyIndex,
  type VaultRecords,
} from '../../src/index';
import { concat, u16be, u32be, utf8 } from '../../src/encoding';
import { deriveInvitation, invitationToken } from '../../src/invitation-listing';
import { S } from '../../src/sodium';
import { FileBuilder, type VectorFile } from './builder';
import {
  compactCertBytes,
  compactDc,
  compactDcBytes,
  DAY,
  flip,
  HOUR,
  iso,
  link,
  LINK_PREFIX,
  linkBytes,
  makeIndex,
  NOW,
  plain,
  plus,
  recordBytes,
  responseBytes,
  secs,
  sig,
  T0,
  vaultBytes,
} from './fixtures';
import { hex, type JsonObj } from './ops';
import type { Shared } from './shared';

// ---------------------------------------------------------------------------------------------
export function invitationLinkVectors(sh: Shared): VectorFile {
  const { w, inv1, f1 } = sh;
  const { alice, bob } = w;
  const s = S();
  const b = new FileBuilder('invitation-link', 'invitation-link.md', 'Short invitation link (version 5), its derivations and listing token, and the invitee-side acceptance against the owner\'s index.');
  const ownerPk = alice.id.master.publicKey;
  const exp = secs(new Date(inv1.expires));
  const addr = (alice.location as string).slice('https://'.length);
  const now = iso(NOW);
  const i1 = b.fixture('i1', serialize(sh.i1));
  const L = (bytes: Uint8Array) => link(bytes);
  const parse = (name: string, d: string, l: string, want: string, at: string = now, details?: JsonObj) => b.add(name, d, 'parse_invitation_link', { link: l, now: at }, want, details);
  parse('link-ok', 'inv1: Alice, rotation 0, expires T0 + 7 days.', f1, 'ok', now, {
    link_bytes_hex: hex(new Uint8Array(Buffer.from(f1, 'base64url'))),
    seed_hex: hex(inv1.seed),
    id_digest_input_hex: hex(concat(utf8('TrianguLair-invitation-id-v1\n'), inv1.seed)),
    secret_digest_input_hex: hex(concat(utf8('TrianguLair-invitation-key-v1\n'), inv1.seed)),
    token_digest_input_hex: hex(
      concat(utf8('TrianguLair-invitation-listing-v2\n'), ownerPk, inv1.keyPair.publicKey, u32be(0), u32be(exp), u16be(utf8(alice.location as string).length), utf8(alice.location as string)),
    ),
    full_link: LINK_PREFIX + f1,
  });
  parse('link-full-url', 'The full https://triangulair.app/i#... link: everything after "#" is the fragment.', LINK_PREFIX + f1, 'ok');
  parse('link-expired', 'Reader clock = expires.', f1, 'EXPIRED', inv1.expires);
  parse('link-max-ahead', 'expires exactly 7 days + 5 minutes after the reader\'s clock.', L(linkBytes(ownerPk, inv1.seed, 0, secs(NOW) + 7 * 86400 + 300, addr)), 'ok');
  parse('link-too-far-ahead', 'expires 7 days + 5 minutes + 1 s after the reader\'s clock.', L(linkBytes(ownerPk, inv1.seed, 0, secs(NOW) + 7 * 86400 + 301, addr)), 'FORMAT');
  parse('link-bad-magic', 'First byte 0x48.', L(linkBytes(ownerPk, inv1.seed, 0, exp, addr, 5, 0x48)), 'FORMAT');
  parse('link-version-4', 'Version 4 (the old signed link).', L(linkBytes(ownerPk, inv1.seed, 0, exp, addr, 4)), 'UNSUPPORTED_VERSION');
  parse('link-version-0', 'Version 0.', L(linkBytes(ownerPk, inv1.seed, 0, exp, addr, 0)), 'FORMAT');
  parse('link-no-address', 'No address bytes.', L(linkBytes(ownerPk, inv1.seed, 0, exp, '')), 'FORMAT');
  parse('link-truncated', '40 bytes.', L(linkBytes(ownerPk, inv1.seed, 0, exp, addr).subarray(0, 40)), 'FORMAT');
  parse('link-address-504', 'Address of 504 bytes (512 with "https://").', L(linkBytes(ownerPk, inv1.seed, 0, exp, 'example.org/' + 'a'.repeat(492))), 'ok');
  parse('link-address-505', 'Address of 505 bytes.', L(linkBytes(ownerPk, inv1.seed, 0, exp, 'example.org/' + 'a'.repeat(493))), 'FORMAT');
  parse('link-too-long', 'Fragment of 751 characters.', 'A'.repeat(751), 'FORMAT');
  parse('link-local-address', 'Address "localhost/".', L(linkBytes(ownerPk, inv1.seed, 0, exp, 'localhost/')), 'FORMAT');
  parse('link-non-canonical-address', 'Address "EXAMPLE.org/".', L(linkBytes(ownerPk, inv1.seed, 0, exp, 'EXAMPLE.org/')), 'FORMAT');
  parse('link-address-invalid-utf8', 'Address with an invalid UTF-8 byte.', L(concat(linkBytes(ownerPk, inv1.seed, 0, exp, 'example.org/'), Uint8Array.of(0xff))), 'FORMAT');
  // 85 bytes = 114 characters: the last character carries 4 unused bits.
  const f85 = L(linkBytes(ownerPk, inv1.seed, 0, exp, addr + 'x'));
  parse('link-85-bytes', 'A link of 85 bytes (its last base64url character has 4 unused bits, here zero).', f85, 'ok');
  parse('link-non-canonical-b64', 'The same link with a non-zero unused bit in the last character.', (() => {
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    return f85.slice(0, -1) + (c[c.indexOf(f85[f85.length - 1] as string) ^ 1] as string);
  })(), 'FORMAT');
  parse('link-padding', 'base64 "=" padding.', f1 + '=', 'FORMAT');

  b.add('token-inv1', 'Listing token of inv1 (in index i1).', 'invitation_token', {
    owner_public_hex: hex(ownerPk),
    invitation_public_hex: hex(inv1.keyPair.publicKey),
    rotation: 0,
    expires: exp,
    location: alice.location as string,
  }, 'ok');

  const acc = (name: string, d: string, l: string, index: JsonObj | string, want: string, extra: JsonObj = {}) => b.add(name, d, 'accept_invitation', { link: l, index, now, ...extra }, want);
  acc('accept-ok', 'inv1 against index i1 read at the link\'s address.', f1, i1, 'ok');
  acc('accept-lastseen', 'An existing contact: index i2 (lists inv1) with lastSeen i1.', f1, serialize(sh.i2), 'ok', { lastSeen: i1 });
  acc('accept-rollback-lastseen', 'An existing contact must not be reset: i1 with lastSeen i2.', f1, i1, 'ROLLBACK', { lastSeen: serialize(sh.i2) });
  const nolist = makeIndex({ keys: alice.d1, dc: alice.dc1, cert: alice.cert0, seq: 3, now: T0, vdk: alice.vdk });
  acc('accept-not-listed', 'The owner\'s index does not list the invitation.', f1, nolist, 'NOT_LISTED');
  acc('accept-tampered-expiry', 'Expiry shortened by one hour in the link: token mismatch.', L(linkBytes(ownerPk, inv1.seed, 0, exp - 3600, addr)), i1, 'NOT_LISTED');
  acc('accept-tampered-seed', 'Another seed (another invitation key): token mismatch.', L(linkBytes(ownerPk, s.randombytes_buf(16), 0, exp, addr)), i1, 'NOT_LISTED');
  acc('accept-link-rotation-ahead', 'Link rotation 1, index rotation 0: the index is older than the link.', L(linkBytes(ownerPk, inv1.seed, 1, exp, addr)), i1, 'ROLLBACK');
  const evil = 'evil.example.net/x/';
  acc('accept-rewritten-address', 'Address rewritten; the genuine index served there redirects to the certified address.', L(linkBytes(ownerPk, inv1.seed, 0, exp, evil)), i1, 'MOVED');
  acc('accept-rewritten-address-followed', 'After following MOVED: the token binds the address (V4-04).', L(linkBytes(ownerPk, inv1.seed, 0, exp, evil)), i1, 'NOT_LISTED', { read_from: alice.location as string });
  acc('accept-other-owner', 'The link names Bob\'s master key, the index is Alice\'s.', L(linkBytes(bob.id.master.publicKey, inv1.seed, 0, exp, addr)), i1, 'OWNER_MISMATCH');
  acc('accept-later-rotation', 'Index of rotation 1: a key change cancelled the invitation (R5-01).', f1, serialize(sh.iRot1), 'NOT_LISTED');
  const faulty = makeIndex({ keys: alice.d1, dc: alice.dc1, cert: w.aliceCert1, seq: 2, now: T0, vdk: alice.vdk, tokens: [sh.received.token] });
  acc('accept-later-rotation-still-listed', 'A faulty writer lists inv1 under rotation 1: refused by the reader too.', f1, faulty, 'NOT_LISTED');
  acc('accept-expired', 'At expiry.', f1, i1, 'EXPIRED', { now: inv1.expires });
  acc('accept-tampered-index', 'Index text altered.', f1, serialize(sh.i1).replace('"seq":1', '"seq":2'), 'SIGNATURE');
  // A device later declared lost (d2) invites before the declaration.
  const { invitation: inv2, fragment: f2 } = createInvitation(alice.s2, alice.cert0, { now: plus(T0, HOUR / 4) });
  const d2idx = makeIndex({ keys: alice.d2, dc: alice.dc2, cert: alice.cert0, seq: 3, now: plus(T0, HOUR / 4), vdk: alice.vdk, tokens: [invitationToken(ownerPk, inv2.keyPair.publicKey, 0, secs(new Date(inv2.expires)), alice.location as string)] });
  acc('accept-stolen-device-tofu', 'RESIDUAL: d2\'s link and index under the old certificate, for a new contact without anchor.', f2, d2idx, 'ok');
  acc('accept-stolen-device-after-declaration', 'The index after the declaration (rotation 1) lists nothing of d2.', f2, serialize(sh.iRot1), 'NOT_LISTED');
  const d2rot1 = makeIndex({ keys: alice.d2, dc: alice.dc2, cert: w.aliceCert1, seq: 2, now: T0, vdk: alice.vdk, tokens: [invitationToken(ownerPk, inv2.keyPair.publicKey, 1, secs(new Date(inv2.expires)), alice.location as string)] });
  acc('accept-revoked-device-index', 'd2 signs an index under the certificate that revokes it.', L(linkBytes(ownerPk, inv2.seed, 1, secs(new Date(inv2.expires)), addr)), d2rot1, 'REVOKED');
  return b.file;
}

// ---------------------------------------------------------------------------------------------
export function returnLinkVectors(sh: Shared): VectorFile {
  const { w, inv1, received, r1, r2 } = sh;
  const { alice, bob, carol, dave } = w;
  const s = S();
  const b = new FileBuilder('return-link', 'return-link.md', 'Return link (response version 4) with its compact certificates; owner-side opening, collection and freshness check.');
  const now = iso(NOW);
  const invitation = b.fixture('inv1', { record: sh.rec1, owner: alice.id.owner });
  const id16 = new Uint8Array(Buffer.from(inv1.id, 'base64url'));
  const invPk = inv1.keyPair.publicKey;
  const ownerPk = alice.id.master.publicKey;
  const open = (name: string, d: string, bytes: Uint8Array, want: string, at: string = now, details?: JsonObj) => b.add(name, d, 'open_invitation_response', { bytes_hex: hex(bytes), invitation, now: at }, want, details);
  const inner1 = s.crypto_box_seal_open(r1.subarray(2), invPk, inv1.keyPair.secretKey);
  open('response-bob', 'Bob\'s answer, signed by his device d1, carrying his rotation-0 certificate.', r1, 'ok', now, {
    inner_hex: hex(inner1),
    signed_bytes_hex: hex(concat(inner1.subarray(0, inner1.length - 64), ownerPk, invPk)),
  });
  open('response-carol', 'Carol\'s answer.', r2, 'ok');
  open('response-after-expiry', 'Opened during the grace period: openedAfterExpiry.', r1, 'ok', iso(plus(new Date(inv1.expires), HOUR)));
  open('response-after-grace', 'Opened at expiry + 7 days.', r1, 'EXPIRED', iso(plus(new Date(inv1.expires), 7 * DAY)));
  open('response-tampered', 'A byte of the sealed box flipped.', flip(r1, 40), 'DECRYPT');
  open('response-version-3', 'Version byte 3.', concat(Uint8Array.of(0x52, 3), r1.subarray(2)), 'UNSUPPORTED_VERSION');
  open('response-bad-magic', 'Magic 0x53.', concat(Uint8Array.of(0x53), r1.subarray(1)), 'FORMAT');
  open('response-too-long', '9601 bytes.', concat(r1, new Uint8Array(9601 - r1.length)), 'FORMAT');
  open('response-one-byte', '1 byte.', Uint8Array.of(0x52), 'FORMAT');
  const other = createInvitation(alice.s1, alice.cert0, { now: T0 }).invitation;
  b.add('response-other-invitation', 'Bob\'s answer opened with another invitation\'s key.', 'open_invitation_response', { bytes_hex: hex(r1), invitation: { record: serialize(invitationRecord(other)), owner: alice.id.owner }, now }, 'DECRYPT');

  const spec = (over: Partial<Parameters<typeof responseBytes>[0]> = {}) =>
    responseBytes({
      id16,
      responderPk: bob.id.master.publicKey,
      createdS: secs(NOW),
      certBytes: compactCertBytes(bob.cert0),
      dcBytes: compactDcBytes(bob.dc1),
      signerSk: bob.d1.sign.secretKey,
      inviterPk: ownerPk,
      invitationPk: invPk,
      ...over,
    });
  open('response-crafted', 'Written from the documented layout (same as Bob\'s, other created time).', spec({ createdS: secs(NOW) + 60 }).bytes, 'ok');
  open('response-created-before', 'created 5 minutes + 1 s before the invitation.', spec({ createdS: secs(T0) - 301 }).bytes, 'FORMAT');
  open('response-created-skew', 'created exactly 5 minutes before the invitation (clock skew allowance).', spec({ createdS: secs(T0) - 300 }).bytes, 'ok');
  open('response-created-at-expiry', 'created = expires.', spec({ createdS: secs(new Date(inv1.expires)) }).bytes, 'FORMAT', iso(plus(new Date(inv1.expires), HOUR)));
  open('response-revoked-device', 'Signed by d1, carrying Bob\'s rotation-1 certificate that revokes d1.', spec({ certBytes: compactCertBytes(w.bobCert1) }).bytes, 'REVOKED');
  open('response-signer-mismatch', 'Signed by d2 while carrying d1\'s device certificate.', spec({ signerSk: bob.d2.sign.secretKey }).bytes, 'SIGNATURE');
  open('response-other-inviter', 'Signature bound to Bob as inviter instead of Alice.', spec({ inviterPk: bob.id.master.publicKey }).bytes, 'SIGNATURE');
  // Signed for another invitation key (Carol's sharing key stands in for it), then sealed to inv1's key.
  const otherKey = spec({ invitationPk: carol.sharing.publicKey });
  open('response-other-invitation-key', 'Signature bound to another invitation key.', concat(Uint8Array.of(0x52, 4), s.crypto_box_seal(otherKey.inner, invPk)), 'SIGNATURE');
  open('response-id-mismatch', 'Another invitation id, sealed to inv1\'s key.', spec({ id16: new Uint8Array(16) }).bytes, 'FORMAT');
  open('response-trailing', 'One byte after the signature.', spec({ trailing: Uint8Array.of(0) }).bytes, 'FORMAT');
  open('response-foreign-device-cert', 'Carol\'s device certificate under Bob\'s master key.', spec({ dcBytes: compactDcBytes(carol.dc1), signerSk: carol.d1.sign.secretKey }).bytes, 'SIGNATURE');
  const unsorted = compactCertBytes({ ...plain(bob.cert0), revoked_devices: [bob.d2.id, bob.d1.id].sort().reverse() });
  open('response-unsorted-revoked', 'Compact certificate with an unsorted revoked list.', spec({ certBytes: unsorted }).bytes, 'FORMAT');
  const daveAnswer = createInvitationResponse(received, dave.s1, dave.cert0, { now: NOW });
  open('response-no-location', 'Dave publishes nothing: L = 0, no location.', daveAnswer, 'ok');

  const col = (name: string, d: string, rs: Uint8Array[], want: string, extra: JsonObj = {}) => b.add(name, d, 'collect_answers', { responses_hex: rs.map(hex), invitation, now, ...extra }, want);
  col('collect-one', 'One answer: accepted.', [r1], 'ok');
  col('collect-two', 'Two responders: none accepted (multiple).', [r1, r2], 'ok');
  col('collect-late', 'acceptedOwner = Bob: Carol is late.', [r1, r2], 'ok', { acceptedOwner: bob.id.owner });
  col('collect-rejected', 'An answer that does not open is counted in rejected.', [r1, flip(r1, 40)], 'ok');
  col('collect-same-responder', 'The same responder twice counts once.', [r1, spec({ createdS: secs(NOW) + 60 }).bytes], 'ok');
  col('collect-after-grace', 'After the grace period.', [r1], 'EXPIRED', { now: iso(plus(new Date(inv1.expires), 7 * DAY)) });

  const bobIdx = serialize(sh.bobIndex);
  const chk = (name: string, d: string, bytes: Uint8Array, index: string, want: string) => b.add(name, d, 'check_answer_index', { bytes_hex: hex(bytes), invitation, index, now }, want);
  chk('answer-index-ok', 'Bob\'s answer and Bob\'s index at his certified address.', r1, bobIdx, 'ok');
  const bobRot1 = serialize(signIndex(bob.s2, { seq: 1, sharingCert: w.bobCert1, packs: [], vaultDataKey: bob.vdk, now: T0 }));
  chk('answer-index-device-revoked', 'Bob\'s index now revokes d1, the device that signed the answer.', r1, bobRot1, 'REVOKED');
  const newer = spec({ certBytes: compactCertBytes(w.bobCert1), dcBytes: compactDcBytes(bob.dc2), signerSk: bob.d2.sign.secretKey }).bytes;
  chk('answer-index-older', 'The answer carries rotation 1, the index read is rotation 0.', newer, bobIdx, 'ROLLBACK');
  chk('answer-index-other-owner', 'Carol\'s index given for Bob\'s answer.', r1, serialize(signIndex(carol.s1, { seq: 1, sharingCert: carol.cert0, packs: [], vaultDataKey: carol.vdk, now: T0 })), 'OWNER_MISMATCH');
  void verifyIndex;
  return b.file;
}

// ---------------------------------------------------------------------------------------------
export function invitationRecordVectors(sh: Shared): VectorFile {
  const { w, inv1 } = sh;
  const { alice, bob } = w;
  const b = new FileBuilder('invitation-record', 'invitation-record.md', 'Invitation record (vault form), its device signature, and the listing decision (invitationStatus / signIndex skip reasons).');
  const ownerPk = alice.id.master.publicKey;
  const rec = JSON.parse(sh.rec1) as JsonObj;
  const msg = recordBytes(ownerPk, new Uint8Array(Buffer.from(inv1.id, 'base64url')), inv1.keyPair.publicKey, 0, secs(new Date(inv1.created)), secs(new Date(inv1.expires)), inv1.location);
  b.add('record-signature', 'The record signature of inv1 (domain "invitation-record", device d1).', 'signature', {
    domain: 'invitation-record',
    public_key_hex: hex(alice.d1.sign.publicKey),
    message_hex: hex(msg),
    signature_hex: hex(new Uint8Array(Buffer.from(inv1.signature, 'base64url'))),
  }, 'ok', { record: sh.rec1 });
  const st = (name: string, d: string, record: string, cert: string, at: Date, status: string, owner: string = alice.id.owner) =>
    b.add(name, d, 'invitation_status', { record, owner, sharing_cert: cert, now: iso(at) }, 'ok', undefined, (e) => {
      if ((e['ok'] as JsonObj)['status'] !== status) throw new Error(`${name}: status ${JSON.stringify(e)} instead of ${status}`);
    });
  const c0 = serialize(alice.cert0);
  const c1 = serialize(w.aliceCert1);
  st('status-listed', 'inv1 under rotation 0 at NOW.', sh.rec1, c0, NOW, 'listed');
  st('status-expired', 'At expiry.', sh.rec1, c0, new Date(inv1.expires), 'expired');
  st('status-superseded', 'Under rotation 1 (any rotation cancels, R5-01).', sh.rec1, c1, NOW, 'superseded');
  const { invitation: inv2 } = createInvitation(alice.s2, alice.cert0, { now: T0 });
  st('status-revoked', 'Created by d2, which rotation 1 revokes.', serialize(invitationRecord(inv2)), c1, NOW, 'revoked');
  const { invitation: future } = createInvitation(alice.s1, alice.cert0, { now: plus(NOW, 10 * 60 * 1000) });
  st('status-not-yet-clock', 'Created 10 minutes after the publisher\'s clock.', serialize(invitationRecord(future)), c0, NOW, 'not-yet');
  const { invitation: newer } = createInvitation(alice.s1, w.aliceCert1, { now: T0 });
  st('status-not-yet-rotation', 'Created under rotation 1, publisher still holds rotation 0.', serialize(invitationRecord(newer)), c0, NOW, 'not-yet');
  st('status-forged-signature', 'Signature of another record.', canonicalize({ ...rec, signature: inv2.signature }), c0, NOW, 'invalid');
  // Properly signed by d1, but lasting 8 days.
  const longExp = secs(new Date(inv1.created)) + 8 * 86400;
  const longSig = sig('invitation-record', recordBytes(ownerPk, new Uint8Array(Buffer.from(inv1.id, 'base64url')), inv1.keyPair.publicKey, 0, secs(new Date(inv1.created)), longExp, inv1.location), alice.d1.sign.secretKey);
  st('status-lifetime-8-days', 'Correctly signed, lifetime 8 days.', canonicalize({ ...rec, expires: iso(new Date(longExp * 1000)), signature: toB64Url(longSig) }), c0, NOW, 'invalid');
  const otherDevSig = sig('invitation-record', msg, alice.d2.sign.secretKey);
  st('status-other-device-name', 'd2 signs a record carrying d1\'s certificate.', canonicalize({ ...rec, signature: toB64Url(otherDevSig) }), c0, NOW, 'invalid');
  st('status-other-owner', 'Alice\'s record checked as Bob\'s.', sh.rec1, serialize(bob.cert0), NOW, 'invalid', bob.id.owner);
  const seed = deriveInvitation(new Uint8Array(16));
  st('status-id-mismatch', 'id does not derive from the seed.', canonicalize({ ...rec, id: seed.id }), c0, NOW, 'invalid');
  st('status-millis', 'created with milliseconds: not a whole second.', canonicalize({ ...rec, created: (rec['created'] as string).replace('.000Z', '.500Z') }), c0, NOW, 'invalid');
  void compactDc;
  return b.file;
}

// ---------------------------------------------------------------------------------------------
export function vaultVectors(sh: Shared): VectorFile {
  const { w, inv1, r1, r2 } = sh;
  const { alice, bob } = w;
  const s = S();
  const b = new FileBuilder('vault', 'vault.md', 'TLVD recovery-vault envelope and records; merge.');
  const ownerPk = alice.id.master.publicKey;
  const bobIdx = verifyIndex(serialize(sh.bobIndex), { expectedOwner: bob.id.owner, now: NOW });
  const records: VaultRecords = {
    ...emptyVault(alice.id.owner),
    contacts: [contactRecord(bobIdx, true)],
    invitations: [invitationRecord(inv1, { answers: [r1], accepted: bob.id.owner })],
    retired_owners: [w.aliceOther.id.owner],
    app: { storage: { kind: 'webdav' } },
  };
  const v1 = sealVault(records, alice.vdk);
  const json = canonicalize(plain(records));
  const k = hex(alice.vdk);
  const open = (name: string, d: string, bytes: Uint8Array, want: string, extra: JsonObj = {}, details?: JsonObj) =>
    b.add(name, d, 'open_vault', { bytes_hex: hex(bytes), owner: alice.id.owner, vault_key_hex: k, ...extra }, want, details);
  open('vault-ok', 'Contact Bob (anchor, verified), inv1 with Bob\'s answer accepted, a retired owner, app data.', v1, 'ok', {}, { records_text: json, nonce_hex: hex(v1.subarray(5, 29)) });
  const raw = (doc: JsonObj, o: { length?: number; padByte?: number; declared?: number } = {}) => vaultBytes({ json: canonicalize(doc), ownerPk, key: alice.vdk, ...o });
  const base = plain(records);
  open('vault-crafted', 'Written from the documented envelope.', raw(base), 'ok');
  open('vault-empty', 'Empty records.', sealVault(emptyVault(alice.id.owner), alice.vdk), 'ok');
  open('vault-wrong-key', 'Another vault data key.', v1, 'DECRYPT', { vault_key_hex: hex(bob.vdk) });
  open('vault-other-owner', 'Opened as Bob\'s vault (owner key in the AD).', v1, 'DECRYPT', { owner: bob.id.owner });
  open('vault-version-2', 'Version 2.', concat(v1.subarray(0, 4), Uint8Array.of(2), v1.subarray(5)), 'UNSUPPORTED_VERSION');
  open('vault-bad-magic', 'Magic "TLVE".', flip(v1, 3), 'FORMAT');
  open('vault-too-short', '44 bytes.', v1.subarray(0, 44), 'FORMAT');
  open('vault-truncated', 'Last byte removed.', v1.subarray(0, v1.length - 1), 'DECRYPT');
  open('vault-bad-padding-length', 'Plaintext not of Padmé length.', raw(base, { length: 4 + utf8(canonicalize(base)).length + 1 }), 'FORMAT');
  open('vault-nonzero-padding', 'A non-zero padding byte.', raw(base, { padByte: 1 }), 'FORMAT');
  open('vault-declared-too-long', 'Declared length beyond the plaintext.', raw(base, { declared: 1 << 20 }), 'FORMAT');
  open('vault-unknown-field', 'Unknown top-level field without minor.', raw({ ...base, x: 1 }), 'FORMAT');
  open('vault-huge-minor', 'minor 2^53 - 1 with unknown fields (a stolen device may write this; N-2): accepted.', raw({ ...base, minor: 9007199254740991, x: { planted: true } }), 'ok');
  open('vault-unknown-crit', 'crit names an unknown field.', raw({ ...base, minor: 1, x: 1, crit: ['x'] }), 'UNSUPPORTED_VERSION');
  open('vault-records-other-owner', 'Records of Bob sealed with Alice\'s key and owner.', raw({ ...base, owner: bob.id.owner }), 'OWNER_MISMATCH');
  open('vault-wrong-type', 'type "vault".', raw({ ...base, type: 'vault' }), 'FORMAT');
  const contact = (base['contacts'] as JsonObj[])[0] as JsonObj;
  const carolC: JsonObj = { ...contact, owner: w.carol.id.owner, sharing_cert: plain(w.carol.cert0) };
  const { anchor: _a, ...carolNoAnchor } = carolC;
  open('vault-contacts-unsorted', 'Contacts not sorted by owner.', raw({ ...base, contacts: [carolNoAnchor, contact].sort((x, y) => ((x['owner'] as string) < (y['owner'] as string) ? 1 : -1)) }), 'FORMAT');
  open('vault-contact-cert-other-owner', 'A contact whose certificate belongs to someone else.', raw({ ...base, contacts: [{ ...contact, sharing_cert: plain(w.carol.cert0) }] }), 'OWNER_MISMATCH');
  open('vault-contact-anchor-tampered', 'Anchor seq changed: accepted (anchors are authenticated by the vault data key only); its certificate is master-checked.', raw({ ...base, contacts: [{ ...contact, anchor: { ...(contact['anchor'] as JsonObj), seq: 99 } }] }), 'ok');
  open('vault-contact-anchor-bad-cert', 'Anchor certificate with a bad master signature.', raw({ ...base, contacts: [{ ...contact, anchor: { ...(contact['anchor'] as JsonObj), sharing_cert: { ...plain(bob.cert0), rotation: 3 } } }] }), 'SIGNATURE');
  const inv = (base['invitations'] as JsonObj[])[0] as JsonObj;
  open('vault-invitation-forged', 'Invitation record whose signature is not the creating device\'s.', raw({ ...base, invitations: [{ ...inv, signature: toB64Url(new Uint8Array(64)) }] }), 'SIGNATURE');
  const longExp = secs(new Date(inv1.created)) + 8 * 86400;
  const longSig = sig('invitation-record', recordBytes(ownerPk, new Uint8Array(Buffer.from(inv1.id, 'base64url')), inv1.keyPair.publicKey, 0, secs(new Date(inv1.created)), longExp, inv1.location), alice.d1.sign.secretKey);
  open('vault-invitation-8-days', 'Correctly signed record lasting 8 days.', raw({ ...base, invitations: [{ ...inv, expires: iso(new Date(longExp * 1000)), signature: toB64Url(longSig) }] }), 'FORMAT');
  open('vault-planted-answers', 'Junk answers (base64url, not return links): accepted by openVault, rejected by collectInvitationAnswers.', raw({ ...base, invitations: [{ ...inv, answers: ['AAAA', 'BBBB', ...(inv['answers'] as string[])].sort() }] }), 'ok');
  open('vault-17-answers', '17 answers (max 16).', raw({ ...base, invitations: [{ ...inv, answers: Array.from({ length: 17 }, (_, i) => toB64Url(Uint8Array.of(i, i))).sort() }] }), 'FORMAT');
  open('vault-answer-too-long', 'An answer of 13001 characters.', raw({ ...base, invitations: [{ ...inv, answers: ['A'.repeat(13001)] }] }), 'FORMAT');
  open('vault-accepted-not-a-key', 'accepted is not an owner id.', raw({ ...base, invitations: [{ ...inv, accepted: 'bob' }] }), 'FORMAT');
  open('vault-retired-unsorted', 'retired_owners unsorted.', raw({ ...base, retired_owners: [w.aliceOther.id.owner, w.aliceNew.id.owner].sort().reverse() }), 'FORMAT');
  open('vault-app-not-object', 'app is a string.', raw({ ...base, app: 'x' }), 'FORMAT');

  // Merge: the other device saw Carol's answer and un-verified Bob.
  const otherSide: VaultRecords = { ...records, contacts: [contactRecord(bobIdx, false)], invitations: [invitationRecord(inv1, { answers: [r2] })], retired_owners: [w.aliceNew.id.owner], app: { storage: { kind: 's3' } } };
  const v2 = sealVault(otherSide, alice.vdk);
  b.add('merge', 'Union of answers and retired owners; verified if either says so; accepted and app from a.', 'merge_vaults', { a_hex: hex(v1), b_hex: hex(v2), owner: alice.id.owner, vault_key_hex: k }, 'ok');
  const minorSide = raw({ ...plain(otherSide), minor: 3, x_new: { kept: true } });
  b.add('merge-newer-minor', 'b written by a newer minor: its minor and unknown field are kept (V4-07).', 'merge_vaults', { a_hex: hex(v1), b_hex: hex(minorSide), owner: alice.id.owner, vault_key_hex: k }, 'ok');
  void s;
  return b.file;
}
