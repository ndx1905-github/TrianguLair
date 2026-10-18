import {
  arr,
  checkKeys,
  checkVersion,
  deepFreeze,
  formatKey,
  int,
  ownerString,
  parseJsonObject,
  parseKey,
  str,
  type JsonObject,
} from './encoding';
import { FormatError, RollbackError, SignatureError } from './errors';
import { checkNotRetired, type DeviceKeys, type Identity } from './identity';
import { signBody, verifyBody } from './sign';

/** Options shared by every verifier that trusts a master key. */
export interface TrustOptions {
  /** Master public key (or "ed25519:..." owner id) the document must belong to; else OWNER_MISMATCH. */
  expectedOwner?: Uint8Array | string;
  /** Owner ids that moved to a new identity: anything they sign is refused (code REVOKED). */
  retiredOwners?: Iterable<string>;
}

/**
 * Options for verifiers of a sharing certificate. Pass `lastSeen` (the certificate this device or
 * reader already holds for the owner) whenever there is one: an older rotation is then refused, so
 * a thief cannot push the old sharing key back to a remaining device (R-08).
 */
export interface SharingCertOptions extends TrustOptions {
  lastSeen?: SharingCert;
}

const MAX_REVOKED = 256;

// ---------------------------------------------------------------------------
// Device certificate: the master key authorizes a device key to sign indexes.
//   {"box":"x25519:…","device":"ed25519:…","owner":"ed25519:…","signature":"…","type":"device-cert","version":1}
// Inside an index it is stored compactly as {box, device, signature} (owner = index owner).
// ---------------------------------------------------------------------------

export const DEVICE_CERT_VERSION = 1;

export interface DeviceCert {
  type: 'device-cert';
  version: number;
  owner: string;
  /** Device signing key "ed25519:…" (= DeviceKeys.id). */
  device: string;
  /** Device X25519 key "x25519:…" to which the sharing key is sealed. */
  box: string;
  signature: string;
}

/** The public half of a device's keys: what a new device shows to the primary device (QR). */
export function devicePublicKeys(keys: DeviceKeys): { device: string; box: string } {
  return { device: keys.id, box: formatKey('x25519', keys.box.publicKey) };
}

/** Master signs a device certificate. Requires the phrase or the primary device. */
export function issueDeviceCert(identity: Identity, device: { device: string; box: string }): DeviceCert {
  parseKey('ed25519', device.device, 'device-cert.device');
  parseKey('x25519', device.box, 'device-cert.box');
  const signed = signBody(
    'device-cert',
    { type: 'device-cert' as const, version: DEVICE_CERT_VERSION, owner: identity.owner, device: device.device, box: device.box },
    identity.master.secretKey,
  );
  return verifyDeviceCert(signed);
}

export function verifyDeviceCert(input: string | DeviceCert | JsonObject, opts: TrustOptions = {}): DeviceCert {
  const W = 'device-cert';
  const doc = parseJsonObject(input as string | JsonObject, W);
  checkVersion(doc, W, DEVICE_CERT_VERSION);
  checkKeys(doc, W, ['type', 'version', 'owner', 'device', 'box', 'signature']);
  if (doc['type'] !== W) throw new FormatError(`${W}: wrong type`);
  const ownerPk = parseKey('ed25519', doc['owner'], `${W}.owner`);
  parseKey('ed25519', doc['device'], `${W}.device`);
  parseKey('x25519', doc['box'], `${W}.box`);
  verifyBody('device-cert', doc, ownerPk);
  checkOwner(str(doc, 'owner', W), opts, W);
  return deepFreeze({ ...doc } as unknown as DeviceCert);
}

// ---------------------------------------------------------------------------
// Sharing certificate: the master key binds the CURRENT sharing key (random X25519) and the
// list of revoked devices. A new rotation is issued whenever the sharing key changes (a device is
// lost or removed). Revocations are permanent: a later rotation must keep every earlier revoked
// device.
//   {"key":"x25519:…","owner":"ed25519:…","revoked_devices":["ed25519:…"],"rotation":3,
//    "signature":"…","type":"sharing-cert","version":2}
// Inside an index it is stored as sharing_cert = {key, rotation, signature}; `owner` and
// `revoked_devices` are the index's top-level fields, and are covered by this master signature.
// ---------------------------------------------------------------------------

export const SHARING_CERT_VERSION = 2;

export interface SharingCert {
  type: 'sharing-cert';
  version: number;
  owner: string;
  key: string;
  rotation: number;
  revoked_devices: string[];
  signature: string;
}

export interface VerifiedSharingCert {
  cert: SharingCert;
  ownerPublicKey: Uint8Array;
  sharingPublicKey: Uint8Array;
}

function normalizeRevoked(list: readonly string[], W: string): string[] {
  if (list.length > MAX_REVOKED) throw new FormatError(`${W}: too many revoked devices (max ${MAX_REVOKED})`);
  for (const d of list) parseKey('ed25519', d, `${W}.revoked_devices[]`);
  return [...new Set(list)].sort();
}

/**
 * Master key certifies a sharing public key. Requires the phrase or the primary device.
 * `rotation` must increase at each key change; `revokedDevices` must contain every device ever revoked.
 */
export function issueSharingCert(
  identity: Identity,
  sharingPublicKey: Uint8Array,
  opts: { rotation: number; revokedDevices?: readonly string[] },
): SharingCert {
  if (!Number.isSafeInteger(opts.rotation) || opts.rotation < 0) throw new FormatError('rotation must be a non-negative integer');
  const signed = signBody(
    'sharing-cert',
    {
      type: 'sharing-cert' as const,
      version: SHARING_CERT_VERSION,
      owner: identity.owner,
      key: formatKey('x25519', sharingPublicKey),
      rotation: opts.rotation,
      revoked_devices: normalizeRevoked(opts.revokedDevices ?? [], 'sharing-cert'),
    },
    identity.master.secretKey,
  );
  return verifySharingCert(signed).cert;
}

function checkOwner(owner: string, opts: TrustOptions, W: string): void {
  checkNotRetired(owner, opts.retiredOwners, W);
  if (opts.expectedOwner !== undefined && ownerString(opts.expectedOwner) !== owner) {
    throw new SignatureError(`${W}: signed by an unexpected owner`, 'OWNER_MISMATCH');
  }
}

/**
 * Verifies structure + master signature (+ `expectedOwner`, `retiredOwners`). With `lastSeen` (the
 * last cert accepted for this owner): a lower rotation is a RollbackError, the same rotation with
 * different content is a fork (RollbackError, fork = true), and a higher rotation that "un-revokes"
 * a device is refused.
 */
export function verifySharingCert(
  input: string | SharingCert | JsonObject,
  opts: SharingCertOptions = {},
): VerifiedSharingCert {
  const W = 'sharing-cert';
  const doc = parseJsonObject(input as string | JsonObject, W);
  checkVersion(doc, W, SHARING_CERT_VERSION);
  checkKeys(doc, W, ['type', 'version', 'owner', 'key', 'rotation', 'revoked_devices', 'signature']);
  if (doc['type'] !== W) throw new FormatError(`${W}: wrong type`);
  const ownerPublicKey = parseKey('ed25519', doc['owner'], `${W}.owner`);
  const sharingPublicKey = parseKey('x25519', doc['key'], `${W}.key`);
  int(doc, 'rotation', W);
  const revoked = arr(doc, 'revoked_devices', W, MAX_REVOKED);
  for (const d of revoked) parseKey('ed25519', d, `${W}.revoked_devices[]`);
  const sorted = [...new Set(revoked as string[])].sort();
  if (sorted.length !== revoked.length || sorted.some((d, i) => d !== revoked[i])) {
    throw new FormatError(`${W}: revoked_devices must be sorted and unique`);
  }
  verifyBody('sharing-cert', doc, ownerPublicKey);
  const cert = deepFreeze({ ...doc, revoked_devices: [...sorted] } as unknown as SharingCert);
  checkOwner(cert.owner, opts, W);
  if (opts.lastSeen) checkSharingCertNotOlder(cert, opts.lastSeen);
  return { cert, ownerPublicKey, sharingPublicKey };
}

/** Both certs must already be verified. */
export function checkSharingCertNotOlder(next: SharingCert, lastSeen: SharingCert): void {
  const W = 'sharing-cert';
  if (lastSeen.owner !== next.owner) throw new SignatureError(`${W}: lastSeen belongs to another owner`, 'OWNER_MISMATCH');
  if (next.rotation < lastSeen.rotation) throw new RollbackError(`${W}: rotation ${next.rotation} is older than last seen ${lastSeen.rotation}`);
  if (next.rotation === lastSeen.rotation) {
    if (next.key !== lastSeen.key || next.revoked_devices.join() !== lastSeen.revoked_devices.join()) {
      throw new RollbackError(`${W}: two different certificates for rotation ${next.rotation}`, true);
    }
    return;
  }
  const now = new Set(next.revoked_devices);
  if (lastSeen.revoked_devices.some((d) => !now.has(d))) throw new RollbackError(`${W}: a later rotation cannot un-revoke a device`);
}
