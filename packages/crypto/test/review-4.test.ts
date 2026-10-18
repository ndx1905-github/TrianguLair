/*
 * Fourth independent review (format v4, short invitation link v5, index 4.1, vault v2):
 * docs/reviews/2026-10-18-crypto-v4-review.md.
 *
 * Each `it.fails(...)` states the DESIRED behaviour and fails today at the intended assertion
 * (checked by running each one with `it`). When a finding is fixed, turn it into a plain `it(...)`.
 */
import { describe, expect, it } from 'vitest';
import {
  checkInvitationIndex,
  collectInvitationAnswers,
  createInvitation,
  createInvitationResponse,
  devicePublicKeys,
  emptyVault,
  fromB64Url,
  generateDeviceKeys,
  generateVaultDataKey,
  generateX25519KeyPair,
  INVITATION_ANSWER_GRACE_MS,
  invitationFromRecord,
  invitationRecord,
  invitationToken,
  issueDeviceCert,
  issueSharingCert,
  mergeVaults,
  openVault,
  parseInvitationLink,
  parseKey,
  sealVault,
  serialize,
  signIndex,
  toB64Url,
  verifyIndex,
  type OwnerInvitation,
  type VaultRecords,
} from '../src/index';
import { accept, invite, person, te } from './helpers';

const H = 60 * 60 * 1000;
const D = 24 * H;
const t0 = new Date('2026-10-18T12:00:00.000Z'); // the phone is stolen (unlocked) at t0
const decl = new Date(t0.getTime() + H); // "Declare a device lost" from the tablet
const t2 = new Date(t0.getTime() + 2 * D); // a new contact opens a link
const REAL = 'https://cloud.example.org/s/marie';
const THIEF = 'https://thief.example/marie/';

/** Marie with her phone (`marie.signer`, stolen) and a tablet, plus the rotation-1 cert revoking the phone. */
function household() {
  const marie = person(REAL);
  const tablet = generateDeviceKeys();
  const tabletSigner = { keys: tablet, cert: issueDeviceCert(marie.id, devicePublicKeys(tablet)) };
  const cert1 = issueSharingCert(marie.id, generateX25519KeyPair().publicKey, {
    rotation: 1,
    revokedDevices: [marie.device.id],
    location: REAL,
  });
  return { marie, tabletSigner, cert1 };
}

/** The tablet's side of the declaration: reads the vault records (old key), re-seals them (new key), publishes. */
function declare(h: ReturnType<typeof household>, sealed: Uint8Array) {
  const owner = h.marie.id.owner;
  const records = openVault(sealed, owner, h.marie.vaultDataKey);
  sealVault(records, generateVaultDataKey()); // carried over to the new vault data key
  const invitations = records.invitations.map((r) => invitationFromRecord(r, owner).invitation);
  return signIndex(h.tabletSigner, { seq: 1, sharingCert: h.cert1, packs: [], invitations, now: decl });
}

describe('V4-01 (high): the vault invitation records are not authenticated, so a stolen device plants listings that survive its revocation', () => {
  it.fails('a record written by the phone with `device` set to the tablet is no longer listed after the phone is declared lost', () => {
    const h = household();
    const owner = h.marie.id.owner;
    // Theft window: with the phone's keys and vault data key, the thief makes an invitation and
    // writes its record to the vault naming the tablet as the creating device (a self-declared field).
    const { invitation, fragment } = createInvitation(h.marie.signer, h.marie.cert, { now: t0 });
    expect(invitation.device).toBe(h.marie.device.id);
    const planted = invitationRecord({ ...invitation, device: h.tabletSigner.keys.id });
    const sealed = sealVault({ ...emptyVault(owner), invitations: [planted] }, h.marie.vaultDataKey);

    const index = declare(h, sealed);
    // Two days after the declaration a new contact opens the thief's link at the certified address.
    const received = parseInvitationLink(fragment, { now: t2 });
    const read = verifyIndex(serialize(index), { expectedOwner: owner, location: received.location, now: t2 });
    // Desired (spec "Loss and theft" step 1, README "Declare a device lost"): NOT_LISTED.
    expect(() => checkInvitationIndex(received, read, { now: t2 })).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
  });

  it.fails('an invitation record whose lifetime exceeds 7 days is refused by the vault and never listed', () => {
    const h = household();
    const owner = h.marie.id.owner;
    const { invitation } = createInvitation(h.marie.signer, h.marie.cert, { now: t0 });
    // The thief rewrites the expiry: listed (and wrapped to, as an "open invitation") for 4 years.
    const longLived: OwnerInvitation = { ...invitation, device: h.tabletSigner.keys.id, expires: new Date(t0.getTime() + 4 * 365 * D).toISOString() };
    const index = signIndex(h.tabletSigner, { seq: 1, sharingCert: h.cert1, packs: [], invitations: [longLived], now: decl });
    const token = invitationToken(parseKey('ed25519', owner), longLived.keyPair.publicKey, longLived.rotation, Date.parse(longLived.expires) / 1000);
    expect(index.invitations ?? []).not.toContain(token);
    expect(() => sealVault({ ...emptyVault(owner), invitations: [invitationRecord(longLived)] }, h.marie.vaultDataKey)).toThrow(
      expect.objectContaining({ code: 'FORMAT' }),
    );
  });

  it.fails('a planted record with an impossible rotation does not stop honest devices from publishing the revocation', () => {
    const h = household();
    const owner = h.marie.id.owner;
    const { invitation } = createInvitation(h.marie.signer, h.marie.cert, { now: t0 });
    const planted = invitationRecord({ ...invitation, rotation: 0xffffffff });
    const sealed = sealVault({ ...emptyVault(owner), invitations: [planted] }, h.marie.vaultDataKey);
    // Today signIndex throws for the whole index ("made with a newer sharing certificate"), so the
    // declaration's index cannot be published while the record is in the vault. Desired: skip it.
    const index = declare(h, sealed);
    expect(index.sharing_cert.rotation).toBe(1);
  });
});

describe('V4-02 (medium): open invitations whose seeds the stolen device read stay listed and open after the declaration', () => {
  it.fails('an invitation created by the tablet before the theft is withdrawn by the declaration', () => {
    const h = household();
    const owner = h.marie.id.owner;
    // Before the theft, the tablet invited a friend; the seed is in the vault, which the phone reads.
    const { invitation, fragment } = createInvitation(h.tabletSigner, h.marie.cert, { now: new Date(t0.getTime() - D) });
    const sealed = sealVault({ ...emptyVault(owner), invitations: [invitationRecord(invitation)] }, h.marie.vaultDataKey);
    const index = declare(h, sealed);
    // The thief, who holds the seed, can open the link (and so every pack still wrapped to its key).
    const received = parseInvitationLink(fragment, { now: t2 });
    const read = verifyIndex(serialize(index), { expectedOwner: owner, location: received.location, now: t2 });
    expect(() => checkInvitationIndex(received, read, { now: t2 })).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
  });
});

describe('V4-04 (low): a rewritten read address in the link is not refused, only redirected', () => {
  it.fails('a link whose address was changed is refused (spec: "a forged link (another key, another address, …) is refused")', () => {
    const owner = person(REAL);
    const { fragment, index } = invite(owner, { now: t0 });
    const bytes = fromB64Url(fragment);
    const forged = toB64Url(new Uint8Array([...bytes.subarray(0, 58), ...te.encode(THIEF.slice('https://'.length))]));
    const received = parseInvitationLink(forged, { now: t0 });
    expect(received.location).toBe(THIEF);
    // The app reads THIEF, which serves any copy of Marie's index: MOVED to REAL after full
    // verification. The same bytes, verified for REAL, are accepted for the forged link: the link's
    // address is neither in the token nor compared with the address the index was read from.
    expect(() => verifyIndex(serialize(index), { expectedOwner: received.owner, location: THIEF, now: t0 })).toThrow(expect.objectContaining({ code: 'MOVED' }));
    const read = verifyIndex(serialize(index), { expectedOwner: received.owner, location: REAL, now: t0 });
    expect(() => checkInvitationIndex(received, read, { now: t0 })).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
  });
});

describe('V4-05 (low): listing padding does not hide which tokens are real', () => {
  it.fails('two devices of the same owner listing the same invitations publish the same padded list', () => {
    const h = household();
    const { invitation } = createInvitation(h.marie.signer, h.marie.cert, { now: t0 });
    const a = signIndex(h.marie.signer, { seq: 1, sharingCert: h.marie.cert, packs: [], invitations: [invitation], now: t0 });
    const b = signIndex(h.tabletSigner, { seq: 2, sharingCert: h.marie.cert, packs: [], invitations: [invitation], now: t0 });
    // Today the dummies are keyed by each device's signing seed: the intersection of two
    // consecutive indexes is exactly the set of real tokens (here: 1 of 4).
    const inBoth = (a.invitations ?? []).filter((t) => (b.invitations ?? []).includes(t));
    expect(inBoth.length).toBe(4);
  });
});

describe('V4-06 (low): an answer first opened after expiry is accepted like any other', () => {
  it.fails('a lone answer opened during the grace period is flagged, so the app does not grant silently', () => {
    const owner = person();
    const holder = person(); // anyone who kept the link (chat history, screenshot)
    const { invitation, fragment, index } = invite(owner, { now: t0, ttlMs: 7 * D });
    const expires = Date.parse(invitation.expires);
    // The link holder signs an answer dated inside the window (the date is self-claimed) ...
    const answer = createInvitationResponse(accept(fragment, index, t0), holder.signer, holder.cert, { now: new Date(expires - 60_000) });
    // ... and delivers it during the grace period, when no other answer exists.
    const res = collectInvitationAnswers(invitation, [answer], { now: new Date(expires + INVITATION_ANSWER_GRACE_MS - D) });
    expect(res.accepted).not.toBeNull();
    expect((res.accepted as unknown as { openedAfterExpiry?: boolean }).openedAfterExpiry).toBe(true);
  });
});

describe('V4-07 (low): vault records from a newer minor cannot be merged by an older device', () => {
  it.fails('mergeVaults keeps the newer minor and its unknown fields, and the result can be sealed', () => {
    const owner = person();
    const { invitation } = createInvitation(owner.signer, owner.cert, { now: t0 });
    const newer = { ...emptyVault(owner.id.owner), minor: 1, invitations: [{ ...invitationRecord(invitation), withdrawn: true }] } as unknown as VaultRecords;
    const opened = openVault(sealVault(newer, owner.vaultDataKey), owner.id.owner, owner.vaultDataKey);
    const merged = mergeVaults(opened, opened);
    expect(() => sealVault(merged, owner.vaultDataKey)).not.toThrow();
  });
});
