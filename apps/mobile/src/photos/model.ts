/**
 * Personal photos (T-111b), the pure part: sizes and quality by setting, the friends' cache cap
 * setting, data URIs for display. Spec "No duplicates, lightweight storages": recompressed to about
 * 1,600 px (WebP, AVIF where the platform encodes it), with a separate thumbnail; Error cases,
 * quota full: "reduce photo quality".
 */
import { getSetting, setSetting } from '../data/deviceSettings';

export type PhotoQuality = 'standard' | 'saver';
export const PHOTO_QUALITIES: readonly PhotoQuality[] = ['standard', 'saver'];

export interface QualitySpec {
  /** Longest side of the photo, px. */
  side: number;
  /** Encoder quality, 0–1. */
  quality: number;
  thumbSide: number;
  thumbQuality: number;
}

export const QUALITY: Readonly<Record<PhotoQuality, QualitySpec>> = {
  standard: { side: 1600, quality: 0.8, thumbSide: 400, thumbQuality: 0.6 },
  saver: { side: 1200, quality: 0.65, thumbSide: 320, thumbQuality: 0.5 },
};

/** Friends' cache sizes offered (spec: "cache capped at 500 MB by default, adjustable"). */
export const CACHE_CAPS_MB: readonly number[] = [100, 250, 500, 1000, 2000];
export const DEFAULT_CACHE_MB = 500;

const QUALITY_KEY = 'photos:quality';
const CACHE_KEY = 'photos:cacheMb';

export function photoQuality(): PhotoQuality {
  const v = getSetting(QUALITY_KEY);
  return v === 'saver' ? 'saver' : 'standard';
}
export function setPhotoQuality(q: PhotoQuality): void {
  setSetting(QUALITY_KEY, q);
}
export function cacheCapMb(): number {
  const v = Number(getSetting(CACHE_KEY));
  return CACHE_CAPS_MB.includes(v) ? v : DEFAULT_CACHE_MB;
}
export function setCacheCapMb(mb: number): void {
  if (!CACHE_CAPS_MB.includes(mb)) throw new RangeError('unsupported cache size');
  setSetting(CACHE_KEY, String(mb));
}
/** Megabytes as storage providers and the spec count them. */
export const MB = 1_000_000;

/** Size that fits `max` on the longest side, never enlarged. */
export function fitSize(w: number, h: number, max: number): { width: number; height: number } {
  if (!(w > 0) || !(h > 0)) throw new RangeError('bad image size');
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${B64[n >> 18]!}${B64[(n >> 12) & 63]!}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${B64[n >> 18]!}${B64[(n >> 12) & 63]!}${B64[(n >> 6) & 63]!}=`;
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[\s=]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('not base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** A data URI for an image (both platforms' Image components accept it). */
export function dataUri(bytes: Uint8Array, mime: string | null): string {
  return `data:${mime ?? 'image/webp'};base64,${toBase64(bytes)}`;
}

/** What the gallery shows for a photo of mine that is not on my storage yet. */
export function waitingReason(opts: { hasStorage: boolean; quota: boolean }): 'local' | 'quota' | 'pending' {
  if (!opts.hasStorage) return 'local';
  return opts.quota ? 'quota' : 'pending';
}
