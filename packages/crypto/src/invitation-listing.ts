import { concat, toB64Url, u32be, utf8 } from './encoding';
import { FormatError } from './errors';
import type { KeyPair } from './identity';
import { S } from './sodium';

/*
 * Invitation listing (spec "Invitation link and return link"): what binds a short, unsigned
 * invitation link to its owner. The owner's current signed index lists one token per open
 * invitation:
 *   token = "b2b256:" + b64url(BLAKE2b-256("TrianguLair-invitation-listing-v1\n" ||
 *           owner master pk 32 || invitation X25519 pk 32 || rotation u32 || expires u32 s))
 * Only a device that can publish an index readers accept at the master-certified address (a device
 * not revoked by the current sharing certificate) can list an invitation, so the listing replaces
 * the device signature the link carried in format 4.
 *
 * The invitation key pair and id are derived from a 16-byte random seed (the only secret in the
 * link):
 *   secret key = BLAKE2b-256("TrianguLair-invitation-key-v1\n" || seed)   (X25519, clamped on use)
 *   id         = BLAKE2b-128("TrianguLair-invitation-id-v1\n" || seed)
 */

export const INVITATION_SEED_BYTES = 16;
/** Largest number of entries in an index `invitations` list (padding included). */
export const MAX_LISTED_INVITATIONS = 256;
/** A non-empty list is padded with dummy tokens to a power of two, at least this many. */
const MIN_LISTED = 4;

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

/** Token listed in the owner's index for an invitation (see above). */
export function invitationToken(ownerPublicKey: Uint8Array, invitationPublicKey: Uint8Array, rotation: number, expiresSeconds: number): string {
  const digest = h(32, 'TrianguLair-invitation-listing-v1\n', ownerPublicKey, invitationPublicKey, u32be(rotation), u32be(expiresSeconds));
  return `b2b256:${toB64Url(digest)}`;
}

/**
 * Sorted list of `tokens` padded with dummy tokens to a power of two (at least 4). The dummies are
 * derived from `padKey` (a device secret) and their position, so they stay the same from one
 * publication to the next while the bucket does not change: diffing two indexes does not tell
 * real entries from padding. Empty in, empty out.
 */
export function padListing(tokens: readonly string[], padKey: Uint8Array): string[] {
  const real = [...new Set(tokens)];
  if (real.length === 0) return [];
  let size = MIN_LISTED;
  while (size < real.length) size *= 2;
  if (size > MAX_LISTED_INVITATIONS) throw new FormatError(`index: too many open invitations (max ${MAX_LISTED_INVITATIONS})`);
  const s = S();
  const out = new Set(real);
  for (let i = 0; out.size < size; i++) {
    const dummy = s.crypto_generichash(32, concat(utf8('TrianguLair-invitation-padding-v1\n'), u32be(i)), padKey);
    out.add(`b2b256:${toB64Url(dummy)}`);
  }
  return [...out].sort();
}
