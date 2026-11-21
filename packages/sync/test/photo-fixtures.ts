// SPDX-License-Identifier: MPL-2.0
/** Synthetic images for the photo tests (containers only: nothing here decodes pixels). */

const enc = new TextEncoder();

function le32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

function chunk(id: string, data: Uint8Array): number[] {
  const out = [...enc.encode(id), ...le32(data.length), ...data];
  if (data.length & 1) out.push(0);
  return out;
}

/** Deterministic noise (images do not compress). */
export function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed * 2654435761 >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/**
 * A WebP container (VP8X with the canvas size + optional EXIF/XMP + a VP8L chunk of `size` bytes: its
 * header with the frame size, then noise). `canvas`: another canvas size in VP8X (a bomb's header).
 */
export function webp(size: number, seed = 1, opts: { exif?: boolean; xmp?: boolean; width?: number; height?: number; canvas?: [number, number] } = {}): Uint8Array {
  const flags = (opts.exif ? 0x08 : 0) | (opts.xmp ? 0x04 : 0);
  const width = opts.width ?? 1600;
  const height = opts.height ?? 1200;
  const [cw, ch] = opts.canvas ?? [width, height];
  const vp8x = new Uint8Array(10);
  vp8x[0] = flags;
  vp8x.set([(cw - 1) & 0xff, ((cw - 1) >> 8) & 0xff, ((cw - 1) >> 16) & 0xff, (ch - 1) & 0xff, ((ch - 1) >> 8) & 0xff, ((ch - 1) >> 16) & 0xff], 4);
  const body: number[] = [...enc.encode('WEBP'), ...chunk('VP8X', vp8x)];
  if (opts.exif) body.push(...chunk('EXIF', enc.encode('Exif\0\0MM GPSLatitude 48.8566 GPSLongitude 2.3522 Model iPhone')));
  const tail: number[] = [];
  if (opts.xmp) tail.push(...chunk('XMP ', enc.encode('<x:xmpmeta>exif:GPSLatitude="48,51.4N"</x:xmpmeta>')));
  const img = noise(size, seed);
  if (size >= 5) {
    const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
    img.set([0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]);
  }
  const pad = size & 1;
  const total = body.length + 8 + size + pad + tail.length;
  const out = new Uint8Array(8 + total);
  out.set([...enc.encode('RIFF'), ...le32(total), ...body, ...enc.encode('VP8L'), ...le32(size)]);
  out.set(img, 8 + body.length + 8);
  out.set(tail, 8 + body.length + 8 + size + pad);
  return out;
}

/** Noise as entropy-coded JPEG data: every 0xFF is followed by a stuffed 0x00. */
function scanData(size: number, seed: number): number[] {
  const out: number[] = [];
  for (const x of noise(size, seed)) {
    out.push(x);
    if (x === 0xff) out.push(0);
  }
  return out;
}

/**
 * A JPEG container with JFIF, optional Exif (with GPS text) and comment, a frame header, then a scan of
 * noise. `mpf`: an APP2 MPF segment and a second image after the end of the first (as phones write).
 */
export function jpeg(size: number, seed = 1, opts: { exif?: boolean; mpf?: boolean; icc?: boolean; width?: number; height?: number } = {}): Uint8Array {
  const seg = (m: number, data: Uint8Array) => [0xff, m, ((data.length + 2) >> 8) & 0xff, (data.length + 2) & 0xff, ...data];
  const out: number[] = [0xff, 0xd8];
  out.push(...seg(0xe0, enc.encode('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')));
  if (opts.exif) {
    out.push(...seg(0xe1, enc.encode('Exif\0\0MM GPSLatitude 48.8566 Model iPhone')));
    out.push(...seg(0xfe, enc.encode('taken at home')));
  }
  if (opts.icc) out.push(...seg(0xe2, enc.encode('ICC_PROFILE\0\x01\x01colour')));
  if (opts.mpf) out.push(...seg(0xe2, enc.encode('MPF\0II*\0 secondary image index')));
  out.push(...seg(0xdb, noise(64, seed)));
  const w = opts.width ?? 1600;
  const h = opts.height ?? 1200;
  out.push(...seg(0xc0, new Uint8Array([8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0])));
  out.push(...seg(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0])));
  out.push(...scanData(size, seed + 1), 0xff, 0xd9);
  if (opts.mpf) {
    // The secondary image (depth map, gain map…), with its own Exif.
    out.push(0xff, 0xd8, ...seg(0xe1, enc.encode('Exif\0\0MM GPSLatitude 48.8566 secondary')), ...seg(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0])), ...scanData(64, seed + 2), 0xff, 0xd9);
  }
  return new Uint8Array(out);
}

export const has = (hay: Uint8Array, needle: string): boolean => {
  const n = enc.encode(needle);
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
};

/** A photo and its thumbnail as the app gives them. */
export function photo(seed = 1, opts: { exif?: boolean; size?: number } = {}) {
  return { full: webp(opts.size ?? 20_000, seed, { exif: !!opts.exif }), thumb: webp(2_000, seed + 100, { width: 400, height: 300 }), width: 1600, height: 1200 };
}
