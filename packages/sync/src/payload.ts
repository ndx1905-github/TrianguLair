// SPDX-License-Identifier: MPL-2.0
/**
 * Pack payloads (inside the pack encryption, after the crypto frame).
 *
 *   0  4  magic "TLSY"
 *   4  1  envelope version (= 1, major only: a binary structure)
 *   5  1  kind: 1 = places (GeoJSON FeatureCollection, JSON)
 *               2 = own document (Yjs update, own devices only)
 *               3 = manifest (JSON, own devices only)
 *   6  1  codec: 0 = stored, 1 = raw DEFLATE (RFC 1951, fflate, pure JavaScript)
 *   7  …  body (compressed with the codec)
 *
 * Compression happens BEFORE encryption (see THREATS.md: the storage sees the
 * padded size of compressed content). Decompression is bounded (`maxBytes`)
 * so that a hostile pack cannot exhaust memory.
 */
import { Inflate, deflateSync } from 'fflate';
import { PayloadError } from './errors.ts';

const MAGIC = [0x54, 0x4c, 0x53, 0x59]; // "TLSY"
export const PAYLOAD_VERSION = 1;
export type PayloadKind = 'places' | 'own-doc' | 'manifest';
const KIND_BYTE: Record<PayloadKind, number> = { places: 1, 'own-doc': 2, manifest: 3 };
const BYTE_KIND: Record<number, PayloadKind> = { 1: 'places', 2: 'own-doc', 3: 'manifest' };

/** Largest decompressed body accepted (64 MiB: a 10,000-place own document is about 3 MB). */
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

export function encodePayload(kind: PayloadKind, body: Uint8Array, opts: { compress?: boolean; level?: number } = {}): Uint8Array {
  let codec = 0;
  let data = body;
  if (opts.compress !== false && body.length > 64) {
    const z = deflateSync(body, { level: (opts.level ?? 6) as 6 });
    if (z.length < body.length) {
      codec = 1;
      data = z;
    }
  }
  const out = new Uint8Array(7 + data.length);
  out.set(MAGIC, 0);
  out[4] = PAYLOAD_VERSION;
  out[5] = KIND_BYTE[kind];
  out[6] = codec;
  out.set(data, 7);
  return out;
}

export function decodePayload(bytes: Uint8Array, opts: { maxBytes?: number } = {}): { kind: PayloadKind; body: Uint8Array } {
  if (bytes.length < 7 || MAGIC.some((b, i) => bytes[i] !== b)) throw new PayloadError('payload: bad magic');
  if (bytes[4] !== PAYLOAD_VERSION) throw new PayloadError('payload: unsupported version', true);
  const kind = BYTE_KIND[bytes[5]!];
  if (!kind) throw new PayloadError('payload: unknown kind', true);
  const max = opts.maxBytes ?? MAX_PAYLOAD_BYTES;
  const data = bytes.subarray(7);
  if (bytes[6] === 0) {
    if (data.length > max) throw new PayloadError('payload: too large');
    return { kind, body: data };
  }
  if (bytes[6] !== 1) throw new PayloadError('payload: unknown codec', true);
  return { kind, body: inflateBounded(data, max) };
}

/** Raw DEFLATE decompression that stops as soon as the output exceeds `max` bytes. */
export function inflateBounded(data: Uint8Array, max: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  const inf = new Inflate((chunk, final) => {
    total += chunk.length;
    if (total > max) throw new PayloadError('payload: decompressed size over the limit');
    chunks.push(chunk);
    if (final) done = true;
  });
  const STEP = 4096; // at most ~4 MB of output per push (DEFLATE expands at most ~1032:1)
  try {
    for (let i = 0; i < data.length; i += STEP) inf.push(data.subarray(i, Math.min(data.length, i + STEP)), i + STEP >= data.length);
    if (data.length === 0) inf.push(new Uint8Array(0), true);
  } catch (e) {
    if (e instanceof PayloadError) throw e;
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
