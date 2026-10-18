/*
 * Third independent review (format v3, before T-201): docs/reviews/2026-10-18-crypto-v3-review.md.
 *
 * Every test is an `it.fails(...)` that states the DESIRED behaviour. It fails today, so the suite
 * stays green. When a fix lands the test starts passing, `it.fails` reports it, and it must become
 * a plain `it(...)`. src/ was not modified.
 */
import { describe, expect, it } from 'vitest';
import {
  assertInvitationActive,
  canonicalize,
  checkInvitationIndex,
  collectInvitationAnswers,
  createInvitation,
  createInvitationResponse,
  devicePublicKeys,
  generateDeviceKeys,
  generateX25519KeyPair,
  issueDeviceCert,
  issueSharingCert,
  packEntry,
  parseInvitationLink,
  retireInvitationKey,
  safetyCode,
  sealPack,
  serialize,
  signIndex,
  verifyIndex,
} from '../src/index';
import { checkLocation } from '../src/invitation';
import { signBody } from '../src/sign';
import { person, publish, te } from './helpers';

const now = new Date('2026-10-18T12:00:00.000Z');
const later = new Date('2026-12-01T12:00:00.000Z'); // weeks after the theft was declared
const REAL = 'https://cloud.example.org/s/marie';
const THIEF = 'https://thief.example/marie/';

/** Marie's phone is stolen; from her tablet she declares it lost: rotation 1 revokes the phone. */
function theft() {
  const marie = person();
  const tablet = generateDeviceKeys();
  const tabletSigner = { keys: tablet, cert: issueDeviceCert(marie.id, devicePublicKeys(tablet)) };
  const k1 = generateX25519KeyPair();
  const cert1 = issueSharingCert(marie.id, k1.publicKey, { rotation: 1, revokedDevices: [marie.device.id] });
  // What the real storage serves after the declaration.
  const realIndex = signIndex(tabletSigner, { seq: 1, sharingCert: cert1, packs: [], now: later });
  return { marie, tabletSigner, k1, cert1, realIndex };
}

/** Re-signs an index body (as a device would) after `edit`. */
function resign(index: object, deviceSecretKey: Uint8Array, edit: (b: Record<string, unknown>) => void): string {
  const { signature: _s, ...body } = JSON.parse(serialize(index)) as Record<string, unknown>;
  edit(body);
  return serialize(signBody('index', body, deviceSecretKey));
}

describe('V3-01 (high): a revoked device keeps the identity toward NEW contacts (attacker-chosen location)', () => {
  it.fails('a link minted by the revoked phone after the declaration, pointing to the thief\'s host, is refused', () => {
    const { marie, realIndex } = theft();
    // Weeks after the declaration, the thief mints a fresh link with the phone's device key and the
    // (public) rotation-0 certificate, and points `location` to a host he controls.
    const { fragment } = createInvitation(marie.signer, marie.cert, { now: later, location: THIEF });
    const received = parseInvitationLink(fragment, { now: later });
    // The thief serves an index he signs himself with the phone key, at rotation 0, with new content.
    const fakePack = sealPack(marie.id.owner, te.encode('fake places in Marie\'s name'), [received.keyPair.publicKey]);
    const fake = signIndex(marie.signer, { seq: 7, sharingCert: marie.cert, packs: [packEntry(fakePack)], now: later });
    // The real storage would have shown the revocation, but the link decides where the invitee reads.
    expect(() => checkInvitationIndex(received, realIndex)).toThrow(expect.objectContaining({ code: 'REVOKED' }));
    // The safety code cannot help: the master key is genuine.
    expect(safetyCode(received.owner, marie.id.owner)).toEqual(safetyCode(marie.id.owner, marie.id.owner));
    // Desired: the new friend refuses this chain (e.g. the read address is bound by a master signature).
    expect(() => {
      const idx = verifyIndex(serialize(fake), { expectedOwner: received.owner, now: later });
      checkInvitationIndex(received, idx);
    }).toThrow();
  });

  it.fails('mirror: the revoked phone answers an invitation; the inviter would wrap to the old sharing key the thief holds', () => {
    const { marie: bob } = theft(); // Bob's phone stolen and revoked (rotation 1)
    const alice = person();
    const { invitation, fragment } = createInvitation(alice.signer, alice.cert, { now: later, location: REAL });
    const received = parseInvitationLink(fragment, { now: later });
    // The thief answers with Bob's revoked phone, Bob's rotation-0 cert, and his own read address.
    const resp = createInvitationResponse(received, bob.signer, bob.cert, { now: later, location: THIEF });
    const answer = collectInvitationAnswers(invitation, [resp], { now: later }).accepted!;
    const served = signIndex(bob.signer, { seq: 3, sharingCert: bob.cert, packs: [], now: later });
    expect(answer.sharingPublicKey).toEqual(bob.sharing.publicKey); // the thief holds this secret
    expect(() => {
      const idx = verifyIndex(serialize(served), { expectedOwner: answer.owner, now: later });
      checkInvitationIndex(answer, idx);
    }).toThrow();
  });
});

describe('V3-02 (medium): answers after expiry are thrown away, including the late-answer warning', () => {
  const ttlMs = 3600e3;
  const afterExpiry = new Date(now.getTime() + 2 * ttlMs);

  it.fails('a second responder whose answer is processed after expiry still shows up in `late`', () => {
    const owner = person();
    const { invitation, fragment } = createInvitation(owner.signer, owner.cert, { now, ttlMs });
    const received = parseInvitationLink(fragment, { now });
    const [interceptor, friend] = [person(), person()];
    const first = createInvitationResponse(received, interceptor.signer, interceptor.cert, { now });
    expect(collectInvitationAnswers(invitation, [first], { now }).accepted?.owner).toBe(interceptor.id.owner);
    // The real friend answered inside the validity window; the owner's app sees it after expiry.
    const second = createInvitationResponse(received, friend.signer, friend.cert, { now: new Date(now.getTime() + ttlMs / 2) });
    const r = collectInvitationAnswers(invitation, [first, second], { now: afterExpiry, acceptedOwner: interceptor.id.owner });
    expect(r.late.map((a) => a.owner)).toEqual([friend.id.owner]);
  });

  it.fails('a single answer created inside the window but opened after expiry can still be listed', () => {
    const owner = person();
    const friend = person();
    const { invitation, fragment } = createInvitation(owner.signer, owner.cert, { now, ttlMs });
    const resp = createInvitationResponse(parseInvitationLink(fragment, { now }), friend.signer, friend.cert, { now });
    expect(collectInvitationAnswers(invitation, [resp], { now: afterExpiry }).answers).toHaveLength(1);
  });
});

describe('V3-03 (medium): versioning contradicts the spec ("ignore the unknown", minor versions)', () => {
  it.fails('an index from a newer minor version with an extra signed field is still readable', () => {
    const p = person();
    const idx = signIndex(p.signer, { seq: 1, sharingCert: p.cert, packs: [] });
    const newer = resign(idx, p.device.sign.secretKey, (b) => {
      b['zones_hint'] = 'added in 3.1';
    });
    expect(() => verifyIndex(newer)).not.toThrow();
  });
});

describe('V3-04 (low): invitation `created` is not bounded by the reader\'s clock', () => {
  it.fails('a link "created" ten years in the future is refused', () => {
    const owner = person();
    const future = new Date(now.getTime() + 10 * 365 * 86400e3);
    const { fragment } = createInvitation(owner.signer, owner.cert, { now: future });
    expect(() => parseInvitationLink(fragment, { now })).toThrow();
  });
});

describe('V3-05 (low): index pack entries given as JSON strings are accepted', () => {
  it.fails('packs: ["{\\"file\\":…}"] (a string, not an object) is a FormatError', () => {
    const p = person();
    const pack = sealPack(p.id.owner, te.encode('x'), [p.sharing.publicKey]);
    const idx = signIndex(p.signer, { seq: 1, sharingCert: p.cert, packs: [packEntry(pack)] });
    const stringy = resign(idx, p.device.sign.secretKey, (b) => {
      b['packs'] = [canonicalize(packEntry(pack))];
    });
    expect(() => verifyIndex(stringy)).toThrow(expect.objectContaining({ code: 'FORMAT' }));
  });
});

describe('V3-06 (low): sharing-cert rotation is a u53 in JSON but a u32 in links', () => {
  it.fails('issueSharingCert refuses a rotation that invitations cannot carry', () => {
    const p = person();
    expect(() => issueSharingCert(p.id, generateX25519KeyPair().publicKey, { rotation: 2 ** 32 })).toThrow();
  });
});

describe('V3-07 (low): an invitation record with a malformed expiry never expires', () => {
  it.fails('assertInvitationActive refuses an unparseable `expires`', () => {
    expect(() => assertInvitationActive({ expires: 'not a date' })).toThrow();
  });
});

describe('V3-08 (low): retireInvitationKey silently skips packs it was not given', () => {
  it.fails('it refuses a pack list that does not cover the index', () => {
    const owner = person();
    const { invitation } = createInvitation(owner.signer, owner.cert);
    const a = sealPack(owner.id.owner, te.encode('a'), [owner.sharing.publicKey, invitation.keyPair.publicKey]);
    const b = sealPack(owner.id.owner, te.encode('b'), [owner.sharing.publicKey, invitation.keyPair.publicKey]);
    const index = publish(owner, [a, b]);
    // Only `a` is passed (e.g. a page of a paginated listing): `b` stays readable by the link holder.
    expect(() => retireInvitationKey([a], index, invitation.keyPair, () => [owner.sharing.publicKey])).toThrow();
  });
});

describe('V3-09 (low): checkLocation misses some IPv6 spellings of local addresses', () => {
  it.fails('IPv4-compatible and NAT64 forms of loopback / private IPv4 are refused', () => {
    for (const bad of ['https://[::7f00:1]/', 'https://[::a00:1]/', 'https://[64:ff9b::7f00:1]/', 'https://[64:ff9b::c0a8:101]/']) {
      expect(() => checkLocation(bad), bad).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    }
  });
});
