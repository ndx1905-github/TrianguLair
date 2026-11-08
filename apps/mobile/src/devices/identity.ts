/**
 * Identity glue for T-206 / T-207, pure over @triangulair/crypto (unit-tested):
 *
 * - `joinedIdentity`: what a new device stores once it joined (its own device keys and
 *   master-signed certificate, the sharing key sealed to itself, the primary blob when it keeps the
 *   master key). The 12 words are never stored.
 * - `moveIdentity`: "Declare the primary device lost" (spec "Loss and theft"): the 12 words recreate
 *   the old identity, a new phrase and master key are made, the move is signed by the old master
 *   and countersigned by the new one (`issueIdentityMove`), this device gets a new device
 *   certificate (same device keys) and a new random sharing key and vault data key, with the same
 *   read address. The new phrase is shown as the new recovery kit; this device keeps the new
 *   master key (it is the new primary device).
 */
import {
  devicePublicKeys,
  encodePrimaryIdentity,
  generateRecoveryPhrase,
  generateVaultDataKey,
  generateX25519KeyPair,
  identityFromPhrase,
  issueDeviceCert,
  issueIdentityMove,
  issueSharingCert,
  sealSharingKey,
  toB64Url,
  type DeviceKeys,
  type IdentityMove,
  type KeyPair,
  type SharingKey,
} from '@triangulair/crypto';

import { IDENTITY_RECORD_VERSION, serializeDeviceKeys, wipeIdentity, type IdentityRecord, type IdentitySecrets } from '../identity/create';
import type { Joined } from './sessions';
import { normalizePhrase } from './sessions';

export function joinedIdentity(j: Joined, now: number): { record: IdentityRecord; secrets: IdentitySecrets } {
  return {
    record: {
      version: IDENTITY_RECORD_VERSION,
      owner: j.owner,
      deviceId: j.deviceKeys.id,
      deviceCert: j.deviceCert,
      createdAt: now,
      primary: !!j.primaryIdentity,
      // The kit belongs to the identity, saved (or not) on the first device; nothing pending here.
      kitSavedAt: null,
    },
    secrets: {
      deviceKeys: serializeDeviceKeys(j.deviceKeys),
      sharingKey: toB64Url(sealSharingKey(j.sharing, j.deviceCert)),
      primaryIdentity: j.primaryIdentity,
    },
  };
}

export interface MovedIdentity {
  /** The new 12 words: the new recovery kit (kept as `pending-phrase` until confirmed). */
  phrase: string;
  move: IdentityMove;
  record: IdentityRecord;
  secrets: IdentitySecrets & { primaryIdentity: string };
  sharing: SharingKey;
  /** Phrase-protected copy of the new sharing key (keys/<new owner>.bin). */
  vaultCopy: Uint8Array;
  /** The old sharing key pair: friends may still wrap to it until they follow the move. */
  previousSharing: KeyPair;
}

/** Throws `Error('phrase-mismatch')` when the words are not those of `record.owner`. */
export function moveIdentity(oldPhrase: string, record: IdentityRecord, device: DeviceKeys, current: SharingKey, now: number): MovedIdentity {
  let old;
  try {
    old = identityFromPhrase(normalizePhrase(oldPhrase));
  } catch {
    throw new Error('phrase-mismatch');
  }
  if (old.owner !== record.owner) {
    wipeIdentity(old);
    throw new Error('phrase-mismatch');
  }
  const phrase = generateRecoveryPhrase();
  const next = identityFromPhrase(phrase);
  try {
    const move = issueIdentityMove(old, next, { now: new Date(now) });
    const deviceCert = issueDeviceCert(next, devicePublicKeys(device));
    const kp = generateX25519KeyPair();
    const sharing: SharingKey = {
      keyPair: kp,
      cert: issueSharingCert(next, kp.publicKey, { rotation: 0, ...(current.cert.location !== undefined && { location: current.cert.location }) }),
      vaultDataKey: generateVaultDataKey(),
    };
    return {
      phrase,
      move,
      record: { ...record, version: IDENTITY_RECORD_VERSION, owner: next.owner, deviceCert, primary: true, kitSavedAt: null, move },
      secrets: { deviceKeys: serializeDeviceKeys(device), sharingKey: toB64Url(sealSharingKey(sharing, deviceCert)), primaryIdentity: toB64Url(encodePrimaryIdentity(next)) },
      sharing,
      vaultCopy: sealSharingKey(sharing, next),
      previousSharing: current.keyPair,
    };
  } finally {
    wipeIdentity(old);
    wipeIdentity(next);
  }
}
