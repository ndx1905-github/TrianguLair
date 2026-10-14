/*
 * Second independent review (fixes of T-002): reproductions of NEW findings from
 * docs/reviews/2026-10-13-crypto-fixes-review.md.
 *
 * Each test is `it.fails(...)` and states the DESIRED behaviour. It fails against the current
 * library, so the suite stays green. When a fix lands the test starts passing, `it.fails` reports
 * it, and it must be turned into a plain `it(...)`. `src/` was not modified by the reviewer.
 */
import { describe, expect, it } from 'vitest';
import {
  createGroup,
  createInvitation,
  devicePublicKeys,
  generateDeviceKeys,
  generateX25519KeyPair,
  issueDeviceCert,
  issueSharingCert,
  openPack,
  retireInvitationKey,
  sealGroupKey,
  sealPack,
  sealSharingKey,
  serialize,
  signIndex,
  verifyIndex,
  canonicalize,
} from '../src/index';
import { checkLocation } from '../src/invitation';
import { mutateHeader, person, publish, te, trust } from './helpers';

describe('R-01 (high): a stolen, not-yet-revoked device can jam `seq` and block its own revocation', () => {
  it.fails('a master-signed higher rotation (revoking the thief) is accepted after a jammed seq', () => {
    // R-01: ordering by `seq` alone lets any certified device publish seq = 2^53-1 once.
    const marie = person(); // marie.device is the stolen phone
    const before = signIndex(marie.signer, { seq: 1, sharingCert: marie.cert, packs: [] });
    // The thief, before the owner notices, publishes the largest possible seq.
    const jam = signIndex(marie.signer, { seq: Number.MAX_SAFE_INTEGER, sharingCert: marie.cert, packs: [] });
    const friendSeen = verifyIndex(serialize(jam), { lastSeen: before });
    // Owner declares the phone lost from another device: new sharing key, phone revoked.
    const tablet = generateDeviceKeys();
    const tabletCert = issueDeviceCert(marie.id, devicePublicKeys(tablet));
    const k1 = generateX25519KeyPair();
    const cert1 = issueSharingCert(marie.id, k1.publicKey, { rotation: 1, revokedDevices: [marie.device.id] });
    const revocation = signIndex({ keys: tablet, cert: tabletCert }, { seq: 2, sharingCert: cert1, packs: [] });
    // Desired: the higher master-signed rotation wins. Today: ROLLBACK forever, the friend keeps
    // wrapping to the old sharing key, which the thief holds.
    expect(() => verifyIndex(serialize(revocation), { lastSeen: friendSeen })).not.toThrow();
  });
});

describe('R-02 (medium): retireInvitationKey keeps a group secret the invitation key received', () => {
  it.fails('refuses (or flags) a group-key pack instead of re-encrypting the same group secret', () => {
    // R-02: re-encrypting a group-key pack does not change the group secret the link holder kept.
    const owner = person();
    const friend = person();
    const { invitation } = createInvitation(owner.id);
    const friends = createGroup();
    const groupPack = sealGroupKey(friends, owner.id.owner, [friend.sharing.publicKey, invitation.keyPair.publicKey]);
    const content = sealPack(te.encode('friends-only places'), [friends.keyPair.publicKey]);
    const index = publish(owner, [groupPack, content]);
    expect(() => retireInvitationKey([groupPack, content], index, invitation.keyPair, () => [friend.sharing.publicKey])).toThrow();
  });
});

describe('R-07 (low): sealSharingKey accepts a device the certificate revokes', () => {
  it.fails('refuses to seal a sharing key to a device listed in its revoked_devices', () => {
    // R-07: one wrong list in the app and the new key goes straight to the thief.
    const marie = person();
    const k1 = generateX25519KeyPair();
    const cert1 = issueSharingCert(marie.id, k1.publicKey, { rotation: 1, revokedDevices: [marie.device.id] });
    expect(() => sealSharingKey({ keyPair: k1, cert: cert1 }, marie.deviceCert)).toThrow();
  });
});

describe('R-05 (low): packs are not bound to their owner', () => {
  it.fails('a pack of Alice listed in Mallory\'s verified index is not attributed to Mallory', () => {
    // R-05: Mallory (a recipient of Alice) re-lists an (old) Alice pack in her own index.
    const [alice, mallory, bob] = [person(), person(), person()];
    const pack = sealPack(te.encode('Alice: my home'), [bob.sharing.publicKey, mallory.sharing.publicKey]);
    publish(alice, [pack]);
    const malloryIndex = publish(mallory, [pack]);
    expect(() => openPack(pack, malloryIndex, [bob.sharing])).toThrow();
  });
});

describe('R-09 (low): canonical-bytes rule has a UTF-8 BOM hole', () => {
  it.fails('a pack header prefixed with a UTF-8 BOM is rejected as non-canonical', () => {
    // R-09: TextDecoder strips a leading BOM by default (ignoreBOM: false).
    const p = person();
    const pack = sealPack(te.encode('x'), [p.sharing.publicKey]);
    const bom = mutateHeader(pack, () => {}, (h) => '﻿' + canonicalize(h));
    expect(() => openPack(bom, trust(bom), [p.sharing])).toThrow();
  });
});

describe('R-10 (low): read-address validation allows parser differentials', () => {
  it.fails('rejects a backslash (WHATWG parses host "good.example", other parsers may not)', () => {
    // R-10: require new URL(location).href === location.
    expect(() => checkLocation('https://good.example\\@evil.example/')).toThrow();
  });
});
