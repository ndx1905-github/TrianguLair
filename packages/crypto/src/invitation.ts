import { SHARING_CERT_VERSION, verifySharingCert, type SharingCert } from './certs';
import {
  bytesEqual,
  checkByteVersion,
  concat,
  formatKey,
  fromB64Url,
  fromUtf8,
  nowMs,
  parseKey,
  Reader,
  toB64Url,
  u16be,
  u32be,
  utf8,
} from './encoding';
import { DecryptionError, ExpiredError, FormatError } from './errors';
import { generateX25519KeyPair, type Identity, type KeyPair } from './identity';
import { findIndexed, openUnchecked, readPackHeader, sealPack, type PackIndex, type SealOptions } from './pack';
import { signBinary, verifyBinary } from './sign';
import { S } from './sodium';

/*
 * Invitation flow (spec: "Invitation link and return link")
 * 1. Owner: createInvitation() -> temporary X25519 key pair valid <= 7 days and a compact binary
 *    link (base64url in the URL fragment, about 270 chars with a typical read address).
 *    The owner immediately wraps "friends" content to invitation.keyPair.publicKey.
 * 2. Invitee: parseInvitationLink() -> checks the owner signature and expiry, gets the key pair,
 *    reads the owner's index at `location` (verifyIndex with expectedOwner) and opens content.
 * 3. Invitee: createInvitationResponse() -> compact binary return link signed by the invitee's
 *    master key, carrying their sharing certificate, bound to the inviter and invitation key,
 *    sealed (crypto_box_seal) to the invitation key.
 * 4. Owner: collectInvitationAnswers() over EVERY answer received: exactly one responder =>
 *    `accepted`; several => none accepted, all returned with `multiple: true` (the user chooses).
 *    Compare safetyCode() out of band before marking the contact verified.
 * 5. On acceptance or expiry: retireInvitationKey() RE-ENCRYPTS (new batch keys) every pack that
 *    carried the invitation wrap, so a kept copy of the link opens nothing new.
 *
 * Link (version 2), big-endian:
 *   0   1   magic 0x49 ("I")
 *   1   1   version (= 2)
 *   2   16  invitation id
 *   18  32  owner master public key (Ed25519)
 *   50  4   created, unix seconds
 *   54  4   expires, unix seconds (expires - created in [60 s, 7 days])
 *   58  32  invitation secret key (X25519)
 *   90  2   L = location length (0 = none, max 512)
 *   92  L   location: UTF-8 https:// read address
 *   92+L 64 Ed25519 signature by the owner master key, domain "invitation", over
 *           bytes[0..58) || invitation PUBLIC key || bytes[90..92+L)
 *
 * Response (version 2): 0x52 ("R") | version (= 2) | crypto_box_seal(inner, invitation public key)
 *   inner: invitation id 16 | responder master pk 32 | created u32 s | sharing pk 32 | rotation u32 |
 *          n revoked u16 | n x 32 revoked device keys | sharing-cert signature 64 |
 *          L u16 | location L | signature 64
 *   signature: responder master key, domain "invitation-response", over
 *          inner[0..end-64) || inviter master pk || invitation public key
 *   The sharing certificate is rebuilt from (owner, key, rotation, revoked) and its master
 *   signature checked like any sharing-cert.
 */

export const INVITATION_VERSION = 2;
export const INVITATION_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITATION_MIN_TTL_MS = 60 * 1000;
const LINK_MAGIC = 0x49;
const RESPONSE_MAGIC = 0x52;
const MAX_LOCATION = 512;
const CLOCK_SKEW_S = 5 * 60;

/** Kept privately by the owner (track it in the recovery vault so another device can retire it). */
export interface OwnerInvitation {
  id: string;
  owner: string;
  keyPair: KeyPair;
  created: string;
  expires: string;
}

/** What the invitee obtains from the link. */
export interface ReceivedInvitation {
  id: string;
  owner: string;
  ownerPublicKey: Uint8Array;
  keyPair: KeyPair;
  created: string;
  expires: string;
  location?: string;
}

/** Read address check: https only, no credentials, no fragment, at most 512 bytes. */
export function checkLocation(location: string, what = 'location'): void {
  const bad = () => new FormatError(`${what}: must be an https:// URL without credentials or fragment (max ${MAX_LOCATION} bytes)`);
  if (typeof location !== 'string' || utf8(location).length > MAX_LOCATION || !location.startsWith('https://')) throw bad();
  if (/[\s\u0000-\u001f\u007f#]/.test(location)) throw bad();
  let u: URL;
  try {
    u = new URL(location);
  } catch {
    throw bad();
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.hostname === '') throw bad();
}

function encodeLocation(location: string | undefined, what: string): Uint8Array {
  if (location === undefined) return u16be(0);
  checkLocation(location, what);
  const b = utf8(location);
  return concat(u16be(b.length), b);
}

function readLocation(r: Reader, what: string): string | undefined {
  const len = r.u16();
  if (len === 0) return undefined;
  if (len > MAX_LOCATION) throw new FormatError(`${what}: location too long`);
  const loc = fromUtf8(r.bytes(len), what);
  checkLocation(loc, what);
  return loc;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export function createInvitation(
  identity: Identity,
  opts: { now?: Date; ttlMs?: number; location?: string } = {},
): { invitation: OwnerInvitation; fragment: string } {
  const now = nowMs(opts.now, 'invitation');
  const ttl = opts.ttlMs ?? INVITATION_MAX_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < INVITATION_MIN_TTL_MS || ttl > INVITATION_MAX_TTL_MS) {
    throw new FormatError('invitation: ttlMs must be an integer between 60 000 ms and 7 days');
  }
  const s = S();
  const keyPair = generateX25519KeyPair();
  const id = s.randombytes_buf(16);
  const created = Math.floor(now / 1000);
  const expires = created + Math.floor(ttl / 1000);
  const head = concat(Uint8Array.of(LINK_MAGIC, INVITATION_VERSION), id, identity.master.publicKey, u32be(created), u32be(expires));
  const loc = encodeLocation(opts.location, 'invitation');
  const sig = signBinary('invitation', concat(head, keyPair.publicKey, loc), identity.master.secretKey);
  const fragment = toB64Url(concat(head, keyPair.secretKey, loc, sig));
  // Round-trip: never hand out a link that parseInvitationLink would reject.
  parseInvitationLink(fragment, { now: new Date(created * 1000) });
  return {
    invitation: { id: toB64Url(id), owner: identity.owner, keyPair, created: iso(created), expires: iso(expires) },
    fragment,
  };
}

export function isInvitationExpired(inv: { expires: string }, now?: Date): boolean {
  return nowMs(now, 'invitation') >= Date.parse(inv.expires);
}

export function assertInvitationActive(inv: { expires: string }, now?: Date): void {
  if (isInvitationExpired(inv, now)) throw new ExpiredError(`invitation expired at ${inv.expires}`);
}

/** Accepts the full link (anything after '#') or the bare fragment. Throws ExpiredError after expiry. */
export function parseInvitationLink(linkOrFragment: string, opts: { now?: Date } = {}): ReceivedInvitation {
  const W = 'invitation-link';
  if (typeof linkOrFragment !== 'string') throw new FormatError(`${W}: string expected`);
  const hash = linkOrFragment.indexOf('#');
  const fragment = hash >= 0 ? linkOrFragment.slice(hash + 1) : linkOrFragment;
  const bytes = fromB64Url(fragment, W);
  const r = new Reader(bytes, W);
  if (r.u8() !== LINK_MAGIC) throw new FormatError(`${W}: bad magic`);
  checkByteVersion(r.u8(), W, INVITATION_VERSION);
  const id = r.bytes(16);
  const ownerPublicKey = r.bytes(32).slice();
  const created = r.u32();
  const expires = r.u32();
  const headEnd = r.offset;
  const secretKey = r.bytes(32).slice();
  const locStart = r.offset;
  const location = readLocation(r, W);
  const locEnd = r.offset;
  const sig = r.bytes(64);
  r.end();
  if (expires - created < INVITATION_MIN_TTL_MS / 1000 || expires - created > INVITATION_MAX_TTL_MS / 1000 || expires <= created) {
    throw new FormatError(`${W}: validity must be between 60 s and 7 days`);
  }
  const publicKey = S().crypto_scalarmult_base(secretKey);
  verifyBinary('invitation', sig, concat(bytes.subarray(0, headEnd), publicKey, bytes.subarray(locStart, locEnd)), ownerPublicKey);
  const out: ReceivedInvitation = {
    id: toB64Url(id),
    owner: formatKey('ed25519', ownerPublicKey),
    ownerPublicKey,
    keyPair: { publicKey, secretKey },
    created: iso(created),
    expires: iso(expires),
  };
  if (location !== undefined) out.location = location;
  assertInvitationActive(out, opts.now);
  return out;
}

// ---------------------------------------------------------------------------
// Return link
// ---------------------------------------------------------------------------

export interface InvitationResponse {
  /** Responder owner id "ed25519:..." */
  owner: string;
  ownerPublicKey: Uint8Array;
  sharingPublicKey: Uint8Array;
  /** Responder's sharing certificate (verified). */
  cert: SharingCert;
  created: string;
  /** Read address of the responder's own content, if they share. */
  location?: string;
}

export function createInvitationResponse(
  invitation: ReceivedInvitation,
  invitee: Identity,
  sharingCert: SharingCert,
  opts: { now?: Date; location?: string } = {},
): Uint8Array {
  const now = nowMs(opts.now, 'invitation-response');
  assertInvitationActive(invitation, new Date(now));
  const v = verifySharingCert(sharingCert, { expectedOwner: invitee.owner });
  if (v.cert.rotation > 0xffffffff) throw new FormatError('invitation-response: rotation too large');
  const revoked = v.cert.revoked_devices.map((d) => parseKey('ed25519', d));
  const body = concat(
    fromB64Url(invitation.id, 'invitation.id', 16),
    invitee.master.publicKey,
    u32be(Math.floor(now / 1000)),
    v.sharingPublicKey,
    u32be(v.cert.rotation),
    u16be(revoked.length),
    ...revoked,
    fromB64Url(v.cert.signature, 'sharing-cert.signature', 64),
    encodeLocation(opts.location, 'invitation-response'),
  );
  const sig = signBinary('invitation-response', concat(body, invitation.ownerPublicKey, invitation.keyPair.publicKey), invitee.master.secretKey);
  const inner = concat(body, sig);
  return concat(Uint8Array.of(RESPONSE_MAGIC, INVITATION_VERSION), S().crypto_box_seal(inner, invitation.keyPair.publicKey));
}

/** Owner side, for ONE answer. Prefer collectInvitationAnswers, which enforces "one answer per invitation". */
export function openInvitationResponse(bytes: Uint8Array, invitation: OwnerInvitation, opts: { now?: Date } = {}): InvitationResponse {
  const W = 'invitation-response';
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) throw new FormatError(`${W}: too short`);
  if (bytes[0] !== RESPONSE_MAGIC) throw new FormatError(`${W}: bad magic`);
  checkByteVersion(bytes[1] as number, W, INVITATION_VERSION);
  assertInvitationActive(invitation, opts.now);
  let inner: Uint8Array;
  try {
    inner = S().crypto_box_seal_open(bytes.subarray(2), invitation.keyPair.publicKey, invitation.keyPair.secretKey);
  } catch {
    throw new DecryptionError(`${W}: cannot open (not for this invitation or tampered)`);
  }
  const r = new Reader(inner, W);
  const id = r.bytes(16);
  if (toB64Url(id) !== invitation.id) throw new FormatError(`${W}: answers another invitation`);
  const ownerPublicKey = r.bytes(32).slice();
  const created = r.u32();
  const sharingPublicKey = r.bytes(32).slice();
  const rotation = r.u32();
  const n = r.u16();
  if (n > 256) throw new FormatError(`${W}: too many revoked devices`);
  const revoked: string[] = [];
  for (let i = 0; i < n; i++) revoked.push(formatKey('ed25519', r.bytes(32)));
  const certSig = toB64Url(r.bytes(64));
  const location = readLocation(r, W);
  const bodyEnd = r.offset;
  const sig = r.bytes(64);
  r.end();
  const inviterPk = parseKey('ed25519', invitation.owner, 'invitation.owner');
  verifyBinary('invitation-response', sig, concat(inner.subarray(0, bodyEnd), inviterPk, invitation.keyPair.publicKey), ownerPublicKey);
  const createdMs = created * 1000;
  if (createdMs < Date.parse(invitation.created) - CLOCK_SKEW_S * 1000 || createdMs >= Date.parse(invitation.expires)) {
    throw new FormatError(`${W}: created outside the invitation validity window`);
  }
  const owner = formatKey('ed25519', ownerPublicKey);
  const v = verifySharingCert(
    {
      type: 'sharing-cert',
      version: SHARING_CERT_VERSION,
      owner,
      key: formatKey('x25519', sharingPublicKey),
      rotation,
      revoked_devices: revoked,
      signature: certSig,
    },
    { expectedOwner: owner },
  );
  const out: InvitationResponse = { owner, ownerPublicKey, sharingPublicKey: v.sharingPublicKey, cert: v.cert, created: iso(created) };
  if (location !== undefined) out.location = location;
  return out;
}

export interface InvitationAnswers {
  /** Valid answers, one per responder (highest sharing-key rotation kept), in arrival order. */
  answers: InvitationResponse[];
  /** Number of answers that failed to open or verify (ignored). */
  rejected: number;
  /** True if more than one distinct responder answered: the link may have been intercepted. */
  multiple: boolean;
  /** The single answer if exactly one responder answered; null otherwise (never auto-accepted). */
  accepted: InvitationResponse | null;
}

/**
 * "One answer per invitation": pass EVERY answer received for this invitation (keep them; call
 * again when a new one arrives). If several distinct people answered, none is accepted: show them
 * all with a warning and let the user choose (and compare the safety code).
 */
export function collectInvitationAnswers(invitation: OwnerInvitation, responses: Uint8Array[], opts: { now?: Date } = {}): InvitationAnswers {
  const byOwner = new Map<string, InvitationResponse>();
  let rejected = 0;
  for (const bytes of responses) {
    let resp: InvitationResponse;
    try {
      resp = openInvitationResponse(bytes, invitation, opts);
    } catch (e) {
      if (e instanceof ExpiredError) throw e;
      rejected++;
      continue;
    }
    const prev = byOwner.get(resp.owner);
    if (!prev || resp.cert.rotation > prev.cert.rotation) byOwner.set(resp.owner, resp);
  }
  const answers = [...byOwner.values()];
  return { answers, rejected, multiple: answers.length > 1, accepted: answers.length === 1 ? (answers[0] as InvitationResponse) : null };
}

/**
 * On acceptance or expiry of an invitation: RE-ENCRYPTS (new batch key and nonce, not a rewrap)
 * every pack of the verified own `index` that the invitation key can open, for the recipients
 * returned by `recipientsFor(logical pack id)` (which must not include the invitation key).
 * Packs the invitation key cannot open are left untouched. Returns the new files; publish them,
 * list them in a new index (packEntry) and delete the old files.
 */
export function retireInvitationKey(
  packs: Uint8Array[],
  index: PackIndex,
  invitationKeyPair: KeyPair,
  recipientsFor: (packId: string) => Uint8Array[],
  opts: Pick<SealOptions, 'padTo'> = {},
): { oldFile: string; bytes: Uint8Array }[] {
  const out: { oldFile: string; bytes: Uint8Array }[] = [];
  for (const bytes of packs) {
    const entry = findIndexed(bytes, index);
    let opened;
    try {
      opened = openUnchecked(bytes, [invitationKeyPair], entry.file);
    } catch (e) {
      if (e instanceof DecryptionError && e.code === 'NO_MATCHING_KEY') continue;
      throw e;
    }
    try {
      const recipients = recipientsFor(opened.id);
      if (recipients.some((pk) => bytesEqual(pk, invitationKeyPair.publicKey))) {
        throw new FormatError('retireInvitationKey: recipients still include the invitation key');
      }
      const sealOpts: SealOptions = { id: opened.id, pad: readPackHeader(bytes).pad };
      if (opts.padTo !== undefined) sealOpts.padTo = opts.padTo;
      out.push({ oldFile: entry.file, bytes: sealPack(opened.payload, recipients, sealOpts) });
    } finally {
      S().memzero(opened.payload);
    }
  }
  return out;
}
