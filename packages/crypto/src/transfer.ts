import { wordlist } from '@scure/bip39/wordlists/english.js';
import { verifySharingCert, type SharingCertOptions } from './certs';
import {
  bytesEqual,
  canonicalize,
  checkByteVersion,
  checkStructure,
  concat,
  fromB64Url,
  fromUtf8,
  nowMs,
  parseJsonObject,
  readU32be,
  toB64Url,
  u32be,
  utf8,
  type JsonObject,
} from './encoding';
import { DecryptionError, ExpiredError, FormatError, TLCryptoError } from './errors';
import type { SharingKey } from './sharing-key';
import { S } from './sodium';

/*
 * Transfer blob ("Link + code" way of adding a device), big-endian:
 *   0   4   magic "TLTX"
 *   4   1   version (= 2)
 *   5   1   purpose (1 = key-export)
 *   6   4   Argon2id opslimit
 *   10  4   Argon2id memlimit (bytes)
 *   14  4   expires, unix seconds (default: 15 minutes after creation)
 *   18  16  salt
 *   34  24  nonce
 *   58  ... XChaCha20-Poly1305(payload), AD = bytes[0..58)
 * key = crypto_pwhash(32, normalizedCode, salt, ops, mem, ARGON2ID13)
 * Parameters are floored at libsodium INTERACTIVE (2 passes, 64 MiB) and capped at 10 passes,
 * 256 MiB. The receiver rejects expired blobs; single use = deleting the blob from the storage.
 *
 * Transfer code: 6 words of the BIP39 English list (2048 words => 66 bits), as the spec says.
 */

const MAGIC = utf8('TLTX');
export const TRANSFER_VERSION = 2;
const PURPOSE_KEY_EXPORT = 1;
const HEADER_BYTES = 58;
const MAX_OPS = 10;
const MAX_MEM = 256 * 1024 * 1024;
export const TRANSFER_TTL_MS = 15 * 60 * 1000;
const CODE_WORDS = 6;

export interface TransferParams {
  opslimit: number;
  memlimit: number;
}

export function generateTransferCode(): string {
  const s = S();
  const words: string[] = [];
  for (let i = 0; i < CODE_WORDS; i++) words.push(wordlist[s.randombytes_uniform(wordlist.length)] as string);
  return words.join(' ');
}

const byPrefix = new Map<string, string>();

/**
 * Lowercases, accepts spaces or hyphens as separators, and each word in full or by its first 4
 * letters (unique in the BIP39 list). Returns the 6 full words separated by single spaces.
 * Throws code INVALID_CODE.
 */
export function normalizeTransferCode(code: string): string {
  if (byPrefix.size === 0) for (const w of wordlist) byPrefix.set(w.slice(0, 4), w); // 3-letter words map to themselves
  const parts = String(code).normalize('NFKD').toLowerCase().trim().split(/[\s-]+/).filter(Boolean);
  const words = parts.map((p) => (p.length >= 3 ? byPrefix.get(p.slice(0, 4)) : undefined));
  if (parts.length !== CODE_WORDS || words.some((w, i) => w === undefined || !w.startsWith(parts[i] as string))) {
    throw new TLCryptoError('INVALID_CODE', 'transfer code must be 6 words from the list');
  }
  return words.join(' ');
}

function checkParams(p: TransferParams, W: string): void {
  const s = S();
  if (
    !Number.isSafeInteger(p.opslimit) ||
    !Number.isSafeInteger(p.memlimit) ||
    p.opslimit < s.crypto_pwhash_OPSLIMIT_INTERACTIVE ||
    p.opslimit > MAX_OPS ||
    p.memlimit < s.crypto_pwhash_MEMLIMIT_INTERACTIVE ||
    p.memlimit > MAX_MEM
  ) {
    throw new FormatError(`${W}: argon2 params out of range`);
  }
}

function deriveKey(code: string, salt: Uint8Array, p: TransferParams): Uint8Array {
  const s = S();
  return s.crypto_pwhash(32, utf8(normalizeTransferCode(code)), salt, p.opslimit, p.memlimit, s.crypto_pwhash_ALG_ARGON2ID13);
}

export function encryptForTransfer(payload: Uint8Array, code: string, opts: { params?: TransferParams; ttlMs?: number; now?: Date } = {}): Uint8Array {
  const s = S();
  const W = 'transfer';
  const p = opts.params ?? { opslimit: s.crypto_pwhash_OPSLIMIT_INTERACTIVE, memlimit: s.crypto_pwhash_MEMLIMIT_INTERACTIVE };
  checkParams(p, W);
  const ttl = opts.ttlMs ?? TRANSFER_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > TRANSFER_TTL_MS) throw new FormatError(`${W}: ttlMs must be between 1 s and 15 minutes`);
  const expires = Math.floor((nowMs(opts.now, W) + ttl) / 1000);
  const salt = s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
  const nonce = s.randombytes_buf(24);
  const header = concat(MAGIC, Uint8Array.of(TRANSFER_VERSION, PURPOSE_KEY_EXPORT), u32be(p.opslimit), u32be(p.memlimit), u32be(expires), salt, nonce);
  const key = deriveKey(code, salt, p);
  try {
    return concat(header, s.crypto_aead_xchacha20poly1305_ietf_encrypt(payload, header, null, nonce, key));
  } finally {
    s.memzero(key);
  }
}

/** Throws ExpiredError after the blob's expiry (checked before the slow key derivation). */
export function decryptTransfer(blob: Uint8Array, code: string, opts: { now?: Date } = {}): Uint8Array {
  const s = S();
  const W = 'transfer';
  if (!(blob instanceof Uint8Array) || blob.length < HEADER_BYTES + 16) throw new FormatError(`${W}: too short`);
  if (!bytesEqual(blob.subarray(0, 4), MAGIC)) throw new FormatError(`${W}: bad magic`);
  checkByteVersion(blob[4] as number, W, TRANSFER_VERSION);
  if (blob[5] !== PURPOSE_KEY_EXPORT) throw new FormatError(`${W}: unknown purpose`);
  const p = { opslimit: readU32be(blob, 6), memlimit: readU32be(blob, 10) };
  // Bound attacker-controlled cost parameters (DoS).
  checkParams(p, W);
  const expires = readU32be(blob, 14);
  if (nowMs(opts.now, W) >= expires * 1000) throw new ExpiredError(`${W}: expired`);
  const header = blob.subarray(0, HEADER_BYTES);
  const salt = blob.subarray(18, 34);
  const nonce = blob.subarray(34, 58);
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
// Key export: payload for encryptForTransfer, canonical JSON
//   {"cert":<sharing cert>,"secret":"<b64url 32B>","type":"key-export","vault_key":"<b64url 32B>","version":3}
// Only the CURRENT sharing key and vault data key travel. The master key never does (it stays with the phrase and
// the optional primary device); the new device generates its own device keys and gets a device
// certificate from the primary device or the phrase.
// ---------------------------------------------------------------------------

export const KEY_EXPORT_VERSION = 3;

export function encodeKeyExport(sharing: SharingKey): Uint8Array {
  const v = verifySharingCert(sharing.cert);
  if (!bytesEqual(S().crypto_scalarmult_base(sharing.keyPair.secretKey), v.sharingPublicKey)) {
    throw new FormatError('key-export: sharing key does not match certificate');
  }
  if (!(sharing.vaultDataKey instanceof Uint8Array) || sharing.vaultDataKey.length !== 32) throw new FormatError('key-export: vault data key must be 32 bytes');
  return utf8(
    canonicalize({
      type: 'key-export',
      version: KEY_EXPORT_VERSION,
      secret: toB64Url(sharing.keyPair.secretKey),
      vault_key: toB64Url(sharing.vaultDataKey),
      cert: v.cert as unknown as JsonObject,
    }),
  );
}

/** Pass `expectedOwner`, and `lastSeen` if the receiving device already holds a sharing key (R-08). */
export function decodeKeyExport(bytes: Uint8Array, opts: SharingCertOptions = {}): SharingKey {
  const W = 'key-export';
  const doc = parseJsonObject(fromUtf8(bytes, W), W);
  checkStructure(doc, W, KEY_EXPORT_VERSION, ['type', 'version', 'secret', 'vault_key', 'cert']);
  if (doc['type'] !== 'key-export') throw new FormatError(`${W}: wrong type`);
  const v = verifySharingCert(doc['cert'] as JsonObject, opts);
  const secretKey = fromB64Url(doc['secret'], `${W}.secret`, 32);
  const publicKey = S().crypto_scalarmult_base(secretKey);
  if (!bytesEqual(publicKey, v.sharingPublicKey)) throw new FormatError(`${W}: sharing key does not match certificate`);
  return { keyPair: { publicKey, secretKey }, cert: v.cert, vaultDataKey: fromB64Url(doc['vault_key'], `${W}.vault_key`, 32) };
}
