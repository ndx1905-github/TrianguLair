// SPDX-License-Identifier: MPL-2.0
/**
 * Pack payloads (inside the pack encryption, after the crypto frame).
 *
 *   0  4  magic "TLSY"
 *   4  1  envelope version (= 1, major only: a binary structure)
 *   5  1  kind: 1 = places (GeoJSON FeatureCollection, JSON)
 *               2 = own document (Yjs update, own devices only)
 *               3 = manifest (JSON, own devices only)
 *               4 = lists (GeoJSON FeatureCollection, JSON: list definitions, and the places of a
 *                   link-only list; lists.ts)
 *   6  1  codec: 0 = stored, 1 = raw DEFLATE (RFC 1951, fflate, pure JavaScript)
 *   7  4  body length (u32 big-endian, as stored: compressed with the codec)
 *  11  …  body
 *   …  …  zero bytes up to the padding floor (PAYLOAD_PAD_FLOOR: 4 KiB)
 *
 * Compression happens BEFORE encryption (see THREATS.md: the storage sees the
 * padded size of compressed content). The padding floor makes small packs and
 * own-document deltas all look alike (Padmé alone only hides about 12 % of a
 * size; under 4 KiB it would follow the size of each small edit). The pack
 * format then pads the whole payload with Padmé. Readers check that the
 * padding is zeros. Decompression is bounded (`maxBytes`, by default per
 * kind) so that a hostile pack cannot exhaust memory.
 *
 * (Pre-release change, T-211/T-212: kind 4 was added before any app shipped; a reader of
 * envelope version 1 that predates it would refuse the pack as "unsupported".)
 *
 * (Pre-release change, T-204 review: the length field and the padding were
 * added before any app shipped; envelope version 1 has only ever had this
 * layout in a release.)
 */
import { Inflate, deflateSync } from 'fflate';
import { PayloadError } from './errors.ts';
import { DEFAULT_LIMITS } from './limits.ts';
import { LimitError, type ByteBudget } from './util.ts';

const MAGIC = [0x54, 0x4c, 0x53, 0x59]; // "TLSY"
export const PAYLOAD_VERSION = 1;
export type PayloadKind = 'places' | 'own-doc' | 'manifest' | 'lists';
const KIND_BYTE: Record<PayloadKind, number> = { places: 1, 'own-doc': 2, manifest: 3, lists: 4 };
const BYTE_KIND: Record<number, PayloadKind> = { 1: 'places', 2: 'own-doc', 3: 'manifest', 4: 'lists' };
const HEADER = 11;

/** Smallest payload written (header, body and zero padding): 4 KiB. */
export const PAYLOAD_PAD_FLOOR = 4096;

/** Largest decompressed body accepted for any kind (64 MiB: a 10,000-place own document is about 3.8 MB). */
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

/** Default decompressed limit for each kind (SyncLimits overrides them). */
export const PAYLOAD_LIMITS: Readonly<Record<PayloadKind, number>> = Object.freeze({
  places: DEFAULT_LIMITS.placesPayloadBytes,
  lists: DEFAULT_LIMITS.placesPayloadBytes,
  manifest: DEFAULT_LIMITS.manifestPayloadBytes,
  'own-doc': DEFAULT_LIMITS.ownDocPayloadBytes,
});

export function encodePayload(
  kind: PayloadKind,
  body: Uint8Array,
  opts: { compress?: boolean; level?: number; padFloor?: number } = {},
): Uint8Array {
  let codec = 0;
  let data = body;
  if (opts.compress !== false && body.length > 64) {
    const z = deflateSync(body, { level: (opts.level ?? 6) as 6 });
    if (z.length < body.length) {
      codec = 1;
      data = z;
    }
  }
  if (data.length > 0xffffffff) throw new PayloadError('payload: too large');
  const out = new Uint8Array(Math.max(HEADER + data.length, opts.padFloor ?? PAYLOAD_PAD_FLOOR));
  out.set(MAGIC, 0);
  out[4] = PAYLOAD_VERSION;
  out[5] = KIND_BYTE[kind];
  out[6] = codec;
  new DataView(out.buffer, out.byteOffset).setUint32(7, data.length);
  out.set(data, HEADER);
  return out;
}

/**
 * Decodes a payload. `maxBytes` bounds the decompressed body (default: the
 * limit of its kind, PAYLOAD_LIMITS); `budget` is charged with the
 * decompressed bytes as they come (a friend's or a pass's total).
 */
export function decodePayload(
  bytes: Uint8Array,
  opts: { maxBytes?: number | Partial<Record<PayloadKind, number>>; budget?: ByteBudget } = {},
): { kind: PayloadKind; body: Uint8Array } {
  if (bytes.length < HEADER || MAGIC.some((b, i) => bytes[i] !== b)) throw new PayloadError('payload: bad magic');
  if (bytes[4] !== PAYLOAD_VERSION) throw new PayloadError('payload: unsupported version', true);
  const kind = BYTE_KIND[bytes[5]!];
  if (!kind) throw new PayloadError('payload: unknown kind', true);
  const max = typeof opts.maxBytes === 'number' ? opts.maxBytes : (opts.maxBytes?.[kind] ?? PAYLOAD_LIMITS[kind]);
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(7);
  if (HEADER + len > bytes.length) throw new PayloadError('payload: truncated');
  for (let i = HEADER + len; i < bytes.length; i++) if (bytes[i] !== 0) throw new PayloadError('payload: non-zero padding');
  const data = bytes.subarray(HEADER, HEADER + len);
  if (bytes[6] === 0) {
    if (data.length > max) throw new LimitError('pack', `payload (${kind})`);
    opts.budget?.take(data.length, `payload (${kind})`);
    return { kind, body: data };
  }
  if (bytes[6] !== 1) throw new PayloadError('payload: unknown codec', true);
  return { kind, body: inflateBounded(data, max, opts.budget) };
}

/** Raw DEFLATE decompression that stops as soon as the output exceeds `max` bytes (or the budget). */
export function inflateBounded(data: Uint8Array, max: number, budget?: ByteBudget): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  const inf = new Inflate((chunk, final) => {
    total += chunk.length;
    if (total > max) throw new LimitError('pack', 'payload: decompressed size');
    budget?.take(chunk.length, 'payload: decompressed size');
    chunks.push(chunk);
    if (final) done = true;
  });
  const STEP = 4096; // at most ~4 MB of output per push (DEFLATE expands at most ~1032:1)
  try {
    for (let i = 0; i < data.length; i += STEP) inf.push(data.subarray(i, Math.min(data.length, i + STEP)), i + STEP >= data.length);
    if (data.length === 0) inf.push(new Uint8Array(0), true);
  } catch (e) {
    if (e instanceof PayloadError || e instanceof LimitError) throw e;
    throw new PayloadError('payload: invalid compressed data');
  }
  if (!done) throw new PayloadError('payload: truncated compressed data');
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export function jsonBytes(value: unknown): Uint8Array {
  return enc.encode(JSON.stringify(value));
}

/**
 * Parses a JSON body written by `jsonBytes`. The text must be exactly what
 * `JSON.stringify` writes for the parsed value: this refuses duplicate keys
 * (parser differentials), whitespace variants and a BOM, like the crypto
 * package's canonical-JSON rule, while allowing floating-point coordinates
 * (canonical JSON in @triangulair/crypto is integers only). Numbers are
 * written in ECMAScript's shortest round-trip form.
 */
export function parseJsonBody(body: Uint8Array): unknown {
  let text: string;
  try {
    text = dec.decode(body);
  } catch {
    throw new PayloadError('payload: invalid UTF-8');
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new PayloadError('payload: invalid JSON');
  }
  if (JSON.stringify(v) !== text) throw new PayloadError('payload: JSON not in its written form (duplicate keys, spacing)');
  return v;
}

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}
