// SPDX-License-Identifier: MPL-2.0
/**
 * Image metadata removal (spec "Protections": "Photos: automatic removal of EXIF metadata (GPS,
 * device) before encryption").
 *
 * The app re-encodes every photo (expo-image-manipulator on the phone, a canvas on the web), which
 * already writes no EXIF. This module is the second barrier, run on every image before it is stored
 * or sealed: it recognises the format from its bytes, removes the metadata containers a re-encoder
 * might still write, and `imageMetadata` tells what is left (the sync layer refuses an image that
 * still carries any).
 *
 * - JPEG: APP1 (Exif, XMP), APP3–APP15 (IPTC in APP13, maker data) and COM segments are removed
 *   before the first scan; APP0 (JFIF) and APP2 (ICC colour profile) are kept.
 * - WebP: `EXIF` and `XMP ` chunks are removed and the VP8X flags updated.
 * - AVIF: recognised only; an `Exif` item or an XMP (`mime`) item in its `meta` box is reported (the
 *   app then falls back to WebP).
 */
export type ImageFormat = 'image/webp' | 'image/avif' | 'image/jpeg';
export type MetadataKind = 'exif' | 'xmp' | 'iptc' | 'comment' | 'other';

const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

/** The image format from its first bytes (null: not one of ours). */
export function sniffImage(b: Uint8Array): ImageFormat | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brands = ascii(b, 8, Math.min(32, b.length - 8));
    if (brands.includes('avif') || brands.includes('avis')) return 'image/avif';
  }
  return null;
}

export class ImageFormatError extends Error {
  constructor(msg: string) {
    super(`image: ${msg}`);
    this.name = 'ImageFormatError';
  }
}

/** Metadata containers present in an image (empty: none found). Throws on an unknown or broken file. */
export function imageMetadata(b: Uint8Array): MetadataKind[] {
  const f = sniffImage(b);
  if (f === 'image/jpeg') return jpegSegments(b).filter((s) => !s.keep).map((s) => s.kind);
  if (f === 'image/webp') return webpChunks(b).filter((c) => c.meta).map((c) => (c.id === 'EXIF' ? 'exif' : 'xmp'));
  if (f === 'image/avif') return avifMetadata(b);
  throw new ImageFormatError('not a JPEG, WebP or AVIF image');
}

/** The image without its metadata containers (same bytes when there are none). AVIF is returned as is. */
export function stripImageMetadata(b: Uint8Array): Uint8Array {
  const f = sniffImage(b);
  if (f === 'image/jpeg') {
    const segs = jpegSegments(b);
    if (segs.every((s) => s.keep)) return b;
    const parts: Uint8Array[] = [b.subarray(0, 2)];
    for (const s of segs) if (s.keep) parts.push(b.subarray(s.start, s.end));
    parts.push(b.subarray(segs.length ? segs[segs.length - 1]!.end : 2));
    return concat(parts);
  }
  if (f === 'image/webp') {
    const chunks = webpChunks(b);
    if (!chunks.some((c) => c.meta)) return b;
    const parts: Uint8Array[] = [];
    for (const c of chunks) {
      if (c.meta) continue;
      const bytes = b.slice(c.start, c.end);
      if (c.id === 'VP8X' && bytes.length > 8) bytes[8] = bytes[8]! & ~0x0c; // EXIF (0x08) and XMP (0x04) flags
      parts.push(bytes);
    }
    const body = concat(parts);
    const out = new Uint8Array(12 + body.length);
    out.set(b.subarray(0, 12));
    new DataView(out.buffer).setUint32(4, 4 + body.length, true);
    out.set(body, 12);
    return out;
  }
  if (f === 'image/avif') return b;
  throw new ImageFormatError('not a JPEG, WebP or AVIF image');
}

interface Seg {
  start: number;
  end: number;
  keep: boolean;
  kind: MetadataKind;
}

/** JPEG marker segments before the first scan (SOS). */
function jpegSegments(b: Uint8Array): Seg[] {
  const out: Seg[] = [];
  let o = 2;
  for (;;) {
    if (o + 4 > b.length) throw new ImageFormatError('truncated JPEG');
    if (b[o] !== 0xff) throw new ImageFormatError('bad JPEG marker');
    let m = b[o + 1]!;
    while (m === 0xff && o + 2 < b.length) {
      o++; // fill bytes
      m = b[o + 1]!;
    }
    if (m === 0xda || m === 0xd9) return out; // start of scan / end of image: the rest is image data
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      o += 2; // markers without a length
      continue;
    }
    const len = (b[o + 2]! << 8) | b[o + 3]!;
    if (len < 2 || o + 2 + len > b.length) throw new ImageFormatError('bad JPEG segment length');
    const end = o + 2 + len;
    let keep = true;
    let kind: MetadataKind = 'other';
    if (m === 0xe1) {
      keep = false;
      kind = ascii(b, o + 4, 4) === 'Exif' ? 'exif' : 'xmp';
    } else if (m === 0xed) {
      keep = false;
      kind = 'iptc';
    } else if (m === 0xfe) {
      keep = false;
      kind = 'comment';
    } else if (m >= 0xe3 && m <= 0xef) {
      keep = false;
    }
    out.push({ start: o, end, keep, kind });
    o = end;
  }
}

interface Chunk {
  id: string;
  start: number;
  end: number;
  meta: boolean;
}

function webpChunks(b: Uint8Array): Chunk[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const riff = dv.getUint32(4, true);
  if (riff + 8 > b.length || riff < 4) throw new ImageFormatError('bad WebP size');
  const end = 8 + riff;
  const out: Chunk[] = [];
  let o = 12;
  while (o + 8 <= end) {
    const id = ascii(b, o, 4);
    const size = dv.getUint32(o + 4, true);
    const next = o + 8 + size + (size & 1);
    if (o + 8 + size > end) throw new ImageFormatError('bad WebP chunk');
    out.push({ id, start: o, end: Math.min(next, end), meta: id === 'EXIF' || id === 'XMP ' });
    o = next;
  }
  return out;
}

/** ISO-BMFF boxes inside [start, end). */
function boxes(b: Uint8Array, start: number, end: number): { type: string; body: number; end: number }[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: { type: string; body: number; end: number }[] = [];
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    const type = ascii(b, o + 4, 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) break;
      size = dv.getUint32(o + 8) * 2 ** 32 + dv.getUint32(o + 12);
      header = 16;
    } else if (size === 0) size = end - o;
    if (size < header || o + size > end) throw new ImageFormatError('bad AVIF box');
    out.push({ type, body: o + header, end: o + size });
    o += size;
  }
  return out;
}

function avifMetadata(b: Uint8Array): MetadataKind[] {
  const found: MetadataKind[] = [];
  const meta = boxes(b, 0, b.length).find((x) => x.type === 'meta');
  if (!meta) return found;
  const iinf = boxes(b, meta.body + 4, meta.end).find((x) => x.type === 'iinf'); // meta is a full box
  if (!iinf) return found;
  const version = b[iinf.body]!;
  const first = iinf.body + 4 + (version === 0 ? 2 : 4);
  for (const infe of boxes(b, first, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const v = b[infe.body]!;
    if (v < 2) continue;
    const typeAt = infe.body + 4 + (v === 2 ? 2 : 4) + 2;
    const itemType = ascii(b, typeAt, 4);
    if (itemType === 'Exif') found.push('exif');
    else if (itemType === 'mime') found.push('xmp');
  }
  return found;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
