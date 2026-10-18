import { verifyDeviceCert, verifySharingCert, type DeviceCert, type SharingCert, type SharingCertOptions } from './certs';
import {
  bytesEqual,
  canonicalize,
  checkByteVersion,
  checkStructure,
  concat,
  fromB64Url,
  fromUtf8,
  parseJsonObject,
  parseKey,
  Reader,
  toB64Url,
  utf8,
  type JsonObject,
} from './encoding';
import { DecryptionError, FormatError, SignatureError } from './errors';
import type { DeviceKeys, Identity, KeyPair } from './identity';
import { S } from './sodium';

/**
 * The secrets every device of an owner holds: the current sharing key pair with its master-signed
 * certificate, and the current random VAULT DATA KEY (encrypts the recovery-vault records, see
 * vault.ts). Both are renewed when a device is declared lost.
 */
export interface SharingKey {
  keyPair: KeyPair;
  cert: SharingCert;
  /** 32-byte random vault data key (generateVaultDataKey). Not derived from the phrase. */
  vaultDataKey: Uint8Array;
}

/** New random 32-byte vault data key (spec "Recovery kit"). */
export function generateVaultDataKey(): Uint8Array {
  return S().crypto_aead_xchacha20poly1305_ietf_keygen();
}

/*
 * Sealed sharing key: how the CURRENT sharing key and vault data key reach each device, and the
 * phrase-protected copy kept in the recovery vault.
 *
 *   0  4  magic "TLSK"
 *   4  1  version (= 2)
 *   5  1  mode: 1 = sealed to a device, 2 = recovery vault
 *   mode 1:  crypto_box_seal(payload, device box key)
 *   mode 2:  nonce 24B || XChaCha20-Poly1305(payload, AD = bytes[0..6) || nonce, key = Identity.vaultKey)
 *
 * payload = canonical JSON {"cert":<sharing cert>,"secret":"<b64url 32B>","to":"<device id | owner id>",
 *                           "type":"sharing-key","vault_key":"<b64url 32B>","version":2}
 * `to` binds the payload to its recipient (the device id, or the owner id for the vault).
 * Identity.vaultKey derives from the phrase only, so a stolen ordinary device cannot open the vault
 * copy of a sharing key or vault data key created after the theft.
 */

const MAGIC = utf8('TLSK');
export const SHARING_KEY_VERSION = 2;
const MODE_DEVICE = 1;
const MODE_VAULT = 2;

function isDeviceCert(x: DeviceCert | Identity): x is DeviceCert {
  return (x as DeviceCert).type === 'device-cert';
}

function payloadFor(sharing: SharingKey, to: string): Uint8Array {
  const v = verifySharingCert(sharing.cert);
  const pk = S().crypto_scalarmult_base(sharing.keyPair.secretKey);
  if (!bytesEqual(pk, v.sharingPublicKey)) throw new FormatError('sharing-key: key pair does not match certificate');
  if (!(sharing.vaultDataKey instanceof Uint8Array) || sharing.vaultDataKey.length !== 32) throw new FormatError('sharing-key: vault data key must be 32 bytes');
  return utf8(
    canonicalize({
      type: 'sharing-key',
      version: SHARING_KEY_VERSION,
      to,
      secret: toB64Url(sharing.keyPair.secretKey),
      vault_key: toB64Url(sharing.vaultDataKey),
      cert: v.cert as unknown as JsonObject,
    }),
  );
}

/** Seals the current sharing key and vault data key to a certified device (from its device cert) or to the recovery vault (Identity). */
export function sealSharingKey(sharing: SharingKey, to: DeviceCert | Identity): Uint8Array {
  const s = S();
  if (isDeviceCert(to)) {
    const dc = verifyDeviceCert(to, { expectedOwner: sharing.cert.owner });
    // R-07: never hand a new sharing key to a device that this very certificate revokes.
    if (sharing.cert.revoked_devices.includes(dc.device)) throw new SignatureError('sharing-key: the device is revoked by this certificate', 'REVOKED');
    const payload = payloadFor(sharing, dc.device);
    try {
      return concat(MAGIC, Uint8Array.of(SHARING_KEY_VERSION, MODE_DEVICE), s.crypto_box_seal(payload, parseKey('x25519', dc.box)));
    } finally {
      s.memzero(payload);
    }
  }
  if (sharing.cert.owner !== to.owner) throw new SignatureError('sharing-key: certificate belongs to another owner', 'OWNER_MISMATCH');
  const payload = payloadFor(sharing, to.owner);
  const head = concat(MAGIC, Uint8Array.of(SHARING_KEY_VERSION, MODE_VAULT));
  const nonce = s.randombytes_buf(24);
  try {
    const ad = concat(head, nonce);
    return concat(ad, s.crypto_aead_xchacha20poly1305_ietf_encrypt(payload, ad, null, nonce, to.vaultKey));
  } finally {
    s.memzero(payload);
  }
}

/**
 * Opens a sealed sharing key with this device's keys, or with the Identity (vault copy).
 * Pass `expectedOwner` on a device (the Identity path always checks its own owner), and `lastSeen`
 * (the sharing cert currently held) whenever there is one: anyone can seal to a device's public box
 * key, so without it a thief could push back an older, compromised sharing key (R-08).
 */
export function openSharingKey(bytes: Uint8Array, holder: DeviceKeys | Identity, opts: SharingCertOptions = {}): SharingKey {
  const W = 'sharing-key';
  const s = S();
  const r = new Reader(bytes, W);
  if (!bytesEqual(r.bytes(4), MAGIC)) throw new FormatError(`${W}: bad magic`);
  checkByteVersion(r.u8(), W, SHARING_KEY_VERSION);
  const mode = r.u8();
  const isDevice = 'box' in holder;
  let plain: Uint8Array;
  if (mode === MODE_DEVICE && isDevice) {
    try {
      plain = s.crypto_box_seal_open(r.rest(), holder.box.publicKey, holder.box.secretKey);
    } catch {
      throw new DecryptionError(`${W}: cannot open (not sealed to this device, or tampered)`);
    }
  } else if (mode === MODE_VAULT && !isDevice) {
    const nonce = r.bytes(24);
    const ad = bytes.subarray(0, r.offset);
    try {
      plain = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, r.rest(), ad, nonce, holder.vaultKey);
    } catch {
      throw new DecryptionError(`${W}: cannot open vault copy (other identity, or tampered)`);
    }
  } else {
    throw new FormatError(`${W}: mode does not match the holder`);
  }
  try {
    const doc = parseJsonObject(fromUtf8(plain, W), W);
    checkStructure(doc, W, SHARING_KEY_VERSION, ['type', 'version', 'to', 'secret', 'vault_key', 'cert']);
    if (doc['type'] !== W) throw new FormatError(`${W}: wrong type`);
    const expectedTo = isDevice ? holder.id : holder.owner;
    if (doc['to'] !== expectedTo) throw new FormatError(`${W}: addressed to another recipient`);
    const trust: SharingCertOptions = isDevice ? opts : { ...opts, expectedOwner: holder.owner };
    const v = verifySharingCert(doc['cert'] as JsonObject, trust);
    const secretKey = fromB64Url(doc['secret'], `${W}.secret`, 32);
    const publicKey = s.crypto_scalarmult_base(secretKey);
    if (!bytesEqual(publicKey, v.sharingPublicKey)) throw new FormatError(`${W}: secret does not match certificate`);
    return { keyPair: { publicKey, secretKey }, cert: v.cert, vaultDataKey: fromB64Url(doc['vault_key'], `${W}.vault_key`, 32) };
  } finally {
    s.memzero(plain);
  }
}
