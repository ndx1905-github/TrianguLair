/**
 * New sharing certificate (master key): the read address of my storage is certified in it
 * (`location`), so connecting a first storage and every move issue rotation r + 1 (crypto README
 * "Change storage"). The same glue serves the sync engine's "Declare a device lost"
 * (`revokeDevices`, `newKey`), so it is one small interface, `SharingCertRotation`.
 *
 * Pure (no React, no secret store): takes and returns the stored, sealed forms. Unit-tested.
 */
import {
  decodePrimaryIdentity,
  fromB64Url,
  generateVaultDataKey,
  generateX25519KeyPair,
  identityFromPhrase,
  issueSharingCert,
  sealSharingKey,
  toB64Url,
  type Identity,
  type SharingCert,
  type SharingKey,
} from '@triangulair/crypto';

import { checkStoredIdentity, wipeIdentity, type IdentityRecord, type IdentitySecrets } from '../identity/create';

/** Where the master key comes from: this primary device, or the 12 words typed now. */
export type MasterKeySource = { kind: 'primary' } | { kind: 'phrase'; phrase: string };

export interface CertChange {
  /** New read address (`undefined`: keep; `null`: none, local only). */
  location?: string | null;
  /** Devices to add to the permanent revoked list (declaration of loss). */
  revokeDevices?: readonly string[];
  /** New random sharing key and vault data key (declaration of loss, key change). */
  newKey?: boolean;
}

export interface RotationResult {
  /** The new certificate (rotation + 1). */
  cert: SharingCert;
  /** The previous one (to tell which invitations it cancels). */
  previous: SharingCert;
  /** New sharing key sealed to this device (b64url TLSK), to store as `sharing-key`. */
  sealedForThisDevice: string;
  /** The new sharing key, for sealing to other devices and to the vault (sync engine). */
  sharing: SharingKey;
  /** Phrase-protected copy for the recovery vault (TLSK mode 2). */
  vaultCopy: Uint8Array;
}

/**
 * The interface the storage screens use and the sync engine will reuse (loss declaration). The
 * app's implementation is `IdentityApi.rotateSharingCert` (IdentityProvider), over the function below.
 */
export interface SharingCertRotation {
  /** The current certificate (rotation, location, revoked devices). */
  currentSharingCert(): Promise<SharingCert>;
  /** Issues and stores rotation r + 1. Throws `Error('phrase-mismatch')` / `Error('master-key-needed')`. */
  rotateSharingCert(change: CertChange, master: MasterKeySource): Promise<RotationResult>;
}

export function masterIdentity(record: IdentityRecord, secrets: IdentitySecrets, master: MasterKeySource): Identity {
  if (master.kind === 'primary') {
    if (!secrets.primaryIdentity) throw new Error('master-key-needed');
    return decodePrimaryIdentity(fromB64Url(secrets.primaryIdentity, 'primaryIdentity'));
  }
  let id: Identity;
  try {
    id = identityFromPhrase(master.phrase.trim().toLowerCase().split(/\s+/).join(' '));
  } catch {
    throw new Error('phrase-mismatch');
  }
  if (id.owner !== record.owner) {
    wipeIdentity(id);
    throw new Error('phrase-mismatch');
  }
  return id;
}

/** Rotation r + 1 of the stored sharing key. Call `await ready()` first. */
export function rotateStoredSharingKey(record: IdentityRecord, secrets: IdentitySecrets, change: CertChange, master: MasterKeySource): RotationResult {
  const { sharing: current } = checkStoredIdentity(record, secrets);
  const identity = masterIdentity(record, secrets, master);
  try {
    const prev = current.cert;
    const location = change.location === undefined ? prev.location : change.location ?? undefined;
    const keyPair = change.newKey ? generateX25519KeyPair() : current.keyPair;
    const cert = issueSharingCert(identity, keyPair.publicKey, {
      rotation: prev.rotation + 1,
      revokedDevices: [...prev.revoked_devices, ...(change.revokeDevices ?? [])],
      ...(location !== undefined ? { location } : {}),
    });
    const sharing: SharingKey = { keyPair, cert, vaultDataKey: change.newKey ? generateVaultDataKey() : current.vaultDataKey };
    return {
      cert,
      previous: prev,
      sharing,
      sealedForThisDevice: toB64Url(sealSharingKey(sharing, record.deviceCert)),
      vaultCopy: sealSharingKey(sharing, identity),
    };
  } finally {
    wipeIdentity(identity);
  }
}
