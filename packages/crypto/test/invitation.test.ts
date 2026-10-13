import { describe, expect, it } from 'vitest';
import {
  createInvitation,
  createInvitationResponse,
  DecryptionError,
  ExpiredError,
  FormatError,
  INVITATION_MAX_TTL_MS,
  isInvitationExpired,
  issueSharingCert,
  openInvitationResponse,
  openPack,
  parseInvitationLink,
  rewrapPack,
  sealPack,
  SignatureError,
  toB64Url,
  UnsupportedVersionError,
} from '../src/index';
import { person, td, te } from './helpers';

const now = new Date('2026-10-13T12:00:00.000Z');
const day = 24 * 3600 * 1000;
const at = (ms: number) => new Date(now.getTime() + ms);

function relink(fragment: string, f: (o: any) => void): string {
  const o = JSON.parse(td.decode(Buffer.from(fragment, 'base64url')));
  f(o);
  return toB64Url(te.encode(JSON.stringify(o)));
}

describe('invitations', () => {
  const owner = person();
  const friend = person();
  const { invitation, fragment } = createInvitation(owner.id, { now, location: 'https://example.org/alice/' });

  it('link fragment is base64url and valid 7 days', () => {
    expect(fragment).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Date.parse(invitation.expires) - now.getTime()).toBe(7 * day);
    const r = parseInvitationLink(`https://triangulair.app/invite#${fragment}`, { now: at(day) });
    expect(r.owner).toBe(owner.id.owner);
    expect(r.ownerPublicKey).toEqual(owner.id.master.publicKey);
    expect(r.keyPair.publicKey).toEqual(invitation.keyPair.publicKey);
    expect(r.location).toBe('https://example.org/alice/');
  });

  it('expiry: rejected at/after 7 days', () => {
    expect(isInvitationExpired(invitation, at(7 * day - 1))).toBe(false);
    expect(isInvitationExpired(invitation, at(7 * day))).toBe(true);
    expect(() => parseInvitationLink(fragment, { now: at(7 * day) })).toThrow(ExpiredError);
    expect(() => parseInvitationLink(fragment, { now: at(30 * day) })).toThrow(expect.objectContaining({ code: 'EXPIRED' }));
  });

  it('cannot create invitations longer than 7 days', () => {
    expect(() => createInvitation(owner.id, { ttlMs: INVITATION_MAX_TTL_MS + 1 })).toThrow(FormatError);
    expect(() => createInvitation(owner.id, { ttlMs: 0 })).toThrow(FormatError);
  });

  it('tampered link is rejected (expiry extension, owner swap, secret swap)', () => {
    const later = new Date(now.getTime() + 8 * day).toISOString();
    expect(() => parseInvitationLink(relink(fragment, (o) => (o.invitation.expires = later)), { now })).toThrow(FormatError); // > 7 days
    const sixDays = new Date(now.getTime() + 6 * day).toISOString();
    expect(() => parseInvitationLink(relink(fragment, (o) => (o.invitation.expires = sixDays)), { now })).toThrow(SignatureError);
    expect(() => parseInvitationLink(relink(fragment, (o) => (o.invitation.owner = friend.id.owner)), { now })).toThrow(SignatureError);
    expect(() => parseInvitationLink(relink(fragment, (o) => (o.secret = toB64Url(friend.sharing.secretKey))), { now })).toThrow(FormatError);
    expect(() => parseInvitationLink(relink(fragment, (o) => (o.version = 2)), { now })).toThrow(UnsupportedVersionError);
    expect(() => parseInvitationLink(relink(fragment, (o) => (o.invitation.version = 2)), { now })).toThrow(UnsupportedVersionError);
    expect(() => parseInvitationLink('!!!', { now })).toThrow(FormatError);
  });

  it('full flow: content visible immediately, then rewrapped to the real key on lien retour', () => {
    const content = te.encode('{"places":["Le Comptoir"]}');
    const pack = sealPack(content, [owner.sharing.publicKey, invitation.keyPair.publicKey]);

    // Invitee opens the link and sees content right away.
    const received = parseInvitationLink(fragment, { now: at(1000) });
    expect(openPack(pack, [received.keyPair]).payload).toEqual(content);

    // Invitee sends back their real sharing key, signed by their master key.
    const resp = createInvitationResponse(received, friend.id, friend.cert, { now: at(2000) });
    expect(td.decode(resp.subarray(0, 4))).toBe('TLIR');
    const verified = openInvitationResponse(resp, invitation, { now: at(3000) });
    expect(verified.owner).toBe(friend.id.owner);
    expect(verified.sharingPublicKey).toEqual(friend.sharing.publicKey);

    // Owner rewraps to the real key and drops the invitation wrap.
    const re = rewrapPack(pack, [owner.sharing], [owner.sharing.publicKey, verified.sharingPublicKey]);
    expect(openPack(re, [friend.sharing]).payload).toEqual(content);
    expect(() => openPack(re, [received.keyPair])).toThrow(expect.objectContaining({ code: 'NO_MATCHING_KEY' }));
  });

  it('response is rejected after expiry, for another invitation, or tampered', () => {
    const received = parseInvitationLink(fragment, { now });
    const resp = createInvitationResponse(received, friend.id, friend.cert, { now });
    expect(() => openInvitationResponse(resp, invitation, { now: at(7 * day) })).toThrow(ExpiredError);
    expect(() => createInvitationResponse(received, friend.id, friend.cert, { now: at(8 * day) })).toThrow(ExpiredError);

    const other = createInvitation(owner.id, { now }).invitation;
    expect(() => openInvitationResponse(resp, other, { now })).toThrow(DecryptionError);

    const t = resp.slice();
    t[t.length - 3] = (t[t.length - 3] as number) ^ 1;
    expect(() => openInvitationResponse(t, invitation, { now })).toThrow(DecryptionError);

    const v2 = resp.slice();
    v2[4] = 2;
    expect(() => openInvitationResponse(v2, invitation, { now })).toThrow(UnsupportedVersionError);
  });

  it('invitee cannot present a sharing cert signed by someone else', () => {
    const received = parseInvitationLink(fragment, { now });
    const mallory = person();
    const malloryCertForFriendKey = issueSharingCert(mallory.id, friend.sharing.publicKey, { rotation: 0 });
    expect(() => createInvitationResponse(received, friend.id, malloryCertForFriendKey, { now })).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
  });
});
