import { DEVICE_CERT_VERSION, SHARING_CERT_VERSION, verifyDeviceCert, verifySharingCert, type DeviceCert, type SharingCert } from './certs';
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
import { DecryptionError, ExpiredError, FormatError, RollbackError, SignatureError } from './errors';
import { isGroupKeyPayload } from './group';
import { generateX25519KeyPair, type KeyPair } from './identity';
import { findIndexed, openUnchecked, readPackHeader, sealPack, type PackIndex, type SealOptions } from './pack';
import type { DeviceSigner, SignedIndex } from './signed-index';
import { signBinary, verifyBinary } from './sign';
import { S } from './sodium';
import { isVerified } from './verified';

/*
 * Invitation flow (spec: "Invitation link and return link")
 * 1. Owner: createInvitation(device signer, current sharing cert) -> temporary X25519 key pair
 *    valid <= 7 days and a compact binary link (base64url in the URL fragment). The link is signed
 *    by the owner's DEVICE key and carries that device's master-signed certificate, so inviting
 *    does not need the master key (R-03). The owner wraps "friends" content directly to
 *    invitation.keyPair.publicKey (never as a group member: R-02).
 * 2. Invitee: parseInvitationLink() -> checks the device cert, the device signature and expiry, gets
 *    the key pair, reads the owner's index at `location` (verifyIndex with expectedOwner), then
 *    checkInvitationIndex(): same owner, rotation >= min_rotation, signing device not revoked.
 * 3. Invitee: createInvitationResponse(received, own device signer, own sharing cert) -> compact
 *    binary return link signed by the invitee's DEVICE key (with its device cert), carrying their
 *    sharing certificate, bound to the inviter and invitation key, sealed to the invitation key.
 * 4. Owner: collectInvitationAnswers() over EVERY answer received: exactly one responder =>
 *    `accepted`; several => none accepted. Keep the invitation record until EXPIRY, even after
 *    acceptance, and pass `acceptedOwner`: any other responder is returned in `late` (R-04).
 * 5. On acceptance or expiry: retireInvitationKey() RE-ENCRYPTS (new batch keys) every pack that
 *    carried the invitation wrap, so a kept copy of the link opens nothing new. It refuses a
 *    group-key pack (the link holder would keep the group secret: rotate the group instead).
 *
 * Link (version 3), big-endian:
 *   0    1   magic 0x49 ("I")
 *   1    1   version (= 3)
 *   2    16  invitation id
 *   18   32  owner master public key (Ed25519)
 *   50   4   created, unix seconds
 *   54   4   expires, unix seconds (expires - created in [60 s, 7 days])
 *   58   4   min_rotation: the owner's sharing-cert rotation when inviting (freshness anchor, R-12)
 *   62   32  device signing key (Ed25519)
 *   94   32  device box key (X25519)
 *   126  64  device-cert signature (owner master key, see certs.ts)
 *   190  32  invitation secret key (X25519)
 *   222  2   L = location length (0 = none, max 512)
 *   224  L   location: UTF-8 https:// read address (canonical form)
 *   224+L 64 Ed25519 signature by the DEVICE key, domain "invitation", over
 *            bytes[0..190) || invitation PUBLIC key || bytes[222..224+L)
 *
 * Response (version 3): 0x52 ("R") | version (= 3) | crypto_box_seal(inner, invitation public key)
 *   inner: invitation id 16 | responder master pk 32 | created u32 s | sharing pk 32 | rotation u32 |
 *          n revoked u16 | n x 32 revoked device keys | sharing-cert signature 64 |
 *          device pk 32 | device box pk 32 | device-cert signature 64 |
 *          L u16 | location L | signature 64
 *   signature: responder DEVICE key, domain "invitation-response", over
 *          inner[0..end-64) || inviter master pk || invitation public key
 *   The sharing and device certificates are rebuilt from their fields and their master
 *   signatures checked like any certificate; the device must not be revoked by that sharing cert.
 */

export const INVITATION_VERSION = 3;
export const INVITATION_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITATION_MIN_TTL_MS = 60 * 1000;
const LINK_MAGIC = 0x49;
const RESPONSE_MAGIC = 0x52;
const MAX_LOCATION = 512;
const CLOCK_SKEW_S = 5 * 60;

/** Kept privately by the owner until EXPIRY, also after acceptance (track it in the recovery vault). */
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
  /** Device that signed the link ("ed25519:…"), certified by `owner`. */
  device: string;
  /** Lowest acceptable sharing-cert rotation for the owner's index (freshness anchor). */
  minRotation: number;
  keyPair: KeyPair;
  created: string;
  expires: string;
  location?: string;
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.startsWith('[')) {
    const h = host.slice(1, -1);
    // Unspecified, loopback, link-local fe80::/10, unique-local fc00::/7, IPv4-mapped.
    return h === '::' || h === '::1' || /^fe[89ab]/.test(h) || /^f[cd]/.test(h) || h.startsWith('::ffff:');
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/**
 * Read address check: https only, canonical WHATWG form (`new URL(l).href === l`, so no backslash
 * or other parser-dependent spelling), no credentials, no fragment, at most 512 bytes, and no
 * local-network host (localhost, *.local, loopback / private / link-local IP literals): the app
 * fetches this address, which may come from an untrusted party (R-10).
 */
export function checkLocation(location: string, what = 'location'): void {
  const bad = () =>
    new FormatError(`${what}: must be a canonical https:// URL on a public host, without credentials or fragment (max ${MAX_LOCATION} bytes)`);
  if (typeof location !== 'string' || utf8(location).length > MAX_LOCATION || !location.startsWith('https://')) throw bad();
  if (/[\s\u0000-\u001f\u007f#\\]/.test(location)) throw bad();
  let u: URL;
  try {
    u = new URL(location);
  } catch {
    throw bad();
  }
  if (u.href !== location || u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.hostname === '') throw bad();
  if (isLocalHost(u.hostname)) throw bad();
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

/** Checks a device signer against the sharing cert it publishes with; returns the verified device cert. */
function checkSigner(signer: DeviceSigner, cert: SharingCert, what: string): DeviceCert {
  const dc = verifyDeviceCert(signer.cert, { expectedOwner: cert.owner });
  if (dc.device !== signer.keys.id) throw new FormatError(`${what}: device keys do not match the device certificate`);
  if (cert.revoked_devices.includes(dc.device)) throw new SignatureError(`${what}: the device is revoked`, 'REVOKED');
  if (cert.rotation > 0xffffffff) throw new FormatError(`${what}: rotation too large`);
  return dc;
}

/** Compact device cert: device pk 32 | box pk 32 | master signature 64. */
function deviceCertBytes(dc: DeviceCert): Uint8Array {
  return concat(parseKey('ed25519', dc.device), parseKey('x25519', dc.box), fromB64Url(dc.signature, 'device-cert.signature', 64));
}

function readDeviceCert(r: Reader, owner: string): DeviceCert {
  const device = formatKey('ed25519', r.bytes(32));
  const box = formatKey('x25519', r.bytes(32));
  const signature = toB64Url(r.bytes(64));
  return verifyDeviceCert({ type: 'device-cert', version: DEVICE_CERT_VERSION, owner, device, box, signature }, { expectedOwner: owner });
}

/**
 * Creates an invitation, signed by this DEVICE (no master key needed). `sharingCert` is the
 * owner's current sharing certificate: its rotation becomes the link's min_rotation.
 */
export function createInvitation(
  signer: DeviceSigner,
  sharingCert: SharingCert,
  opts: { now?: Date; ttlMs?: number; location?: string } = {},
): { invitation: OwnerInvitation; fragment: string } {
  const now = nowMs(opts.now, 'invitation');
  const ttl = opts.ttlMs ?? INVITATION_MAX_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < INVITATION_MIN_TTL_MS || ttl > INVITATION_MAX_TTL_MS) {
    throw new FormatError('invitation: ttlMs must be an integer between 60 000 ms and 7 days');
  }
  const v = verifySharingCert(sharingCert);
  const dc = checkSigner(signer, v.cert, 'invitation');
  const s = S();
  const keyPair = generateX25519KeyPair();
  const id = s.randombytes_buf(16);
  const created = Math.floor(now / 1000);
  const expires = created + Math.floor(ttl / 1000);
  const head = concat(
    Uint8Array.of(LINK_MAGIC, INVITATION_VERSION),
    id,
    v.ownerPublicKey,
    u32be(created),
    u32be(expires),
    u32be(v.cert.rotation),
    deviceCertBytes(dc),
  );
  const loc = encodeLocation(opts.location, 'invitation');
  const sig = signBinary('invitation', concat(head, keyPair.publicKey, loc), signer.keys.sign.secretKey);
  const fragment = toB64Url(concat(head, keyPair.secretKey, loc, sig));
  // Round-trip: never hand out a link that parseInvitationLink would reject.
  parseInvitationLink(fragment, { now: new Date(created * 1000) });
  return {
    invitation: { id: toB64Url(id), owner: v.cert.owner, keyPair, created: iso(created), expires: iso(expires) },
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
  const owner = formatKey('ed25519', ownerPublicKey);
  const created = r.u32();
  const expires = r.u32();
  const minRotation = r.u32();
  const dc = readDeviceCert(r, owner);
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
  verifyBinary('invitation', sig, concat(bytes.subarray(0, headEnd), publicKey, bytes.subarray(locStart, locEnd)), parseKey('ed25519', dc.device));
  const out: ReceivedInvitation = {
    id: toB64Url(id),
    owner,
    ownerPublicKey,
    device: dc.device,
    minRotation,
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
  /** Responder's device that signed the answer ("ed25519:…"), certified by `owner`. */
  device: string;
  sharingPublicKey: Uint8Array;
  /** Responder's sharing certificate (verified). */
  cert: SharingCert;
  created: string;
  /** Read address of the responder's own content, if they share. */
  location?: string;
}

/** Answers an invitation, signed by this DEVICE (no master key needed), with the invitee's current sharing cert. */
export function createInvitationResponse(
  invitation: ReceivedInvitation,
  signer: DeviceSigner,
  sharingCert: SharingCert,
  opts: { now?: Date; location?: string } = {},
): Uint8Array {
  const now = nowMs(opts.now, 'invitation-response');
  assertInvitationActive(invitation, new Date(now));
  const v = verifySharingCert(sharingCert);
  const dc = checkSigner(signer, v.cert, 'invitation-response');
  const revoked = v.cert.revoked_devices.map((d) => parseKey('ed25519', d));
  const body = concat(
    fromB64Url(invitation.id, 'invitation.id', 16),
    v.ownerPublicKey,
    u32be(Math.floor(now / 1000)),
    v.sharingPublicKey,
    u32be(v.cert.rotation),
    u16be(revoked.length),
    ...revoked,
    fromB64Url(v.cert.signature, 'sharing-cert.signature', 64),
    deviceCertBytes(dc),
    encodeLocation(opts.location, 'invitation-response'),
  );
  const sig = signBinary('invitation-response', concat(body, invitation.ownerPublicKey, invitation.keyPair.publicKey), signer.keys.sign.secretKey);
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
  const owner = formatKey('ed25519', ownerPublicKey);
  const created = r.u32();
  const sharingPublicKey = r.bytes(32).slice();
  const rotation = r.u32();
  const n = r.u16();
  if (n > 256) throw new FormatError(`${W}: too many revoked devices`);
  const revoked: string[] = [];
  for (let i = 0; i < n; i++) revoked.push(formatKey('ed25519', r.bytes(32)));
  const certSig = toB64Url(r.bytes(64));
  const dc = readDeviceCert(r, owner);
  const location = readLocation(r, W);
  const bodyEnd = r.offset;
  const sig = r.bytes(64);
  r.end();
  const inviterPk = parseKey('ed25519', invitation.owner, 'invitation.owner');
  verifyBinary('invitation-response', sig, concat(inner.subarray(0, bodyEnd), inviterPk, invitation.keyPair.publicKey), parseKey('ed25519', dc.device));
  const createdMs = created * 1000;
  if (createdMs < Date.parse(invitation.created) - CLOCK_SKEW_S * 1000 || createdMs >= Date.parse(invitation.expires)) {
    throw new FormatError(`${W}: created outside the invitation validity window`);
  }
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
  if (v.cert.revoked_devices.includes(dc.device)) throw new SignatureError(`${W}: signed by a revoked device`, 'REVOKED');
  const out: InvitationResponse = { owner, ownerPublicKey, device: dc.device, sharingPublicKey: v.sharingPublicKey, cert: v.cert, created: iso(created) };
  if (location !== undefined) out.location = location;
  return out;
}

/**
 * Checks the index read at an invitation's (or a return link's) `location` against it, after
 * verifyIndex: same owner, sharing-cert rotation not older than the link's min_rotation (or the
 * rotation of the certificate carried in the return link), and the device that signed the link
 * not revoked in that index. Then use that index as the first `lastSeen` for this owner.
 */
export function checkInvitationIndex(source: ReceivedInvitation | InvitationResponse, index: SignedIndex): void {
  const W = 'invitation';
  if (!isVerified(index)) throw new FormatError(`${W}: the index must come from verifyIndex or signIndex`);
  if (index.owner !== source.owner) throw new SignatureError(`${W}: index belongs to another owner`, 'OWNER_MISMATCH');
  const min = 'minRotation' in source ? source.minRotation : source.cert.rotation;
  if (index.sharing_cert.rotation < min) throw new RollbackError(`${W}: index is older than the invitation (rotation ${index.sharing_cert.rotation} < ${min})`);
  if (index.revoked_devices.includes(source.device)) throw new SignatureError(`${W}: signed by a device that is now revoked`, 'REVOKED');
}

export interface InvitationAnswers {
  /** Valid answers, one per responder (highest sharing-key rotation kept), in arrival order. */
  answers: InvitationResponse[];
  /** Number of answers that failed to open or verify (ignored). */
  rejected: number;
  /** True if more than one distinct responder answered: the link may have been intercepted. */
  multiple: boolean;
  /**
   * Without `acceptedOwner`: the single answer if exactly one responder answered, null otherwise
   * (never auto-accepted). With `acceptedOwner`: that person's answer (or null).
   */
  accepted: InvitationResponse | null;
  /**
   * With `acceptedOwner`: valid answers from anyone else. Non-empty => warn "a second person answered
   * this invitation; the first may have been an impostor", offer to revoke and compare the code.
   */
  late: InvitationResponse[];
}

/**
 * "One answer per invitation": pass EVERY answer received for this invitation (keep them; call
 * again when a new one arrives, until the invitation expires, also after acceptance). If several
 * distinct people answered, none is accepted: show them all with a warning and let the user choose
 * (and compare the safety code). After acceptance, pass `acceptedOwner` to get the others in `late`.
 */
export function collectInvitationAnswers(
  invitation: OwnerInvitation,
  responses: Uint8Array[],
  opts: { now?: Date; acceptedOwner?: string } = {},
): InvitationAnswers {
  const byOwner = new Map<string, InvitationResponse>();
  let rejected = 0;
  const openOpts = opts.now !== undefined ? { now: opts.now } : {};
  for (const bytes of responses) {
    let resp: InvitationResponse;
    try {
      resp = openInvitationResponse(bytes, invitation, openOpts);
    } catch (e) {
      if (e instanceof ExpiredError) throw e;
      rejected++;
      continue;
    }
    const prev = byOwner.get(resp.owner);
    if (!prev || resp.cert.rotation > prev.cert.rotation) byOwner.set(resp.owner, resp);
  }
  const answers = [...byOwner.values()];
  const multiple = answers.length > 1;
  if (opts.acceptedOwner !== undefined) {
    const acceptedOwner = opts.acceptedOwner;
    return { answers, rejected, multiple, accepted: byOwner.get(acceptedOwner) ?? null, late: answers.filter((a) => a.owner !== acceptedOwner) };
  }
  return { answers, rejected, multiple, accepted: answers.length === 1 ? (answers[0] as InvitationResponse) : null, late: [] };
}

/**
 * On acceptance or expiry of an invitation: RE-ENCRYPTS (new batch key and nonce, not a rewrap)
 * every pack of the verified own `index` that the invitation key can open, for the recipients
 * returned by `recipientsFor(logical pack id)` (which must not include the invitation key).
 * Packs the invitation key cannot open are left untouched. Returns the new files; publish them,
 * list them in a new index (packEntry) and delete the old files.
 * Throws FormatError if the invitation key received a group secret (group-key pack): re-encrypting
 * it would leave the same secret with the link holder. The invitation key must be a direct
 * recipient, never a group member; if it was, rotate the group (rotateGroup, sealGroupKey to the
 * remaining members, reencryptPack of every pack wrapped to the old group key) first.
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
      opened = openUnchecked(bytes, [invitationKeyPair], index.owner, entry.file);
    } catch (e) {
      if (e instanceof DecryptionError && e.code === 'NO_MATCHING_KEY') continue;
      throw e;
    }
    try {
      if (isGroupKeyPayload(opened.payload)) {
        throw new FormatError('retireInvitationKey: the invitation key received a group secret; rotate that group instead');
      }
      const recipients = recipientsFor(opened.id);
      if (recipients.some((pk) => bytesEqual(pk, invitationKeyPair.publicKey))) {
        throw new FormatError('retireInvitationKey: recipients still include the invitation key');
      }
      const sealOpts: SealOptions = { id: opened.id, pad: readPackHeader(bytes).pad };
      if (opts.padTo !== undefined) sealOpts.padTo = opts.padTo;
      out.push({ oldFile: entry.file, bytes: sealPack(index.owner, opened.payload, recipients, sealOpts) });
    } finally {
      S().memzero(opened.payload);
    }
  }
  return out;
}
