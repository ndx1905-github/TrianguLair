/*
 * Fifth independent review (final pass before the format v4 freeze, commits b02ebd0 and 5be049b):
 * docs/reviews/2026-10-18-crypto-v4-final-review.md.
 *
 * The review's three `it.fails(...)` reproductions (R5-01, R5-02, R5-03) are now plain tests: the
 * fixes landed (listing rule "same rotation only", skip reasons "superseded" / "not-yet", answer
 * ranking in mergeVaults). The notes and the new behaviour are covered below them.
 */
import { describe, expect, it } from 'vitest';
import {
  cancelAllInvitations,
  checkInvitationIndex,
  collectInvitationAnswers,
  createInvitation,
  createInvitationResponse,
  devicePublicKeys,
  emptyVault,
  generateDeviceKeys,
  generateVaultDataKey,
  generateX25519KeyPair,
  invitationFromRecord,
  invitationRecord,
  issueDeviceCert,
  issueSharingCert,
  mergeVaults,
  openVault,
  parseInvitationLink,
  sealVault,
  serialize,
  signIndex,
  toB64Url,
  verifyIndex,
  invitationStatus,
  invitationToken,
  parseKey,
  type InvitationSkipReason,
  type OwnerInvitation,
  type VaultRecords,
} from '../src/index';
import { signBody } from '../src/sign';
import { accept, invite, person, te } from './helpers';

const H = 60 * 60 * 1000;
const D = 24 * H;
const t0 = new Date('2026-10-18T12:00:00.000Z'); // the phone is stolen at t0
const decl = new Date(t0.getTime() + H); // "Declare a device lost" from the tablet
const t2 = new Date(t0.getTime() + 2 * D);
const REAL = 'https://cloud.example.org/s/marie';

/** Marie: phone (stolen, marie.signer), tablet (declares), laptop (third device), rotation-1 cert revoking the phone. */
function household() {
  const marie = person(REAL);
  const dev = () => {
    const keys = generateDeviceKeys();
    return { keys, cert: issueDeviceCert(marie.id, devicePublicKeys(keys)) };
  };
  const cert1 = issueSharingCert(marie.id, generateX25519KeyPair().publicKey, { rotation: 1, revokedDevices: [marie.device.id], location: REAL });
  return { marie, tablet: dev(), laptop: dev(), cert1 };
}

describe('R5-01 (medium): a cancelled invitation comes back through mergeVaults with any pre-declaration copy', () => {
  it('the laptop merges its local copy into the declared vault: the cancelled invitation is not listed again', () => {
    const h = household();
    const owner = h.marie.id.owner;
    // Before the theft the tablet invited someone; the record (and seed) is in the vault, which
    // the phone reads, and in the laptop's local copy.
    const { invitation, fragment } = createInvitation(h.tablet, h.marie.cert, { now: new Date(t0.getTime() - D) });
    const before = sealVault({ ...emptyVault(owner), invitations: [invitationRecord(invitation)] }, h.marie.vaultDataKey);
    const laptopLocal = openVault(before, owner, h.marie.vaultDataKey);

    // Declaration on the tablet, exactly as README "Declare a device lost" says.
    const newKey = generateVaultDataKey();
    const { records } = cancelAllInvitations(openVault(before, owner, h.marie.vaultDataKey));
    const declared = sealVault(records, newKey);

    // The laptop receives the new TLSK, opens the new vault and merges its local copy (spec: "two
    // devices that write the vault at the same time merge their versions"), then publishes.
    const merged = mergeVaults(openVault(declared, owner, newKey), laptopLocal);
    const index = signIndex(h.laptop, {
      seq: 2,
      sharingCert: h.cert1,
      packs: [],
      invitations: merged.invitations.map((r) => invitationFromRecord(r, owner).invitation),
      vaultDataKey: newKey,
      now: t2,
    });

    // The thief, who read the seed, uses the link two days after the declaration.
    const received = parseInvitationLink(fragment, { now: t2 });
    const read = verifyIndex(serialize(index), { expectedOwner: owner, location: received.location, now: t2 });
    // A declaration's cancellation sticks: the invitation was created under rotation 0.
    expect(() => checkInvitationIndex(received, read, { now: t2 })).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
  });
});

describe('R5-02 (low): "invalid" mixes planted records with legitimate ones that are not listable yet', () => {
  it('an invitation from a device whose clock is 10 minutes ahead is "not-yet" (keep it), not "invalid" (drop it)', () => {
    const p = person();
    const other = generateDeviceKeys();
    const otherSigner = { keys: other, cert: issueDeviceCert(p.id, devicePublicKeys(other)) };
    // Device A (clock 10 minutes fast) creates a genuine invitation; device B publishes first.
    const { invitation } = createInvitation(p.signer, p.cert, { now: new Date(t0.getTime() + 10 * 60 * 1000) });
    const why: InvitationSkipReason[] = [];
    signIndex(otherSigner, { seq: 1, sharingCert: p.cert, packs: [], invitations: [invitation], vaultDataKey: p.vaultDataKey, now: t0, onSkip: (_i, r) => why.push(r) });
    // A distinct reason ("not yet listable": keep the record), not the one whose documented
    // handling is "drop it from the vault and warn".
    expect(why).toEqual(['not-yet']);
  });
});

describe('R5-03 (low): mergeVaults truncates the union of answers by sort order', () => {
  it('16 junk answers that sort first no longer push the real answer out of the merged record', () => {
    const marie = person();
    const lea = person();
    const owner = marie.id.owner;
    const { invitation, fragment, index } = invite(marie, { now: t0 });
    const answer = createInvitationResponse(accept(fragment, index, t0), lea.signer, lea.cert, { now: new Date(t0.getTime() + H) });
    const honest = openVault(sealVault({ ...emptyVault(owner), invitations: [invitationRecord(invitation, { answers: [answer] })] }, marie.vaultDataKey), owner, marie.vaultDataKey);
    // A stolen device (vault data key) writes the same record with 16 short junk answers.
    const junk = Array.from({ length: 16 }, (_, i) => `---${'ABCDEFGHIJKLMNOP'[i]}`);
    const planted = { ...honest, invitations: [{ ...honest.invitations[0]!, answers: junk }] } as VaultRecords;
    const stolen = openVault(sealVault(planted, marie.vaultDataKey), owner, marie.vaultDataKey);
    const merged = mergeVaults(honest, stolen);
    // The honest device's answer survives the merge (Léa's answer is the evidence for "one answer
    // per invitation"), in either merge order, and the result seals.
    expect(merged.invitations[0]!.answers).toContain(toB64Url(answer));
    expect(mergeVaults(stolen, honest).invitations[0]!.answers).toContain(toB64Url(answer));
    expect(() => sealVault(merged, marie.vaultDataKey)).not.toThrow();
  });
});

describe('notes (current behaviour, documented)', () => {
  it('N-2: a minor and unknown fields written by a stolen device survive merge and the declaration', () => {
    const marie = person();
    const owner = marie.id.owner;
    const poisoned = { ...emptyVault(owner), minor: Number.MAX_SAFE_INTEGER, zones: 'thief' } as unknown as VaultRecords;
    const stolen = openVault(sealVault(poisoned, marie.vaultDataKey), owner, marie.vaultDataKey);
    const after = cancelAllInvitations(mergeVaults(emptyVault(owner), stolen)).records;
    const newKey = generateVaultDataKey();
    const reopened = openVault(sealVault(after, newKey), owner, newKey);
    expect(reopened.minor).toBe(Number.MAX_SAFE_INTEGER);
    expect((reopened as unknown as Record<string, unknown>)['zones']).toBe('thief');
  });

  it('N-3: `invitations` is written in every index (padding only when nothing is open); vaultDataKey is required', () => {
    const p = person();
    const idx = signIndex(p.signer, { seq: 1, sharingCert: p.cert, packs: [], vaultDataKey: p.vaultDataKey, now: decl });
    expect(idx.invitations).toHaveLength(4);
    // A JavaScript caller that omits the key gets a FormatError instead of an index without the field.
    // @ts-expect-error vaultDataKey is required
    expect(() => signIndex(p.signer, { seq: 2, sharingCert: p.cert, packs: [], now: decl })).toThrow(expect.objectContaining({ code: 'FORMAT' }));
  });
});

describe('new behaviour after the fifth review', () => {
  it('R5-01: a vault copy sealed with the OLD key (thief, or a device not yet updated) merged after the declaration relists nothing', () => {
    const h = household();
    const owner = h.marie.id.owner;
    const byTablet = createInvitation(h.tablet, h.marie.cert, { now: new Date(t0.getTime() - D) });
    const byPhone = createInvitation(h.marie.signer, h.marie.cert, { now: t0 }); // the thief, during the theft window
    const oldCopy = openVault(
      sealVault({ ...emptyVault(owner), invitations: [invitationRecord(byTablet.invitation), invitationRecord(byPhone.invitation)] }, h.marie.vaultDataKey),
      owner,
      h.marie.vaultDataKey,
    );
    // Declaration: cancel, new vault data key, rotation 1. A new invitation made afterwards is listed.
    const newKey = generateVaultDataKey();
    const declared = openVault(sealVault(cancelAllInvitations(oldCopy).records, newKey), owner, newKey);
    const after = createInvitation(h.laptop, h.cert1, { now: decl });
    const current = mergeVaults({ ...declared, invitations: [invitationRecord(after.invitation)] }, oldCopy);
    expect(current.invitations).toHaveLength(3); // the union brings the cancelled records back ...
    const why: [string, InvitationSkipReason][] = [];
    const index = signIndex(h.laptop, {
      seq: 2,
      sharingCert: h.cert1,
      packs: [],
      invitations: current.invitations.map((r) => invitationFromRecord(r, owner).invitation),
      vaultDataKey: newKey,
      now: t2,
      onSkip: (i, r) => why.push([i.id, r]),
    });
    // ... but the listing rule ignores them: superseded (tablet) and revoked (phone).
    expect(Object.fromEntries(why)).toEqual({ [byTablet.invitation.id]: 'superseded', [byPhone.invitation.id]: 'revoked' });
    const read = (fragment: string) => {
      const received = parseInvitationLink(fragment, { now: t2 });
      return { received, index: verifyIndex(serialize(index), { expectedOwner: owner, location: received.location, now: t2 }) };
    };
    for (const f of [byTablet.fragment, byPhone.fragment]) {
      const r = read(f);
      expect(() => checkInvitationIndex(r.received, r.index, { now: t2 })).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
    }
    const ok = read(after.fragment);
    expect(() => checkInvitationIndex(ok.received, ok.index, { now: t2 })).not.toThrow();
    // invitationStatus gives the same verdicts (wrap "friends" content only to "listed" ones).
    expect(invitationStatus(byTablet.invitation, h.cert1, t2)).toBe('superseded');
    expect(invitationStatus(byPhone.invitation, h.cert1, t2)).toBe('revoked');
    expect(invitationStatus(after.invitation, h.cert1, t2)).toBe('listed');
  });

  it('R5-01: a reader refuses an older-rotation invitation even if an index of a later rotation lists its token', () => {
    const h = household();
    const owner = h.marie.id.owner;
    const { invitation, fragment } = createInvitation(h.tablet, h.marie.cert, { now: t0 });
    // A buggy or hand-made writer at rotation 1 that puts the rotation-0 token in the list.
    const token = invitationToken(parseKey('ed25519', owner), invitation.keyPair.publicKey, 0, Date.parse(invitation.expires) / 1000, REAL);
    const honest = signIndex(h.tablet, { seq: 1, sharingCert: h.cert1, packs: [], vaultDataKey: h.marie.vaultDataKey, now: decl });
    const { signature: _s, ...body } = JSON.parse(serialize(honest)) as Record<string, unknown>;
    const list = [...(body['invitations'] as string[]).slice(1), token].sort();
    const forged = serialize(signBody('index', { ...body, invitations: list }, h.tablet.keys.sign.secretKey));
    const received = parseInvitationLink(fragment, { now: t2 });
    const read = verifyIndex(forged, { expectedOwner: owner, location: received.location, now: t2 });
    expect(read.invitations).toContain(received.token);
    expect(() => checkInvitationIndex(received, read, { now: t2 })).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
  });

  it('R5-02: an invitation under a newer certificate than the publisher holds is "not-yet", then listed; every genuine record ends as "expired"', () => {
    const h = household();
    // The laptop already holds rotation 1 and invites; the tablet still publishes with rotation 0.
    const { invitation, fragment } = createInvitation(h.laptop, h.cert1, { now: decl });
    const why: InvitationSkipReason[] = [];
    signIndex(h.tablet, { seq: 5, sharingCert: h.marie.cert, packs: [], invitations: [invitation], vaultDataKey: h.marie.vaultDataKey, now: decl, onSkip: (_i, r) => why.push(r) });
    expect(why).toEqual(['not-yet']);
    // Once the tablet has the new certificate, the same record is listed.
    const index = signIndex(h.tablet, { seq: 1, sharingCert: h.cert1, packs: [], invitations: [invitation], vaultDataKey: h.marie.vaultDataKey, now: decl });
    expect(() => accept(fragment, index, decl)).not.toThrow();
    // A not-yet or superseded record is never kept forever: at expiry it becomes "expired".
    const late = new Date(Date.parse(invitation.expires));
    expect(invitationStatus(invitation, h.marie.cert, late)).toBe('expired');
    const old = createInvitation(h.tablet, h.marie.cert, { now: t0 }).invitation;
    expect(invitationStatus(old, h.cert1, decl)).toBe('superseded');
    expect(invitationStatus(old, h.cert1, new Date(Date.parse(old.expires)))).toBe('expired');
    // Planted or broken records stay "invalid" (the only reason, with "revoked" and "expired", that allows deletion).
    const forged: OwnerInvitation = { ...invitation, signature: invitation.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) };
    expect(invitationStatus(forged, h.cert1, decl)).toBe('invalid');
  });

  it('R5-03: above 16 answers, verifiable answers are kept first, one per responder, the accepted one and a second responder included', () => {
    const marie = person();
    const owner = marie.id.owner;
    const lea = person();
    const bob = person();
    const eve = person();
    const { invitation, fragment, index } = invite(marie, { now: t0 });
    const confirmed = accept(fragment, index, t0);
    const at = (ms: number) => ({ now: new Date(t0.getTime() + ms) });
    const leaAnswer = toB64Url(createInvitationResponse(confirmed, lea.signer, lea.cert, at(H)));
    const bobAnswer = toB64Url(createInvitationResponse(confirmed, bob.signer, bob.cert, at(2 * H)));
    // Eve (who holds the seed) floods with valid answers of her own, plus junk.
    const eveAnswers = Array.from({ length: 12 }, (_, i) => toB64Url(createInvitationResponse(confirmed, eve.signer, eve.cert, at(3 * H + i * 1000))));
    const junk = Array.from({ length: 8 }, (_, i) => `---${'ABCDEFGH'[i]}`);
    const rec = invitationRecord(invitation, { accepted: lea.id.owner });
    const a = { ...emptyVault(owner), invitations: [{ ...rec, answers: [leaAnswer, ...junk.slice(0, 4)].sort() }] } as VaultRecords;
    const b = { ...emptyVault(owner), invitations: [{ ...rec, answers: [bobAnswer, ...eveAnswers.slice(0, 7), ...junk.slice(4)].sort() }] } as VaultRecords;
    const c = { ...emptyVault(owner), invitations: [{ ...rec, answers: [...eveAnswers.slice(7)].sort() }] } as VaultRecords;
    const merged = mergeVaults(mergeVaults(a, b), c);
    const kept = merged.invitations[0]!.answers;
    expect(kept.length).toBeLessThanOrEqual(16);
    expect(kept).toContain(leaAnswer);
    expect(kept).toContain(bobAnswer);
    const sealed = openVault(sealVault(merged, marie.vaultDataKey), owner, marie.vaultDataKey);
    const { invitation: inv, answers } = invitationFromRecord(sealed.invitations[0]!, owner);
    const res = collectInvitationAnswers(inv, answers, { now: new Date(t0.getTime() + 4 * H), acceptedOwner: lea.id.owner });
    expect(res.accepted?.owner).toBe(lea.id.owner);
    expect(res.late.map((r) => r.owner).sort()).toEqual([bob.id.owner, eve.id.owner].sort());
    // Below the cap the union is kept as it is (cheap, and nothing is lost).
    const small = mergeVaults(a, { ...emptyVault(owner), invitations: [{ ...rec, answers: [bobAnswer] }] } as VaultRecords);
    expect(small.invitations[0]!.answers).toEqual([leaAnswer, bobAnswer, ...junk.slice(0, 4)].sort());
  });

  it('the invitation link stays at most 200 characters with an 80-character read address', () => {
    const address = `https://cloud.example.org/${'m'.repeat(80 - 'https://cloud.example.org/'.length)}`;
    expect(te.encode(address).length).toBe(80);
    const p = person(address);
    const { fragment } = createInvitation(p.signer, p.cert, { now: t0 });
    const link = `https://triangulair.app/i#${fragment}`;
    expect(link.length).toBeLessThanOrEqual(200);
    expect(parseInvitationLink(link, { now: t0 }).location).toBe(address);
  });
});
