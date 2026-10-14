import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  checkNoRollback,
  devicePublicKeys,
  FormatError,
  generateDeviceKeys,
  generateRecoveryPhrase,
  generateX25519KeyPair,
  IdentityMovedError,
  identityFromPhrase,
  issueDeviceCert,
  issueIdentityMove,
  issueSharingCert,
  packEntry,
  RollbackError,
  sealPack,
  serialize,
  sharingCertOf,
  SignatureError,
  signIndex,
  UnsupportedVersionError,
  verifyIndex,
  verifySharingCert,
} from '../src/index';
import { signBody } from '../src/sign';
import { person, te } from './helpers';

const t0 = new Date('2026-10-13T10:00:00.000Z');
const t1 = new Date('2026-10-13T11:00:00.000Z');

describe('signed index', () => {
  const alice = person();
  const pack = sealPack(te.encode('x'), [alice.sharing.publicKey]);
  const idx = signIndex(alice.signer, { seq: 1, sharingCert: alice.cert, packs: [packEntry(pack)], public: 'public/lists.geojson', now: t0 });
  const json = serialize(idx);

  it('has the spec shape and canonical serialization', () => {
    const o = JSON.parse(json);
    expect(Object.keys(o)).toEqual(['device_cert', 'owner', 'packs', 'public', 'reads', 'revoked_devices', 'seq', 'sharing_cert', 'signature', 'updated', 'version']);
    expect(o).toMatchObject({ version: 2, seq: 1, owner: alice.id.owner, updated: '2026-10-13T10:00:00.000Z', public: 'public/lists.geojson', reads: ['2'], revoked_devices: [] });
    expect(o.sharing_cert).toEqual({ key: alice.cert.key, rotation: 0, signature: alice.cert.signature });
    expect(o.device_cert).toEqual({ box: alice.deviceCert.box, device: alice.device.id, signature: alice.deviceCert.signature });
    expect(o.packs[0]).toEqual({ file: packEntry(pack).file, hash: packEntry(pack).hash });
    expect(o.packs[0].hash).toMatch(/^b2b256:[A-Za-z0-9_-]{43}$/);
    expect(json).toBe(canonicalize(JSON.parse(json)));
  });

  it('verifies from canonical JSON and from an object; re-ordered or pretty JSON is refused (T-002 F-05)', () => {
    expect(verifyIndex(json).seq).toBe(1);
    expect(verifyIndex(JSON.parse(json), { expectedOwner: alice.id.master.publicKey }).owner).toBe(alice.id.owner);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(json)).reverse()));
    expect(() => verifyIndex(reordered)).toThrow(FormatError);
    expect(() => verifyIndex(JSON.stringify(JSON.parse(json), null, 2))).toThrow(FormatError);
  });

  it('exposes the embedded master-signed sharing certificate', () => {
    const cert = sharingCertOf(verifyIndex(json));
    expect(cert).toEqual(alice.cert);
    expect(verifySharingCert(cert).sharingPublicKey).toEqual(alice.sharing.publicKey);
  });

  it('works without the optional public field and with custom reads', () => {
    const i = signIndex(alice.signer, { seq: 2, sharingCert: alice.cert, packs: [], reads: ['2', '2.1'] });
    expect('public' in i).toBe(false);
    expect(verifyIndex(serialize(i)).reads).toEqual(['2', '2.1']);
  });

  it('rejects tampering of any field', () => {
    const o = JSON.parse(json);
    const other = packEntry(sealPack(te.encode('y'), [alice.sharing.publicKey]));
    const cases = [
      { ...o, seq: 2 },
      { ...o, updated: '2026-10-13T10:00:01.000Z' },
      { ...o, public: 'public/other.geojson' },
      { ...o, packs: [other] },
      { ...o, packs: [] },
      { ...o, reads: ['1'] },
    ];
    for (const c of cases) expect(() => verifyIndex(canonicalize(c))).toThrow(SignatureError);
    // revoked_devices is covered by the sharing cert's MASTER signature
    expect(() => verifyIndex(canonicalize({ ...o, revoked_devices: [generateDeviceKeys().id] }))).toThrow(SignatureError);
    const sig = o.signature as string;
    const flipped = sig[5] === 'A' ? 'B' : 'A';
    expect(() => verifyIndex({ ...o, signature: sig.slice(0, 5) + flipped + sig.slice(6) })).toThrow(SignatureError);
    expect(() => verifyIndex({ ...o, signature: undefined })).toThrow(FormatError);
  });

  it('rejects wrong owner', () => {
    const mallory = person();
    const o = JSON.parse(json);
    expect(() => verifyIndex({ ...o, owner: mallory.id.owner })).toThrow(SignatureError);
    const mi = signIndex(mallory.signer, { seq: 5, sharingCert: mallory.cert, packs: o.packs });
    expect(() => verifyIndex(serialize(mi), { expectedOwner: alice.id.master.publicKey })).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
    expect(() => verifyIndex(serialize(mi), { expectedOwner: alice.id.owner })).toThrow(SignatureError);
  });

  it('is signed by a device certified by the master; an uncertified device or foreign cert is refused', () => {
    const rogue = generateDeviceKeys();
    // A device cert signed by another master, embedded in alice's index.
    const mallory = person();
    const foreignCert = issueDeviceCert(mallory.id, devicePublicKeys(rogue));
    expect(() => signIndex({ keys: rogue, cert: foreignCert }, { seq: 9, sharingCert: alice.cert, packs: [] })).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
    // Device keys that do not match the certificate.
    expect(() => signIndex({ keys: rogue, cert: alice.deviceCert }, { seq: 9, sharingCert: alice.cert, packs: [] })).toThrow(FormatError);
    // Hand-made: rogue device signs an index claiming alice's device cert.
    const o = JSON.parse(json);
    const forged = signBody('index', { ...o, seq: 9, signature: undefined }, rogue.sign.secretKey);
    expect(() => verifyIndex(forged)).toThrow(SignatureError);
  });

  it('a revoked device can no longer sign (T-002 F-01)', () => {
    const p = person();
    const k1 = generateX25519KeyPair();
    const cert1 = issueSharingCert(p.id, k1.publicKey, { rotation: 1, revokedDevices: [p.device.id] });
    expect(() => signIndex(p.signer, { seq: 2, sharingCert: cert1, packs: [] })).toThrow(expect.objectContaining({ code: 'REVOKED' }));
    const other = generateDeviceKeys();
    const ok = signIndex({ keys: other, cert: issueDeviceCert(p.id, devicePublicKeys(other)) }, { seq: 2, sharingCert: cert1, packs: [] });
    expect(ok.revoked_devices).toEqual([p.device.id]);
  });

  it('rollback: seq is the only ordering criterion; forks are reported', () => {
    const newer = signIndex(alice.signer, { seq: 2, sharingCert: alice.cert, packs: [], now: t1 });
    expect(verifyIndex(serialize(newer), { lastSeen: idx }).seq).toBe(2);
    expect(() => verifyIndex(json, { lastSeen: newer })).toThrow(RollbackError);
    const lowerSeq = signIndex(alice.signer, { seq: 0, sharingCert: alice.cert, packs: [], now: t1 });
    expect(() => checkNoRollback(lowerSeq, newer)).toThrow(RollbackError);
    // higher seq but older date: accepted (updated is informational, T-002 F-04)
    const olderDate = signIndex(alice.signer, { seq: 3, sharingCert: alice.cert, packs: [], now: t0 });
    expect(() => checkNoRollback(olderDate, newer)).not.toThrow();
    // same seq, different content = fork
    const fork = signIndex(alice.signer, { seq: 2, sharingCert: alice.cert, packs: [packEntry(pack)], now: t1 });
    expect(() => checkNoRollback(fork, newer)).toThrow(expect.objectContaining({ code: 'ROLLBACK', fork: true }));
    expect(() => checkNoRollback(verifyIndex(serialize(newer)), newer)).not.toThrow();
    const bob = person();
    expect(() => checkNoRollback(newer, signIndex(bob.signer, { seq: 1, sharingCert: bob.cert, packs: [] }))).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
  });

  it('an old sharing certificate is covered by rollback protection (T-002 F-07)', () => {
    const p = person();
    const k1 = generateX25519KeyPair();
    const cert1 = issueSharingCert(p.id, k1.publicKey, { rotation: 1 });
    const i1 = signIndex(p.signer, { seq: 10, sharingCert: cert1, packs: [] });
    // A higher seq carrying the stale rotation-0 cert (e.g. a stolen, not yet revoked device) is refused.
    const stale = signIndex(p.signer, { seq: 11, sharingCert: p.cert, packs: [] });
    expect(() => checkNoRollback(stale, i1)).toThrow(RollbackError);
    // Same rotation, different certified key: fork.
    const cert1b = issueSharingCert(p.id, generateX25519KeyPair().publicKey, { rotation: 1 });
    expect(() => checkNoRollback(signIndex(p.signer, { seq: 12, sharingCert: cert1b, packs: [] }), i1)).toThrow(expect.objectContaining({ fork: true }));
  });

  it('refuses `updated` more than 24 h in the future (T-002 F-04)', () => {
    const now = new Date('2026-10-13T12:00:00.000Z');
    const in23h = signIndex(alice.signer, { seq: 7, sharingCert: alice.cert, packs: [], now: new Date(now.getTime() + 23 * 3600e3) });
    expect(() => verifyIndex(serialize(in23h), { now })).not.toThrow();
    const in25h = signIndex(alice.signer, { seq: 7, sharingCert: alice.cert, packs: [], now: new Date(now.getTime() + 25 * 3600e3) });
    expect(() => verifyIndex(serialize(in25h), { now })).toThrow(FormatError);
  });

  it('only accepts relative, content-addressed file names and no duplicates (T-002 F-11)', () => {
    const e = packEntry(pack);
    const bad = [
      [{ file: 'https://tracker.example/p.gif', hash: e.hash }],
      [{ file: '../../private/x', hash: e.hash }],
      [{ file: 'packs/other.bin', hash: e.hash }],
      [{ file: e.file, hash: 'x' }],
      [{ file: e.file, hash: e.hash.replace('b2b256', 'sha256') }],
      [e, e],
    ];
    for (const packs of bad) expect(() => signIndex(alice.signer, { seq: 1, sharingCert: alice.cert, packs })).toThrow(FormatError);
    for (const pub of ['https://x.example/a.geojson', 'public/../a.geojson', 'public/a.json']) {
      expect(() => signIndex(alice.signer, { seq: 1, sharingCert: alice.cert, packs: [], public: pub })).toThrow(FormatError);
    }
    expect(signIndex(alice.signer, { seq: 1, sharingCert: alice.cert, packs: [packEntry(pack, 'media')] }).packs).toHaveLength(1);
  });

  it('rejects other versions and malformed documents', () => {
    const o = JSON.parse(json);
    expect(() => verifyIndex({ ...o, version: 3 })).toThrow(UnsupportedVersionError);
    expect(() => verifyIndex({ ...o, version: 1 })).toThrow(UnsupportedVersionError);
    expect(() => verifyIndex({ ...o, version: 0 })).toThrow(FormatError);
    expect(() => verifyIndex({ ...o, extra: true })).toThrow(FormatError);
    expect(() => verifyIndex({ ...o, updated: 'yesterday' })).toThrow(FormatError);
    expect(() => verifyIndex({ ...o, packs: [{ file: 'a' }] })).toThrow(FormatError);
    expect(() => verifyIndex({ ...o, reads: [] })).toThrow(FormatError);
    expect(() => verifyIndex({ ...o, owner: 'rsa:abc' })).toThrow(FormatError);
    expect(() => verifyIndex('[]')).toThrow(FormatError);
    expect(() => signIndex(alice.signer, { seq: 1, sharingCert: alice.cert, packs: [], now: new Date('x') })).toThrow(FormatError);
  });
});

describe('identity change (primary device stolen)', () => {
  it('the new identity publishes a move signed by the old master; readers are told, then refuse the old master', () => {
    const marie = person();
    const before = signIndex(marie.signer, { seq: 5, sharingCert: marie.cert, packs: [] });

    // "Declare the primary device lost": new phrase, new master, move signed by the old master.
    const newId = identityFromPhrase(generateRecoveryPhrase());
    const move = issueIdentityMove(marie.id, newId);
    const device = generateDeviceKeys();
    const signer = { keys: device, cert: issueDeviceCert(newId, devicePublicKeys(device)) };
    const sharing = generateX25519KeyPair();
    const after = signIndex(signer, { seq: 1, sharingCert: issueSharingCert(newId, sharing.publicKey, { rotation: 0 }), packs: [], move });

    // A friend expecting the old identity gets an explicit IdentityMovedError.
    let err: unknown;
    try {
      verifyIndex(serialize(after), { expectedOwner: marie.id.owner, lastSeen: before });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IdentityMovedError);
    expect(err).toMatchObject({ code: 'IDENTITY_MOVED', from: marie.id.owner, to: newId.owner });

    // The friend then follows the new identity and retires the old one.
    const retired = [marie.id.owner];
    expect(verifyIndex(serialize(after), { expectedOwner: newId.owner, retiredOwners: retired }).owner).toBe(newId.owner);
    // Anything later signed by the old master is refused (e.g. a thief holding the old primary device).
    const thiefCert = issueSharingCert(marie.id, generateX25519KeyPair().publicKey, { rotation: 99 });
    expect(() => verifySharingCert(thiefCert, { retiredOwners: retired })).toThrow(expect.objectContaining({ code: 'REVOKED' }));
    const thiefIndex = signIndex(marie.signer, { seq: 6, sharingCert: thiefCert, packs: [] });
    expect(() => verifyIndex(serialize(thiefIndex), { retiredOwners: retired })).toThrow(expect.objectContaining({ code: 'REVOKED' }));
  });

  it('a move that does not lead to the index owner, or from another identity, is refused', () => {
    const [a, b, c] = [person(), person(), person()];
    const moveAB = issueIdentityMove(a.id, b.id);
    expect(() => signIndex(c.signer, { seq: 1, sharingCert: c.cert, packs: [], move: moveAB })).toThrow(FormatError);
    const moveCB = issueIdentityMove(c.id, b.id);
    const idx = signIndex(b.signer, { seq: 1, sharingCert: b.cert, packs: [], move: moveCB });
    expect(() => verifyIndex(serialize(idx), { expectedOwner: a.id.owner })).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
  });
});
