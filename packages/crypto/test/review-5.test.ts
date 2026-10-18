/*
 * Fifth independent review (final pass before the format v4 freeze, commits b02ebd0 and 5be049b):
 * docs/reviews/2026-10-18-crypto-v4-final-review.md.
 *
 * Each `it.fails(...)` states the DESIRED behaviour; it was checked as a plain `it` to fail at the
 * intended assertion, not earlier. src/ is not modified by the review.
 */
import { describe, expect, it } from 'vitest';
import {
  cancelAllInvitations,
  checkInvitationIndex,
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
  type InvitationSkipReason,
  type VaultRecords,
} from '../src/index';
import { accept, invite, person } from './helpers';

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
  it.fails('the laptop merges its local copy into the declared vault and lists the cancelled invitation again', () => {
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
    // Desired: a declaration's cancellation sticks (NOT_LISTED). Today the link is confirmed.
    expect(() => checkInvitationIndex(received, read, { now: t2 })).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
  });
});

describe('R5-02 (low): "invalid" mixes planted records with legitimate ones that are not listable yet', () => {
  it.fails('an invitation from a device whose clock is 10 minutes ahead is reported as "invalid" (guidance: drop it)', () => {
    const p = person();
    const other = generateDeviceKeys();
    const otherSigner = { keys: other, cert: issueDeviceCert(p.id, devicePublicKeys(other)) };
    // Device A (clock 10 minutes fast) creates a genuine invitation; device B publishes first.
    const { invitation } = createInvitation(p.signer, p.cert, { now: new Date(t0.getTime() + 10 * 60 * 1000) });
    const why: InvitationSkipReason[] = [];
    signIndex(otherSigner, { seq: 1, sharingCert: p.cert, packs: [], invitations: [invitation], vaultDataKey: p.vaultDataKey, now: t0, onSkip: (_i, r) => why.push(r) });
    // Desired: a distinct reason ("not yet listable": keep the record), not the one whose
    // documented handling is "drop it from the vault and warn".
    expect(why).toHaveLength(1);
    expect(why[0]).not.toBe('invalid');
  });
});

describe('R5-03 (low): mergeVaults truncates the union of answers by sort order', () => {
  it.fails('16 junk answers that sort first push the real answer out of the merged record', () => {
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
    // Desired: the honest device's answers survive a merge (Léa's answer is the evidence for
    // "one answer per invitation"). Today the union is sorted and cut to 16.
    expect(merged.invitations[0]!.answers).toContain(toB64Url(answer));
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

  it('N-3: without vaultDataKey, signIndex omits `invitations` although the spec says it is written in every index', () => {
    const p = person();
    const idx = signIndex(p.signer, { seq: 1, sharingCert: p.cert, packs: [], now: decl });
    expect('invitations' in idx).toBe(false);
  });
});
