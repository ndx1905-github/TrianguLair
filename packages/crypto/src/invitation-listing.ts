import { verifyDeviceCert } from './certs';
import { bytesEqual, concat, fromB64Url, parseKey, readU32be, toB64Url, u16be, u32be, utf8 } from './encoding';
import { FormatError } from './errors';
import type { KeyPair } from './identity';
import type { OwnerInvitation } from './invitation';
import { checkLocation } from './location';
import { signBinary, verifyBinary } from './sign';
import { S } from './sodium';

/*
 * Invitation listing (spec "Invitation link and return link"): what binds a short, unsigned
 * invitation link to its owner. The owner's current signed index lists one token per open
 * invitation:
 *   token = "b2b256:" + b64url(BLAKE2b-256("TrianguLair-invitation-listing-v2\n" ||
 *           owner master pk 32 || invitation X25519 pk 32 || rotation u32 || expires u32 s ||
 *           u16 L || read address L (UTF-8, the full "https://…" address written in the link)))
 * Every field of the link is bound (V4-04: a link whose address was rewritten is NOT_LISTED, not
 * redirected). Only a device that can publish an index readers accept at the master-certified
 * address (a device not revoked by the current sharing certificate) can list an invitation, so the
 * listing replaces the device signature the link carried in format 4.
 *
 * The invitation key pair and id are derived from a 16-byte random seed (the only secret in the
 * link):
 *   secret key = BLAKE2b-256("TrianguLair-invitation-key-v1\n" || seed)   (X25519, clamped on use)
 *   id         = BLAKE2b-128("TrianguLair-invitation-id-v1\n" || seed)
 *
 * Invitation record signature (V4-01): the device that creates an invitation signs, under the
 * domain "invitation-record",
 *   owner master pk 32 || id 16 || invitation X25519 pk 32 || rotation u32 || created u32 s ||
 *   expires u32 s || u16 L || read address L
 * and the record carries that device's master-signed certificate. A record is listed only if both
 * verify, its lifetime is at most 7 days, and the current sharing certificate does not revoke the
 * device: a stolen device cannot plant a record in another device's name, nor extend one.
 *
 * Padding (V4-05): the list always has a power-of-two number of entries, at least 4. Dummy slot i
 * holds BLAKE2b-256(key = padKey, "TrianguLair-invitation-padding-v2\n" || u32 i || u32 epoch),
 * where padKey = BLAKE2b-256(key = vault data key, "TrianguLair-invitation-padding-key-v1") is the
 * same on every device of the owner, and each slot changes value at its own pseudo-random period
 * (1 to 7 days) and phase:
 *   p = BLAKE2b-64(key = padKey, "TrianguLair-invitation-padding-period-v1\n" || u32 i)
 *   period = 86400 + (u32(p[0..4]) mod 518401) s,  phase = u32(p[4..8]) mod period,
 *   epoch = floor((now s + phase) / period)
 * so dummies come and go like real tokens (which live at most 7 days) and two devices publishing
 * at the same time write the same list.
 */

export const INVITATION_SEED_BYTES = 16;
/** Largest number of entries in an index `invitations` list (padding included). */
export const MAX_LISTED_INVITATIONS = 256;
/** Longest invitation lifetime (created to expires). */
export const INVITATION_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The list is padded with dummy tokens to a power of two, at least this many. */
const MIN_LISTED = 4;
const DAY_S = 24 * 60 * 60;

function h(size: number, domain: string, ...parts: Uint8Array[]): Uint8Array {
  return S().crypto_generichash(size, concat(utf8(domain), ...parts), null);
}

/** Invitation key pair and id derived from the link seed. */
export function deriveInvitation(seed: Uint8Array): { id: string; keyPair: KeyPair } {
  if (!(seed instanceof Uint8Array) || seed.length !== INVITATION_SEED_BYTES) throw new FormatError('invitation: seed must be 16 bytes');
  const secretKey = h(32, 'TrianguLair-invitation-key-v1\n', seed);
  const publicKey = S().crypto_scalarmult_base(secretKey);
  return { id: toB64Url(h(16, 'TrianguLair-invitation-id-v1\n', seed)), keyPair: { publicKey, secretKey } };
}

function address(location: string): Uint8Array {
  const b = utf8(location);
  return concat(u16be(b.length), b);
}

/** Token listed in the owner's index for an invitation (see above). `location` is the link's read address. */
export function invitationToken(ownerPublicKey: Uint8Array, invitationPublicKey: Uint8Array, rotation: number, expiresSeconds: number, location: string): string {
  const digest = h(32, 'TrianguLair-invitation-listing-v2\n', ownerPublicKey, invitationPublicKey, u32be(rotation), u32be(expiresSeconds), address(location));
  return `b2b256:${toB64Url(digest)}`;
}

/** Epoch seconds of an invitation date: an ISO string on a whole second (fails closed). */
function seconds(value: unknown, what: string): number {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(t) || t % 1000 !== 0 || t < 0 || t / 1000 > 0xffffffff) throw new FormatError(`${what}: invalid date in the invitation`);
  return t / 1000;
}

function recordBytes(inv: OwnerInvitation, what: string): Uint8Array {
  const ownerPk = parseKey('ed25519', inv.owner, `${what}.owner`);
  const created = seconds(inv.created, what);
  const expires = seconds(inv.expires, what);
  if (expires <= created) throw new FormatError(`${what}: expires must follow created`);
  if ((expires - created) * 1000 > INVITATION_MAX_TTL_MS) throw new FormatError(`${what}: an invitation lasts at most 7 days`);
  if (!Number.isSafeInteger(inv.rotation) || inv.rotation < 0 || inv.rotation > 0xffffffff) throw new FormatError(`${what}: bad rotation`);
  checkLocation(inv.location, `${what}.location`);
  const { id, keyPair } = deriveInvitation(inv.seed);
  if (id !== inv.id || !(inv.keyPair?.publicKey instanceof Uint8Array) || !bytesEqual(keyPair.publicKey, inv.keyPair.publicKey)) {
    throw new FormatError(`${what}: id or key pair does not match the seed`);
  }
  return concat(ownerPk, fromB64Url(id, `${what}.id`, 16), keyPair.publicKey, u32be(inv.rotation), u32be(created), u32be(expires), address(inv.location));
}

/** @internal Signature of a new invitation by its creating device (base64url). */
export function signInvitationRecord(inv: OwnerInvitation, deviceSecretKey: Uint8Array): string {
  return toB64Url(signBinary('invitation-record', recordBytes(inv, 'invitation'), deviceSecretKey));
}

/**
 * @internal Checks an owner invitation (or a vault record turned into one): dates on whole seconds,
 * lifetime at most 7 days, u32 rotation, read address, id and key pair derived from the seed
 * (FormatError), then the creating device's certificate against the owner's master and its
 * signature over the record (SignatureError). Says nothing about revocation or expiry.
 */
export function checkOwnerInvitation(inv: OwnerInvitation, what = 'invitation'): void {
  if (typeof inv !== 'object' || inv === null) throw new FormatError(`${what}: expected an invitation`);
  const bytes = recordBytes(inv, what);
  const dc = verifyDeviceCert(inv.deviceCert, { expectedOwner: inv.owner });
  if (dc.device !== inv.device) throw new FormatError(`${what}: device does not match its certificate`);
  verifyBinary('invitation-record', fromB64Url(inv.signature, `${what}.signature`, 64), bytes, parseKey('ed25519', dc.device));
}

/** @internal Padding key of the listing, the same on every device: derived from the vault data key. */
export function listingPadKey(vaultDataKey: Uint8Array): Uint8Array {
  if (!(vaultDataKey instanceof Uint8Array) || vaultDataKey.length !== 32) throw new FormatError('index: vault data key must be 32 bytes');
  return S().crypto_generichash(32, utf8('TrianguLair-invitation-padding-key-v1'), vaultDataKey);
}

function dummy(padKey: Uint8Array, slot: number, nowS: number): string {
  const s = S();
  const p = s.crypto_generichash(8, concat(utf8('TrianguLair-invitation-padding-period-v1\n'), u32be(slot)), padKey);
  const period = DAY_S + (readU32be(p, 0) % (6 * DAY_S + 1));
  const phase = readU32be(p, 4) % period;
  const epoch = Math.floor((nowS + phase) / period);
  return `b2b256:${toB64Url(s.crypto_generichash(32, concat(utf8('TrianguLair-invitation-padding-v2\n'), u32be(slot), u32be(epoch)), padKey))}`;
}

/**
 * @internal Sorted list of `tokens` padded with dummy tokens (see above) to a power of two, at
 * least 4, at most 256.
 */
export function padListing(tokens: readonly string[], padKey: Uint8Array, nowMs: number): string[] {
  const real = [...new Set(tokens)];
  let size = MIN_LISTED;
  while (size < real.length) size *= 2;
  if (size > MAX_LISTED_INVITATIONS) throw new FormatError(`index: too many open invitations (max ${MAX_LISTED_INVITATIONS})`);
  const nowS = Math.floor(nowMs / 1000);
  const out = new Set(real);
  for (let i = 0; out.size < size; i++) out.add(dummy(padKey, i, nowS));
  return [...out].sort();
}
