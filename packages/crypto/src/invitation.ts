import {
  checkSharingCertNotOlder,
  DEVICE_CERT_VERSION,
  SHARING_CERT_VERSION,
  verifyDeviceCert,
  verifySharingCert,
  type DeviceCert,
  type SharingCert,
} from './certs';
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
import type { KeyPair } from './identity';
import { deriveInvitation, INVITATION_MAX_TTL_MS, INVITATION_SEED_BYTES, invitationToken, signInvitationRecord } from './invitation-listing';
import { checkLocation, MAX_LOCATION } from './location';
import { findIndexed, openUnchecked, readPackHeader, sealTyped, type PackIndex, type SealOptions } from './pack';
import { checkNoRollback, sharingCertOf, type DeviceSigner, type IndexAnchor, type SignedIndex } from './signed-index';
import { signBinary, verifyBinary } from './sign';
import { S } from './sodium';
import { verifiedInfo } from './verified';

export { checkLocation } from './location';
export { INVITATION_MAX_TTL_MS } from './invitation-listing';

/*
 * Invitation flow (spec: "Invitation link and return link")
 * 1. Owner: createInvitation(device signer, current sharing cert) -> OwnerInvitation (temporary
 *    X25519 key pair derived from a 16-byte seed, valid <= 7 days, signed by the creating device
 *    with its device certificate: V4-01) and a SHORT link (about 150 characters with the URL
 *    prefix). The link is not signed: it carries only what cannot be fetched
 *    (owner master key, read address, seed, rotation, expiry). The owner then publishes an index
 *    listing the invitation (signIndex({ invitations })) BEFORE sending the link: the listing, in
 *    an index signed by a device that the current master-signed certificate does not revoke and
 *    read at the master-certified address, replaces the device signature of format 4. The owner
 *    wraps "friends" content directly to invitation.keyPair.publicKey (never as a group member: R-02).
 * 2. Invitee: parseInvitationLink() -> the seed gives the key pair; nothing is trusted yet. Read
 *    the owner's index at received.location ONLY (verifyIndex with expectedOwner and location;
 *    follow StorageMovedError), then checkInvitationIndex(): same owner, read at its certified
 *    address, rotation = the link's (an older index is ROLLBACK; a later rotation cancelled the
 *    invitation, R5-01), the invitation is LISTED, not expired. Only then show the
 *    invitation as the owner's, and only then createInvitationResponse() accepts it.
 * 3. Invitee: createInvitationResponse(confirmed invitation, own device signer, own sharing cert)
 *    -> compact binary return link signed by the invitee's DEVICE key (with its device cert),
 *    carrying their sharing certificate (and so their certified read address), bound to the
 *    inviter and the invitation key, sealed to the invitation key. (Unchanged from format 4.)
 * 4. Owner: collectInvitationAnswers() over EVERY answer received: exactly one responder =>
 *    `accepted`; several => none accepted. Keep the invitation record (and its listing) until
 *    expiry; keep the record until expiry + 7 days (INVITATION_ANSWER_GRACE_MS), even after
 *    acceptance, and pass `acceptedOwner`: any other responder is returned in `late` (R-04).
 *    Answers created before expiry are still opened during the grace period (V3-02), flagged
 *    `openedAfterExpiry` (V4-06: never grant such an answer silently). Then
 *    checkInvitationIndex(answer, responder's index).
 * 5. On acceptance or expiry: retireInvitationKey() RE-ENCRYPTS (new batch keys) every pack that
 *    carried the invitation wrap, so a kept copy of the link opens nothing new. It refuses a
 *    group-key pack (the link holder would keep the group secret: rotate the group instead).
 *
 * Link (version 5), base64url in the URL fragment, big-endian:
 *   0    1   magic 0x49 ("I")
 *   1    1   version (= 5)
 *   2    32  owner master public key (Ed25519)
 *   34   16  seed (invitation key pair and id derive from it, invitation-listing.ts)
 *   50   4   rotation of the owner's sharing certificate when inviting (freshness floor)
 *   54   4   expires, unix seconds (at most 7 days + 5 min after the reader's clock)
 *   58   ..  read address without its "https://" prefix (UTF-8, 1..504 bytes; checkLocation)
 * The token listed in the index binds every field, the address included (invitation-listing.ts).
 * 58 + (address length - 8) bytes: 142 characters with "https://example.org/i#" and a 40-character
 * address, 200 characters with an 80-character address. No certificate, no revocation list.
 *
 * Compact sharing certificate (in return links), big-endian:
 *   key 32 | rotation u32 | n u16 | n x 32 revoked device keys (sorted) | L u16 | location L | master signature 64
 *   (L = 0: no location.) Rebuilt as a version-3 sharing certificate and verified like any other;
 *   a certificate with extension fields (minor, crit, ...) cannot travel in a return link.
 * Compact device certificate: device pk 32 | box pk 32 | master signature 64.
 *
 * Response (version 4): 0x52 ("R") | version (= 4) | crypto_box_seal(inner, invitation public key)
 *   inner: invitation id 16 | responder master pk 32 | created u32 s | compact sharing cert |
 *          compact device cert 128 | signature 64
 *   signature: responder DEVICE key, domain "invitation-response", over
 *          inner[0..end-64) || inviter master pk || invitation public key
 *   The signing device must not be revoked by the carried sharing certificate.
 */

/** Version of the invitation LINK (5: short, unsigned, bound by the index listing). */
export const INVITATION_VERSION = 5;
/** Version of the return link (unchanged by the short link). */
export const INVITATION_RESPONSE_VERSION = 4;
export const INVITATION_MIN_TTL_MS = 60 * 1000;
/** Answers created before expiry are still opened for this long after it (V3-02). */
export const INVITATION_ANSWER_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const LINK_MAGIC = 0x49;
const RESPONSE_MAGIC = 0x52;
const CLOCK_SKEW_S = 5 * 60;
const MAX_REVOKED = 256;
const HTTPS = 'https://';
/** Size bounds checked before any decoding (N-2): a fragment of 58 + 504 bytes is 750 characters (N-5). */
const MAX_LINK_CHARS = 750;
const MAX_RESPONSE_BYTES = 9_600;

/**
 * Kept privately by the owner until expiry + INVITATION_ANSWER_GRACE_MS, also after acceptance
 * (track it in the recovery vault: invitationRecord / invitationFromRecord), and passed to
 * signIndex({ invitations }) so that every index published until expiry lists it.
 */
export interface OwnerInvitation {
  id: string;
  owner: string;
  /** The link's secret (16 bytes): keyPair and id derive from it. */
  seed: Uint8Array;
  keyPair: KeyPair;
  /** Rotation of the owner's sharing certificate when inviting (in the link and the token). */
  rotation: number;
  /** Device that created it ("ed25519:…"): the listing is dropped once that device is revoked. */
  device: string;
  /** Master-signed certificate of that device (V4-01). */
  deviceCert: DeviceCert;
  /** Read address written in the link (the certified one when inviting); bound in the token (V4-04). */
  location: string;
  created: string;
  expires: string;
  /** The creating device's signature over the invitation (domain "invitation-record", V4-01). */
  signature: string;
}

/** What the invitee obtains from the link: UNVERIFIED until checkInvitationIndex accepts it. */
export interface ReceivedInvitation {
  id: string;
  owner: string;
  ownerPublicKey: Uint8Array;
  /** Read address given by the link: read the owner's index there ONLY (and follow MOVED). */
  location: string;
  /** Freshness floor: the owner's index must have at least this sharing-cert rotation. */
  rotation: number;
  keyPair: KeyPair;
  expires: string;
  /** Token the owner's index must list. */
  token: string;
}

/** Received invitations accepted by checkInvitationIndex (createInvitationResponse requires one). */
const confirmed = new WeakSet<object>();

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** Epoch ms of a date read back from an invitation record; fails closed on a malformed value (V3-07). */
function recordTime(value: unknown, what: string): number {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) throw new FormatError(`${what}: invalid date in the invitation record`);
  return t;
}

/** Checks a device signer against the sharing cert it publishes with; returns the verified device cert. */
function checkSigner(signer: DeviceSigner, cert: SharingCert, what: string): DeviceCert {
  const dc = verifyDeviceCert(signer.cert, { expectedOwner: cert.owner });
  if (dc.device !== signer.keys.id) throw new FormatError(`${what}: device keys do not match the device certificate`);
  if (cert.revoked_devices.includes(dc.device)) throw new SignatureError(`${what}: the device is revoked`, 'REVOKED');
  return dc;
}

const CERT_FIELDS = new Set(['type', 'version', 'owner', 'key', 'location', 'rotation', 'revoked_devices', 'signature']);

function sharingCertBytes(cert: SharingCert, what: string): Uint8Array {
  if (Object.keys(cert).some((k) => !CERT_FIELDS.has(k))) throw new FormatError(`${what}: a certificate with extension fields cannot travel in a link`);
  const loc = cert.location === undefined ? new Uint8Array(0) : utf8(cert.location);
  return concat(
    parseKey('x25519', cert.key),
    u32be(cert.rotation),
    u16be(cert.revoked_devices.length),
    ...cert.revoked_devices.map((d) => parseKey('ed25519', d)),
    u16be(loc.length),
    loc,
    fromB64Url(cert.signature, 'sharing-cert.signature', 64),
  );
}

function readSharingCert(r: Reader, owner: string, what: string): SharingCert {
  const key = formatKey('x25519', r.bytes(32));
  const rotation = r.u32();
  const n = r.u16();
  if (n > MAX_REVOKED) throw new FormatError(`${what}: too many revoked devices`);
  const revoked: string[] = [];
  for (let i = 0; i < n; i++) revoked.push(formatKey('ed25519', r.bytes(32)));
  const len = r.u16();
  if (len > MAX_LOCATION) throw new FormatError(`${what}: location too long`);
  const location = len === 0 ? undefined : fromUtf8(r.bytes(len), what);
  if (location !== undefined) checkLocation(location, what);
  const signature = toB64Url(r.bytes(64));
  const doc: Record<string, unknown> = { type: 'sharing-cert', version: SHARING_CERT_VERSION, owner, key, rotation, revoked_devices: revoked, signature };
  if (location !== undefined) doc['location'] = location;
  return verifySharingCert(doc, { expectedOwner: owner }).cert;
}

function deviceCertBytes(dc: DeviceCert): Uint8Array {
  return concat(parseKey('ed25519', dc.device), parseKey('x25519', dc.box), fromB64Url(dc.signature, 'device-cert.signature', 64));
}

function readDeviceCert(r: Reader, owner: string): DeviceCert {
  const device = formatKey('ed25519', r.bytes(32));
  const box = formatKey('x25519', r.bytes(32));
  const signature = toB64Url(r.bytes(64));
  return verifyDeviceCert({ type: 'device-cert', version: DEVICE_CERT_VERSION, owner, device, box, signature }, { expectedOwner: owner });
}

/** Link fragment of an invitation (its read address is the certified one when inviting). */
function linkFragment(inv: OwnerInvitation, ownerPublicKey: Uint8Array): string {
  const location = inv.location;
  checkLocation(location, 'invitation');
  return toB64Url(
    concat(
      Uint8Array.of(LINK_MAGIC, INVITATION_VERSION),
      ownerPublicKey,
      inv.seed,
      u32be(inv.rotation),
      u32be(Math.floor(Date.parse(inv.expires) / 1000)),
      utf8(location.slice(HTTPS.length)),
    ),
  );
}

/**
 * Creates an invitation (no master key needed). `sharingCert` is the owner's current sharing
 * certificate: it must carry the read address (an owner without storage cannot invite: the link
 * points to the index that vouches for it) and must not revoke `signer`, the device that creates
 * and signs the invitation (the signature and its device certificate go into the vault record, so
 * that any device can check who created it before listing it: V4-01). Publish an index with
 * signIndex({ invitations: [..., invitation], vaultDataKey }) BEFORE sending the link: until then
 * the invitee refuses it. Returns the link fragment (put it after "https://example.org/i#").
 */
export function createInvitation(
  signer: DeviceSigner,
  sharingCert: SharingCert,
  opts: { now?: Date; ttlMs?: number } = {},
): { invitation: OwnerInvitation; fragment: string } {
  const now = nowMs(opts.now, 'invitation');
  const ttl = opts.ttlMs ?? INVITATION_MAX_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < INVITATION_MIN_TTL_MS || ttl > INVITATION_MAX_TTL_MS) {
    throw new FormatError('invitation: ttlMs must be an integer between 60 000 ms and 7 days');
  }
  const v = verifySharingCert(sharingCert);
  if (v.cert.location === undefined) throw new FormatError('invitation: the sharing certificate has no read address (connect a storage first)');
  const dc = checkSigner(signer, v.cert, 'invitation');
  const seed = S().randombytes_buf(INVITATION_SEED_BYTES);
  const { id, keyPair } = deriveInvitation(seed);
  const created = Math.floor(now / 1000);
  const expires = created + Math.floor(ttl / 1000);
  const invitation: OwnerInvitation = {
    id,
    owner: v.cert.owner,
    seed,
    keyPair,
    rotation: v.cert.rotation,
    device: dc.device,
    deviceCert: dc,
    location: v.cert.location,
    created: iso(created),
    expires: iso(expires),
    signature: '',
  };
  invitation.signature = signInvitationRecord(invitation, signer.keys.sign.secretKey);
  const fragment = linkFragment(invitation, v.ownerPublicKey);
  // Round-trip: never hand out a link that parseInvitationLink would reject.
  parseInvitationLink(fragment, { now: new Date(created * 1000) });
  return { invitation, fragment };
}

/** True at or after `expires`, and for a malformed `expires` (fails closed, V3-07). */
export function isInvitationExpired(inv: { expires: string }, now?: Date): boolean {
  const t = typeof inv.expires === 'string' ? Date.parse(inv.expires) : NaN;
  return !Number.isFinite(t) || nowMs(now, 'invitation') >= t;
}

export function assertInvitationActive(inv: { expires: string }, now?: Date): void {
  if (isInvitationExpired(inv, now)) throw new ExpiredError(`invitation expired at ${String(inv.expires)}`);
}

/**
 * Accepts the full link (anything after '#') or the bare fragment. Throws ExpiredError after expiry,
 * and FormatError for an expiry more than 7 days + 5 minutes after the reader's clock (V3-04).
 * The result is NOT authenticated: anyone can write a link naming any master key. Nothing may be
 * shown as coming from `owner` before checkInvitationIndex accepts the owner's index for it.
 */
export function parseInvitationLink(linkOrFragment: string, opts: { now?: Date } = {}): ReceivedInvitation {
  const W = 'invitation-link';
  if (typeof linkOrFragment !== 'string') throw new FormatError(`${W}: string expected`);
  const hash = linkOrFragment.indexOf('#');
  const fragment = hash >= 0 ? linkOrFragment.slice(hash + 1) : linkOrFragment;
  if (fragment.length > MAX_LINK_CHARS) throw new FormatError(`${W}: too long`);
  const now = nowMs(opts.now, W);
  const bytes = fromB64Url(fragment, W);
  const r = new Reader(bytes, W);
  if (r.u8() !== LINK_MAGIC) throw new FormatError(`${W}: bad magic`);
  checkByteVersion(r.u8(), W, INVITATION_VERSION);
  const ownerPublicKey = r.bytes(32).slice();
  const owner = formatKey('ed25519', ownerPublicKey);
  const seed = r.bytes(INVITATION_SEED_BYTES).slice();
  const rotation = r.u32();
  const expires = r.u32();
  const rest = bytes.length - r.offset;
  if (rest < 1 || rest > MAX_LOCATION - HTTPS.length) throw new FormatError(`${W}: bad read address length`);
  const location = HTTPS + fromUtf8(r.bytes(rest), W);
  r.end();
  checkLocation(location, W);
  if (expires * 1000 > now + INVITATION_MAX_TTL_MS + CLOCK_SKEW_S * 1000) throw new FormatError(`${W}: expires too far in the future`);
  const { id, keyPair } = deriveInvitation(seed);
  S().memzero(seed);
  const out: ReceivedInvitation = {
    id,
    owner,
    ownerPublicKey,
    location,
    rotation,
    keyPair,
    expires: iso(expires),
    token: invitationToken(ownerPublicKey, keyPair.publicKey, rotation, expires, location),
  };
  assertInvitationActive(out, new Date(now));
  Object.freeze(out.keyPair);
  return Object.freeze(out);
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
  /**
   * True if the answer was opened at or after the invitation's expiry (during the grace period,
   * V4-06). Its signed `created` is claimed by the responder, so anyone who kept the link can
   * produce such an answer: do not grant it silently, even when it is the only one; ask the user
   * and suggest comparing the safety code.
   */
  openedAfterExpiry: boolean;
  /**
   * Master-certified read address of the responder (= cert.location), if they publish. Without it,
   * checkInvitationIndex cannot check that the signing device is not revoked (see THREATS.md).
   */
  location?: string;
}

/**
 * Answers an invitation, signed by this DEVICE (no master key needed), with the invitee's current
 * sharing cert (its location, if any, is the read address the inviter will use). `invitation` must
 * have been accepted by checkInvitationIndex (FormatError otherwise): never answer, nor show, an
 * invitation whose owner's index does not list it.
 */
export function createInvitationResponse(
  invitation: ReceivedInvitation,
  signer: DeviceSigner,
  sharingCert: SharingCert,
  opts: { now?: Date } = {},
): Uint8Array {
  const now = nowMs(opts.now, 'invitation-response');
  if (!confirmed.has(invitation)) throw new FormatError('invitation-response: check the invitation against its owner\'s index first (checkInvitationIndex)');
  assertInvitationActive(invitation, new Date(now));
  const v = verifySharingCert(sharingCert);
  const dc = checkSigner(signer, v.cert, 'invitation-response');
  const body = concat(
    fromB64Url(invitation.id, 'invitation.id', 16),
    v.ownerPublicKey,
    u32be(Math.floor(now / 1000)),
    sharingCertBytes(v.cert, 'invitation-response'),
    deviceCertBytes(dc),
  );
  const sig = signBinary('invitation-response', concat(body, invitation.ownerPublicKey, invitation.keyPair.publicKey), signer.keys.sign.secretKey);
  const inner = concat(body, sig);
  return concat(Uint8Array.of(RESPONSE_MAGIC, INVITATION_RESPONSE_VERSION), S().crypto_box_seal(inner, invitation.keyPair.publicKey));
}

/**
 * Owner side, for ONE answer. Prefer collectInvitationAnswers, which enforces "one answer per
 * invitation". Answers are opened until expiry + INVITATION_ANSWER_GRACE_MS (then ExpiredError),
 * provided their signed `created` falls inside the invitation's validity (V3-02); those opened at
 * or after expiry are flagged `openedAfterExpiry` (V4-06).
 */
export function openInvitationResponse(bytes: Uint8Array, invitation: OwnerInvitation, opts: { now?: Date } = {}): InvitationResponse {
  const W = 'invitation-response';
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) throw new FormatError(`${W}: too short`);
  if (bytes.length > MAX_RESPONSE_BYTES) throw new FormatError(`${W}: too long`);
  if (bytes[0] !== RESPONSE_MAGIC) throw new FormatError(`${W}: bad magic`);
  checkByteVersion(bytes[1] as number, W, INVITATION_RESPONSE_VERSION);
  const invCreated = recordTime(invitation.created, W);
  const invExpires = recordTime(invitation.expires, W);
  const now = nowMs(opts.now, W);
  if (now >= invExpires + INVITATION_ANSWER_GRACE_MS) {
    throw new ExpiredError(`invitation expired at ${invitation.expires} (answers are no longer opened)`);
  }
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
  const cert = readSharingCert(r, owner, W);
  const dc = readDeviceCert(r, owner);
  const bodyEnd = r.offset;
  const sig = r.bytes(64);
  r.end();
  const inviterPk = parseKey('ed25519', invitation.owner, 'invitation.owner');
  verifyBinary('invitation-response', sig, concat(inner.subarray(0, bodyEnd), inviterPk, invitation.keyPair.publicKey), parseKey('ed25519', dc.device));
  const createdMs = created * 1000;
  if (createdMs < invCreated - CLOCK_SKEW_S * 1000 || createdMs >= invExpires) {
    throw new FormatError(`${W}: created outside the invitation validity window`);
  }
  if (cert.revoked_devices.includes(dc.device)) throw new SignatureError(`${W}: signed by a revoked device`, 'REVOKED');
  const out: InvitationResponse = {
    owner,
    ownerPublicKey,
    device: dc.device,
    sharingPublicKey: parseKey('x25519', cert.key),
    cert,
    created: iso(created),
    openedAfterExpiry: now >= invExpires,
  };
  if (cert.location !== undefined) out.location = cert.location;
  return out;
}

/**
 * Checks the index read for an invitation (or a return link) against it, after verifyIndex with
 * `expectedOwner` and `location` (V3-01):
 * - the index was read at its own master-certified address (the link's location, or a newer one
 *   reached by following StorageMovedError), never at an address chosen by the link alone;
 * - same owner (a link naming another master key than the index's signer is refused);
 * - for an invitation link: the index's rotation is at least the link's (freshness floor, ROLLBACK)
 *   and equal to it (a later rotation cancelled the invitation, R5-01: NOT_LISTED), the index
 *   LISTS the invitation's token (code NOT_LISTED otherwise: never listed, withdrawn, expired,
 *   cancelled by a key rotation such as a declaration of loss or a storage move, or a forged
 *   link: another key, address, rotation or expiry, V4-04), and it has not expired.
 *   On success the invitation is marked as confirmed (createInvitationResponse requires it);
 * - for a return link: the index's sharing certificate is not older than the one carried by the
 *   answer (same rotation => the very same certificate; a later rotation keeps every revocation),
 *   and the device that signed the answer is not revoked in that index;
 * - with `lastSeen` (the owner is already a contact): no rollback. A link must never reset an
 *   existing contact's anchor to trust on first use.
 * Then use that index as the first `lastSeen` for this owner.
 */
export function checkInvitationIndex(
  source: ReceivedInvitation | InvitationResponse,
  index: SignedIndex,
  opts: { lastSeen?: SignedIndex | IndexAnchor; now?: Date } = {},
): void {
  const W = 'invitation';
  const info = verifiedInfo(index);
  if (!info || !info.ownerBound) throw new FormatError(`${W}: the index must come from verifyIndex with expectedOwner`);
  if (source.location === undefined) throw new FormatError(`${W}: the answer carries no read address; its device cannot be checked`);
  if (info.readFrom === undefined || info.readFrom !== index.sharing_cert.location) {
    throw new FormatError(`${W}: the index must be verified with the address it was read from (location option)`);
  }
  if (index.owner !== source.owner) throw new SignatureError(`${W}: index belongs to another owner`, 'OWNER_MISMATCH');
  if ('token' in source) {
    if (index.sharing_cert.rotation < source.rotation) {
      throw new RollbackError(`${W}: the index is older than the invitation (rotation ${index.sharing_cert.rotation} < ${source.rotation})`);
    }
    // R5-01: a rotation cancels every invitation open before it; an index of a later rotation
    // never lists an older invitation (also checked here, against a writer that would).
    if (index.sharing_cert.rotation !== source.rotation) {
      throw new SignatureError(`${W}: the invitation was cancelled by a later key change of its owner`, 'NOT_LISTED');
    }
    if (!(index.invitations ?? []).includes(source.token)) {
      throw new SignatureError(`${W}: the owner's current index does not list this invitation`, 'NOT_LISTED');
    }
    assertInvitationActive(source, opts.now);
  } else {
    checkSharingCertNotOlder(sharingCertOf(index), source.cert);
    if (index.revoked_devices.includes(source.device)) throw new SignatureError(`${W}: signed by a device that is now revoked`, 'REVOKED');
  }
  if (opts.lastSeen !== undefined) checkNoRollback(index, opts.lastSeen);
  if ('token' in source) confirmed.add(source);
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
 * again when a new one arrives, until expiry + INVITATION_ANSWER_GRACE_MS, also after acceptance:
 * answers created before expiry are still opened, accepted and reported in `late`). If several
 * distinct people answered, none is accepted: show them all with a warning and let the user choose
 * (and compare the safety code). After acceptance, pass `acceptedOwner` to get the others in `late`.
 * An answer with `openedAfterExpiry` (V4-06) is returned like the others but must not be granted
 * without asking the user, even as `accepted`: it may come from anyone who kept the link.
 */
export function collectInvitationAnswers(
  invitation: OwnerInvitation,
  responses: Uint8Array[],
  opts: { now?: Date; acceptedOwner?: string } = {},
): InvitationAnswers {
  // A corrupted record is an error of the record, not a rejected answer (V3-07).
  recordTime(invitation.created, 'invitation');
  recordTime(invitation.expires, 'invitation');
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
 * `packs` must contain the bytes of EVERY file listed in `index.packs` (packs and media): a missing
 * one is a FormatError, so nothing stays readable to the link holder by omission (V3-08).
 * Packs the invitation key cannot open are left untouched. Returns the new files; publish them,
 * list them in a new index (packEntry) and delete the old files.
 * Throws FormatError if the invitation key received a group secret (group-key pack): re-encrypting
 * it would leave the same secret with the link holder. The invitation key must be a direct
 * recipient, never a group member; if it was, rotate the group (rotateGroup, sealGroupKey to the
 * remaining members, reencryptPack of every pack wrapped to the old group key) first.
 * Several invitation key pairs may be given at once (a declaration of loss cancels every open
 * invitation, V4-02: pass cancelAllInvitations().cancelled.map((c) => c.keyPair)); a pack is
 * re-encrypted once if any of them can open it, and `recipientsFor` must include none of them.
 */
export function retireInvitationKey(
  packs: Uint8Array[],
  index: PackIndex,
  invitationKeyPair: KeyPair | readonly KeyPair[],
  recipientsFor: (packId: string) => Uint8Array[],
  opts: Pick<SealOptions, 'padTo'> = {},
): { oldFile: string; bytes: Uint8Array }[] {
  const retired: KeyPair[] = Array.isArray(invitationKeyPair) ? [...(invitationKeyPair as readonly KeyPair[])] : [invitationKeyPair as KeyPair];
  if (retired.length === 0) return [];
  const out: { oldFile: string; bytes: Uint8Array }[] = [];
  const entries = packs.map((bytes) => findIndexed(bytes, index));
  const given = new Set(entries.map((e) => e.hash));
  const missing = index.packs.filter((p) => !given.has(p.hash)).length;
  if (missing > 0) throw new FormatError(`retireInvitationKey: ${missing} file(s) listed in the index were not provided`);
  for (const [i, bytes] of packs.entries()) {
    const entry = entries[i] as { file: string; hash: string };
    let opened;
    try {
      opened = openUnchecked(bytes, retired, index.owner, entry.file);
    } catch (e) {
      if (e instanceof DecryptionError && e.code === 'NO_MATCHING_KEY') continue;
      throw e;
    }
    try {
      if (opened.type === 'group-key') {
        throw new FormatError('retireInvitationKey: the invitation key received a group secret; rotate that group instead');
      }
      const recipients = recipientsFor(opened.id);
      if (recipients.some((pk) => retired.some((k) => bytesEqual(pk, k.publicKey)))) {
        throw new FormatError('retireInvitationKey: recipients still include the invitation key');
      }
      const sealOpts: SealOptions = { id: opened.id, pad: readPackHeader(bytes).pad };
      if (opts.padTo !== undefined) sealOpts.padTo = opts.padTo;
      out.push({ oldFile: entry.file, bytes: sealTyped(index.owner, opened.payload, recipients, sealOpts, opened.type) });
    } finally {
      S().memzero(opened.payload);
    }
  }
  return out;
}
