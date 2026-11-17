// SPDX-License-Identifier: MPL-2.0
/**
 * Personal photos on the storage (spec "No duplicates, lightweight storages": recompressed to about
 * 1,600 px in WebP or AVIF, a separate thumbnail, friends download the full photo only when they open
 * it). Frozen format: each image is its own **media file** (`sealPack(…, { type: "media" })`, file
 * `media/b2b256-<hash>.bin`, listed in my signed index like every pack), so the storage sees the same
 * kind of file as my own document and manifest.
 *
 * - Payload (inside the pack): the sync payload frame with kind 5 (`photo`), stored (images do not
 *   compress), padded to the 4 KiB floor like every payload, then Padmé by the pack format.
 * - Key: each photo has its own random X25519 key (the **photo key**, spec "Direct recipient": "every
 *   key reachable from that content (a photo key…) is renewed too"). Both files of a photo (full and
 *   thumbnail) are sealed to it alone. The key travels inside what can already read the photo: my own
 *   document (`u:<mediaId>`, my devices) and the places pack of the save (friends). So adding a friend
 *   uploads nothing new; a removed reader (a friend, an invitation link, a device declared lost, a
 *   save made private) gets the photo re-sealed under a new key (OwnSync.preparePhotos).
 * - Reference from the places payload, by content hash of the encrypted files:
 *   `"photos":[{"id","key","full":"b2b256:…","thumb":"b2b256:…","type":"image/webp","w","h","created"}]`.
 */
import { fromB64Url, openPack, packEntry, packHash, sealPack, type KeyPair, type PackIndex } from '@triangulair/crypto';
import { DecryptionError } from '@triangulair/crypto';
import { PayloadError } from './errors.ts';
import { listKeyPair, newListKey } from './lists.ts';
import { decodePayload, encodePayload } from './payload.ts';
import type { ByteBudget } from './util.ts';

/** Image formats accepted (photo and thumbnail have the same one). */
export const PHOTO_TYPES = ['image/webp', 'image/avif', 'image/jpeg'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];
/** At most this many photos of one save travel to friends (readers refuse more). */
export const MAX_PHOTOS_PER_PLACE = 24;
/** Largest width or height accepted in a reference (the app writes about 1,600 px). */
export const MAX_PHOTO_SIDE = 10_000;
/** Spec sizes: about 1,600 px for the photo, a thumbnail for galleries and What's new. */
export const PHOTO_SIDE = 1600;
export const THUMB_SIDE = 400;

/** One photo as a friend's places payload references it. */
export interface PhotoRef {
  id: string;
  /** base64url of the 32-byte X25519 secret key both files are sealed to. */
  key: string;
  /** `b2b256:` hash of the encrypted full-size file (`media/b2b256-<h>.bin`). */
  full: string;
  /** Same for the thumbnail. */
  thumb: string;
  type: PhotoType;
  w: number;
  h: number;
  created: string;
}

const HASH_RE = /^b2b256:[A-Za-z0-9_-]{43}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const REF_KEYS = new Set(['id', 'key', 'full', 'thumb', 'type', 'w', 'h', 'created']);

export const isPhotoType = (v: unknown): v is PhotoType => typeof v === 'string' && (PHOTO_TYPES as readonly string[]).includes(v);
export const isMediaHash = (v: unknown): v is string => typeof v === 'string' && HASH_RE.test(v);

/** `media/b2b256-<h>.bin` of a `b2b256:<h>` hash. */
export function mediaPath(hash: string): string {
  if (!HASH_RE.test(hash)) throw new PayloadError('photo: bad file hash');
  return `media/b2b256-${hash.slice(7)}.bin`;
}

/** A new photo key (base64url of an X25519 secret key). */
export function newPhotoKey(): string {
  return newListKey();
}

/** The key pair of a stored photo key (`listsReady()` first: it uses the same libsodium call). */
export function photoKeyPair(key: string): KeyPair {
  return listKeyPair(fromB64Url(key, 'photo key', 32));
}

/** Content hash of an image (the id of its local copy). */
export function imageHash(bytes: Uint8Array): string {
  return packHash(bytes);
}

/**
 * Seals one image to its photo key. Returns the file bytes and its index entry. `id`: the logical id
 * inside the encryption (random by default).
 */
export function sealPhoto(owner: string, image: Uint8Array, key: KeyPair, opts: { id?: string } = {}): { bytes: Uint8Array; file: string; hash: string } {
  const payload = encodePayload('photo', image, { compress: false });
  const bytes = sealPack(owner, payload, [key.publicKey], { type: 'media', ...(opts.id !== undefined && { id: opts.id }) });
  const e = packEntry(bytes, 'media');
  return { bytes, file: e.file, hash: e.hash };
}

/**
 * Opens a photo file fetched at `path`: it must be listed in the owner's verified `index` (openPack),
 * be served at its own path (another listed file at this path is refused), be a media file, and hold a
 * photo payload no larger than `maxBytes`.
 */
export function openPhoto(bytes: Uint8Array, index: PackIndex, key: KeyPair, path: string, opts: { maxBytes: number; budget?: ByteBudget }): Uint8Array {
  const opened = openPack(bytes, index, [key]);
  if (opened.file !== path) throw new DecryptionError(`${path}: the storage served another listed file`, 'NOT_INDEXED');
  if (opened.type !== 'media') throw new PayloadError('photo: not a media file');
  const { kind, body } = decodePayload(opened.payload, { maxBytes: opts.maxBytes, ...(opts.budget && { budget: opts.budget }) });
  if (kind !== 'photo') throw new PayloadError('photo: wrong payload kind');
  return body;
}

/** Validates the `photos` property of a place (strict, like the rest of the payload). */
export function checkPhotoRefs(v: unknown, lenient: boolean): PhotoRef[] {
  const fail = (m: string): never => {
    throw new PayloadError(`places: photos: ${m}`);
  };
  if (!Array.isArray(v) || v.length > MAX_PHOTOS_PER_PLACE) fail('must be an array (bounded)');
  const ids = new Set<string>();
  for (const r of v as unknown[]) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) fail('object expected');
    const o = r as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!REF_KEYS.has(k) && !lenient) fail(`unknown field ${k}`);
    if (typeof o.id !== 'string' || !ID_RE.test(o.id) || ids.has(o.id)) fail('bad id');
    ids.add(o.id as string);
    if (typeof o.key !== 'string' || !KEY_RE.test(o.key)) fail('bad key');
    if (!isMediaHash(o.full) || !isMediaHash(o.thumb) || o.full === o.thumb) fail('bad file hash');
    if (!isPhotoType(o.type)) fail('bad type');
    for (const d of [o.w, o.h]) if (typeof d !== 'number' || !Number.isSafeInteger(d) || d < 1 || d > MAX_PHOTO_SIDE) fail('bad size');
    if (typeof o.created !== 'string' || !ISO_RE.test(o.created) || !Number.isFinite(Date.parse(o.created))) fail('bad date');
  }
  return v as PhotoRef[];
}
