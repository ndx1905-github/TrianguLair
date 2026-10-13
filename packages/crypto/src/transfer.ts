import {
  canonicalize,
  checkKeys,
  checkVersion,
  concat,
  fromB64Url,
  fromUtf8,
  parseJsonObject,
  readU32be,
  toB64Url,
  u32be,
  utf8,
  type JsonObject,
} from './encoding';
import { DecryptionError, FormatError, TLCryptoError, UnsupportedVersionError } from './errors';
import { identityFromRootSeed, verifySharingCert, type Identity, type KeyPair, type SharingCert } from './identity';
import { S } from './sodium';

/*
 * Transfer blob (moving keys to a new device), big-endian:
 *   0   4   magic "TLTX"
 *   4   1   version (= 1)
 *   5   4   Argon2id opslimit
 *   9   4   Argon2id memlimit (bytes)
 *   13  16  salt
 *   29  24  nonce
 *   53  ... XChaCha20-Poly1305(payload), AD = bytes[0..53)
 * key = crypto_pwhash(32, normalizedCode, salt, ops, mem, ARGON2ID13)
 *
 * Transfer code: 12 Crockford-base32 chars (60 bits), shown as XXXX-XXXX-XXXX.
 */

const MAGIC = utf8('TLTX');
export const TRANSFER_VERSION = 1;
const HEADER_BYTES = 53;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_OPS = 10;
const MAX_MEM = 1024 * 1024 * 1024;

export interface TransferParams {
  opslimit: number;
  memlimit: number;
}

export function generateTransferCode(): string {
  const s = S();
  let out = '';
  for (let i = 0; i < 12; i++) out += ALPHABET[s.randombytes_uniform(32)];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

/** Uppercases, strips separators/spaces, maps O->0 and I/L->1. Throws INVALID_CODE. */
export function normalizeTransferCode(code: string): string {
  const c = code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (c.length !== 12 || [...c].some((ch) => !ALPHABET.includes(ch))) {
    throw new TLCryptoError('INVALID_CODE', 'transfer code must be 12 Crockford base32 characters');
  }
  return c;
}

function deriveKey(code: string, salt: Uint8Array, p: TransferParams): Uint8Array {
  const s = S();
  return s.crypto_pwhash(32, utf8(normalizeTransferCode(code)), salt, p.opslimit, p.memlimit, s.crypto_pwhash_ALG_ARGON2ID13);
}

export function encryptForTransfer(payload: Uint8Array, code: string, params?: TransferParams): Uint8Array {
  const s = S();
  const p = params ?? { opslimit: s.crypto_pwhash_OPSLIMIT_INTERACTIVE, memlimit: s.crypto_pwhash_MEMLIMIT_INTERACTIVE };
  if (p.opslimit < 1 || p.opslimit > MAX_OPS || p.memlimit < 8192 || p.memlimit > MAX_MEM) throw new FormatError('transfer: argon2 params out of range');
  const salt = s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
  const nonce = s.randombytes_buf(24);
  const header = concat(MAGIC, Uint8Array.of(TRANSFER_VERSION), u32be(p.opslimit), u32be(p.memlimit), salt, nonce);
  const key = deriveKey(code, salt, p);
  try {
    return concat(header, s.crypto_aead_xchacha20poly1305_ietf_encrypt(payload, header, null, nonce, key));
  } finally {
    s.memzero(key);
  }
}

export function decryptTransfer(blob: Uint8Array, code: string): Uint8Array {
  const s = S();
  const W = 'transfer';
  if (blob.length < HEADER_BYTES + 16) throw new FormatError(`${W}: too short`);
  for (let i = 0; i < 4; i++) if (blob[i] !== MAGIC[i]) throw new FormatError(`${W}: bad magic`);
  const ver = blob[4] as number;
  if (ver > TRANSFER_VERSION) throw new UnsupportedVersionError(W, ver, TRANSFER_VERSION);
  if (ver < 1) throw new FormatError(`${W}: bad version`);
  const p = { opslimit: readU32be(blob, 5), memlimit: readU32be(blob, 9) };
  // Bound attacker-controlled cost parameters (DoS).
  if (p.opslimit < 1 || p.opslimit > MAX_OPS || p.memlimit < 8192 || p.memlimit > MAX_MEM) throw new FormatError(`${W}: argon2 params out of range`);
  const header = blob.subarray(0, HEADER_BYTES);
  const salt = blob.subarray(13, 29);
  const nonce = blob.subarray(29, 53);
  const key = deriveKey(code, salt, p);
  try {
    return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, blob.subarray(HEADER_BYTES), header, nonce, key);
  } catch {
    throw new DecryptionError(`${W}: wrong code or tampered data`);
  } finally {
    s.memzero(key);
  }
}

// ---------------------------------------------------------------------------
// Key export (device keys). Payload for encryptForTransfer, canonical JSON:
//   {"type":"key-export","version":1,"root":"<b64url 32B>"?,"sharing":{"secretKey":"<b64url>","cert":{...}}?}
// A full device gets `root` (whole identity). A limited device only gets a copy of the
// current sharing key + its certificate: it can read/wrap content but cannot sign.
// ---------------------------------------------------------------------------

export const KEY_EXPORT_VERSION = 1;

export interface KeyExport {
  identity?: Identity;
  sharing?: { keyPair: KeyPair; cert: SharingCert };
}

export function encodeKeyExport(exp: KeyExport): Uint8Array {
  const doc: JsonObject = { type: 'key-export', version: KEY_EXPORT_VERSION };
  if (exp.identity) doc['root'] = toB64Url(exp.identity.rootSeed);
  if (exp.sharing) doc['sharing'] = { secretKey: toB64Url(exp.sharing.keyPair.secretKey), cert: exp.sharing.cert as unknown as JsonObject };
  if (!exp.identity && !exp.sharing) throw new FormatError('key-export: nothing to export');
  return utf8(canonicalize(doc));
}

export function decodeKeyExport(bytes: Uint8Array): KeyExport {
  const W = 'key-export';
  const doc = parseJsonObject(fromUtf8(bytes, W), W);
  checkVersion(doc, W, KEY_EXPORT_VERSION);
  checkKeys(doc, W, ['type', 'version'], ['root', 'sharing']);
  if (doc['type'] !== 'key-export') throw new FormatError(`${W}: wrong type`);
  const out: KeyExport = {};
  if ('root' in doc) out.identity = identityFromRootSeed(fromB64Url(doc['root'], `${W}.root`, 32));
  if ('sharing' in doc) {
    const sh = parseJsonObject(doc['sharing'] as JsonObject, `${W}.sharing`);
    checkKeys(sh, `${W}.sharing`, ['secretKey', 'cert']);
    const secretKey = fromB64Url(sh['secretKey'], `${W}.sharing.secretKey`, 32);
    const v = verifySharingCert(sh['cert'] as JsonObject);
    const publicKey = S().crypto_scalarmult_base(secretKey);
    if (!S().memcmp(publicKey, v.sharingPublicKey)) throw new FormatError(`${W}: sharing key does not match certificate`);
    out.sharing = { keyPair: { publicKey, secretKey }, cert: v.cert };
  }
  return out;
}
