import { canonicalize, checkKeys, checkVersion, fromB64Url, fromUtf8, int, parseJsonObject, str, toB64Url, utf8 } from './encoding';
import { FormatError } from './errors';
import { generateX25519KeyPair, type KeyPair } from './identity';
import { openPack, sealPack, type SealOptions } from './pack';
import { S } from './sodium';

/*
 * A recipient group is just an X25519 key pair. Content packs wrap their batch key to
 * the group PUBLIC key like to any other recipient; the group SECRET key is distributed
 * to members inside an ordinary pack ("group-key pack") wrapped to each member's
 * sharing key. Removing a member = rotateGroup + seal the new group key to remaining
 * members + reencryptPack the affected content packs to the new group public key.
 *
 * Group-key pack payload (canonical JSON):
 *   {"generation":1,"group":"<b64url 16B>","secretKey":"<b64url 32B>","type":"group-key","version":1}
 */

export const GROUP_KEY_VERSION = 1;

export interface Group {
  /** Stable group id across rotations (b64url of 16 bytes). Only visible to members (inside the encrypted payload). */
  id: string;
  /** Rotation counter, starts at 1. */
  generation: number;
  keyPair: KeyPair;
}

export function createGroup(): Group {
  return { id: toB64Url(S().randombytes_buf(16)), generation: 1, keyPair: generateX25519KeyPair() };
}

/** New key pair for the same group (after removing a member). */
export function rotateGroup(group: Group): Group {
  return { id: group.id, generation: group.generation + 1, keyPair: generateX25519KeyPair() };
}

export function sealGroupKey(group: Group, memberPublicKeys: Uint8Array[], opts: Omit<SealOptions, 'id'> = {}): Uint8Array {
  const payload = utf8(
    canonicalize({
      type: 'group-key',
      version: GROUP_KEY_VERSION,
      group: group.id,
      generation: group.generation,
      secretKey: toB64Url(group.keyPair.secretKey),
    }),
  );
  return sealPack(payload, memberPublicKeys, opts);
}

export function openGroupKey(bytes: Uint8Array, keys: KeyPair[]): Group {
  const W = 'group-key';
  const { payload } = openPack(bytes, keys);
  const doc = parseJsonObject(fromUtf8(payload, W), W);
  checkVersion(doc, W, GROUP_KEY_VERSION);
  checkKeys(doc, W, ['type', 'version', 'group', 'generation', 'secretKey']);
  if (doc['type'] !== 'group-key') throw new FormatError(`${W}: wrong type`);
  const id = str(doc, 'group', W);
  fromB64Url(id, `${W}.group`, 16);
  const generation = int(doc, 'generation', W);
  const secretKey = fromB64Url(doc['secretKey'], `${W}.secretKey`, 32);
  return { id, generation, keyPair: { publicKey: S().crypto_scalarmult_base(secretKey), secretKey } };
}
