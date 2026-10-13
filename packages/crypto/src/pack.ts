import {
  canonicalize,
  checkKeys,
  checkVersion,
  concat,
  fromB64Url,
  fromUtf8,
  parseJsonObject,
  readU32be,
  str,
  toB64Url,
  u32be,
  utf8,
} from './encoding';
import { DecryptionError, FormatError, UnsupportedVersionError } from './errors';
import type { KeyPair } from './identity';
import { S } from './sodium';

/*
 * Pack binary layout (all integers big-endian):
 *
 *   offset  size  field
 *   0       4     magic "TLPK"
 *   4       1     envelope version (= 1)
 *   5       4     N = header length in bytes
 *   9       N     header: canonical JSON, UTF-8
 *   9+N     ...   ciphertext = XChaCha20-Poly1305-IETF(payload) || 16-byte tag
 *
 * Header JSON:
 *   { "alg":"xchacha20poly1305-ietf", "id":"<b64url 16B>", "nonce":"<b64url 24B>",
 *     "type":"pack", "version":1, "wrapAlg":"x25519-sealedbox",
 *     "wraps":["<b64url 80B>", ...] }
 *
 * AEAD associated data = magic || envelope version || canonicalJSON(header WITHOUT "wraps").
 * Wraps are deliberately outside the AD (like JWE per-recipient encrypted_key) so the
 * owner can re-wrap a pack (add a friend, drop an invitation key) without touching the
 * ciphertext. A tampered wrap can only fail to open; pack authenticity w.r.t. the owner
 * comes from the signed index (etag = hash of the whole pack file).
 *
 * Each wrap = crypto_box_seal(batchKey, recipientX25519Pk): 32B ephemeral pk || 48B box.
 * No recipient identifier is stored; readers try every wrap with every key they hold.
 */

const MAGIC = utf8('TLPK');
export const PACK_VERSION = 1;
const ALG = 'xchacha20poly1305-ietf';
const WRAP_ALG = 'x25519-sealedbox';
const WRAP_BYTES = 80; // 32 (ephemeral pk) + 16 (MAC) + 32 (batch key)
const MAX_WRAPS = 4096;
const MAX_HEADER = 1 << 20;

interface ProtectedHeader {
  type: 'pack';
  version: number;
  id: string;
  alg: typeof ALG;
  wrapAlg: typeof WRAP_ALG;
  nonce: string;
}

export interface PackHeader extends ProtectedHeader {
  wraps: string[];
}

export interface SealOptions {
  /** Pack id (b64url of 16 bytes). Random by default. */
  id?: string;
  /**
   * Pad the wrap list with indistinguishable dummy wraps up to this count, hiding the
   * number of recipients. Default: next power of two >= max(recipients, 2).
   * Pass 0 to disable padding.
   */
  padTo?: number;
}

export interface OpenedPack {
  id: string;
  payload: Uint8Array;
}

function adFor(ph: ProtectedHeader): Uint8Array {
  return concat(MAGIC, Uint8Array.of(PACK_VERSION), utf8(canonicalize(ph)));
}

function shuffle<T>(arr: T[]): T[] {
  const s = S();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = s.randombytes_uniform(i + 1);
    [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
  }
  return arr;
}

function defaultPad(n: number): number {
  let p = 2;
  while (p < n) p *= 2;
  return p;
}

function makeWraps(batchKey: Uint8Array, recipients: Uint8Array[], padTo: number | undefined): string[] {
  const s = S();
  if (recipients.length === 0) throw new FormatError('pack: at least one recipient is required');
  const wraps: Uint8Array[] = [];
  for (const pk of recipients) {
    if (!(pk instanceof Uint8Array) || pk.length !== 32) throw new FormatError('pack: recipient public keys must be 32-byte X25519 keys');
    wraps.push(s.crypto_box_seal(batchKey, pk));
  }
  const target = padTo ?? defaultPad(recipients.length);
  while (wraps.length < target) {
    // Dummy: a real sealed box of random bytes to a throwaway key -> indistinguishable.
    wraps.push(s.crypto_box_seal(s.randombytes_buf(32), s.crypto_box_keypair().publicKey));
  }
  if (wraps.length > MAX_WRAPS) throw new FormatError(`pack: too many wraps (max ${MAX_WRAPS})`);
  return shuffle(wraps).map(toB64Url);
}

function encode(ph: ProtectedHeader, wraps: string[], ciphertext: Uint8Array): Uint8Array {
  const header: PackHeader = { ...ph, wraps };
  const hb = utf8(canonicalize(header));
  return concat(MAGIC, Uint8Array.of(PACK_VERSION), u32be(hb.length), hb, ciphertext);
}

interface Decoded {
  header: PackHeader;
  ph: ProtectedHeader;
  ciphertext: Uint8Array;
}

function decode(bytes: Uint8Array): Decoded {
  const W = 'pack';
  if (!(bytes instanceof Uint8Array) || bytes.length < 9) throw new FormatError(`${W}: too short`);
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new FormatError(`${W}: bad magic`);
  const ver = bytes[4] as number;
  if (ver > PACK_VERSION) throw new UnsupportedVersionError(W, ver, PACK_VERSION);
  if (ver < 1) throw new FormatError(`${W}: bad envelope version`);
  const n = readU32be(bytes, 5);
  if (n > MAX_HEADER || 9 + n > bytes.length) throw new FormatError(`${W}: bad header length`);
  const h = parseJsonObject(fromUtf8(bytes.subarray(9, 9 + n), `${W} header`), `${W} header`);
  checkVersion(h, `${W} header`, PACK_VERSION);
  if (h['version'] !== ver) throw new FormatError(`${W}: header/envelope version mismatch`);
  checkKeys(h, `${W} header`, ['type', 'version', 'id', 'alg', 'wrapAlg', 'nonce', 'wraps']);
  if (h['type'] !== 'pack') throw new FormatError(`${W}: wrong type`);
  if (h['alg'] !== ALG) throw new FormatError(`${W}: unsupported alg`);
  if (h['wrapAlg'] !== WRAP_ALG) throw new FormatError(`${W}: unsupported wrapAlg`);
  const id = str(h, 'id', W);
  fromB64Url(id, `${W}.id`, 16);
  const nonce = str(h, 'nonce', W);
  fromB64Url(nonce, `${W}.nonce`, 24);
  const wraps = h['wraps'];
  if (!Array.isArray(wraps) || wraps.length === 0 || wraps.length > MAX_WRAPS) throw new FormatError(`${W}: bad wraps`);
  for (const w of wraps) fromB64Url(w, `${W}.wrap`, WRAP_BYTES);
  const ph: ProtectedHeader = { type: 'pack', version: ver, id, alg: ALG, wrapAlg: WRAP_ALG, nonce };
  return { header: { ...ph, wraps: wraps as string[] }, ph, ciphertext: bytes.subarray(9 + n) };
}

/** Parses and validates the public header (no decryption). */
export function readPackHeader(bytes: Uint8Array): PackHeader {
  return decode(bytes).header;
}

function newPackId(): string {
  return toB64Url(S().randombytes_buf(16));
}

function encryptWithKey(payload: Uint8Array, batchKey: Uint8Array, recipients: Uint8Array[], opts: SealOptions): Uint8Array {
  const s = S();
  const id = opts.id ?? newPackId();
  fromB64Url(id, 'pack.id', 16);
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ph: ProtectedHeader = { type: 'pack', version: PACK_VERSION, id, alg: ALG, wrapAlg: WRAP_ALG, nonce: toB64Url(nonce) };
  const wraps = makeWraps(batchKey, recipients, opts.padTo);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(payload, adFor(ph), null, nonce, batchKey);
  return encode(ph, wraps, ct);
}

/** Encrypts `payload` with a fresh random batch key wrapped to every recipient X25519 public key. */
export function sealPack(payload: Uint8Array, recipients: Uint8Array[], opts: SealOptions = {}): Uint8Array {
  const batchKey = S().crypto_aead_xchacha20poly1305_ietf_keygen();
  try {
    return encryptWithKey(payload, batchKey, recipients, opts);
  } finally {
    S().memzero(batchKey);
  }
}

function openInternal(bytes: Uint8Array, keys: KeyPair[]): { d: Decoded; payload: Uint8Array; batchKey: Uint8Array } {
  const s = S();
  const d = decode(bytes);
  const ad = adFor(d.ph);
  const nonce = fromB64Url(d.ph.nonce, 'pack.nonce', 24);
  let unwrapped = false;
  for (const w of d.header.wraps) {
    const wrap = fromB64Url(w, 'pack.wrap', WRAP_BYTES);
    for (const k of keys) {
      let batchKey: Uint8Array;
      try {
        batchKey = s.crypto_box_seal_open(wrap, k.publicKey, k.secretKey);
      } catch {
        continue;
      }
      unwrapped = true;
      try {
        const payload = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, d.ciphertext, ad, nonce, batchKey);
        return { d, payload, batchKey };
      } catch {
        // A wrap addressed to us but whose key does not decrypt: tampering or forged wrap. Keep trying.
      }
    }
  }
  if (unwrapped) throw new DecryptionError('pack: authentication failed (header or ciphertext tampered)');
  throw new DecryptionError('pack: none of the provided keys can open this pack', 'NO_MATCHING_KEY');
}

/** Tries every wrap with every candidate key (sharing key, group keys, invitation key...). */
export function openPack(bytes: Uint8Array, keys: KeyPair[]): OpenedPack {
  const { d, payload, batchKey } = openInternal(bytes, keys);
  S().memzero(batchKey);
  return { id: d.ph.id, payload };
}

/**
 * Same batch key and ciphertext, new wrap list. Use to ADD recipients or replace an
 * invitation key by the invitee's real key. NOT a revocation: anyone who could unwrap
 * before still knows the batch key (use reencryptPack for that).
 */
export function rewrapPack(bytes: Uint8Array, keys: KeyPair[], recipients: Uint8Array[], opts: Omit<SealOptions, 'id'> = {}): Uint8Array {
  const { d, batchKey } = openInternal(bytes, keys);
  try {
    return encode(d.ph, makeWraps(batchKey, recipients, opts.padTo), d.ciphertext);
  } finally {
    S().memzero(batchKey);
  }
}

/** Revocation: decrypts, then re-encrypts under a NEW batch key wrapped only to `recipients`. Keeps the pack id. */
export function reencryptPack(bytes: Uint8Array, keys: KeyPair[], recipients: Uint8Array[], opts: Omit<SealOptions, 'id'> = {}): Uint8Array {
  const { id, payload } = openPack(bytes, keys);
  return sealPack(payload, recipients, { ...opts, id });
}

/** Content hash of a pack file for the signed index: b64url(BLAKE2b-128(bytes)). */
export function packEtag(bytes: Uint8Array): string {
  return toB64Url(S().crypto_generichash(16, bytes, null));
}
