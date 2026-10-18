import { canonicalize, checkStructure, fromB64Url, fromUtf8, int, parseJsonObject, str, toB64Url, utf8 } from './encoding';
import { FormatError, SignatureError } from './errors';
import { generateX25519KeyPair, type KeyPair } from './identity';
import { findIndexed, openUnchecked, sealTyped, type PackIndex, type SealOptions } from './pack';
import { S } from './sodium';

/*
 * A recipient group is just an X25519 key pair. Content packs wrap their batch key to
 * the group PUBLIC key like to any other recipient; the group SECRET key is distributed
 * to members inside an ordinary pack ("group-key pack") wrapped to each member's
 * sharing key. Removing a member = rotateGroup + seal the new group key to remaining
 * members + reencryptPack the affected content packs to the new group public key.
 *
 * Group-key pack payload (canonical JSON):
 *   {"generation":1,"group":"<b64url 16B>","owner":"ed25519:…","secretKey":"<b64url 32B>",
 *    "type":"group-key","version":2}
 * A group-key pack is accepted only if it is listed in the VERIFIED index of `owner`
 * (openGroupKey checks both), so a former member cannot forge "generation n+1".
 * Readers key groups by (owner, group id).
 * The pack's payload type (inside the encryption) is "group-key" (V3-16): openGroupKey refuses any
 * other type, and retireInvitationKey recognises group secrets by it.
 */

export const GROUP_KEY_VERSION = 2;

export interface Group {
  /** Stable group id across rotations (b64url of 16 bytes). Only visible to members (inside the encrypted payload). */
  id: string;
  /** Rotation counter, starts at 1. */
  generation: number;
  keyPair: KeyPair;
}

export interface OpenedGroup extends Group {
  /** Owner id of the index the group-key pack was listed in. */
  owner: string;
}

export function createGroup(): Group {
  return { id: toB64Url(S().randombytes_buf(16)), generation: 1, keyPair: generateX25519KeyPair() };
}

/** New key pair for the same group (after removing a member). */
export function rotateGroup(group: Group): Group {
  return { id: group.id, generation: group.generation + 1, keyPair: generateX25519KeyPair() };
}

/**
 * `owner` = the owner id of the index that will list this pack. Never include an invitation key in
 * `memberPublicKeys`: a link holder would keep the group secret (retireInvitationKey refuses it).
 */
export function sealGroupKey(group: Group, owner: string, memberPublicKeys: Uint8Array[], opts: Omit<SealOptions, 'id' | 'type'> = {}): Uint8Array {
  const payload = utf8(
    canonicalize({
      type: 'group-key',
      version: GROUP_KEY_VERSION,
      owner,
      group: group.id,
      generation: group.generation,
      secretKey: toB64Url(group.keyPair.secretKey),
    }),
  );
  try {
    return sealTyped(owner, payload, memberPublicKeys, opts, 'group-key');
  } finally {
    S().memzero(payload);
  }
}

/** Opens a group-key pack listed in the verified index `index` of the group's owner. */
export function openGroupKey(bytes: Uint8Array, index: PackIndex, keys: KeyPair[]): OpenedGroup {
  const W = 'group-key';
  const entry = findIndexed(bytes, index);
  const { type, payload } = openUnchecked(bytes, keys, index.owner, entry.file);
  try {
    if (type !== 'group-key') throw new FormatError(`${W}: not a group-key pack`);
    const doc = parseJsonObject(fromUtf8(payload, W), W);
    checkStructure(doc, W, GROUP_KEY_VERSION, ['type', 'version', 'owner', 'group', 'generation', 'secretKey']);
    if (doc['type'] !== 'group-key') throw new FormatError(`${W}: wrong type`);
    const owner = str(doc, 'owner', W);
    if (owner !== index.owner) throw new SignatureError(`${W}: belongs to another owner than the index`, 'OWNER_MISMATCH');
    const id = str(doc, 'group', W);
    fromB64Url(id, `${W}.group`, 16);
    const generation = int(doc, 'generation', W);
    if (generation < 1) throw new FormatError(`${W}: generation must be >= 1`);
    const secretKey = fromB64Url(doc['secretKey'], `${W}.secretKey`, 32);
    return { owner, id, generation, keyPair: { publicKey: S().crypto_scalarmult_base(secretKey), secretKey } };
  } finally {
    S().memzero(payload);
  }
}
