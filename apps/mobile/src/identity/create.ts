/**
 * Identity creation (first launch, spec "Standard flow" and "Loss and theft"):
 * pure glue over @triangulair/crypto, unit-tested. Nothing here touches a
 * storage; `secrets.ts` decides where each part goes.
 *
 * What is created, all at once and without asking anything:
 * - the 12-word recovery phrase, giving the master key (the owner id friends
 *   know) and the phrase-derived vault key;
 * - this device's own keys (signing + box), never copied;
 * - the device certificate (master-signed);
 * - a random sharing key with its certificate (rotation 0, no read address:
 *   local-only mode publishes nothing until a storage is connected);
 * - a random vault data key, sealed with the sharing key to this device;
 * - on the primary device only (an option, on by default here), the master
 *   key and vault key (`encodePrimaryIdentity`).
 *
 * The phrase is returned to the caller, which keeps it only until the
 * recovery kit is saved (spec: never stored after setup).
 */
import {
  decodePrimaryIdentity,
  devicePublicKeys,
  encodePrimaryIdentity,
  fromB64Url,
  generateDeviceKeys,
  generateRecoveryPhrase,
  generateVaultDataKey,
  generateX25519KeyPair,
  identityFromPhrase,
  issueDeviceCert,
  issueSharingCert,
  openSharingKey,
  sealSharingKey,
  toB64Url,
  verifyDeviceCert,
  type DeviceCert,
  type DeviceKeys,
  type Identity,
  type IdentityMove,
  type SharingKey,
} from '@triangulair/crypto';

/** Version of the stored record layout below (app-side, not a transported format). */
export const IDENTITY_RECORD_VERSION = 1;

/** Public, non-secret part: who I am on this device. */
export interface IdentityRecord {
  version: number;
  /** "ed25519:…" master public key: my owner id. */
  owner: string;
  /** "ed25519:…" this device's signing key. */
  deviceId: string;
  deviceCert: DeviceCert;
  /** ms since epoch. */
  createdAt: number;
  /** This device keeps the master key (primary device). */
  primary: boolean;
  /** When the recovery kit was confirmed (the phrase was then forgotten); null until then. */
  kitSavedAt: number | null;
  /**
   * After "Declare the primary device lost" (T-207): the move from my previous identity, written in
   * every index I publish (friends who were offline need it, crypto rule R-11).
   */
  move?: IdentityMove;
}

/** Secret parts, each kept as its own entry in the system's secure vault. */
export interface IdentitySecrets {
  /** JSON of this device's key pairs (b64url). */
  deviceKeys: string;
  /** b64url "TLSK" sealed to this device: current sharing key + vault data key. */
  sharingKey: string;
  /** b64url "TLPI" (master seed + vault key); primary device only. */
  primaryIdentity: string | null;
}

export interface CreatedIdentity {
  record: IdentityRecord;
  secrets: IdentitySecrets;
  /** Shown once in the recovery kit, then forgotten. */
  phrase: string;
  /** Phrase-protected copy of the sharing key (TLSK mode 2) for the future recovery vault (phase 2). */
  vaultCopy: Uint8Array;
}

export function serializeDeviceKeys(k: DeviceKeys): string {
  return JSON.stringify({
    v: 1,
    id: k.id,
    signPk: toB64Url(k.sign.publicKey),
    signSk: toB64Url(k.sign.secretKey),
    boxPk: toB64Url(k.box.publicKey),
    boxSk: toB64Url(k.box.secretKey),
  });
}

export function parseDeviceKeys(s: string): DeviceKeys {
  const o = JSON.parse(s) as Record<string, unknown>;
  if (o['v'] !== 1 || typeof o['id'] !== 'string') throw new Error('device keys: unknown layout');
  return {
    id: o['id'],
    sign: { publicKey: fromB64Url(o['signPk'], 'signPk', 32), secretKey: fromB64Url(o['signSk'], 'signSk', 64) },
    box: { publicKey: fromB64Url(o['boxPk'], 'boxPk', 32), secretKey: fromB64Url(o['boxSk'], 'boxSk', 32) },
  };
}

/** Creates everything from a phrase (a new one by default). Call `await ready()` first. */
export function createIdentity(opts: { primary: boolean; now?: number; phrase?: string }): CreatedIdentity {
  const phrase = opts.phrase ?? generateRecoveryPhrase();
  const identity = identityFromPhrase(phrase);
  try {
    const device = generateDeviceKeys();
    const deviceCert = issueDeviceCert(identity, devicePublicKeys(device));
    const sharingPair = generateX25519KeyPair();
    const sharing: SharingKey = {
      keyPair: sharingPair,
      cert: issueSharingCert(identity, sharingPair.publicKey, { rotation: 0 }),
      vaultDataKey: generateVaultDataKey(),
    };
    const record: IdentityRecord = {
      version: IDENTITY_RECORD_VERSION,
      owner: identity.owner,
      deviceId: device.id,
      deviceCert,
      createdAt: opts.now ?? Date.now(),
      primary: opts.primary,
      kitSavedAt: null,
    };
    return {
      record,
      secrets: {
        deviceKeys: serializeDeviceKeys(device),
        sharingKey: toB64Url(sealSharingKey(sharing, deviceCert)),
        primaryIdentity: opts.primary ? toB64Url(encodePrimaryIdentity(identity)) : null,
      },
      phrase,
      vaultCopy: sealSharingKey(sharing, identity),
    };
  } finally {
    wipeIdentity(identity);
  }
}

/** Best-effort wipe of an identity's secret bytes once it is no longer needed. */
export function wipeIdentity(identity: Identity): void {
  identity.master.secretKey.fill(0);
  identity.vaultKey.fill(0);
}

/**
 * Checks that stored secrets belong together and to `record` (run on load):
 * the device certificate verifies for the owner and names these device keys,
 * the sealed sharing key opens with them, and the primary blob gives the same owner.
 */
export function checkStoredIdentity(record: IdentityRecord, secrets: IdentitySecrets): { sharing: SharingKey; device: DeviceKeys } {
  const device = parseDeviceKeys(secrets.deviceKeys);
  const cert = verifyDeviceCert(record.deviceCert, { expectedOwner: record.owner });
  if (cert.device !== device.id || device.id !== record.deviceId) throw new Error('identity: device keys do not match the device certificate');
  const sharing = openSharingKey(fromB64Url(secrets.sharingKey, 'sharingKey'), device, { expectedOwner: record.owner });
  if (secrets.primaryIdentity) {
    const id = decodePrimaryIdentity(fromB64Url(secrets.primaryIdentity, 'primaryIdentity'));
    const same = id.owner === record.owner;
    wipeIdentity(id);
    if (!same) throw new Error('identity: primary identity belongs to another owner');
  }
  return { sharing, device };
}

/**
 * What the app finds at launch (spec "Error cases", key missing from the phone's vault): no
 * identity record (first launch), a record whose device or sharing key is gone (a system restore
 * that brought the app's files back without the system vault's keys: blocked before any write, the
 * recovery kit is asked), or both (checked further by checkStoredIdentity).
 */
export function storedIdentityKind(record: IdentityRecord | null, secrets: { deviceKeys: string | null; sharingKey: string | null }): 'none' | 'keys-missing' | 'present' {
  if (!record) return 'none';
  return secrets.deviceKeys && secrets.sharingKey ? 'present' : 'keys-missing';
}

/** Typed 12 words → primary blob, after checking they recreate this owner (turning "primary device" on later). */
export function primaryFromPhrase(phrase: string, owner: string): string {
  const id = identityFromPhrase(phrase);
  try {
    if (id.owner !== owner) throw new Error('phrase-mismatch');
    return toB64Url(encodePrimaryIdentity(id));
  } finally {
    wipeIdentity(id);
  }
}

export function parseIdentityRecord(s: string | null): IdentityRecord | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s) as IdentityRecord;
    if (o.version !== IDENTITY_RECORD_VERSION || typeof o.owner !== 'string' || !o.owner.startsWith('ed25519:')) return null;
    return o;
  } catch {
    return null;
  }
}
