import { FormatError, InvalidKeyError, UnsupportedVersionError } from './errors';
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

export function u16be(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, false);
  return b;
}

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

export function readU16be(b: Uint8Array, offset: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(offset, false);
}

export function readU32be(b: Uint8Array, offset: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(offset, false);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && S().memcmp(a, b);
}

/** Lexicographic byte comparison (not constant time; only for public values). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

/** Simple binary reader with bounds checks that throw FormatError. */
export class Reader {
  private o = 0;
  constructor(
    private readonly b: Uint8Array,
    private readonly what: string,
  ) {}
  bytes(n: number): Uint8Array {
    if (this.o + n > this.b.length) throw new FormatError(`${this.what}: truncated`);
    const out = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return out;
  }
  u8(): number {
    return this.bytes(1)[0] as number;
  }
  u16(): number {
    return readU16be(this.bytes(2), 0);
  }
  u32(): number {
    return readU32be(this.bytes(4), 0);
  }
  get offset(): number {
    return this.o;
  }
  rest(): Uint8Array {
    return this.bytes(this.b.length - this.o);
  }
  end(): void {
    if (this.o !== this.b.length) throw new FormatError(`${this.what}: trailing bytes`);
  }
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
      // The value is deliberately not echoed (it could be a coordinate put here by mistake).
      if (!Number.isSafeInteger(value)) throw new FormatError('canonical JSON: only safe integers are allowed');
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

/**
 * Parses a JSON object. Transported text (a string) MUST be canonical JSON: re-canonicalizing
 * the parsed value must give back exactly the same string. This single rule rejects duplicate
 * keys (parser differentials), whitespace and key-order variants. Already-parsed objects are
 * accepted as is (in-process use only).
 */
export function parseJsonObject(input: string | JsonObject, what: string): JsonObject {
  let v: unknown = input;
  if (typeof input === 'string') {
    try {
      v = JSON.parse(input);
    } catch {
      throw new FormatError(`${what}: invalid JSON`);
    }
    let canonical: string;
    try {
      canonical = canonicalize(v);
    } catch {
      throw new FormatError(`${what}: non-canonical JSON`);
    }
    if (canonical !== input) throw new FormatError(`${what}: non-canonical JSON (duplicate keys, whitespace or key order)`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new FormatError(`${what}: expected a JSON object`);
  return v as JsonObject;
}

/** Checks the `version` field is exactly the version this library reads (else UnsupportedVersionError). */
export function checkVersion(obj: JsonObject, structure: string, supported: number): number {
  const v = obj['version'];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new FormatError(`${structure}: missing or invalid version`);
  if (v !== supported) throw new UnsupportedVersionError(structure, v, supported);
  return v;
}

/** Binary counterpart of checkVersion. */
export function checkByteVersion(v: number, structure: string, supported: number): void {
  if (v === 0) throw new FormatError(`${structure}: bad version`);
  if (v !== supported) throw new UnsupportedVersionError(structure, v, supported);
}

/** Rejects unknown keys and missing required keys. Call AFTER checkVersion so other versions get the right error. */
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

export function obj(o: JsonObject, key: string, structure: string): JsonObject {
  const v = o[key];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new FormatError(`${structure}: field "${key}" must be an object`);
  return v as JsonObject;
}

export function arr(o: JsonObject, key: string, structure: string, max: number): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new FormatError(`${structure}: field "${key}" must be an array`);
  if (v.length > max) throw new FormatError(`${structure}: field "${key}" has too many entries (max ${max})`);
  return v;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/**
 * ISO-8601 UTC timestamp, `YYYY-MM-DDTHH:MM:SS[.mmm]Z`, that must denote a real calendar instant
 * (no Feb 30, no hour 24). Returns epoch ms.
 */
export function isoDate(o: JsonObject, key: string, structure: string): number {
  const v = str(o, key, structure);
  const t = Date.parse(v);
  const bad = () => new FormatError(`${structure}: field "${key}" must be an ISO-8601 UTC date`);
  if (!ISO_RE.test(v) || !Number.isFinite(t)) throw bad();
  const back = new Date(t).toISOString();
  if (back !== v && back !== v.replace(/Z$/, '.000Z')) throw bad();
  return t;
}

/** Validates an optional `now` option and returns epoch ms. */
export function nowMs(now: Date | undefined, what: string): number {
  if (now === undefined) return Date.now();
  const t = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(t)) throw new FormatError(`${what}: "now" must be a valid Date`);
  return t;
}

/** "ed25519:<b64url>" / "x25519:<b64url>" */
export function formatKey(kind: 'ed25519' | 'x25519', publicKey: Uint8Array): string {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) throw new InvalidKeyError(`${kind} public key must be 32 bytes`);
  if (kind === 'x25519') assertX25519PublicKey(publicKey, 'x25519 public key');
  return `${kind}:${toB64Url(publicKey)}`;
}

export function parseKey(kind: 'ed25519' | 'x25519', value: unknown, what = 'key'): Uint8Array {
  if (typeof value !== 'string' || !value.startsWith(`${kind}:`)) throw new FormatError(`${what}: expected "${kind}:<base64url>"`);
  const pk = fromB64Url(value.slice(kind.length + 1), what, 32);
  if (kind === 'x25519') assertX25519PublicKey(pk, what);
  return pk;
}

let probeScalar: Uint8Array | undefined;

/**
 * Rejects X25519 public keys that are all-zero or of low order: any key whose shared secret with a
 * fixed, clamped, non-zero scalar is the all-zero point. Such keys would make sealed boxes fail
 * (or be trivially decryptable). Throws InvalidKeyError.
 */
export function assertX25519PublicKey(pk: Uint8Array, what = 'x25519 public key'): void {
  if (!(pk instanceof Uint8Array) || pk.length !== 32) throw new InvalidKeyError(`${what}: must be 32 bytes`);
  const s = S();
  probeScalar ??= s.crypto_generichash(32, utf8('TrianguLair/x25519-probe'), null);
  let shared: Uint8Array;
  try {
    shared = s.crypto_scalarmult(probeScalar, pk);
  } catch {
    throw new InvalidKeyError(`${what}: low-order or invalid X25519 key`);
  }
  const zero = s.is_zero(shared);
  s.memzero(shared);
  if (zero) throw new InvalidKeyError(`${what}: low-order or invalid X25519 key`);
}

/** Accepts a 32-byte Ed25519 public key or its "ed25519:..." form and returns the string form. */
export function ownerString(owner: Uint8Array | string): string {
  return typeof owner === 'string' ? (parseKey('ed25519', owner, 'owner'), owner) : formatKey('ed25519', owner);
}

/** Recursively freezes a plain JSON value (verified documents are returned frozen). */
export function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}
