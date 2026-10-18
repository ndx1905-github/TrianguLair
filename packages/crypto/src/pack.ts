import {
  assertX25519PublicKey,
  bytesEqual,
  canonicalize,
  checkKeys,
  checkVersion,
  concat,
  fromB64Url,
  fromUtf8,
  parseJsonObject,
  parseKey,
  readU32be,
  str,
  toB64Url,
  u32be,
  utf8,
} from './encoding';
import { DecryptionError, FormatError, InvalidKeyError, UnsupportedVersionError } from './errors';
import type { KeyPair } from './identity';
import { S } from './sodium';
import { isVerified } from './verified';

/*
 * Pack binary layout (all integers big-endian):
 *
 *   offset  size  field
 *   0       4     magic "TLPK"
 *   4       1     envelope version (= 3)
 *   5       4     N = header length in bytes
 *   9       N     header: canonical JSON, UTF-8 (non-canonical headers are rejected)
 *   9+N     ...   ciphertext = XChaCha20-Poly1305-IETF(plaintext) || 16-byte tag
 *
 * Header JSON:
 *   { "alg":"xchacha20poly1305-ietf", "nonce":"<b64url 24B>", "pad":"padme", "type":"pack",
 *     "version":3, "wrapAlg":"x25519-sealedbox", "wraps":["<b64url 80B>", ...] }
 *
 * Plaintext = logical id (16 B) || u32 payload length || payload || zero padding.
 * With pad = "padme", the plaintext length is max(256, Padmé(20 + payload length)) (≤ 12 % overhead);
 * with pad = "none" there is no padding. Readers check the exact length and that padding is zeros.
 * The logical pack id is inside the encryption: the storage and former recipients cannot link
 * successive versions of a pack. Files are content-addressed (packEntry) and never modified.
 *
 * AEAD associated data = magic || envelope version || owner master public key (32 B) ||
 * canonicalJSON(header WITHOUT "wraps").
 * The owner is not written in the file: the reader takes it from the verified index the pack is
 * listed in. A pack re-listed in someone else's index (re-attribution, resurrection of deleted
 * content under another name) fails authentication (version 3, R-05).
 * Wraps are outside the AD (like JWE per-recipient encrypted_key); a tampered wrap can only fail to
 * open. Authenticity w.r.t. the owner comes from the signed index (hash of the whole file), which
 * openPack checks BEFORE any decryption.
 *
 * Each wrap = crypto_box_seal(batchKey, recipientX25519Pk): 32B ephemeral pk || 48B box.
 * No recipient identifier is stored; readers try every wrap with every key they hold.
 */

const MAGIC = utf8('TLPK');
export const PACK_VERSION = 3;
const ALG = 'xchacha20poly1305-ietf';
const WRAP_ALG = 'x25519-sealedbox';
const WRAP_BYTES = 80; // 32 (ephemeral pk) + 16 (MAC) + 32 (batch key)
export const MAX_WRAPS = 256;
const MAX_HEADER = 64 * 1024;
const ID_BYTES = 16;
const FRAME = ID_BYTES + 4;
const MIN_PADDED = 256;

export type PackPadding = 'padme' | 'none';

interface ProtectedHeader {
  type: 'pack';
  version: number;
  alg: typeof ALG;
  wrapAlg: typeof WRAP_ALG;
  nonce: string;
  pad: PackPadding;
}

export interface PackHeader extends ProtectedHeader {
  wraps: string[];
}

export interface SealOptions {
  /** Logical pack id (b64url of 16 bytes), stored inside the encryption. Random by default. */
  id?: string;
  /**
   * Pad the wrap list with indistinguishable dummy wraps up to this count, hiding the number of
   * recipients. Default: next power of two >= max(recipients, 2). 0 disables. Max 256.
   */
  padTo?: number;
  /** Payload padding. Default "padme". */
  pad?: PackPadding;
}

export interface OpenedPack {
  /** Logical id, stable across re-encryptions (only visible after decryption). */
  id: string;
  payload: Uint8Array;
  /** File name of the matching index entry. */
  file: string;
}

/** floor(log2(n)) for an integer 1 <= n < 2^32, with integer operations only. */
function ilog2(n: number): number {
  return 31 - Math.clz32(n);
}

/**
 * Plaintext length for a framed length `n` (= 20 + payload length) under "padme", integer-only so
 * that every implementation agrees: for n <= 256 the result is 256; otherwise
 * e = floor(log2 n), s = floor(log2 e) + 1, step = 2^(e - s), result = ceil(n / step) * step.
 */
export function paddedLength(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new FormatError('pack: length out of range');
  if (n <= MIN_PADDED) return MIN_PADDED;
  const e = ilog2(n);
  const s = ilog2(e) + 1;
  const step = 2 ** (e - s);
  return Math.ceil(n / step) * step;
}

function adFor(ph: ProtectedHeader, ownerPk: Uint8Array): Uint8Array {
  return concat(MAGIC, Uint8Array.of(PACK_VERSION), ownerPk, utf8(canonicalize(ph)));
}

function ownerKey(owner: string): Uint8Array {
  return parseKey('ed25519', owner, 'pack.owner');
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
  if (padTo !== undefined && (!Number.isSafeInteger(padTo) || padTo < 0)) throw new FormatError('pack: padTo must be a non-negative integer');
  const target = Math.max(padTo ?? defaultPad(recipients.length), recipients.length);
  // Bound check BEFORE generating anything (DoS).
  if (target > MAX_WRAPS) throw new FormatError(`pack: too many wraps (max ${MAX_WRAPS})`);
  const wraps: Uint8Array[] = [];
  for (const pk of recipients) {
    assertX25519PublicKey(pk, 'pack recipient');
    try {
      wraps.push(s.crypto_box_seal(batchKey, pk));
    } catch {
      throw new InvalidKeyError('pack: invalid recipient key');
    }
  }
  while (wraps.length < target) {
    // Dummy: a real sealed box of random bytes to a throwaway key -> indistinguishable.
    wraps.push(s.crypto_box_seal(s.randombytes_buf(32), s.crypto_box_keypair().publicKey));
  }
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
  if (ver === 0) throw new FormatError(`${W}: bad envelope version`);
  if (ver !== PACK_VERSION) throw new UnsupportedVersionError(W, ver, PACK_VERSION);
  const n = readU32be(bytes, 5);
  if (n > MAX_HEADER || 9 + n > bytes.length) throw new FormatError(`${W}: bad header length`);
  const h = parseJsonObject(fromUtf8(bytes.subarray(9, 9 + n), `${W} header`), `${W} header`);
  checkVersion(h, `${W} header`, PACK_VERSION);
  checkKeys(h, `${W} header`, ['type', 'version', 'alg', 'wrapAlg', 'nonce', 'pad', 'wraps']);
  if (h['type'] !== 'pack') throw new FormatError(`${W}: wrong type`);
  if (h['alg'] !== ALG) throw new FormatError(`${W}: unsupported alg`);
  if (h['wrapAlg'] !== WRAP_ALG) throw new FormatError(`${W}: unsupported wrapAlg`);
  const pad = h['pad'];
  if (pad !== 'padme' && pad !== 'none') throw new FormatError(`${W}: unsupported pad`);
  const nonce = str(h, 'nonce', W);
  fromB64Url(nonce, `${W}.nonce`, 24);
  const wraps = h['wraps'];
  if (!Array.isArray(wraps) || wraps.length === 0 || wraps.length > MAX_WRAPS) throw new FormatError(`${W}: bad wraps`);
  for (const w of wraps) fromB64Url(w, `${W}.wrap`, WRAP_BYTES);
  const ph: ProtectedHeader = { type: 'pack', version: ver, alg: ALG, wrapAlg: WRAP_ALG, nonce, pad };
  return { header: { ...ph, wraps: wraps as string[] }, ph, ciphertext: bytes.subarray(9 + n) };
}

/** Parses and validates the public header (no decryption). */
export function readPackHeader(bytes: Uint8Array): PackHeader {
  return decode(bytes).header;
}

function frame(id: string, payload: Uint8Array, pad: PackPadding): Uint8Array {
  const idBytes = fromB64Url(id, 'pack.id', ID_BYTES);
  if (payload.length > 0xffffffff - FRAME) throw new FormatError('pack: payload too large');
  const n = FRAME + payload.length;
  const out = new Uint8Array(pad === 'padme' ? paddedLength(n) : n);
  out.set(idBytes, 0);
  out.set(u32be(payload.length), ID_BYTES);
  out.set(payload, FRAME);
  return out;
}

function unframe(pt: Uint8Array, pad: PackPadding): { id: string; payload: Uint8Array } {
  const W = 'pack';
  if (pt.length < FRAME) throw new FormatError(`${W}: plaintext too short`);
  const len = readU32be(pt, ID_BYTES);
  if (len > pt.length - FRAME) throw new FormatError(`${W}: declared length exceeds plaintext`);
  const expected = pad === 'padme' ? paddedLength(FRAME + len) : FRAME + len;
  if (pt.length !== expected) throw new FormatError(`${W}: bad padding length`);
  let acc = 0;
  for (let i = FRAME + len; i < pt.length; i++) acc |= pt[i] as number;
  if (acc !== 0) throw new FormatError(`${W}: non-zero padding`);
  return { id: toB64Url(pt.subarray(0, ID_BYTES)), payload: pt.slice(FRAME, FRAME + len) };
}

function encryptWithKey(owner: string, payload: Uint8Array, batchKey: Uint8Array, recipients: Uint8Array[], opts: SealOptions): Uint8Array {
  const s = S();
  const ownerPk = ownerKey(owner);
  const pad = opts.pad ?? 'padme';
  if (pad !== 'padme' && pad !== 'none') throw new FormatError('pack: unsupported pad');
  const id = opts.id ?? toB64Url(s.randombytes_buf(ID_BYTES));
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ph: ProtectedHeader = { type: 'pack', version: PACK_VERSION, alg: ALG, wrapAlg: WRAP_ALG, nonce: toB64Url(nonce), pad };
  const wraps = makeWraps(batchKey, recipients, opts.padTo);
  const pt = frame(id, payload, pad);
  try {
    return encode(ph, wraps, s.crypto_aead_xchacha20poly1305_ietf_encrypt(pt, adFor(ph, ownerPk), null, nonce, batchKey));
  } finally {
    s.memzero(pt);
  }
}

/**
 * Encrypts `payload` with a fresh random batch key wrapped to every recipient X25519 public key.
 * `owner` ("ed25519:…") is the owner id of the index that will list the pack: it is bound into the
 * AEAD, so the pack only opens through that owner's verified index.
 */
export function sealPack(owner: string, payload: Uint8Array, recipients: Uint8Array[], opts: SealOptions = {}): Uint8Array {
  const batchKey = S().crypto_aead_xchacha20poly1305_ietf_keygen();
  try {
    return encryptWithKey(owner, payload, batchKey, recipients, opts);
  } finally {
    S().memzero(batchKey);
  }
}

/**
 * Unwraps the batch key and decrypts. The caller owns (and must wipe) `batchKey` and `plaintext`.
 * NO index check: internal only.
 */
function openRaw(bytes: Uint8Array, keys: KeyPair[], owner: string): { d: Decoded; plaintext: Uint8Array; batchKey: Uint8Array } {
  const s = S();
  const d = decode(bytes);
  const ad = adFor(d.ph, ownerKey(owner));
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
        const plaintext = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, d.ciphertext, ad, nonce, batchKey);
        return { d, plaintext, batchKey };
      } catch {
        // A wrap addressed to us whose key does not decrypt: tampering or forged wrap. Keep trying.
        s.memzero(batchKey);
      }
    }
  }
  if (unwrapped) throw new DecryptionError('pack: authentication failed (tampered, or listed in another owner\'s index)');
  throw new DecryptionError('pack: none of the provided keys can open this pack', 'NO_MATCHING_KEY');
}

/** @internal Opens without the index check (pack bytes already matched against a verified index). */
export function openUnchecked(bytes: Uint8Array, keys: KeyPair[], owner: string, file = ''): OpenedPack {
  const { d, plaintext, batchKey } = openRaw(bytes, keys, owner);
  S().memzero(batchKey);
  try {
    return { ...unframe(plaintext, d.ph.pad), file };
  } finally {
    S().memzero(plaintext);
  }
}

/** Content hash of a pack (or media) file for the signed index: "b2b256:" + b64url(BLAKE2b-256(bytes)). */
export function packHash(bytes: Uint8Array): string {
  return `b2b256:${toB64Url(S().crypto_generichash(32, bytes, null))}`;
}

/** Index entry for a pack file: content-addressed name `<dir>/b2b256-<b64url hash>.bin` and its hash. */
export function packEntry(bytes: Uint8Array, dir: 'packs' | 'media' = 'packs'): { file: string; hash: string } {
  const hash = packHash(bytes);
  return { file: `${dir}/b2b256-${hash.slice(7)}.bin`, hash };
}

/** Minimal shape of a verified index needed to open packs (see verifyIndex). */
export interface PackIndex {
  owner: string;
  packs: readonly { file: string; hash: string }[];
}

/** @internal Returns the entry of `index` matching the bytes, or throws NOT_INDEXED. Hash first, no X25519. */
export function findIndexed(bytes: Uint8Array, index: PackIndex): { file: string; hash: string } {
  if (!isVerified(index)) throw new DecryptionError('pack: the index must come from verifyIndex or signIndex', 'NOT_INDEXED');
  if (!(bytes instanceof Uint8Array)) throw new FormatError('pack: bytes expected');
  const h = utf8(packHash(bytes));
  const entry = index.packs.find((p) => bytesEqual(utf8(p.hash), h));
  if (!entry) throw new DecryptionError('pack: not listed in the signed index (ignored)', 'NOT_INDEXED');
  return entry;
}

/**
 * Opens a pack reached through a VERIFIED signed index (the object returned by verifyIndex or
 * signIndex). The content hash is checked against the index BEFORE any key operation; a pack
 * that is not listed is rejected with code NOT_INDEXED. Tries every wrap with every candidate key
 * (sharing key, group keys, invitation key...).
 */
export function openPack(bytes: Uint8Array, index: PackIndex, keys: KeyPair[]): OpenedPack {
  const entry = findIndexed(bytes, index);
  return openUnchecked(bytes, keys, index.owner, entry.file);
}

/**
 * Same batch key and ciphertext, new wrap list. Use only to ADD recipients. NOT a revocation:
 * anyone who could unwrap before still knows the batch key (use reencryptPack for that).
 * The result is a new file (new content hash).
 */
export function rewrapPack(bytes: Uint8Array, index: PackIndex, keys: KeyPair[], recipients: Uint8Array[], opts: Pick<SealOptions, 'padTo'> = {}): Uint8Array {
  findIndexed(bytes, index);
  const { d, plaintext, batchKey } = openRaw(bytes, keys, index.owner);
  S().memzero(plaintext);
  try {
    return encode(d.ph, makeWraps(batchKey, recipients, opts.padTo), d.ciphertext);
  } finally {
    S().memzero(batchKey);
  }
}

/** @internal reencrypt without the index check. */
export function reencryptUnchecked(bytes: Uint8Array, keys: KeyPair[], owner: string, recipients: Uint8Array[], opts: Omit<SealOptions, 'id'>): Uint8Array {
  const d = decode(bytes);
  const { id, payload } = openUnchecked(bytes, keys, owner);
  try {
    return sealPack(owner, payload, recipients, { pad: d.ph.pad, ...opts, id });
  } finally {
    S().memzero(payload);
  }
}

/**
 * Revocation: decrypts, then re-encrypts under a NEW batch key and nonce wrapped only to
 * `recipients`. Keeps the logical id (inside the encryption); the file name changes.
 */
export function reencryptPack(bytes: Uint8Array, index: PackIndex, keys: KeyPair[], recipients: Uint8Array[], opts: Omit<SealOptions, 'id'> = {}): Uint8Array {
  findIndexed(bytes, index);
  return reencryptUnchecked(bytes, keys, index.owner, recipients, opts);
}
