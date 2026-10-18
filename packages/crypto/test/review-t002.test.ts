/*
 * T-002 independent review: tests demonstrating findings from
 * docs/reviews/2026-10-13-crypto-T-002.md.
 *
 * These started as `it.fails(...)` expected failures. Each one now passes against the fixed
 * library. Where the API changed (random sharing keys, device keys, index-bound packs, compact
 * invitations) the scenario is kept and expressed with the new API.
 */
import { describe, expect, it } from 'vitest';
import {
  checkNoRollback,
  createGroup,
  createInvitation,
  decodeKeyExport,
  encodeKeyExport,
  generateDeviceKeys,
  generateX25519KeyPair,
  identityFromPhrase,
  issueDeviceCert,
  devicePublicKeys,
  issueSharingCert,
  openGroupKey,
  openPack,
  openSharingKey,
  parseInvitationLink,
  rotateGroup,
  sealGroupKey,
  sealPack,
  sealSharingKey,
  generateVaultDataKey,
  serialize,
  sharingCertOf,
  signIndex,
  TLCryptoError,
  verifyIndex,
  verifySharingCert,
} from '../src/index';
import { signBody } from '../src/sign';
import { person, publish, te, PAD_KEY } from './helpers';

describe('T-002 F-01 (high): sharing-key rotation survives theft of an ordinary device', () => {
  // Marie has a phone and a tablet; both received the sharing key sealed to their device keys.
  function setup() {
    const marie = person(); // marie.device = the phone
    const tablet = generateDeviceKeys();
    const tabletCert = issueDeviceCert(marie.id, devicePublicKeys(tablet));
    const sk0 = { keyPair: marie.sharing, cert: marie.cert, vaultDataKey: marie.vaultDataKey };
    // What the thief extracts from the stolen tablet: its device keys, and the current sharing key.
    const stolen = { device: tablet, deviceCert: tabletCert, sharing: openSharingKey(sealSharingKey(sk0, tabletCert), tablet) };

    // "Declare a device lost" from the phone after typing the 12 words: new RANDOM sharing key,
    // certified by the master with the tablet revoked, sent to the phone and to the vault.
    const id = identityFromPhrase(marie.phrase);
    const k1 = generateX25519KeyPair();
    const cert1 = issueSharingCert(id, k1.publicKey, { rotation: 1, revokedDevices: [tablet.id], location: marie.location });
    const toPhone = sealSharingKey({ keyPair: k1, cert: cert1, vaultDataKey: generateVaultDataKey() }, marie.deviceCert);
    const toVault = sealSharingKey({ keyPair: k1, cert: cert1, vaultDataKey: generateVaultDataKey() }, id);
    const after = signIndex(marie.signer, { vaultDataKey: PAD_KEY, seq: 2, sharingCert: cert1, packs: [] });
    return { marie, stolen, k1, cert1, toPhone, toVault, after };
  }

  it('a stolen ordinary device cannot open packs wrapped to the post-theft sharing key', () => {
    const { marie, stolen, k1, toPhone, toVault } = setup();
    const pack = sealPack(marie.id.owner, te.encode('post-theft places'), [k1.publicKey]);
    const index = publish(marie, [pack]);
    // Nothing on the tablet derives the new key: it is random, not derived from a seed.
    expect(() => openPack(pack, index, [stolen.sharing.keyPair, stolen.device.box])).toThrow(TLCryptoError);
    // The deliveries of the new key are sealed to other keys.
    expect(() => openSharingKey(toPhone, stolen.device)).toThrow(TLCryptoError);
    expect(() => openSharingKey(toVault, stolen.device)).toThrow(TLCryptoError);
    // The phone (and the vault, with the phrase) do get it.
    expect(openSharingKey(toPhone, marie.device).keyPair.publicKey).toEqual(k1.publicKey);
    expect(openSharingKey(toVault, identityFromPhrase(marie.phrase)).keyPair.publicKey).toEqual(k1.publicKey);
  });

  it('a thief holding an ordinary device cannot get a higher-rotation certificate accepted', () => {
    const { marie, stolen, after } = setup();
    const thiefSharing = generateX25519KeyPair();
    // The tablet holds no master key: the best it can do is sign with its device key.
    const hijack = signBody(
      'sharing-cert',
      { type: 'sharing-cert', version: 3, owner: marie.id.owner, key: `x25519:${Buffer.from(thiefSharing.publicKey).toString('base64url')}`, rotation: 99, revoked_devices: [] },
      stolen.device.sign.secretKey,
    );
    expect(() => verifySharingCert(hijack, { expectedOwner: marie.id.owner, lastSeen: sharingCertOf(after) })).toThrow(TLCryptoError);
    // And it can no longer publish: the new master-signed cert revokes it...
    expect(() => signIndex({ keys: stolen.device, cert: stolen.deviceCert }, { vaultDataKey: PAD_KEY, seq: 3, sharingCert: sharingCertOf(after), packs: [] })).toThrow(
      expect.objectContaining({ code: 'REVOKED' }),
    );
    // ...and an index with the old certificate is a rollback for any reader who saw the new one.
    const stale = signIndex({ keys: stolen.device, cert: stolen.deviceCert }, { vaultDataKey: PAD_KEY, seq: 3, sharingCert: stolen.sharing.cert, packs: [] });
    expect(() => verifyIndex(serialize(stale), { lastSeen: after })).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
  });
});

describe('T-002 F-03 (medium): low-order X25519 sharing key', () => {
  const zero = new Uint8Array(32);
  it('verifySharingCert rejects a certificate for a low-order (all-zero) X25519 key', () => {
    const mallory = person();
    expect(() => issueSharingCert(mallory.id, zero, { rotation: 0 })).toThrow(TLCryptoError);
    const cert = signBody(
      'sharing-cert',
      { type: 'sharing-cert', version: 3, owner: mallory.id.owner, key: `x25519:${Buffer.from(zero).toString('base64url')}`, rotation: 0, revoked_devices: [] },
      mallory.id.master.secretKey,
    );
    expect(() => verifySharingCert(cert)).toThrow(TLCryptoError);
    expect(() => verifySharingCert(cert)).toThrow(expect.objectContaining({ code: 'INVALID_KEY' }));
  });
  it('sealPack reports a low-order recipient key as a TLCryptoError (not a raw libsodium Error)', () => {
    const owner = person();
    expect(() => sealPack(owner.id.owner, te.encode('x'), [owner.sharing.publicKey, zero])).toThrow(TLCryptoError);
  });
});

describe('T-002 F-04 (medium): far-future `updated` no longer locks readers out', () => {
  it('a higher seq is accepted after an index whose clock was wrong (far future)', () => {
    const alice = person();
    const wrongClock = signIndex(alice.signer, { vaultDataKey: PAD_KEY, seq: 5, sharingCert: alice.cert, packs: [], now: new Date('2099-01-01T00:00:00.000Z') });
    const next = signIndex(alice.signer, { vaultDataKey: PAD_KEY, seq: 6, sharingCert: alice.cert, packs: [], now: new Date('2026-10-13T12:00:00.000Z') });
    expect(() => checkNoRollback(next, wrongClock)).not.toThrow();
    // And the wrong-clock index itself is refused by readers with a correct clock.
    expect(() => verifyIndex(serialize(wrongClock), { now: new Date('2026-10-13T12:00:00.000Z') })).toThrow(TLCryptoError);
  });
});

describe('T-002 F-05 (medium): signed JSON must be canonical on input', () => {
  it('verifyIndex rejects a document with duplicate keys (parser-differential risk)', () => {
    const alice = person();
    const json = serialize(signIndex(alice.signer, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: alice.cert, packs: [] }));
    const dup = json.replace('"seq":1', '"seq":999,"seq":1');
    expect(dup).not.toBe(json);
    expect(() => verifyIndex(dup)).toThrow(TLCryptoError);
  });
});

describe('T-002 F-06 (medium): group-key packs are authenticated through the owner index', () => {
  it('openGroupKey rejects a group-key pack forged by a non-owner for an existing group id', () => {
    const [owner, member] = [person(), person()];
    const group = createGroup();
    const genuine = sealGroupKey(group, owner.id.owner, [member.sharing.publicKey]);
    const index = publish(owner, [genuine]);
    // Anyone knowing the member's PUBLIC sharing key and the group id (e.g. an ex-member) can do this...
    const evil = rotateGroup(rotateGroup(group));
    const forged = sealGroupKey(evil, owner.id.owner, [member.sharing.publicKey]);
    // ...but it is not listed in the owner's verified index.
    expect(() => openGroupKey(forged, index, [member.sharing])).toThrow(TLCryptoError);
    expect(() => openGroupKey(forged, index, [member.sharing])).toThrow(expect.objectContaining({ code: 'NOT_INDEXED' }));
    expect(openGroupKey(genuine, index, [member.sharing]).generation).toBe(1);
  });
});

describe('T-002 F-11 (low): signed index rejects arbitrary file references', () => {
  it('signIndex/verifyIndex reject absolute URLs and path traversal in packs[].file', () => {
    const alice = person();
    const hash = `b2b256:${'A'.repeat(43)}`;
    expect(() => signIndex(alice.signer, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: alice.cert, packs: [{ file: 'https://tracker.example/p.gif', hash }] })).toThrow(TLCryptoError);
    expect(() => signIndex(alice.signer, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: alice.cert, packs: [{ file: '../../private/x', hash }] })).toThrow(TLCryptoError);
  });
});

describe('T-002 F-13 (low): input validation gaps', () => {
  it('createInvitation never returns a link that parseInvitationLink rejects (sub-ms ttl)', () => {
    const owner = person();
    expect(() => createInvitation(owner.signer, owner.cert, { ttlMs: 0.5 })).toThrow(TLCryptoError);
    const { fragment } = createInvitation(owner.signer, owner.cert, { ttlMs: 60_001 });
    expect(() => parseInvitationLink(fragment)).not.toThrow();
  });
  it('an invalid Date is reported as a TLCryptoError', () => {
    const owner = person();
    expect(() => signIndex(owner.signer, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: owner.cert, packs: [], now: new Date('not a date') })).toThrow(TLCryptoError);
  });
  it('impossible calendar dates (Feb 30) are rejected in signed documents', () => {
    const owner = person();
    const idx = JSON.parse(serialize(signIndex(owner.signer, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: owner.cert, packs: [] })));
    const feb30 = signBody('index', { ...idx, updated: '2026-02-30T00:00:00.000Z', signature: undefined }, owner.device.sign.secretKey);
    expect(() => verifyIndex(feb30)).toThrow(TLCryptoError);
  });
  it('decodeKeyExport rejects a sharing key and a certificate belonging to different owners', () => {
    const [a, b] = [person(), person()];
    const doc = JSON.parse(new TextDecoder().decode(encodeKeyExport({ keyPair: a.sharing, cert: a.cert, vaultDataKey: a.vaultDataKey })));
    doc.cert = b.cert;
    const mixed = te.encode(serialize(doc));
    expect(() => decodeKeyExport(mixed)).toThrow(TLCryptoError);
    expect(() => decodeKeyExport(encodeKeyExport({ keyPair: a.sharing, cert: a.cert, vaultDataKey: a.vaultDataKey }), { expectedOwner: b.id.owner })).toThrow(TLCryptoError);
  });
});
