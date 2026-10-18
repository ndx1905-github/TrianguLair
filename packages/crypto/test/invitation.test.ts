import { describe, expect, it } from 'vitest';
import {
  collectInvitationAnswers,
  createInvitation,
  createInvitationResponse,
  DecryptionError,
  ExpiredError,
  FormatError,
  generateX25519KeyPair,
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
  SignatureError,
  toB64Url,
  UnsupportedVersionError,
} from '../src/index';
import { person, publish, te } from './helpers';

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

describe('invitation link (compact binary)', () => {
  const owner = person();
  const friend = person();
  const { invitation, fragment } = createInvitation(owner.signer, owner.cert, { now, location: LOCATION });

  it('is base64url, valid 7 days, and parses back', () => {
    expect(fragment).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Date.parse(invitation.expires) - now.getTime()).toBe(7 * day);
    const r = parseInvitationLink(`${PREFIX}${fragment}`, { now: at(day) });
    expect(r.owner).toBe(owner.id.owner);
    expect(r.id).toBe(invitation.id);
    expect(r.ownerPublicKey).toEqual(owner.id.master.publicKey);
    expect(r.keyPair.publicKey).toEqual(invitation.keyPair.publicKey);
    expect(r.location).toBe(LOCATION);
    expect(r.created).toBe(now.toISOString());
  });

  it('is about 450 characters with the link prefix (device-signed, R-03)', () => {
    const bytes = bytesOf(fragment);
    expect(bytes.length).toBe(288 + LOCATION.length);
    expect(fragment.length).toBeLessThanOrEqual(440);
    expect(`${PREFIX}${fragment}`.length).toBeLessThanOrEqual(470);
    const bare = createInvitation(owner.signer, owner.cert, { now }).fragment;
    expect(bare.length).toBe(384); // 288 bytes, no location
    const long = createInvitation(owner.signer, owner.cert, { now, location: `https://nextcloud.example-hosting.org/index.php/s/${'x'.repeat(20)}` }).fragment;
    expect(`${PREFIX}${long}`.length).toBeLessThan(510);
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

  it('location must be an https URL without credentials or fragment (T-002 F-12)', () => {
    for (const location of ['http://example.org/', 'https://user:pw@example.org/', 'https://example.org/#x', 'javascript:alert(1)', `https://e.org/${'a'.repeat(600)}`]) {
      expect(() => createInvitation(owner.signer, owner.cert, { location })).toThrow(FormatError);
    }
  });

  it('tampered link is rejected (expiry extension, owner swap, secret swap, location change)', () => {
    const b = bytesOf(fragment);
    const dv = (x: Uint8Array) => new DataView(x.buffer, x.byteOffset);
    expect(() => parseInvitationLink(relink(fragment, (x) => dv(x).setUint32(54, dv(b).getUint32(54) - 3600)), { now })).toThrow(SignatureError);
    expect(() => parseInvitationLink(relink(fragment, (x) => dv(x).setUint32(54, dv(b).getUint32(50) + 8 * 86400)), { now })).toThrow(FormatError);
    expect(() => parseInvitationLink(relink(fragment, (x) => x.set(friend.id.master.publicKey, 18)), { now })).toThrow(SignatureError);
    expect(() => parseInvitationLink(relink(fragment, (x) => x.set(friend.sharing.secretKey, 190)), { now })).toThrow(SignatureError);
    expect(() => parseInvitationLink(relink(fragment, (x) => (x[260] = 0x41)), { now })).toThrow(SignatureError);
    expect(() => parseInvitationLink(relink(fragment, (x) => (x[60] = (x[60] as number) ^ 1)), { now })).toThrow(SignatureError); // min_rotation
    expect(() => parseInvitationLink(relink(fragment, (x) => x.set(friend.device.sign.publicKey, 62)), { now })).toThrow(SignatureError); // device cert
    expect(() => parseInvitationLink(relink(fragment, (x) => (x[1] = 2)), { now })).toThrow(UnsupportedVersionError);
    expect(() => parseInvitationLink(relink(fragment, (x) => (x[0] = 0)), { now })).toThrow(FormatError);
    expect(() => parseInvitationLink(toB64Url(b.subarray(0, b.length - 1)), { now })).toThrow(FormatError);
    expect(() => parseInvitationLink('!!!', { now })).toThrow(FormatError);
  });
});

describe('return link', () => {
  const owner = person();
  const friend = person();
  const { invitation, fragment } = createInvitation(owner.signer, owner.cert, { now, location: LOCATION });
  const received = parseInvitationLink(fragment, { now });

  it('carries the sharing cert and an optional location, compactly', () => {
    const resp = createInvitationResponse(received, friend.signer, friend.cert, { now: at(1000), location: 'https://friend.example/tl/' });
    expect(resp[0]).toBe(0x52);
    const v = openInvitationResponse(resp, invitation, { now: at(2000) });
    expect(v.owner).toBe(friend.id.owner);
    expect(v.sharingPublicKey).toEqual(friend.sharing.publicKey);
    expect(v.cert).toEqual(friend.cert);
    expect(v.location).toBe('https://friend.example/tl/');
    const bare = createInvitationResponse(received, friend.signer, friend.cert, { now: at(1000) });
    expect(bare.length).toBe(398);
    expect(toB64Url(bare).length).toBe(531);
    expect(openInvitationResponse(bare, invitation, { now }).location).toBeUndefined();
  });

  it('is rejected after expiry, for another invitation, or tampered', () => {
    const resp = createInvitationResponse(received, friend.signer, friend.cert, { now });
    expect(() => openInvitationResponse(resp, invitation, { now: at(7 * day) })).toThrow(ExpiredError);
    expect(() => createInvitationResponse(received, friend.signer, friend.cert, { now: at(8 * day) })).toThrow(ExpiredError);
    const other = createInvitation(owner.signer, owner.cert, { now }).invitation;
    expect(() => openInvitationResponse(resp, other, { now })).toThrow(DecryptionError);
    const t = resp.slice();
    t[t.length - 3] = (t[t.length - 3] as number) ^ 1;
    expect(() => openInvitationResponse(t, invitation, { now })).toThrow(DecryptionError);
    const v2 = resp.slice();
    v2[1] = 2;
    expect(() => openInvitationResponse(v2, invitation, { now })).toThrow(UnsupportedVersionError);
  });

  it('is bound to the inviter and the invitation key (T-002 F-12)', () => {
    // A link holder replays the response into a self-made invitation with the same id and key.
    const mallory = person();
    const resp = createInvitationResponse(received, friend.signer, friend.cert, { now });
    const fake = { ...invitation, owner: mallory.id.owner };
    expect(() => openInvitationResponse(resp, fake, { now })).toThrow(SignatureError);
  });

  it('created must fall inside the invitation validity window', () => {
    const resp = createInvitationResponse({ ...received, created: now.toISOString(), expires: at(30 * day).toISOString() }, friend.signer, friend.cert, { now: at(8 * day) });
    expect(() => openInvitationResponse(resp, invitation, { now: at(day) })).toThrow(FormatError);
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
  const { invitation, fragment } = createInvitation(owner.signer, owner.cert, { now, location: LOCATION });
  const received = parseInvitationLink(fragment, { now });

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

  it('expired invitations accept nothing', () => {
    const friend = person();
    const r = createInvitationResponse(received, friend.signer, friend.cert, { now });
    expect(() => collectInvitationAnswers(invitation, [r], { now: at(7 * day) })).toThrow(ExpiredError);
  });
});

describe('retiring the invitation key (T-002 F-02)', () => {
  it('re-encrypts (not rewraps) every pack that carried the invitation wrap', () => {
    const owner = person();
    const friend = person();
    const { invitation, fragment } = createInvitation(owner.signer, owner.cert, { now, location: LOCATION });
    const friendsPack = sealPack(owner.id.owner, te.encode('{"places":["Le Comptoir"]}'), [owner.sharing.publicKey, invitation.keyPair.publicKey]);
    const privatePack = sealPack(owner.id.owner, te.encode('{"places":["home"]}'), [owner.sharing.publicKey]);
    const index = publish(owner, [friendsPack, privatePack]);

    // The invitee (and anyone who kept the link) reads the friends pack.
    const received = parseInvitationLink(fragment, { now: at(1000) });
    expect(openPack(friendsPack, index, [received.keyPair]).payload).toEqual(te.encode('{"places":["Le Comptoir"]}'));

    const res = collectInvitationAnswers(invitation, [createInvitationResponse(received, friend.signer, friend.cert, { now })], { now });
    const accepted = res.accepted!;
    expect(() => retireInvitationKey([friendsPack], index, invitation.keyPair, () => [invitation.keyPair.publicKey])).toThrow(FormatError);
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
