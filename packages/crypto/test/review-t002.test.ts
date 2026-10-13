/*
 * T-002 independent review: tests demonstrating findings from
 * docs/reviews/2026-10-13-crypto-T-002.md.
 *
 * Each `it.fails(...)` states the DESIRED secure behaviour. It currently fails
 * (so the suite stays green); once the finding is fixed the test will start
 * passing, `it.fails` will then report an error, and it must be turned into a
 * plain `it(...)`.
 */
import { describe, expect, it } from 'vitest';
import {
  checkNoRollback,
  createGroup,
  createInvitation,
  decodeKeyExport,
  deriveSharingKeyPair,
  encodeKeyExport,
  issueSharingCert,
  openGroupKey,
  openPack,
  parseInvitationLink,
  rotateGroup,
  sealGroupKey,
  sealPack,
  serialize,
  signIndex,
  TLCryptoError,
  verifyIndex,
  verifySharingCert,
} from '../src/index';
import { signBody } from '../src/sign';
import { person, te } from './helpers';

describe('T-002 F-01 (high): sharing-key rotation does not survive theft of a full device', () => {
  it.fails('a stolen full-device key export cannot open packs wrapped to the post-theft sharing key', () => {
    const victim = person(0);
    // Thief extracts the full-device export (what encodeKeyExport({identity}) puts on a device).
    const stolen = decodeKeyExport(encodeKeyExport({ identity: victim.id })).identity!;
    // "Declare a device lost": victim rotates to a new sharing key, friends wrap to it.
    const newKey = deriveSharingKeyPair(victim.id, 1);
    const pack = sealPack(te.encode('post-theft places'), [newKey.publicKey]);
    // Desired: the thief cannot open it. Actual: the root seed derives every future rotation.
    const thiefKey = deriveSharingKeyPair(stolen, 1);
    expect(() => openPack(pack, [thiefKey])).toThrow();
  });

  it.fails('a thief holding the master key cannot get a higher-rotation certificate accepted', () => {
    const victim = person(0);
    const stolen = decodeKeyExport(encodeKeyExport({ identity: victim.id })).identity!;
    const thiefSharing = deriveSharingKeyPair(person().id, 0);
    const hijack = issueSharingCert(stolen, thiefSharing.publicKey, { rotation: 99 });
    // Friends auto-accept a higher rotation (spec: "accept it automatically").
    expect(() => verifySharingCert(hijack, { expectedOwner: victim.id.owner, lastSeen: victim.cert })).toThrow();
  });
});

describe('T-002 F-03 (medium): low-order X25519 sharing key', () => {
  const zero = new Uint8Array(32);
  it.fails('verifySharingCert rejects a certificate for a low-order (all-zero) X25519 key', () => {
    const mallory = person();
    const cert = issueSharingCert(mallory.id, zero, { rotation: 0 });
    expect(() => verifySharingCert(cert)).toThrow(TLCryptoError);
  });
  it.fails('sealPack reports a low-order recipient key as a TLCryptoError (not a raw libsodium Error)', () => {
    const owner = person();
    expect(() => sealPack(te.encode('x'), [owner.sharing.publicKey, zero])).toThrow(TLCryptoError);
  });
});

describe('T-002 F-04 (medium): far-future `updated` locks readers out', () => {
  it.fails('a higher seq is accepted after an index whose clock was wrong (far future)', () => {
    const alice = person();
    const wrongClock = signIndex(alice.id, { seq: 5, packs: [], now: new Date('2099-01-01T00:00:00.000Z') });
    const next = signIndex(alice.id, { seq: 6, packs: [], now: new Date('2026-10-13T12:00:00.000Z') });
    expect(() => checkNoRollback(next, wrongClock)).not.toThrow();
  });
});

describe('T-002 F-05 (medium): signed JSON accepts duplicate keys / non-canonical input', () => {
  it.fails('verifyIndex rejects a document with duplicate keys (parser-differential risk)', () => {
    const alice = person();
    const json = serialize(signIndex(alice.id, { seq: 1, packs: [] }));
    const dup = json.replace('"seq":1', '"seq":999,"seq":1');
    expect(() => verifyIndex(dup)).toThrow(TLCryptoError);
  });
});

describe('T-002 F-06 (medium): group-key packs are not authenticated', () => {
  it.fails('openGroupKey rejects a group-key pack forged by a non-owner for an existing group id', () => {
    const member = person();
    const group = createGroup();
    // Anyone knowing the member's PUBLIC sharing key and the group id (e.g. an ex-member) can do this.
    const evil = rotateGroup(rotateGroup(group));
    const forged = sealGroupKey(evil, [member.sharing.publicKey]);
    expect(() => openGroupKey(forged, [member.sharing])).toThrow(TLCryptoError);
  });
});

describe('T-002 F-11 (low): signed index accepts arbitrary file references', () => {
  it.fails('verifyIndex rejects absolute URLs and path traversal in packs[].file', () => {
    const alice = person();
    expect(() => signIndex(alice.id, { seq: 1, packs: [{ file: 'https://tracker.example/p.gif', etag: 'x' }] })).toThrow(TLCryptoError);
    expect(() => signIndex(alice.id, { seq: 1, packs: [{ file: '../../private/x', etag: 'x' }] })).toThrow(TLCryptoError);
  });
});

describe('T-002 F-13 (low): input validation gaps', () => {
  it.fails('createInvitation never returns a link that parseInvitationLink rejects (sub-ms ttl)', () => {
    const owner = person();
    const { fragment } = createInvitation(owner.id, { ttlMs: 0.5 });
    expect(() => parseInvitationLink(fragment)).not.toThrow();
  });
  it.fails('an invalid Date is reported as a TLCryptoError', () => {
    const owner = person();
    expect(() => signIndex(owner.id, { seq: 1, packs: [], now: new Date('not a date') })).toThrow(TLCryptoError);
  });
  it.fails('impossible calendar dates (Feb 30) are rejected in signed documents', () => {
    const owner = person();
    const k = deriveSharingKeyPair(owner.id, 0);
    const cert = signBody(
      'sharing-cert',
      { type: 'sharing-cert', version: 1, owner: owner.id.owner, key: issueSharingCert(owner.id, k.publicKey, { rotation: 0 }).key, rotation: 0, issued: '2026-02-30T00:00:00.000Z' },
      owner.id.master.secretKey,
    );
    expect(() => verifySharingCert(cert)).toThrow(TLCryptoError);
  });
  it.fails('decodeKeyExport rejects a root and a sharing certificate belonging to different owners', () => {
    const [a, b] = [person(), person()];
    const mixed = te.encode(
      JSON.stringify({ type: 'key-export', version: 1, root: JSON.parse(new TextDecoder().decode(encodeKeyExport({ identity: a.id }))).root, sharing: JSON.parse(new TextDecoder().decode(encodeKeyExport({ sharing: { keyPair: b.sharing, cert: b.cert } }))).sharing }),
    );
    expect(() => decodeKeyExport(mixed)).toThrow(TLCryptoError);
  });
});
