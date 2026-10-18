/*
 * Fourth independent review (format v4, short invitation link v5, index 4.1, vault v2):
 * docs/reviews/2026-10-18-crypto-v4-review.md.
 *
 * The reproductions were `it.fails(...)` stating the DESIRED behaviour; all are fixed (vault v3
 * with device-signed invitation records, index 4.0 with `invitations`, token v2 binding the read
 * address, owner-wide padding) and are now plain tests, adapted where the attack itself changed
 * shape under the new format (a forged record no longer verifies at all).
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
  cancelAllInvitations,
  issueDeviceCert,
  openPack,
  packEntry,
  retireInvitationKey,
  sealPack,
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
  type InvitationSkipReason,
  type OwnerInvitation,
  type VaultRecords,
} from '../src/index';
import { signInvitationRecord } from '../src/invitation-listing';
import { accept, invite, person, te, PAD_KEY } from './helpers';

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

/**
 * The tablet's side of the declaration (spec "Loss and theft"): reads the vault records (old key),
 * cancels every open invitation (V4-02) unless `cancel` is false, re-seals the records with a new
 * vault data key and publishes rotation 1 listing what is left.
 */
function declare(h: ReturnType<typeof household>, sealed: Uint8Array, opts: { cancel?: boolean; skipped?: InvitationSkipReason[] } = {}) {
  const owner = h.marie.id.owner;
  let records = openVault(sealed, owner, h.marie.vaultDataKey);
  if (opts.cancel !== false) records = cancelAllInvitations(records).records;
  const newKey = generateVaultDataKey();
  sealVault(records, newKey); // carried over to the new vault data key
  const invitations = records.invitations.map((r) => invitationFromRecord(r, owner).invitation);
  return signIndex(h.tabletSigner, {
    seq: 1,
    sharingCert: h.cert1,
    packs: [],
    invitations,
    vaultDataKey: newKey,
    now: decl,
    onSkip: (_i, why) => opts.skipped?.push(why),
  });
}

describe('V4-01 (high): the vault invitation records are not authenticated, so a stolen device plants listings that survive its revocation', () => {
  it('a record written by the phone in the tablet\'s name does not verify, and the phone\'s own records stop being listed at the declaration', () => {
    const h = household();
    const owner = h.marie.id.owner;
    // Theft window: with the phone's keys and vault data key, the thief makes an invitation and
    // tries to write its record naming the tablet as the creating device (V4-01).
    const { invitation, fragment } = createInvitation(h.marie.signer, h.marie.cert, { now: t0 });
    expect(invitation.device).toBe(h.marie.device.id);
    const inTabletsName: OwnerInvitation = { ...invitation, device: h.tabletSigner.keys.id, deviceCert: h.tabletSigner.cert };
    // The record is signed by its creating device: the phone's signature does not verify under the tablet's key.
    expect(() => invitationRecord(inTabletsName)).toThrow(expect.objectContaining({ code: 'SIGNATURE' }));
    const raw = { ...invitationRecord(invitation), device_cert: invitationRecord(createInvitation(h.tabletSigner, h.marie.cert, { now: t0 }).invitation).device_cert };
    expect(() => sealVault({ ...emptyVault(owner), invitations: [raw] }, h.marie.vaultDataKey)).toThrow(expect.objectContaining({ code: 'SIGNATURE' }));
    // Handed to signIndex anyway, it is skipped, reported, and the index is still published.
    const skipped: InvitationSkipReason[] = [];
    signIndex(h.tabletSigner, { seq: 1, sharingCert: h.cert1, packs: [], invitations: [inTabletsName], vaultDataKey: h.marie.vaultDataKey, now: decl, onSkip: (_i, why) => skipped.push(why) });
    expect(skipped).toEqual(['invalid']);

    // The phone's genuine record: even without the purge, the declaration's index skips it (revoked).
    const sealed = sealVault({ ...emptyVault(owner), invitations: [invitationRecord(invitation)] }, h.marie.vaultDataKey);
    const kept: InvitationSkipReason[] = [];
    const noPurge = declare(h, sealed, { cancel: false, skipped: kept });
    expect(kept).toEqual(['revoked']);
    // Two days after the declaration a new contact opens the thief's link at the certified address.
    const received = parseInvitationLink(fragment, { now: t2 });
    for (const index of [noPurge, declare(h, sealed)]) {
      const read = verifyIndex(serialize(index), { expectedOwner: owner, location: received.location, now: t2 });
      expect(() => checkInvitationIndex(received, read, { now: t2 })).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
    }
  });

  it('an invitation record whose lifetime exceeds 7 days is refused by the vault and never listed', () => {
    const h = household();
    const owner = h.marie.id.owner;
    const { invitation } = createInvitation(h.marie.signer, h.marie.cert, { now: t0 });
    // The thief rewrites the expiry: listed (and wrapped to, as an "open invitation") for 4 years.
    const longLived: OwnerInvitation = { ...invitation, device: h.tabletSigner.keys.id, expires: new Date(t0.getTime() + 4 * 365 * D).toISOString() };
    const skipped: InvitationSkipReason[] = [];
    const index = signIndex(h.tabletSigner, { seq: 1, sharingCert: h.cert1, packs: [], invitations: [longLived], vaultDataKey: h.marie.vaultDataKey, now: decl, onSkip: (_i, why) => skipped.push(why) });
    expect(skipped).toEqual(['invalid']);
    const token = invitationToken(parseKey('ed25519', owner), longLived.keyPair.publicKey, longLived.rotation, Date.parse(longLived.expires) / 1000, longLived.location);
    expect(index.invitations ?? []).not.toContain(token);
    expect(() => sealVault({ ...emptyVault(owner), invitations: [invitationRecord(longLived)] }, h.marie.vaultDataKey)).toThrow(
      expect.objectContaining({ code: 'FORMAT' }),
    );
  });

  it('a record with an impossible rotation does not stop honest devices from publishing the revocation', () => {
    const h = household();
    const owner = h.marie.id.owner;
    // The thief signs such a record with the phone's own key (valid until the declaration) ...
    const { invitation } = createInvitation(h.marie.signer, h.marie.cert, { now: t0 });
    const planted: OwnerInvitation = { ...invitation, rotation: 0xffffffff };
    planted.signature = signInvitationRecord(planted, h.marie.device.sign.secretKey);
    // ... and an honest device has a buggy one too: both are skipped, never thrown on.
    const buggy = createInvitation(h.tabletSigner, h.marie.cert, { now: t0 }).invitation;
    const odd: OwnerInvitation = { ...buggy, rotation: 7 };
    odd.signature = signInvitationRecord(odd, h.tabletSigner.keys.sign.secretKey);
    const sealed = sealVault({ ...emptyVault(owner), invitations: [invitationRecord(planted), invitationRecord(odd)] }, h.marie.vaultDataKey);
    const skipped: InvitationSkipReason[] = [];
    const index = declare(h, sealed, { cancel: false, skipped });
    expect(index.sharing_cert.rotation).toBe(1);
    // The phone's record is revoked (may be deleted); the honest device's record is genuine but not
    // listable under this certificate (R5-02: kept, and it ends as "expired" within 7 days).
    expect([...skipped].sort()).toEqual(['not-yet', 'revoked']);
    expect(declare(h, sealed).sharing_cert.rotation).toBe(1);
  });
});

describe('V4-02 (medium): open invitations whose seeds the stolen device read stay listed and open after the declaration', () => {
  it('an invitation created by the tablet before the theft is withdrawn by the declaration, and what it opened is re-encrypted', () => {
    const h = household();
    const owner = h.marie.id.owner;
    // Before the theft, the tablet invited a friend; the seed is in the vault, which the phone reads.
    const { invitation, fragment } = createInvitation(h.tabletSigner, h.marie.cert, { now: new Date(t0.getTime() - D) });
    const sealed = sealVault({ ...emptyVault(owner), invitations: [invitationRecord(invitation)] }, h.marie.vaultDataKey);
    // "Friends" content was wrapped to the open invitation (spec: the invitee sees it immediately).
    const lea = person();
    const friends = sealPack(owner, te.encode('friends places'), [lea.sharing.publicKey, invitation.keyPair.publicKey]);
    const own = signIndex(h.tabletSigner, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: h.cert1, packs: [packEntry(friends)], now: decl });
    // The declaration cancels every open invitation (V4-02) and re-encrypts without their keys.
    const { records, cancelled } = cancelAllInvitations(openVault(sealed, owner, h.marie.vaultDataKey));
    expect(records.invitations).toEqual([]);
    expect(cancelled.map((c) => c.id)).toEqual([invitation.id]);
    expect(cancelled[0]!.accepted).toBeUndefined(); // the friend had not answered: they need a new link
    const fresh = retireInvitationKey([friends], own, cancelled.map((c) => c.keyPair), () => [lea.sharing.publicKey]);
    expect(fresh).toHaveLength(1);
    const after = signIndex(h.tabletSigner, { vaultDataKey: PAD_KEY, seq: 2, sharingCert: h.cert1, packs: [packEntry(fresh[0]!.bytes)], now: decl });
    expect(() => openPack(fresh[0]!.bytes, after, [invitation.keyPair])).toThrow(expect.objectContaining({ code: 'NO_MATCHING_KEY' }));
    expect(openPack(fresh[0]!.bytes, after, [lea.sharing]).payload).toEqual(te.encode('friends places'));
    // The thief, who holds the seed, can no longer get the link confirmed.
    const index = declare(h, sealed);
    const received = parseInvitationLink(fragment, { now: t2 });
    const read = verifyIndex(serialize(index), { expectedOwner: owner, location: received.location, now: t2 });
    expect(() => checkInvitationIndex(received, read, { now: t2 })).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
  });
});

describe('V4-04 (low): a rewritten read address in the link is not refused, only redirected', () => {
  it('a link whose address was changed is refused (spec: "a forged link (another key, another address, …) is refused")', () => {
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
  it('two devices of the same owner listing the same invitations publish the same padded list', () => {
    const h = household();
    const { invitation } = createInvitation(h.marie.signer, h.marie.cert, { now: t0 });
    const key = h.marie.vaultDataKey; // owner-wide: every device holds it
    const a = signIndex(h.marie.signer, { seq: 1, sharingCert: h.marie.cert, packs: [], invitations: [invitation], vaultDataKey: key, now: t0 });
    const b = signIndex(h.tabletSigner, { seq: 2, sharingCert: h.marie.cert, packs: [], invitations: [invitation], vaultDataKey: key, now: t0 });
    // The intersection of two consecutive indexes no longer singles out the real tokens.
    const inBoth = (a.invitations ?? []).filter((t) => (b.invitations ?? []).includes(t));
    expect(inBoth.length).toBe(4);
  });

  it('dummies churn within 7 days like real tokens, and the field is there even with nothing open', () => {
    const p = person();
    const key = p.vaultDataKey;
    const at = (ms: number) => new Date(t0.getTime() + ms);
    const empty = (ms: number) => signIndex(p.signer, { seq: 1, sharingCert: p.cert, packs: [], vaultDataKey: key, now: at(ms) }).invitations!;
    expect(empty(0)).toHaveLength(4);
    // Every dummy changes value within 7 days (each slot has its own period of 1 to 7 days) ...
    const later = empty(7 * D + 1000);
    expect(empty(0).filter((t) => later.includes(t))).toEqual([]);
    // ... but not all at once (sampled hourly, some hour shows a partial change).
    const first = empty(0);
    const partial = Array.from({ length: 7 * 24 }, (_, i) => empty(i * H).filter((t) => first.includes(t)).length);
    expect(partial.some((n) => n > 0 && n < 4)).toBe(true);
    // Another owner-wide key (a new vault data key after a declaration) gives other dummies.
    const other = signIndex(p.signer, { seq: 1, sharingCert: p.cert, packs: [], vaultDataKey: generateVaultDataKey(), now: t0 }).invitations!;
    expect(other.filter((t) => empty(0).includes(t))).toEqual([]);
  });
});

describe('V4-06 (low): an answer first opened after expiry is accepted like any other', () => {
  it('a lone answer opened during the grace period is flagged, so the app does not grant silently', () => {
    const owner = person();
    const holder = person(); // anyone who kept the link (chat history, screenshot)
    const { invitation, fragment, index } = invite(owner, { now: t0, ttlMs: 7 * D });
    const expires = Date.parse(invitation.expires);
    // The link holder signs an answer dated inside the window (the date is self-claimed) ...
    const answer = createInvitationResponse(accept(fragment, index, t0), holder.signer, holder.cert, { now: new Date(expires - 60_000) });
    // ... and delivers it during the grace period, when no other answer exists.
    const res = collectInvitationAnswers(invitation, [answer], { now: new Date(expires + INVITATION_ANSWER_GRACE_MS - D) });
    expect(res.accepted).not.toBeNull();
    expect(res.accepted!.openedAfterExpiry).toBe(true);
    // The same answer opened before expiry is not flagged.
    expect(collectInvitationAnswers(invitation, [answer], { now: new Date(expires - 30_000) }).accepted!.openedAfterExpiry).toBe(false);
  });
});

describe('V4-07 (low): vault records from a newer minor cannot be merged by an older device', () => {
  it('mergeVaults keeps the newer minor and its unknown fields, and the result can be sealed', () => {
    const owner = person();
    const { invitation } = createInvitation(owner.signer, owner.cert, { now: t0 });
    const newer = { ...emptyVault(owner.id.owner), minor: 1, invitations: [{ ...invitationRecord(invitation), withdrawn: true }] } as unknown as VaultRecords;
    const opened = openVault(sealVault(newer, owner.vaultDataKey), owner.id.owner, owner.vaultDataKey);
    const merged = mergeVaults(opened, emptyVault(owner.id.owner));
    expect(merged.minor).toBe(1);
    expect(() => sealVault(merged, owner.vaultDataKey)).not.toThrow();
    const back = openVault(sealVault(mergeVaults(emptyVault(owner.id.owner), opened), owner.vaultDataKey), owner.id.owner, owner.vaultDataKey);
    expect((back.invitations[0] as unknown as Record<string, unknown>)['withdrawn']).toBe(true);
    // Unknown top-level fields and `crit` are kept too (union, re-validated when sealing).
    const top = openVault(sealVault({ ...newer, zones: 3 } as unknown as VaultRecords, owner.vaultDataKey), owner.id.owner, owner.vaultDataKey);
    const m2 = mergeVaults(emptyVault(owner.id.owner), top);
    expect((m2 as unknown as Record<string, unknown>)['zones']).toBe(3);
    expect(() => sealVault(m2, owner.vaultDataKey)).not.toThrow();
  });
});

describe('notes and new behaviour', () => {
  it('N-5: the link size bound matches the longest read address exactly', () => {
    const longest = `https://storage.example.org/${'x'.repeat(512 - 'https://storage.example.org/'.length)}`;
    expect(te.encode(longest).length).toBe(512);
    const p = person(longest);
    const { fragment } = createInvitation(p.signer, p.cert, { now: t0 });
    expect(fragment.length).toBe(750);
    expect(parseInvitationLink(fragment, { now: t0 }).location).toBe(longest);
    expect(() => parseInvitationLink(`${fragment}A`, { now: t0 })).toThrow(expect.objectContaining({ code: 'FORMAT' }));
  });

  it('signIndex reports each skipped record (expired, revoked, invalid) and lists the rest', () => {
    const h = household();
    const ok = createInvitation(h.tabletSigner, h.cert1, { now: decl }).invitation;
    const expired = createInvitation(h.tabletSigner, h.marie.cert, { now: t0, ttlMs: 60_000 }).invitation;
    const byPhone = createInvitation(h.marie.signer, h.marie.cert, { now: t0 }).invitation;
    const future = createInvitation(h.tabletSigner, h.cert1, { now: new Date(decl.getTime() + D) }).invitation;
    const unsigned: OwnerInvitation = { ...ok, signature: '' };
    const seen: [string, InvitationSkipReason][] = [];
    const index = signIndex(h.tabletSigner, {
      seq: 1,
      sharingCert: h.cert1,
      packs: [],
      invitations: [ok, expired, byPhone, future, unsigned, { ...ok, owner: person().id.owner }],
      vaultDataKey: h.marie.vaultDataKey,
      now: decl,
      onSkip: (i, why) => seen.push([i.id, why]),
    });
    expect(seen.map(([, why]) => why)).toEqual(['expired', 'revoked', 'not-yet', 'invalid', 'invalid']);
    expect(index.invitations).toHaveLength(4);
    const token = invitationToken(parseKey('ed25519', h.marie.id.owner), ok.keyPair.publicKey, ok.rotation, Date.parse(ok.expires) / 1000, ok.location);
    expect(index.invitations).toContain(token);
    // Every index needs the owner-wide padding key (N-3 of the fifth review: the field is always written).
    // @ts-expect-error vaultDataKey is required
    expect(() => signIndex(h.tabletSigner, { seq: 2, sharingCert: h.cert1, packs: [], invitations: [ok], now: decl })).toThrow(expect.objectContaining({ code: 'FORMAT' }));
  });

  it('the token binds the read address; a storage move (new rotation) cancels the invitations open before it (R5-01)', () => {
    const h = household();
    const { invitation, fragment } = createInvitation(h.tabletSigner, h.marie.cert, { now: t0 });
    expect(invitation.location).toBe(REAL);
    const rec = invitationFromRecord(invitationRecord(invitation), h.marie.id.owner).invitation;
    expect(rec.location).toBe(REAL);
    const NEW = 'https://new.example.net/marie/';
    const moved = issueSharingCert(h.marie.id, generateX25519KeyPair().publicKey, { rotation: 1, location: NEW });
    const skipped: InvitationSkipReason[] = [];
    const index = signIndex(h.tabletSigner, { seq: 1, sharingCert: moved, packs: [], invitations: [rec], vaultDataKey: h.marie.vaultDataKey, now: t0, onSkip: (_i, why) => skipped.push(why) });
    expect(skipped).toEqual(['superseded']);
    const received = parseInvitationLink(fragment, { now: t0 });
    expect(() => verifyIndex(serialize(index), { expectedOwner: received.owner, location: received.location, now: t0 })).toThrow(expect.objectContaining({ code: 'MOVED' }));
    expect(() => checkInvitationIndex(received, verifyIndex(serialize(index), { expectedOwner: received.owner, location: NEW, now: t0 }), { now: t0 })).toThrow(
      expect.objectContaining({ code: 'NOT_LISTED' }),
    );
  });
});
