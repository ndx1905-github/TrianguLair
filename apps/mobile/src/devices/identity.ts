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
  fromB64Url,
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

/**
 * An identity move under way (devices review F-08), kept in the secret store (`pending-move`) before
 * anything changes on this device or the storage, so that an interrupted move is finished at the
 * next launch (IdentityProvider) instead of leaving this device with neither identity.
 */
export interface PendingMove {
  from: string;
  phrase: string;
  record: IdentityRecord;
  secrets: IdentitySecrets & { primaryIdentity: string };
  vaultCopy: Uint8Array;
  cert: SharingKey['cert'];
  previousSharing: KeyPair;
}

export function encodePendingMove(m: MovedIdentity, from: string): string {
  return JSON.stringify({
    v: 1,
    from,
    phrase: m.phrase,
    record: m.record,
    secrets: m.secrets,
    vaultCopy: toB64Url(m.vaultCopy),
    cert: m.sharing.cert,
    previous: { publicKey: toB64Url(m.previousSharing.publicKey), secretKey: toB64Url(m.previousSharing.secretKey) },
  });
}

export function decodePendingMove(s: string | null): PendingMove | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s) as Record<string, unknown> & { previous: { publicKey: string; secretKey: string } };
    if (o['v'] !== 1 || typeof o['from'] !== 'string' || typeof o['phrase'] !== 'string') return null;
    return {
      from: o['from'],
      phrase: o['phrase'],
      record: o['record'] as IdentityRecord,
      secrets: o['secrets'] as PendingMove['secrets'],
      vaultCopy: fromB64Url(o['vaultCopy'], 'vaultCopy'),
      cert: o['cert'] as PendingMove['cert'],
      previousSharing: { publicKey: fromB64Url(o.previous.publicKey, 'pk', 32), secretKey: fromB64Url(o.previous.secretKey, 'sk', 32) },
    };
  } catch {
    return null;
  }
}
