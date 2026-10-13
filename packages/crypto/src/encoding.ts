import { FormatError, UnsupportedVersionError } from './errors';
import { S } from './sodium';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function fromUtf8(b: Uint8Array, what = 'data'): string {
  try {
    return dec.decode(b);
  } catch {
    throw new FormatError(`${what}: invalid UTF-8`);
  }
}

/** base64url without padding (RFC 4648 §5). Used for every binary value inside JSON. */
export function toB64Url(bytes: Uint8Array): string {
  const s = S();
  return s.to_base64(bytes, s.base64_variants.URLSAFE_NO_PADDING);
}

/** Strict base64url decoding: rejects padding, foreign chars and non-canonical encodings. */
export function fromB64Url(str: unknown, what = 'value', expectedLength?: number): Uint8Array {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new FormatError(`${what}: not base64url`);
  const s = S();
  let out: Uint8Array;
  try {
    out = s.from_base64(str, s.base64_variants.URLSAFE_NO_PADDING);
  } catch {
    throw new FormatError(`${what}: not base64url`);
  }
  if (toB64Url(out) !== str) throw new FormatError(`${what}: non-canonical base64url`);
  if (expectedLength !== undefined && out.length !== expectedLength) {
    throw new FormatError(`${what}: expected ${expectedLength} bytes, got ${out.length}`);
  }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

export function readU32be(b: Uint8Array, offset: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(offset, false);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && S().memcmp(a, b);
}

/**
 * Canonical JSON (subset of RFC 8785 / JCS):
 * - object keys sorted by UTF-16 code units (JS default sort), recursively;
 * - no insignificant whitespace;
 * - strings escaped as JSON.stringify does;
 * - numbers MUST be safe integers (no floats, NaN, Infinity; -0 written as 0);
 * - only plain objects, arrays, strings, integers, booleans and null; `undefined` is rejected.
 * For this value domain the output is byte-identical to JCS.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value)) throw new FormatError(`canonical JSON: only safe integers are allowed (got ${value})`);
      return Object.is(value, -0) ? '0' : String(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new FormatError('canonical JSON: only plain objects are allowed');
      const rec = value as Record<string, unknown>;
      const keys = Object.keys(rec).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(rec[k])}`).join(',')}}`;
    }
    default:
      throw new FormatError(`canonical JSON: unsupported value type ${typeof value}`);
  }
}

export type JsonObject = Record<string, unknown>;

export function parseJsonObject(input: string | JsonObject, what: string): JsonObject {
  let v: unknown = input;
  if (typeof input === 'string') {
    try {
      v = JSON.parse(input);
    } catch {
      throw new FormatError(`${what}: invalid JSON`);
    }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new FormatError(`${what}: expected a JSON object`);
  return v as JsonObject;
}

/** Checks the `version` field: integer >= 1, and <= supported (else UnsupportedVersionError). */
export function checkVersion(obj: JsonObject, structure: string, supported: number): number {
  const v = obj['version'];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new FormatError(`${structure}: missing or invalid version`);
  if (v > supported) throw new UnsupportedVersionError(structure, v, supported);
  return v;
}

/** Rejects unknown keys and missing required keys. Call AFTER checkVersion so newer versions get the right error. */
export function checkKeys(obj: JsonObject, structure: string, required: string[], optional: string[] = []): void {
  for (const k of required) if (!(k in obj)) throw new FormatError(`${structure}: missing field "${k}"`);
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(obj)) if (!allowed.has(k)) throw new FormatError(`${structure}: unknown field "${k}"`);
}

export function str(obj: JsonObject, key: string, structure: string): string {
  const v = obj[key];
  if (typeof v !== 'string') throw new FormatError(`${structure}: field "${key}" must be a string`);
  return v;
}

export function int(obj: JsonObject, key: string, structure: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new FormatError(`${structure}: field "${key}" must be a non-negative integer`);
  return v;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** ISO-8601 UTC timestamp as produced by Date#toISOString. Returns epoch ms. */
export function isoDate(obj: JsonObject, key: string, structure: string): number {
  const v = str(obj, key, structure);
  const t = Date.parse(v);
  if (!ISO_RE.test(v) || !Number.isFinite(t)) throw new FormatError(`${structure}: field "${key}" must be an ISO-8601 UTC date`);
  return t;
}

/** "ed25519:<b64url>" / "x25519:<b64url>" */
export function formatKey(kind: 'ed25519' | 'x25519', publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new FormatError(`${kind} public key must be 32 bytes`);
  return `${kind}:${toB64Url(publicKey)}`;
}

export function parseKey(kind: 'ed25519' | 'x25519', value: unknown, what = 'key'): Uint8Array {
  if (typeof value !== 'string' || !value.startsWith(`${kind}:`)) throw new FormatError(`${what}: expected "${kind}:<base64url>"`);
  return fromB64Url(value.slice(kind.length + 1), what, 32);
}
