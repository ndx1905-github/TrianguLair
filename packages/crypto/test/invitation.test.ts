import { describe, expect, it } from 'vitest';
import {
  checkInvitationIndex,
  collectInvitationAnswers,
  createInvitation,
  createInvitationResponse,
  DecryptionError,
  devicePublicKeys,
  ExpiredError,
  FormatError,
  generateDeviceKeys,
  generateX25519KeyPair,
  issueDeviceCert,
  INVITATION_MAX_TTL_MS,
  isInvitationExpired,
  issueSharingCert,
  openInvitationResponse,
  openPack,
  packEntry,
  parseInvitationLink,
  readPackHeader,
  retireInvitationKey,
  sealPack,
  serialize,
  SignatureError,
  toB64Url,
  UnsupportedVersionError,
  verifyIndex,
  type SignedIndex,
} from '../src/index';
import { accept, invite, person, publish, te } from './helpers';
import { signBody } from '../src/sign';

const now = new Date('2026-10-13T12:00:00.000Z');
const day = 24 * 3600 * 1000;
const at = (ms: number) => new Date(now.getTime() + ms);
const LOCATION = 'https://cloud.example.org/s/AbCdEfGh12345';
const PREFIX = 'https://triangulair.app/i#';

function bytesOf(fragment: string): Uint8Array {
  return new Uint8Array(Buffer.from(fragment, 'base64url'));
}

function relink(fragment: string, f: (b: Uint8Array) => void): string {
  const b = bytesOf(fragment);
  f(b);
  return toB64Url(b);
}

describe('invitation link (short, bound by the owner\'s index)', () => {
  const owner = person(LOCATION);
  const friend = person();
  const { invitation, fragment, index } = invite(owner, { now });
  const read = (link: string, idx: SignedIndex = index, when = at(day)) => {
    const r = parseInvitationLink(link, { now: when });
    checkInvitationIndex(r, verifyIndex(serialize(idx), { expectedOwner: r.owner, location: r.location, now: when }), { now: when });
    return r;
  };

  it('is base64url, valid 7 days, and parses back', () => {
    expect(fragment).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Date.parse(invitation.expires) - now.getTime()).toBe(7 * day);
    const r = read(`${PREFIX}${fragment}`);
    expect(r.owner).toBe(owner.id.owner);
    expect(r.id).toBe(invitation.id);
    expect(r.ownerPublicKey).toEqual(owner.id.master.publicKey);
    expect(r.keyPair.publicKey).toEqual(invitation.keyPair.publicKey);
    expect(r.keyPair.secretKey).toEqual(invitation.keyPair.secretKey);
    expect(r.location).toBe(LOCATION);
    expect(r.rotation).toBe(0);
    expect(r.expires).toBe(invitation.expires);
    expect(invitation.device).toBe(owner.device.id);
  });

  it('is at most 200 characters with the URL prefix and a realistic 40-character address', () => {
    const loc40 = 'https://cloud.example.org/s/AbCdEfGh1234';
    expect(loc40.length).toBe(40);
    const o = person(loc40);
    const link = `${PREFIX}${createInvitation(o.signer, o.cert, { now }).fragment}`;
    expect(bytesOf(link.slice(PREFIX.length)).length).toBe(58 + 40 - 8);
    expect(link.length).toBe(146);
    // Revoked devices and the rotation do not make it longer (no certificate inside).
    const tablet = generateDeviceKeys();
    const signer = { keys: tablet, cert: issueDeviceCert(o.id, devicePublicKeys(tablet)) };
    const revoked = Array.from({ length: 20 }, () => generateDeviceKeys().id);
    const cert9 = issueSharingCert(o.id, o.sharing.publicKey, { rotation: 9, location: loc40, revokedDevices: [o.device.id, ...revoked] });
    expect(`${PREFIX}${createInvitation(signer, cert9, { now }).fragment}`.length).toBe(146);
    // An 80-character address still fits in 200 characters (QR version 10 at level M or lower).
    const loc80 = `https://nextcloud.example-hosting.org/index.php/s/${'x'.repeat(30)}`;
    expect(loc80.length).toBe(80);
    const o80 = person(loc80);
    expect(`${PREFIX}${createInvitation(o80.signer, o80.cert, { now }).fragment}`.length).toBe(200);
  });

  it('expiry: rejected at/after 7 days', () => {
    expect(isInvitationExpired(invitation, at(7 * day - 1))).toBe(false);
    expect(isInvitationExpired(invitation, at(7 * day))).toBe(true);
    expect(() => parseInvitationLink(fragment, { now: at(7 * day) })).toThrow(ExpiredError);
    expect(() => parseInvitationLink(fragment, { now: at(30 * day) })).toThrow(expect.objectContaining({ code: 'EXPIRED' }));
  });

  it('ttl must be an integer between 60 s and 7 days (T-002 F-13)', () => {
    expect(() => createInvitation(owner.signer, owner.cert, { ttlMs: INVITATION_MAX_TTL_MS + 1 })).toThrow(FormatError);
    expect(() => createInvitation(owner.signer, owner.cert, { ttlMs: 0 })).toThrow(FormatError);
    expect(() => createInvitation(owner.signer, owner.cert, { ttlMs: 0.5 })).toThrow(FormatError);
    expect(() => createInvitation(owner.signer, owner.cert, { ttlMs: 59_999 })).toThrow(FormatError);
    expect(() => parseInvitationLink(createInvitation(owner.signer, owner.cert, { ttlMs: 60_000 }).fragment)).not.toThrow();
    expect(() => createInvitation(owner.signer, owner.cert, { now: new Date('nope') })).toThrow(FormatError);
  });

  it('the read address is the certified one: https, no credentials or fragment (T-002 F-12); none means no invitation', () => {
    for (const location of ['http://example.org/', 'https://user:pw@example.org/', 'https://example.org/#x', 'javascript:alert(1)', `https://e.org/${'a'.repeat(600)}`]) {
      expect(() => issueSharingCert(owner.id, owner.sharing.publicKey, { rotation: 0, location })).toThrow(FormatError);
    }
    // A local-only owner (no storage, so no index to vouch for the link) cannot invite.
    const noStorage = issueSharingCert(owner.id, owner.sharing.publicKey, { rotation: 0 });
    expect(() => createInvitation(owner.signer, noStorage, { now })).toThrow(FormatError);
  });

  it('an unpublished invitation, or one missing from the current index, is refused (NOT_LISTED)', () => {
    const o = person(LOCATION);
    const unlisted = createInvitation(o.signer, o.cert, { now });
    const plain = publish(o, [], { now });
    expect(() => read(unlisted.fragment, plain)).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
    // Listed, then withdrawn by the owner: a later index without it closes the link.
    const listed = publish(o, [], { now, invitations: [unlisted.invitation] });
    expect(() => read(unlisted.fragment, listed)).not.toThrow();
    expect(() => read(unlisted.fragment, publish(o, [], { now: at(day) }))).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
    // And it cannot be answered before being confirmed.
    expect(() => createInvitationResponse(parseInvitationLink(unlisted.fragment, { now }), friend.signer, friend.cert, { now })).toThrow(FormatError);
  });

  it('an expired invitation is no longer listed, and is refused even by an old index that lists it', () => {
    const o = person(LOCATION);
    const { invitation: inv, fragment: f, index: idx } = invite(o, { now, ttlMs: 3600e3 });
    expect(idx.invitations).toContain(parseInvitationLink(f, { now }).token);
    // The next publication after expiry drops it.
    const after = publish(o, [], { now: at(2 * 3600e3), invitations: [inv] });
    expect(after.invitations).toBeUndefined();
    expect(() => read(f, idx, at(2 * 3600e3))).toThrow(ExpiredError);
    const r = parseInvitationLink(f, { now });
    const v = verifyIndex(serialize(idx), { expectedOwner: r.owner, location: r.location, now });
    expect(() => checkInvitationIndex(r, v, { now: at(2 * 3600e3) })).toThrow(ExpiredError);
  });

  it('a link pointing to another address is redirected to the certified one, never trusted there', () => {
    const elsewhere = 'thief.example/marie'.padEnd(LOCATION.length - 8, 'x');
    const r = parseInvitationLink(relink(fragment, (x) => x.set(te.encode(elsewhere), 58)), { now });
    expect(r.location).toBe(`https://${elsewhere}`);
    expect(r.token).toBe(parseInvitationLink(fragment, { now }).token); // the address is not in the token
    // Whatever is served at the link's address, only an index certifying that address is accepted
    // there; the owner's genuine index is a redirect to the certified address.
    expect(() => verifyIndex(serialize(index), { expectedOwner: r.owner, location: r.location, now })).toThrow(
      expect.objectContaining({ code: 'MOVED', location: LOCATION }),
    );
    // An index verified without the address it was read from cannot vouch for the link.
    expect(() => checkInvitationIndex(r, verifyIndex(serialize(index), { expectedOwner: r.owner, now }), { now })).toThrow(FormatError);
    // Another owner's index at that address does not either.
    const other = person(r.location);
    expect(() => verifyIndex(serialize(publish(other, [], { now })), { expectedOwner: r.owner, location: r.location, now })).toThrow(
      expect.objectContaining({ code: 'OWNER_MISMATCH' }),
    );
  });

  it('a forged master key is refused: the index at the address is signed under another key', () => {
    const forged = relink(fragment, (x) => x.set(friend.id.master.publicKey, 2));
    const r = parseInvitationLink(forged, { now });
    expect(r.owner).toBe(friend.id.owner);
    expect(() => verifyIndex(serialize(index), { expectedOwner: r.owner, location: r.location, now })).toThrow(
      expect.objectContaining({ code: 'OWNER_MISMATCH' }),
    );
    const genuine = verifyIndex(serialize(index), { expectedOwner: owner.id.owner, location: LOCATION, now });
    expect(() => checkInvitationIndex(r, genuine, { now })).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
    // Even with the right owner listed elsewhere, a token computed for another master key does not match.
    const mallory = person(LOCATION);
    const mIdx = invite(mallory, { now }).index;
    const asMallory = relink(fragment, (x) => x.set(mallory.id.master.publicKey, 2));
    expect(() => read(asMallory, mIdx, now)).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
  });

  it('tampered link is rejected (expiry, rotation, seed, version, size)', () => {
    const b = bytesOf(fragment);
    const dv = (x: Uint8Array) => new DataView(x.buffer, x.byteOffset);
    // Shorter expiry, other rotation, other seed: the token no longer matches the listing.
    expect(() => read(relink(fragment, (x) => dv(x).setUint32(54, dv(b).getUint32(54) - 3600)))).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
    expect(() => read(relink(fragment, (x) => (x[34] = (x[34] as number) ^ 1)))).toThrow(expect.objectContaining({ code: 'NOT_LISTED' }));
    // A higher rotation than the index: refused as a rollback before the listing is looked at.
    expect(() => read(relink(fragment, (x) => dv(x).setUint32(50, 1)))).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
    // Longer than 7 days (+ 5 min) after the reader's clock: refused at parse (V3-04).
    expect(() => parseInvitationLink(relink(fragment, (x) => dv(x).setUint32(54, dv(b).getUint32(54) + 3600)), { now })).toThrow(FormatError);
    expect(() => parseInvitationLink(relink(fragment, (x) => (x[1] = 4)), { now })).toThrow(UnsupportedVersionError);
    expect(() => parseInvitationLink(relink(fragment, (x) => (x[0] = 0)), { now })).toThrow(FormatError);
    expect(() => parseInvitationLink(toB64Url(b.subarray(0, 58)), { now })).toThrow(FormatError); // no address
    expect(() => parseInvitationLink(toB64Url(b.subarray(0, 40)), { now })).toThrow(FormatError);
    expect(() => parseInvitationLink(relink(fragment, (x) => (x[60] = 0x5c)), { now })).toThrow(FormatError); // backslash in the address
    expect(() => parseInvitationLink('!!!', { now })).toThrow(FormatError);
    expect(() => parseInvitationLink('A'.repeat(2_000), { now })).toThrow(FormatError); // size bound before decoding (N-2)
  });

  it('the listing is padded: the index does not tell how many invitations are open (up to the bucket)', () => {
    const o = person(LOCATION);
    const invs = Array.from({ length: 5 }, () => createInvitation(o.signer, o.cert, { now }).invitation);
    expect(publish(o, [], { now, invitations: invs.slice(0, 1) }).invitations).toHaveLength(4);
    const i4 = publish(o, [], { now, invitations: invs.slice(0, 4) });
    const i3 = publish(o, [], { now, invitations: invs.slice(0, 3) });
    expect(i4.invitations).toHaveLength(4);
    expect(publish(o, [], { now, invitations: invs }).invitations).toHaveLength(8);
    // Dummies are stable between publications (same device, same bucket): one entry differs.
    expect(i3.invitations!.filter((t) => !i4.invitations!.includes(t))).toHaveLength(1);
    // The field declares minor 1, and is covered by the device signature.
    expect(i3.minor).toBe(1);
    const text = serialize(i3).replace(i3.invitations![0]!, i4.invitations!.find((t) => !i3.invitations!.includes(t))!);
    expect(() => verifyIndex(text)).toThrow();
  });
});

describe('index `invitations` field (minor 1)', () => {
  const resign = (index: SignedIndex, key: Uint8Array, edit: (b: Record<string, unknown>) => void): string => {
    const { signature: _s, ...body } = JSON.parse(serialize(index)) as Record<string, unknown>;
    edit(body);
    return serialize(signBody('index', body, key));
  };
  const tok = (c: string) => `b2b256:${c.repeat(43)}`;

  it('is validated: minor >= 1, non-empty, b2b256 tokens, sorted and unique, at most 256', () => {
    const p = person();
    const idx = publish(p, [], { now });
    const k = p.device.sign.secretKey;
    const ok = resign(idx, k, (b) => ((b['minor'] = 1), (b['invitations'] = [tok('A'), tok('Q')])));
    expect(verifyIndex(ok).invitations).toEqual([tok('A'), tok('Q')]);
    expect(() => verifyIndex(resign(idx, k, (b) => (b['invitations'] = [tok('A')])))).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    for (const bad of [[], [tok('Q'), tok('A')], [tok('A'), tok('A')], ['b2b256:short'], [42], Array.from({ length: 257 }, () => tok('A'))]) {
      expect(() => verifyIndex(resign(idx, k, (b) => ((b['minor'] = 1), (b['invitations'] = bad))))).toThrow(expect.objectContaining({ code: 'FORMAT' }));
    }
  });

  it('a revoked device cannot publish a listing readers accept', () => {
    const p = person(LOCATION);
    const tablet = generateDeviceKeys();
    const tabletSigner = { keys: tablet, cert: issueDeviceCert(p.id, devicePublicKeys(tablet)) };
    const cert1 = issueSharingCert(p.id, generateX25519KeyPair().publicKey, { rotation: 1, location: LOCATION, revokedDevices: [p.device.id] });
    const { invitation, fragment } = createInvitation(tabletSigner, cert1, { now });
    const honest = publish(p, [], { now, invitations: [invitation] }, tabletSigner, cert1);
    expect(() => accept(fragment, honest, now)).not.toThrow();
    // The phone (revoked by rotation 1) signs the same listing under the current certificate: REVOKED.
    const byPhone = resign(honest, p.device.sign.secretKey, (b) => (b['device_cert'] = { box: devicePublicKeys(p.device).box, device: p.device.id, signature: p.deviceCert.signature }));
    expect(() => verifyIndex(byPhone, { expectedOwner: p.id.owner, location: LOCATION, now })).toThrow(expect.objectContaining({ code: 'REVOKED' }));
    // Or under the old certificate (rotation 0): older than the link (ROLLBACK), and older than any anchor.
    const { signature: _s, ...body } = JSON.parse(serialize(publish(p, [], { now }))) as Record<string, unknown>;
    const old = verifyIndex(serialize(signBody('index', { ...body, minor: 1, invitations: honest.invitations }, p.device.sign.secretKey)), { expectedOwner: p.id.owner, location: LOCATION, now });
    expect(() => checkInvitationIndex(parseInvitationLink(fragment, { now }), old, { now })).toThrow(expect.objectContaining({ code: 'ROLLBACK' }));
  });
});

describe('return link', () => {
  const owner = person(LOCATION);
  const friend = person('https://friend.example/tl/');
  const { invitation, fragment, index } = invite(owner, { now });
  const received = accept(fragment, index, now);

  it('carries the sharing cert, and so the certified read address if any, compactly', () => {
    const resp = createInvitationResponse(received, friend.signer, friend.cert, { now: at(1000) });
    expect(resp[0]).toBe(0x52);
    const v = openInvitationResponse(resp, invitation, { now: at(2000) });
    expect(v.owner).toBe(friend.id.owner);
    expect(v.sharingPublicKey).toEqual(friend.sharing.publicKey);
    expect(v.cert).toEqual(friend.cert);
    expect(v.location).toBe('https://friend.example/tl/');
    const noStorage = issueSharingCert(friend.id, friend.sharing.publicKey, { rotation: 0 });
    const bare = createInvitationResponse(received, friend.signer, noStorage, { now: at(1000) });
    expect(bare.length).toBe(398);
    expect(toB64Url(bare).length).toBe(531);
    expect(openInvitationResponse(bare, invitation, { now }).location).toBeUndefined();
    expect(resp.length).toBe(398 + 'https://friend.example/tl/'.length);
  });

  it('is rejected after expiry + grace, for another invitation, or tampered', () => {
    const resp = createInvitationResponse(received, friend.signer, friend.cert, { now });
    expect(openInvitationResponse(resp, invitation, { now: at(7 * day) }).owner).toBe(friend.id.owner); // grace (V3-02)
    expect(() => openInvitationResponse(resp, invitation, { now: at(14 * day) })).toThrow(ExpiredError);
    expect(() => createInvitationResponse(received, friend.signer, friend.cert, { now: at(8 * day) })).toThrow(ExpiredError);
    const other = createInvitation(owner.signer, owner.cert, { now }).invitation;
    expect(() => openInvitationResponse(resp, other, { now })).toThrow(DecryptionError);
    const t = resp.slice();
    t[t.length - 3] = (t[t.length - 3] as number) ^ 1;
    expect(() => openInvitationResponse(t, invitation, { now })).toThrow(DecryptionError);
    const v2 = resp.slice();
    v2[1] = 3;
    expect(() => openInvitationResponse(v2, invitation, { now })).toThrow(UnsupportedVersionError);
    expect(() => openInvitationResponse(new Uint8Array(20_000), invitation, { now })).toThrow(FormatError);
  });

  it('is bound to the inviter and the invitation key (T-002 F-12)', () => {
    // A link holder replays the response into a self-made invitation with the same id and key.
    const mallory = person();
    const resp = createInvitationResponse(received, friend.signer, friend.cert, { now });
    const fake = { ...invitation, owner: mallory.id.owner };
    expect(() => openInvitationResponse(resp, fake, { now })).toThrow(SignatureError);
  });

  it('created must fall inside the invitation validity window', () => {
    // Created after expiry (as recorded by the owner): refused.
    const resp = createInvitationResponse(received, friend.signer, friend.cert, { now: at(day) });
    expect(openInvitationResponse(resp, invitation, { now: at(day) }).owner).toBe(friend.id.owner);
    expect(() => openInvitationResponse(resp, { ...invitation, expires: at(day - 1000).toISOString() }, { now: at(day) })).toThrow(FormatError);
    const early = createInvitationResponse(received, friend.signer, friend.cert, { now: at(-day) });
    expect(() => openInvitationResponse(early, invitation, { now })).toThrow(FormatError);
  });

  it('the invitee cannot present a sharing cert signed by someone else', () => {
    const mallory = person();
    const malloryCertForFriendKey = issueSharingCert(mallory.id, friend.sharing.publicKey, { rotation: 0 });
    expect(() => createInvitationResponse(received, friend.signer, malloryCertForFriendKey, { now })).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
  });
});

describe('one answer per invitation (T-002 F-02)', () => {
  const owner = person();
  const { invitation, fragment, index } = invite(owner, { now });
  const received = accept(fragment, index, now);

  it('a single responder is accepted (duplicates of the same person count once)', () => {
    const friend = person();
    const r1 = createInvitationResponse(received, friend.signer, friend.cert, { now });
    const r2 = createInvitationResponse(received, friend.signer, friend.cert, { now: at(1000) });
    const res = collectInvitationAnswers(invitation, [r1, r2, new Uint8Array([1, 2, 3])], { now });
    expect(res.answers).toHaveLength(1);
    expect(res.multiple).toBe(false);
    expect(res.rejected).toBe(1);
    expect(res.accepted?.owner).toBe(friend.id.owner);
  });

  it('several responders: all are returned, flagged, and none is accepted', () => {
    const [friend, interceptor] = [person(), person()];
    const answers = [interceptor, friend].map((p) => createInvitationResponse(received, p.signer, p.cert, { now }));
    const res = collectInvitationAnswers(invitation, answers, { now });
    expect(res.multiple).toBe(true);
    expect(res.accepted).toBeNull();
    expect(res.answers.map((a) => a.owner)).toEqual([interceptor.id.owner, friend.id.owner]);
  });

  it('answers are still collected for 7 days after expiry (V3-02), then nothing is opened', () => {
    const friend = person();
    const r = createInvitationResponse(received, friend.signer, friend.cert, { now });
    expect(collectInvitationAnswers(invitation, [r], { now: at(7 * day) }).accepted?.owner).toBe(friend.id.owner);
    expect(collectInvitationAnswers(invitation, [r], { now: at(14 * day - 1) }).accepted?.owner).toBe(friend.id.owner);
    expect(() => collectInvitationAnswers(invitation, [r], { now: at(14 * day) })).toThrow(ExpiredError);
  });
});

describe('retiring the invitation key (T-002 F-02)', () => {
  it('re-encrypts (not rewraps) every pack that carried the invitation wrap', () => {
    const owner = person();
    const friend = person();
    const { invitation, fragment } = createInvitation(owner.signer, owner.cert, { now });
    const friendsPack = sealPack(owner.id.owner, te.encode('{"places":["Le Comptoir"]}'), [owner.sharing.publicKey, invitation.keyPair.publicKey]);
    const privatePack = sealPack(owner.id.owner, te.encode('{"places":["home"]}'), [owner.sharing.publicKey]);
    const index = publish(owner, [friendsPack, privatePack], { now, invitations: [invitation] });

    // The invitee (and anyone who kept the link) reads the friends pack.
    const received = accept(fragment, index, at(1000));
    expect(openPack(friendsPack, index, [received.keyPair]).payload).toEqual(te.encode('{"places":["Le Comptoir"]}'));

    const res = collectInvitationAnswers(invitation, [createInvitationResponse(received, friend.signer, friend.cert, { now })], { now });
    const accepted = res.accepted!;
    expect(() => retireInvitationKey([friendsPack, privatePack], index, invitation.keyPair, () => [invitation.keyPair.publicKey])).toThrow(FormatError);
    expect(() => retireInvitationKey([friendsPack], index, invitation.keyPair, () => [owner.sharing.publicKey])).toThrow(FormatError); // V3-08
    const replaced = retireInvitationKey([friendsPack, privatePack], index, invitation.keyPair, () => [owner.sharing.publicKey, accepted.sharingPublicKey]);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]!.oldFile).toBe(packEntry(friendsPack).file);

    const newPack = replaced[0]!.bytes;
    const next = publish(owner, [newPack, privatePack]);
    const opened = openPack(newPack, next, [friend.sharing]);
    expect(opened.payload).toEqual(te.encode('{"places":["Le Comptoir"]}'));
    expect(opened.id).toBe(openPack(friendsPack, index, [owner.sharing]).id); // same logical id
    // New batch key and nonce: the kept link opens nothing new, and old wraps do not transplant.
    expect(() => openPack(newPack, next, [received.keyPair])).toThrow(expect.objectContaining({ code: 'NO_MATCHING_KEY' }));
    expect(readPackHeader(newPack).nonce).not.toBe(readPackHeader(friendsPack).nonce);
  });

  it('works at expiry too, without any answer', () => {
    const owner = person();
    const { invitation } = createInvitation(owner.signer, owner.cert, { now });
    const pack = sealPack(owner.id.owner, te.encode('x'), [owner.sharing.publicKey, invitation.keyPair.publicKey]);
    const index = publish(owner, [pack]);
    const [r] = retireInvitationKey([pack], index, invitation.keyPair, () => [owner.sharing.publicKey]);
    expect(() => openPack(r!.bytes, publish(owner, [r!.bytes]), [invitation.keyPair])).toThrow(DecryptionError);
    expect(() => retireInvitationKey([sealPack(owner.id.owner, te.encode('y'), [generateX25519KeyPair().publicKey])], index, invitation.keyPair, () => [])).toThrow(
      expect.objectContaining({ code: 'NOT_INDEXED' }),
    );
  });
});
