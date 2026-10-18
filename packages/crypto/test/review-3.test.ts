/*
 * Third independent review (format v3, before T-201): docs/reviews/2026-10-18-crypto-v3-review.md.
 *
 * These started as `it(...)` reproductions written by the reviewer, stating the DESIRED
 * behaviour. Each one now passes against the fixed library and is a plain `it(...)`. Where the API
 * changed (the read address is now inside the master-signed sharing certificate, V3-01; minor
 * versions, V3-03) the scenario is kept and expressed with the new API, with extra assertions.
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
  indexAnchor,
  INDEX_VERSION,
  INVITATION_ANSWER_GRACE_MS,
  isInvitationExpired,
  issueDeviceCert,
  issueSharingCert,
  packEntry,
  parseInvitationLink,
  retireInvitationKey,
  safetyCode,
  sealPack,
  serialize,
  sharingCertOf,
  signIndex,
  verifyIndex,
  verifySharingCert,
} from '../src/index';
import { checkLocation } from '../src/invitation';
import { signBody } from '../src/sign';
import { accept, invite, person, publish, te, PAD_KEY } from './helpers';

const now = new Date('2026-10-18T12:00:00.000Z');
const later = new Date('2026-12-01T12:00:00.000Z'); // weeks after the theft was declared
const REAL = 'https://cloud.example.org/s/marie';
const THIEF = 'https://thief.example/marie/';

/** Marie's phone is stolen; from her tablet she declares it lost: rotation 1 revokes the phone. */
function theft() {
  const marie = person(REAL);
  const tablet = generateDeviceKeys();
  const tabletSigner = { keys: tablet, cert: issueDeviceCert(marie.id, devicePublicKeys(tablet)) };
  const k1 = generateX25519KeyPair();
  const cert1 = issueSharingCert(marie.id, k1.publicKey, { rotation: 1, revokedDevices: [marie.device.id], location: REAL });
  // What the real storage serves after the declaration.
  const realIndex = signIndex(tabletSigner, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: cert1, packs: [], now: later });
  return { marie, tabletSigner, k1, cert1, realIndex };
}

/** Re-signs an index body (as a device would) after `edit`. */
function resign(index: object, deviceSecretKey: Uint8Array, edit: (b: Record<string, unknown>) => void): string {
  const { signature: _s, ...body } = JSON.parse(serialize(index)) as Record<string, unknown>;
  edit(body);
  return serialize(signBody('index', body, deviceSecretKey));
}

describe('V3-01 (high): a revoked device keeps the identity toward NEW contacts (attacker-chosen location)', () => {
  it('a link minted by the revoked phone after the declaration, pointing to the thief\'s host, is refused', () => {
    const { marie, realIndex } = theft();
    // Weeks after the declaration, the thief mints a fresh link with the phone's device key and the
    // (public) rotation-0 certificate. The link is unsigned: it is accepted only if the index read at
    // the link's address is Marie's, read at its master-certified address, and lists it.
    const { invitation, fragment } = createInvitation(marie.signer, marie.cert, { now: later });
    const received = parseInvitationLink(fragment, { now: later });
    expect(received.location).toBe(REAL);
    // The thief serves an index he signs himself with the phone key, at rotation 0, listing the link.
    const fakePack = sealPack(marie.id.owner, te.encode('fake places in Marie\'s name'), [received.keyPair.publicKey]);
    const fake = signIndex(marie.signer, { seq: 7, sharingCert: marie.cert, packs: [packEntry(fakePack)], invitations: [invitation], vaultDataKey: marie.vaultDataKey, now: later });
    // Read where the link says (the certified address): the real index (signed by the tablet) does not list it.
    const real = verifyIndex(serialize(realIndex), { expectedOwner: received.owner, location: received.location, now: later });
    expect(() => checkInvitationIndex(received, real, { now: later })).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
    // The safety code cannot help: the master key is genuine.
    expect(safetyCode(received.owner, marie.id.owner)).toEqual(safetyCode(marie.id.owner, marie.id.owner));
    // Rewriting the address in the link to the thief's host: the fake index there names REAL as
    // the certified address (master-signed): it is a "redirect", never accepted at THIEF.
    const bytes = new Uint8Array(Buffer.from(fragment, 'base64url'));
    const thiefLink = Buffer.from(new Uint8Array([...bytes.subarray(0, 58), ...te.encode(THIEF.slice(8))])).toString('base64url');
    const atThief = parseInvitationLink(thiefLink, { now: later });
    expect(atThief.location).toBe(THIEF);
    expect(() => verifyIndex(serialize(fake), { expectedOwner: atThief.owner, location: THIEF, now: later })).toThrow(
      expect.objectContaining({ code: 'MOVED', location: REAL }),
    );
    // An index verified without the address it was read from cannot be used for the check.
    expect(() => {
      const idx = verifyIndex(serialize(fake), { expectedOwner: received.owner, now: later });
      checkInvitationIndex(received, idx, { now: later });
    }).toThrow();
    // And the phone, revoked by the current certificate, cannot publish an index that lists it.
    expect(() => signIndex(marie.signer, { seq: 2, sharingCert: sharingCertOf(realIndex), packs: [], invitations: [invitation], vaultDataKey: marie.vaultDataKey, now: later })).toThrow(
      expect.objectContaining({ code: 'REVOKED' }),
    );
  });

  it('mirror: the revoked phone answers an invitation; the inviter would wrap to the old sharing key the thief holds', () => {
    const { marie: bob, realIndex } = theft(); // Bob's phone stolen and revoked (rotation 1)
    const alice = person();
    const { invitation, fragment, index } = invite(alice, { now: later });
    const received = accept(fragment, index, later);
    // The thief answers with Bob's revoked phone and Bob's rotation-0 cert; its address is Bob's real one.
    const resp = createInvitationResponse(received, bob.signer, bob.cert, { now: later });
    const answer = collectInvitationAnswers(invitation, [resp], { now: later }).accepted!;
    const served = signIndex(bob.signer, { vaultDataKey: PAD_KEY, seq: 3, sharingCert: bob.cert, packs: [], now: later });
    expect(answer.sharingPublicKey).toEqual(bob.sharing.publicKey); // the thief holds this secret
    expect(answer.location).toBe(REAL);
    expect(() => {
      const idx = verifyIndex(serialize(served), { expectedOwner: answer.owner, now: later });
      checkInvitationIndex(answer, idx);
    }).toThrow();
    // Alice reads Bob's index at the certified address: rotation 1 revokes the phone.
    const idx = verifyIndex(serialize(realIndex), { expectedOwner: answer.owner, location: answer.location!, now: later });
    expect(() => checkInvitationIndex(answer, idx)).toThrow(expect.objectContaining({ code: 'REVOKED' }));
  });
});

describe('V3-02 (medium): answers after expiry are thrown away, including the late-answer warning', () => {
  const ttlMs = 3600e3;
  const afterExpiry = new Date(now.getTime() + 2 * ttlMs);

  it('a second responder whose answer is processed after expiry still shows up in `late`', () => {
    const owner = person();
    const { invitation, fragment, index } = invite(owner, { now, ttlMs });
    const received = accept(fragment, index, now);
    const [interceptor, friend] = [person(), person()];
    const first = createInvitationResponse(received, interceptor.signer, interceptor.cert, { now });
    expect(collectInvitationAnswers(invitation, [first], { now }).accepted?.owner).toBe(interceptor.id.owner);
    // The real friend answered inside the validity window; the owner's app sees it after expiry.
    const second = createInvitationResponse(received, friend.signer, friend.cert, { now: new Date(now.getTime() + ttlMs / 2) });
    const r = collectInvitationAnswers(invitation, [first, second], { now: afterExpiry, acceptedOwner: interceptor.id.owner });
    expect(r.late.map((a) => a.owner)).toEqual([friend.id.owner]);
  });

  it('a single answer created inside the window but opened after expiry can still be listed', () => {
    const owner = person();
    const friend = person();
    const { invitation, fragment, index } = invite(owner, { now, ttlMs });
    const resp = createInvitationResponse(accept(fragment, index, now), friend.signer, friend.cert, { now });
    expect(collectInvitationAnswers(invitation, [resp], { now: afterExpiry }).answers).toHaveLength(1);
  });
});

describe('V3-03 (medium): versioning contradicts the spec ("ignore the unknown", minor versions)', () => {
  it('an index from a newer minor version with an extra signed field is still readable', () => {
    const p = person();
    const idx = signIndex(p.signer, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: p.cert, packs: [] });
    // INDEX_MINOR is 0 (`invitations` is part of 4.0, V4-03): minor 1 and 2 are newer.
    const newer = resign(idx, p.device.sign.secretKey, (b) => {
      b['minor'] = 2;
      b['zones_hint'] = 'added in 4.2';
    });
    expect(() => verifyIndex(newer)).not.toThrow();
    // The extra field is covered by the signature, and kept in the verified index.
    expect((verifyIndex(newer) as unknown as Record<string, unknown>)['zones_hint']).toBe('added in 4.2');
    expect(() => verifyIndex(newer.replace('added in 4.2', 'changed!!!!!!'))).toThrow(expect.objectContaining({ code: 'SIGNATURE' }));
    // Without a higher minor, an unknown field is still refused.
    const noMinor = resign(idx, p.device.sign.secretKey, (b) => {
      b['zones_hint'] = 'x';
    });
    expect(() => verifyIndex(noMinor)).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    const minor1 = resign(idx, p.device.sign.secretKey, (b) => {
      b['minor'] = 1;
      b['zones_hint'] = 'x';
    });
    expect(() => verifyIndex(minor1)).not.toThrow();
    // A security-relevant extension listed in `crit` must be understood.
    const critical = resign(idx, p.device.sign.secretKey, (b) => {
      b['minor'] = 2;
      b['expires_at'] = '2027-01-01T00:00:00.000Z';
      b['crit'] = ['expires_at'];
    });
    expect(() => verifyIndex(critical)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VERSION', critical: 'expires_at' }));
  });
});

describe('V3-04 (low): invitation `created` is not bounded by the reader\'s clock', () => {
  it('a link "created" ten years in the future is refused', () => {
    const owner = person();
    const future = new Date(now.getTime() + 10 * 365 * 86400e3);
    const { fragment } = createInvitation(owner.signer, owner.cert, { now: future });
    expect(() => parseInvitationLink(fragment, { now })).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    // The short link carries only `expires`: at most 7 days + 5 minutes after the reader's clock.
    const edge = createInvitation(owner.signer, owner.cert, { now: new Date(now.getTime() + 299e3) }).fragment;
    expect(() => parseInvitationLink(edge, { now })).not.toThrow();
    const beyond = createInvitation(owner.signer, owner.cert, { now: new Date(now.getTime() + 301e3) }).fragment;
    expect(() => parseInvitationLink(beyond, { now })).toThrow(expect.objectContaining({ code: 'FORMAT' }));
  });
});

describe('V3-05 (low): index pack entries given as JSON strings are accepted', () => {
  it('packs: ["{\\"file\\":…}"] (a string, not an object) is a FormatError', () => {
    const p = person();
    const pack = sealPack(p.id.owner, te.encode('x'), [p.sharing.publicKey]);
    const idx = signIndex(p.signer, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: p.cert, packs: [packEntry(pack)] });
    const stringy = resign(idx, p.device.sign.secretKey, (b) => {
      b['packs'] = [canonicalize(packEntry(pack))];
    });
    expect(() => verifyIndex(stringy)).toThrow(expect.objectContaining({ code: 'FORMAT' }));
  });
});

describe('V3-06 (low): sharing-cert rotation is a u53 in JSON but a u32 in links', () => {
  it('issueSharingCert refuses a rotation that invitations cannot carry', () => {
    const p = person();
    expect(() => issueSharingCert(p.id, generateX25519KeyPair().publicKey, { rotation: 2 ** 32 })).toThrow();
  });
});

describe('V3-07 (low): an invitation record with a malformed expiry never expires', () => {
  it('assertInvitationActive refuses an unparseable `expires`', () => {
    expect(() => assertInvitationActive({ expires: 'not a date' })).toThrow();
  });
});

describe('V3-08 (low): retireInvitationKey silently skips packs it was not given', () => {
  it('it refuses a pack list that does not cover the index', () => {
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
  it('IPv4-compatible and NAT64 forms of loopback / private IPv4 are refused', () => {
    for (const bad of ['https://[::7f00:1]/', 'https://[::a00:1]/', 'https://[64:ff9b::7f00:1]/', 'https://[64:ff9b::c0a8:101]/']) {
      expect(() => checkLocation(bad), bad).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    }
  });
});

// ---------------------------------------------------------------------------
// New behaviour introduced by the fixes.
// ---------------------------------------------------------------------------

describe('V3-01: the read address is master-certified; moving storage needs the master', () => {
  const NEW = 'https://new-host.example.net/marie/';

  it('a move is a new rotation; the newest index left at the old address is a redirect', () => {
    const marie = person(REAL);
    const r0 = signIndex(marie.signer, { vaultDataKey: PAD_KEY, seq: 4, sharingCert: marie.cert, packs: [] });
    // Same rotation, other address: two certificates for one rotation (fork).
    const sameRot = issueSharingCert(marie.id, marie.sharing.publicKey, { rotation: 0, location: NEW });
    expect(() => verifyIndex(serialize(signIndex(marie.signer, { vaultDataKey: PAD_KEY, seq: 5, sharingCert: sameRot, packs: [] })), { lastSeen: r0 })).toThrow(
      expect.objectContaining({ code: 'ROLLBACK', fork: true }),
    );
    // The master issues rotation 1 (same sharing key allowed) with the new address.
    const moved = issueSharingCert(marie.id, marie.sharing.publicKey, { rotation: 1, location: NEW });
    const r1 = signIndex(marie.signer, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: moved, packs: [] });
    // A friend reading the old address finds r1 left there: verified, then told where to go.
    expect(() => verifyIndex(serialize(r1), { expectedOwner: marie.id.owner, lastSeen: r0, location: REAL })).toThrow(
      expect.objectContaining({ code: 'MOVED', location: NEW }),
    );
    // At the new address it is accepted.
    expect(verifyIndex(serialize(r1), { expectedOwner: marie.id.owner, lastSeen: r0, location: NEW }).sharing_cert.location).toBe(NEW);
    // An index pointing elsewhere with an OLDER certificate is a rollback, not a redirect.
    expect(() => verifyIndex(serialize(r0), { expectedOwner: marie.id.owner, lastSeen: r1, location: NEW })).toThrow(
      expect.objectContaining({ code: 'ROLLBACK' }),
    );
  });

  it('a new contact with an old link follows the redirect and still sees the revocation', () => {
    const marie = person(REAL);
    const { invitation, fragment } = createInvitation(marie.signer, marie.cert, { now });
    const received = parseInvitationLink(fragment, { now });
    // Later: storage moved (rotation 1), then the phone was declared lost (rotation 2).
    const tablet = generateDeviceKeys();
    const tabletSigner = { keys: tablet, cert: issueDeviceCert(marie.id, devicePublicKeys(tablet)) };
    const cert2 = issueSharingCert(marie.id, generateX25519KeyPair().publicKey, { rotation: 2, location: NEW, revokedDevices: [marie.device.id] });
    // The tablet's index keeps listing the open invitations, except those made by the revoked phone.
    const latest = serialize(signIndex(tabletSigner, { seq: 1, sharingCert: cert2, packs: [], invitations: [invitation], vaultDataKey: marie.vaultDataKey, now }));
    let next = '';
    try {
      verifyIndex(latest, { expectedOwner: received.owner, location: received.location }); // read at REAL: redirect
    } catch (e) {
      next = (e as { location: string }).location;
    }
    expect(next).toBe(NEW);
    const idx = verifyIndex(latest, { expectedOwner: received.owner, location: next });
    expect(() => checkInvitationIndex(received, idx, { now })).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
    // An invitation made by the tablet before the move is cancelled by the later rotation (R5-01):
    // the link is followed to the new address, then refused there.
    const byTablet = createInvitation(tabletSigner, marie.cert, { now });
    const tabletLink = parseInvitationLink(byTablet.fragment, { now });
    const fresh = createInvitation(tabletSigner, cert2, { now });
    const latest2 = serialize(signIndex(tabletSigner, { seq: 2, sharingCert: cert2, packs: [], invitations: [invitation, byTablet.invitation, fresh.invitation], vaultDataKey: marie.vaultDataKey, now }));
    expect(() => verifyIndex(latest2, { expectedOwner: tabletLink.owner, location: tabletLink.location, now })).toThrow(expect.objectContaining({ code: 'MOVED' }));
    expect(() => checkInvitationIndex(tabletLink, verifyIndex(latest2, { expectedOwner: tabletLink.owner, location: NEW, now }), { now })).toThrow(
      expect.objectContaining({ code: 'NOT_LISTED' }),
    );
    // A link made under the current certificate names the new address and is listed.
    const freshLink = parseInvitationLink(fresh.fragment, { now });
    expect(freshLink.location).toBe(NEW);
    expect(() => checkInvitationIndex(freshLink, verifyIndex(latest2, { expectedOwner: freshLink.owner, location: NEW, now }), { now })).not.toThrow();
  });

  it('checkInvitationIndex refuses to reset an existing contact to trust on first use (lastSeen)', () => {
    const marie = person(REAL);
    const k1 = generateX25519KeyPair();
    const cert1 = issueSharingCert(marie.id, k1.publicKey, { rotation: 1, location: REAL });
    const lastSeen = signIndex(marie.signer, { vaultDataKey: PAD_KEY, seq: 3, sharingCert: cert1, packs: [], now });
    const { invitation, fragment } = createInvitation(marie.signer, marie.cert, { now });
    const received = parseInvitationLink(fragment, { now });
    const old = signIndex(marie.signer, { seq: 9, sharingCert: marie.cert, packs: [], invitations: [invitation], vaultDataKey: marie.vaultDataKey, now });
    expect(() => checkInvitationIndex(received, old, { now })).not.toThrow(); // fine for a brand-new contact
    expect(() => checkInvitationIndex(received, old, { lastSeen, now })).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
  });

  it('an answer without a certified address cannot be freshness-checked', () => {
    const owner = person();
    const friend = person();
    const { invitation, fragment, index } = invite(owner, { now });
    const noStorage = issueSharingCert(friend.id, friend.sharing.publicKey, { rotation: 0 });
    const answer = collectInvitationAnswers(invitation, [createInvitationResponse(accept(fragment, index, now), friend.signer, noStorage, { now })], { now }).accepted!;
    expect(answer.location).toBeUndefined();
    expect(() => checkInvitationIndex(answer, signIndex(friend.signer, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: friend.cert, packs: [] }))).toThrow(
      expect.objectContaining({ code: 'FORMAT' }),
    );
  });
});

describe('V3-02 / V3-07: invitation records', () => {
  it('a malformed `created` in a record fails closed when opening answers', () => {
    const owner = person();
    const friend = person();
    const { invitation, fragment, index } = invite(owner, { now });
    const resp = createInvitationResponse(accept(fragment, index, now), friend.signer, friend.cert, { now });
    expect(() => collectInvitationAnswers({ ...invitation, created: 'garbage' }, [resp], { now })).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    expect(isInvitationExpired({ expires: 'garbage' }, now)).toBe(true);
    expect(INVITATION_ANSWER_GRACE_MS).toBe(7 * 86400e3);
  });
});

describe('V3-03: extension rules on certificates', () => {
  it('a sharing certificate from a newer minor with an extra field still verifies, also embedded in an index', () => {
    const p = person();
    const body = { ...JSON.parse(serialize(p.cert)), minor: 1, note: 'added later' };
    delete body.signature;
    const ext = signBody('sharing-cert', body, p.id.master.secretKey);
    const cert = verifySharingCert(ext).cert;
    expect((cert as unknown as Record<string, unknown>)['note']).toBe('added later');
    const idx = signIndex(p.signer, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: cert, packs: [] });
    expect((verifyIndex(serialize(idx)).sharing_cert as unknown as Record<string, unknown>)['note']).toBe('added later');
    // Not without a higher minor. The short invitation link carries no certificate, so such an owner
    // can invite; a return link (binary compact certificate) still cannot carry it.
    const { minor: _m, ...noMinor } = body;
    expect(() => verifySharingCert(signBody('sharing-cert', noMinor, p.id.master.secretKey))).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    const inv = createInvitation(p.signer, cert, { now });
    const listed = signIndex(p.signer, { seq: 2, sharingCert: cert, packs: [], invitations: [inv.invitation], vaultDataKey: p.vaultDataKey, now });
    const friend = person();
    const received = accept(inv.fragment, listed, now);
    expect(() => createInvitationResponse(received, p.signer, cert, { now })).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    expect(() => createInvitationResponse(received, friend.signer, friend.cert, { now })).not.toThrow();
  });
});

describe('V3-13: signIndex refuses to publish an index readers would refuse', () => {
  it('with `previous`: no rollback, and seq = previous + 1 within the rotation', () => {
    const p = person();
    const i1 = signIndex(p.signer, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: p.cert, packs: [] });
    expect(signIndex(p.signer, { vaultDataKey: PAD_KEY, seq: 2, sharingCert: p.cert, packs: [], previous: i1 }).seq).toBe(2);
    expect(() => signIndex(p.signer, { vaultDataKey: PAD_KEY, seq: 1 + 2 ** 21, sharingCert: p.cert, packs: [], previous: i1 })).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
    expect(() => signIndex(p.signer, { vaultDataKey: PAD_KEY, seq: 5, sharingCert: p.cert, packs: [], previous: i1 })).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
    expect(() => signIndex(p.signer, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: p.cert, packs: [], previous: i1 })).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
    // A new rotation may restart seq.
    const cert1 = issueSharingCert(p.id, generateX25519KeyPair().publicKey, { rotation: 1, location: p.location });
    expect(signIndex(p.signer, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: cert1, packs: [], previous: indexAnchor(i1) }).seq).toBe(1);
  });
});

describe('Index anchors (vault form of lastSeen)', () => {
  it('checkNoRollback and verifyIndex accept an anchor, including fork detection', () => {
    const p = person();
    const i2 = signIndex(p.signer, { vaultDataKey: PAD_KEY, seq: 2, sharingCert: p.cert, packs: [] });
    const a = indexAnchor(i2);
    expect(a).toMatchObject({ type: 'index-anchor', owner: p.id.owner, seq: 2, version: INDEX_VERSION });
    expect(() => verifyIndex(serialize(i2), { lastSeen: a })).not.toThrow();
    expect(() => verifyIndex(serialize(signIndex(p.signer, { vaultDataKey: PAD_KEY, seq: 1, sharingCert: p.cert, packs: [] })), { lastSeen: a })).toThrow(
      expect.objectContaining({ code: 'ROLLBACK' }),
    );
    const fork = signIndex(p.signer, { vaultDataKey: PAD_KEY, seq: 2, sharingCert: p.cert, packs: [], reads: ['4', '4.1'] });
    expect(() => verifyIndex(serialize(fork), { lastSeen: a })).toThrow(expect.objectContaining({ code: 'ROLLBACK', fork: true }));
  });
});

describe('V3-09: more IPv6 forms', () => {
  it('6to4 and local-use NAT64 of private ranges, multicast, are refused; public literals pass', () => {
    for (const bad of ['https://[2002:c0a8:101::1]/', 'https://[64:ff9b:1::1]/', 'https://[ff02::1]/', 'https://[::]/']) {
      expect(() => checkLocation(bad), bad).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    }
    for (const good of ['https://[2001:db8::1]/', 'https://[64:ff9b::cb00:7107]/', 'https://[::ffff:cb00:7107]/']) {
      expect(() => checkLocation(good), good).not.toThrow();
    }
  });
});
