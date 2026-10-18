/*
 * Second independent review (fixes of T-002): docs/reviews/2026-10-13-crypto-fixes-review.md.
 *
 * These started as `it.fails(...)` reproductions written by the reviewer. Each one now passes
 * against the fixed library; where the API changed (device-signed invitations, owner-bound packs)
 * the scenario is kept and expressed with the new API. Tests for the new behaviour follow.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  checkInvitationIndex,
  checkNoRollback,
  collectInvitationAnswers,
  createGroup,
  createInvitation,
  createInvitationResponse,
  decodeKeyExport,
  devicePublicKeys,
  encodeKeyExport,
  generateDeviceKeys,
  generateRecoveryPhrase,
  generateX25519KeyPair,
  identityFromPhrase,
  IdentityMovedError,
  issueDeviceCert,
  issueIdentityMove,
  issueSharingCert,
  MAX_SEQ_STEP,
  openPack,
  openSharingKey,
  paddedLength,
  parseInvitationLink,
  parseKey,
  publicEntry,
  retireInvitationKey,
  sealGroupKey,
  sealPack,
  sealSharingKey,
  serialize,
  signIndex,
  verifyIndex,
  verifyPublicFile,
  type SignedIndex,
} from '../src/index';
import { checkLocation } from '../src/invitation';
import { signBody } from '../src/sign';
import { accept, invite, mutateHeader, person, publish, seal, te, trust } from './helpers';

const now = new Date('2026-10-13T12:00:00.000Z');
const LOCATION = 'https://cloud.example.org/s/AbCdEfGh12345';

/** Marie (phone = marie.device) declares the phone lost from a tablet: rotation 1 revokes the phone. */
function theft() {
  const marie = person();
  const tablet = generateDeviceKeys();
  const tabletSigner = { keys: tablet, cert: issueDeviceCert(marie.id, devicePublicKeys(tablet)) };
  const k1 = generateX25519KeyPair();
  const cert1 = issueSharingCert(marie.id, k1.publicKey, { rotation: 1, revokedDevices: [marie.device.id], location: marie.location });
  return { marie, tabletSigner, k1, cert1 };
}

describe('R-01 (high): a stolen, not-yet-revoked device can no longer block its own revocation', () => {
  it('a master-signed higher rotation (revoking the thief) is accepted after a jammed seq', () => {
    const { marie, tabletSigner, cert1 } = theft();
    const before = signIndex(marie.signer, { seq: 1, sharingCert: marie.cert, packs: [] });
    // The thief, before the owner notices, publishes the largest possible seq.
    const jam = signIndex(marie.signer, { seq: Number.MAX_SAFE_INTEGER, sharingCert: marie.cert, packs: [] });
    // A reader that already follows Marie refuses the jump outright (bounded seq growth)...
    expect(() => verifyIndex(serialize(jam), { lastSeen: before })).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
    // ...and a brand-new reader (no lastSeen) that accepted it is not locked out either.
    const friendSeen = verifyIndex(serialize(jam));
    const revocation = signIndex(tabletSigner, { seq: 2, sharingCert: cert1, packs: [] });
    expect(() => verifyIndex(serialize(revocation), { lastSeen: friendSeen })).not.toThrow();
    expect(() => verifyIndex(serialize(revocation), { lastSeen: before })).not.toThrow();
    // From then on, nothing the phone signs is accepted, whatever its seq.
    const after = verifyIndex(serialize(revocation), { lastSeen: friendSeen });
    const stale = signIndex(marie.signer, { seq: 3, sharingCert: marie.cert, packs: [] });
    expect(() => verifyIndex(serialize(stale), { lastSeen: after })).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
    expect(() => verifyIndex(serialize(jam), { lastSeen: after })).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
    expect(() => signIndex(marie.signer, { seq: 4, sharingCert: cert1, packs: [] })).toThrow(expect.objectContaining({ code: 'REVOKED' }));
  });

  it('variant: a reader served the revoked device\'s old-certificate index still accepts the revocation', () => {
    const { marie, tabletSigner, cert1 } = theft();
    const before = signIndex(marie.signer, { seq: 10, sharingCert: marie.cert, packs: [] });
    const served = verifyIndex(serialize(signIndex(marie.signer, { seq: 10 + MAX_SEQ_STEP, sharingCert: marie.cert, packs: [] })), { lastSeen: before });
    const revocation = signIndex(tabletSigner, { seq: 1, sharingCert: cert1, packs: [] }); // seq restarts on a new rotation
    expect(verifyIndex(serialize(revocation), { lastSeen: served }).sharing_cert.rotation).toBe(1);
  });

  it('within one rotation: seq may grow by at most MAX_SEQ_STEP; lower seq and forks are refused', () => {
    const p = person();
    expect(MAX_SEQ_STEP).toBe(2 ** 20);
    const base = signIndex(p.signer, { seq: 5, sharingCert: p.cert, packs: [] });
    expect(() => checkNoRollback(signIndex(p.signer, { seq: 5 + MAX_SEQ_STEP, sharingCert: p.cert, packs: [] }), base)).not.toThrow();
    expect(() => checkNoRollback(signIndex(p.signer, { seq: 6 + MAX_SEQ_STEP, sharingCert: p.cert, packs: [] }), base)).toThrow(
      expect.objectContaining({ code: 'ROLLBACK', fork: false }),
    );
    expect(() => checkNoRollback(signIndex(p.signer, { seq: 4, sharingCert: p.cert, packs: [] }), base)).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
  });

  it('a higher rotation must still not un-revoke a device, and a new rotation then orders by seq again', () => {
    const { marie, tabletSigner, cert1 } = theft();
    const r1 = signIndex(tabletSigner, { seq: 1, sharingCert: cert1, packs: [] });
    const unrevoke = issueSharingCert(marie.id, generateX25519KeyPair().publicKey, { rotation: 2, location: marie.location });
    expect(() => checkNoRollback(signIndex(tabletSigner, { seq: 1, sharingCert: unrevoke, packs: [] }), r1)).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
    const cert2 = issueSharingCert(marie.id, generateX25519KeyPair().publicKey, { rotation: 2, revokedDevices: [marie.device.id], location: marie.location });
    const r2 = signIndex(tabletSigner, { seq: 1, sharingCert: cert2, packs: [] });
    expect(() => checkNoRollback(r2, r1)).not.toThrow();
    expect(() => checkNoRollback(signIndex(tabletSigner, { seq: 0, sharingCert: cert2, packs: [] }), r2)).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
  });
});

describe('R-02 (medium): retireInvitationKey and group secrets', () => {
  it('refuses a group-key pack instead of re-encrypting the same group secret', () => {
    const owner = person();
    const friend = person();
    const { invitation } = createInvitation(owner.signer, owner.cert);
    const friends = createGroup();
    const groupPack = sealGroupKey(friends, owner.id.owner, [friend.sharing.publicKey, invitation.keyPair.publicKey]);
    const content = sealPack(owner.id.owner, te.encode('friends-only places'), [friends.keyPair.publicKey]);
    const index = publish(owner, [groupPack, content]);
    expect(() => retireInvitationKey([groupPack, content], index, invitation.keyPair, () => [friend.sharing.publicKey])).toThrow(/group/);
    // As a direct recipient, the invitation key is retired normally (content that merely looks like JSON included).
    const direct = sealPack(owner.id.owner, te.encode('{"type":"FeatureCollection"}'), [owner.sharing.publicKey, invitation.keyPair.publicKey]);
    const i2 = publish(owner, [direct, content]);
    expect(retireInvitationKey([direct, content], i2, invitation.keyPair, () => [owner.sharing.publicKey])).toHaveLength(1);
  });
});

describe('R-03 (medium): inviting and answering need no master key', () => {
  it('an ordinary device invites (and lists the invitation) and answers with its device key and device certificate only', () => {
    const [owner, friend] = [person(), person()];
    // Only device keys, device certs and sharing certs are used: no Identity anywhere.
    const { invitation, fragment, index } = invite(owner, { now });
    expect(index.device_cert.device).toBe(owner.device.id); // the listing is vouched for by this device
    const received = accept(fragment, index, now);
    expect(received.owner).toBe(owner.id.owner);
    expect(received.rotation).toBe(owner.cert.rotation);
    expect(received.location).toBe(owner.location);
    const resp = createInvitationResponse(received, friend.signer, friend.cert, { now });
    const opened = collectInvitationAnswers(invitation, [resp], { now }).accepted!;
    expect(opened.owner).toBe(friend.id.owner);
    expect(opened.device).toBe(friend.device.id);
  });

  it('a device revoked by the current sharing cert can neither invite, list nor answer', () => {
    const { marie, cert1 } = theft();
    expect(() => createInvitation(marie.signer, cert1, { now })).toThrow(expect.objectContaining({ code: 'REVOKED' }));
    const { invitation } = createInvitation(marie.signer, marie.cert, { now });
    expect(() => signIndex(marie.signer, { seq: 1, sharingCert: cert1, packs: [], invitations: [invitation], now })).toThrow(expect.objectContaining({ code: 'REVOKED' }));
    const owner = person();
    const o = invite(owner, { now });
    const received = accept(o.fragment, o.index, now);
    expect(() => createInvitationResponse(received, marie.signer, cert1, { now })).toThrow(expect.objectContaining({ code: 'REVOKED' }));
    // A device of another identity cannot invite for this one, nor list another owner's invitation.
    const mallory = person();
    expect(() => createInvitation(mallory.signer, owner.cert, { now })).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
    // (V4-01: skipped and reported, never a reason to refuse publishing the index.)
    const skipped: string[] = [];
    const m = publish(mallory, [], { now, invitations: [o.invitation], onSkip: (_i, why) => skipped.push(why) });
    expect(m.invitations).not.toContain(received.token);
    expect(skipped).toEqual(['invalid']);
  });

  it('checkInvitationIndex: same owner, index not older than the link (R-12), invitation listed by a non-revoked device', () => {
    const { marie, tabletSigner, cert1 } = theft();
    const k2 = generateX25519KeyPair();
    const cert2 = issueSharingCert(marie.id, k2.publicKey, { rotation: 2, revokedDevices: [marie.device.id], location: marie.location });
    // The tablet invites at rotation 1.
    const { invitation, fragment } = createInvitation(tabletSigner, cert1, { now });
    const received = parseInvitationLink(fragment, { now });
    expect(received.rotation).toBe(1);
    const listing = { invitations: [invitation], now, vaultDataKey: marie.vaultDataKey };
    const padding = ['b2b256:' + 'A'.repeat(43)];
    // An old index (rotation 0, signed by the now-revoked phone) served to the new friend is refused, even if it lists the link.
    // (signIndex skips a rotation-1 invitation under a rotation-0 certificate: the thief signs it by hand.)
    expect(signIndex(marie.signer, { seq: 99, sharingCert: marie.cert, packs: [], ...listing }).invitations).not.toContain(received.token);
    const { signature: _s, ...body } = JSON.parse(serialize(signIndex(marie.signer, { seq: 99, sharingCert: marie.cert, packs: [], now }))) as Record<string, unknown>;
    const forged = serialize(signBody('index', { ...body, invitations: [received.token, ...padding].sort() }, marie.device.sign.secretKey));
    const old = verifyIndex(forged, { expectedOwner: marie.id.owner, location: marie.location, now });
    expect(() => checkInvitationIndex(received, old, { now })).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
    expect(() => checkInvitationIndex(received, signIndex(tabletSigner, { seq: 1, sharingCert: cert1, packs: [], ...listing }), { now })).not.toThrow();
    expect(() => checkInvitationIndex(received, signIndex(tabletSigner, { seq: 2, sharingCert: cert2, packs: [], ...listing }), { now })).not.toThrow();
    // The tablet is later revoked too: the next index no longer lists its invitations, so its old link leads nowhere.
    const phone2 = generateDeviceKeys();
    const phone2Signer = { keys: phone2, cert: issueDeviceCert(marie.id, devicePublicKeys(phone2)) };
    const cert3 = issueSharingCert(marie.id, generateX25519KeyPair().publicKey, { rotation: 3, revokedDevices: [marie.device.id, tabletSigner.keys.id], location: marie.location });
    const i3 = signIndex(phone2Signer, { seq: 1, sharingCert: cert3, packs: [], ...listing });
    expect(i3.invitations).not.toContain(received.token);
    expect(() => checkInvitationIndex(received, i3, { now })).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
    // Another owner's index, or an unverified object.
    const other = person();
    const otherIndex = signIndex(other.signer, { seq: 1, sharingCert: other.cert, packs: [] });
    expect(() => checkInvitationIndex(received, otherIndex, { now })).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
    expect(() => checkInvitationIndex(received, { ...signIndex(tabletSigner, { seq: 3, sharingCert: cert1, packs: [], ...listing }) } as SignedIndex, { now })).toThrow();
  });

  it('checkInvitationIndex on the owner side: the responder\'s index must not be older than the cert in the answer', () => {
    const owner = person();
    const { invitation, fragment, index } = invite(owner, { now });
    const { marie: friend, tabletSigner, cert1 } = theft();
    const resp = createInvitationResponse(accept(fragment, index, now), tabletSigner, cert1, { now });
    const answer = collectInvitationAnswers(invitation, [resp], { now }).accepted!;
    expect(() => checkInvitationIndex(answer, signIndex(friend.signer, { seq: 50, sharingCert: friend.cert, packs: [] }))).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
    expect(() => checkInvitationIndex(answer, signIndex(tabletSigner, { seq: 1, sharingCert: cert1, packs: [] }))).not.toThrow();
  });
});

describe('R-04 (medium): one answer per invitation, also after acceptance', () => {
  it('an answer from another person arriving after acceptance is reported in `late`', () => {
    const owner = person();
    const { invitation, fragment, index } = invite(owner, { now });
    const received = accept(fragment, index, now);
    const [interceptor, friend] = [person(), person()];
    const first = createInvitationResponse(received, interceptor.signer, interceptor.cert, { now });
    // Batch 1: only the interceptor's answer -> accepted.
    const b1 = collectInvitationAnswers(invitation, [first], { now });
    expect(b1.accepted?.owner).toBe(interceptor.id.owner);
    expect(b1.late).toEqual([]);
    // The invitation key is retired from content, but the record is kept until expiry.
    const pack = sealPack(owner.id.owner, te.encode('x'), [owner.sharing.publicKey, invitation.keyPair.publicKey]);
    retireInvitationKey([pack], publish(owner, [pack]), invitation.keyPair, () => [owner.sharing.publicKey, b1.accepted!.sharingPublicKey]);
    // Batch 2: the real friend answers later.
    const second = createInvitationResponse(received, friend.signer, friend.cert, { now: new Date(now.getTime() + 3600e3) });
    const b2 = collectInvitationAnswers(invitation, [first, second], { now: new Date(now.getTime() + 7200e3), acceptedOwner: interceptor.id.owner });
    expect(b2.accepted?.owner).toBe(interceptor.id.owner);
    expect(b2.multiple).toBe(true);
    expect(b2.late.map((a) => a.owner)).toEqual([friend.id.owner]);
    // Same answers, no acceptedOwner: none accepted (unchanged rule).
    expect(collectInvitationAnswers(invitation, [first, second], { now }).accepted).toBeNull();
  });
});

describe('R-05 (low): packs are bound to their owner', () => {
  it('a pack of Alice listed in Mallory\'s verified index is not attributed to Mallory', () => {
    // Mallory (a recipient of Alice) re-lists an (old) Alice pack in her own index.
    const [alice, mallory, bob] = [person(), person(), person()];
    const pack = sealPack(alice.id.owner, te.encode('Alice: my home'), [bob.sharing.publicKey, mallory.sharing.publicKey]);
    const aliceIndex = publish(alice, [pack]);
    const malloryIndex = publish(mallory, [pack]);
    expect(() => openPack(pack, malloryIndex, [bob.sharing])).toThrow(expect.objectContaining({ code: 'DECRYPT' }));
    expect(openPack(pack, aliceIndex, [bob.sharing]).payload).toEqual(te.encode('Alice: my home'));
  });
  it('sealPack requires a valid owner id', () => {
    expect(() => sealPack('rsa:abc', te.encode('x'), [generateX25519KeyPair().publicKey])).toThrow(expect.objectContaining({ code: 'FORMAT' }));
  });
});

describe('R-06 (low): the public list file is covered by the signature', () => {
  it('verifyPublicFile accepts exactly the listed bytes', () => {
    const p = person();
    const geojson = te.encode('{"type":"FeatureCollection","features":[]}');
    const index = publish(p, [], { public: publicEntry(geojson, 'lists') });
    expect(index.public?.file).toBe('public/lists.geojson');
    expect(() => verifyPublicFile(geojson, index)).not.toThrow();
    expect(() => verifyPublicFile(te.encode('{"type":"FeatureCollection","features":[{}]}'), index)).toThrow(expect.objectContaining({ code: 'NOT_INDEXED' }));
    expect(() => verifyPublicFile(geojson, { ...index } as SignedIndex)).toThrow(expect.objectContaining({ code: 'NOT_INDEXED' }));
    expect(() => verifyPublicFile(geojson, publish(p, []))).toThrow(expect.objectContaining({ code: 'NOT_INDEXED' }));
  });
});

describe('R-07 (low): sealSharingKey refuses a device the certificate revokes', () => {
  it('refuses to seal a sharing key to a device listed in its revoked_devices', () => {
    const marie = person();
    const k1 = generateX25519KeyPair();
    const cert1 = issueSharingCert(marie.id, k1.publicKey, { rotation: 1, revokedDevices: [marie.device.id] });
    expect(() => sealSharingKey({ keyPair: k1, cert: cert1, vaultDataKey: marie.vaultDataKey }, marie.deviceCert)).toThrow(expect.objectContaining({ code: 'REVOKED' }));
  });
});

describe('R-08 (low): lastSeen is part of the sealed-sharing-key and key-export options', () => {
  it('an older sharing key pushed back to a device is refused with lastSeen', () => {
    const { marie, k1, cert1 } = theft();
    const tablet = generateDeviceKeys();
    const tabletCert = issueDeviceCert(marie.id, devicePublicKeys(tablet));
    // The thief holds the rotation-0 key and its valid cert, and seals it to the tablet's public box key.
    const pushed = sealSharingKey({ keyPair: marie.sharing, cert: marie.cert, vaultDataKey: marie.vaultDataKey }, tabletCert);
    expect(() => openSharingKey(pushed, tablet, { expectedOwner: marie.id.owner, lastSeen: cert1 })).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
    const genuine = sealSharingKey({ keyPair: k1, cert: cert1, vaultDataKey: marie.vaultDataKey }, tabletCert);
    expect(openSharingKey(genuine, tablet, { expectedOwner: marie.id.owner, lastSeen: cert1 }).cert.rotation).toBe(1);
    const exported = encodeKeyExport({ keyPair: marie.sharing, cert: marie.cert, vaultDataKey: marie.vaultDataKey });
    expect(() => decodeKeyExport(exported, { expectedOwner: marie.id.owner, lastSeen: cert1 })).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
  });
});

describe('R-09 (low): canonical-bytes rule has no UTF-8 BOM hole', () => {
  it('a pack header prefixed with a UTF-8 BOM is rejected as non-canonical', () => {
    const p = person();
    const pack = seal(te.encode('x'), [p.sharing.publicKey]);
    const bom = mutateHeader(pack, () => {}, (h) => '﻿' + canonicalize(h));
    expect(() => openPack(bom, trust(bom), [p.sharing])).toThrow(expect.objectContaining({ code: 'FORMAT' }));
  });
});

describe('R-10 (low): read-address validation', () => {
  it('rejects a backslash (WHATWG parses host "good.example", other parsers may not)', () => {
    expect(() => checkLocation('https://good.example\\@evil.example/')).toThrow();
  });
  it('requires the canonical URL form and a public host', () => {
    for (const bad of [
      'https://Example.org/',
      'https://example.org',
      'https://example.org:443/',
      'https://localhost/',
      'https://nas.local/',
      'https://127.0.0.1/',
      'https://10.0.0.8/share',
      'https://172.16.5.4/',
      'https://192.168.1.1/',
      'https://169.254.169.254/latest',
      'https://0.0.0.0/',
      'https://[::1]/',
      'https://[fe80::1]/',
      'https://[fd00::1]/',
      'https://[::ffff:7f00:1]/',
    ]) {
      expect(() => checkLocation(bad), bad).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    }
    for (const good of [LOCATION, 'https://example.org/', 'https://203.0.113.7/tl/', 'https://example.org:8443/s/x']) {
      expect(() => checkLocation(good), good).not.toThrow();
    }
  });
  it('a LAN address cannot be certified, so no return link can carry one', () => {
    const friend = person();
    expect(() => issueSharingCert(friend.id, friend.sharing.publicKey, { rotation: 0, location: 'https://192.168.1.1/' })).toThrow(
      expect.objectContaining({ code: 'FORMAT' }),
    );
  });
});

describe('R-11 (low): conflicting identity moves are reported', () => {
  it('a second successor of an identity already left behind gives IdentityMovedError with conflict', () => {
    const marie = person();
    const thief = identityFromPhrase(generateRecoveryPhrase());
    const real = identityFromPhrase(generateRecoveryPhrase());
    const indexOf = (id: typeof real) => {
      const d = generateDeviceKeys();
      const signer = { keys: d, cert: issueDeviceCert(id, devicePublicKeys(d)) };
      const cert = issueSharingCert(id, generateX25519KeyPair().publicKey, { rotation: 0, location: LOCATION });
      return signIndex(signer, { seq: 1, sharingCert: cert, packs: [], move: issueIdentityMove(marie.id, id) });
    };
    // The reader followed the thief's move first.
    const toReal = indexOf(real);
    let err: unknown;
    try {
      verifyIndex(serialize(toReal), { expectedOwner: thief.owner, retiredOwners: [marie.id.owner] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IdentityMovedError);
    expect(err).toMatchObject({ code: 'IDENTITY_MOVED', conflict: true, from: marie.id.owner, to: real.owner });
    // A plain first move is not a conflict.
    try {
      verifyIndex(serialize(indexOf(thief)), { expectedOwner: marie.id.owner });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'IDENTITY_MOVED', conflict: false });
  });
});

describe('N-1: non-canonical X25519 encodings', () => {
  it('an X25519 key with bit 255 set is rejected', () => {
    const pk = generateX25519KeyPair().publicKey.slice();
    pk[31] = (pk[31] as number) | 0x80;
    expect(() => parseKey('x25519', `x25519:${Buffer.from(pk).toString('base64url')}`)).toThrow(expect.objectContaining({ code: 'INVALID_KEY' }));
    expect(() => sealPack(person().id.owner, te.encode('x'), [pk])).toThrow(expect.objectContaining({ code: 'INVALID_KEY' }));
  });
});

describe('N-2: Padmé with integer operations', () => {
  it('matches the reference vectors up to 2^32 - 1', () => {
    const vectors: [number, number][] = [
      [0, 256],
      [256, 256],
      [257, 272],
      [1000, 1024],
      [65536, 65536],
      [70000, 71680],
      [1000000, 1015808],
      [2 ** 31, 2 ** 31],
      [2 ** 32 - 1, 2 ** 32],
    ];
    for (const [n, p] of vectors) expect(paddedLength(n)).toBe(p);
    expect(() => paddedLength(2 ** 32)).toThrow();
    expect(() => paddedLength(-1)).toThrow();
  });
});
